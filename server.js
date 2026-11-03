require("dotenv").config({ override: true });
const express = require("express");
const Stripe = require("stripe");
const catalog = require("./products");
const orders = require("./orders");
const { sendContactEmail, sendOrderConfirmation } = require("./mail");
const { dollarsToCents, normalizeAddress, previewTax } = require("./tax");

const PORT = process.env.PORT || 4242;
const app = express();
const productsById = new Map(catalog.map((product) => [product.id, product]));

function stripeSecretKey() {
  const raw =
    process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SANDBOX_KEY || "";
  return raw.trim().replace(/^['"]|['"]$/g, "");
}

function getStripe() {
  const key = stripeSecretKey();
  if (!key) {
    throw new Error(
      "Stripe is not configured. Add STRIPE_SECRET_KEY=sk_test_... to your .env file, then restart the server."
    );
  }
  if (key.startsWith("pk_")) {
    throw new Error(
      "That is a publishable key. Paste the Secret key from Stripe (it starts with sk_test_ or sk_live_)."
    );
  }
  if (key.includes("your_key_here") || key.length < 20) {
    throw new Error(
      "Replace the placeholder in .env with your real Stripe secret key, then restart with npm start."
    );
  }
  return new Stripe(key);
}

function originFrom(req) {
  return req.headers.origin || `http://localhost:${PORT}`;
}

function resolveCart(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Your cart is empty.");
  }

  const lineItems = [];

  for (const requested of items) {
    const product = productsById.get(Number(requested.id));
    const quantity = Number(requested.quantity);

    if (!product) {
      throw new Error("One or more items are no longer available.");
    }

    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 99) {
      throw new Error("Invalid quantity.");
    }

    if (quantity === 0) continue;

    lineItems.push({ ...product, quantity });
  }

  if (lineItems.length === 0) {
    throw new Error("Your cart is empty.");
  }

  return lineItems;
}

function productLineItems(lineItems) {
  return lineItems.map((item) => ({
    price_data: {
      currency: "usd",
      tax_behavior: "exclusive",
      product_data: {
        name: item.name,
        images: [item.image],
      },
      unit_amount: dollarsToCents(item.price),
    },
    quantity: item.quantity,
  }));
}

async function createCheckoutSession(stripe, { lineItems, tax, email, origin }) {
  const base = {
    mode: "payment",
    billing_address_collection: "required",
    shipping_address_collection: {
      allowed_countries: ["US", "CA", "GB", "AU"],
    },
    success_url: `${origin}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?canceled=true`,
    customer_email: email || undefined,
    metadata: { app: "studio-shop" },
  };

  if (tax.automaticTax) {
    try {
      return await stripe.checkout.sessions.create({
        ...base,
        automatic_tax: { enabled: true },
        line_items: productLineItems(lineItems),
      });
    } catch (error) {
      console.warn("automatic_tax failed, using calculated tax line:", error.message);
    }
  }

  const line_items = productLineItems(lineItems);
  if (tax.taxCents > 0) {
    line_items.push({
      price_data: {
        currency: "usd",
        tax_behavior: "inclusive",
        product_data: { name: `Tax (${Math.round(tax.rate * 10000) / 100}%)` },
        unit_amount: tax.taxCents,
      },
      quantity: 1,
    });
  }

  return stripe.checkout.sessions.create({ ...base, line_items });
}

async function confirmPaidSession(session, stripe, { webhook = false } = {}) {
  if (!session?.id) return null;

  const existing = orders.get(session.id);
  if (existing?.emailSent) {
    return orders.upsert(session.id, { webhook: existing.webhook || webhook });
  }

  const paid =
    session.payment_status === "paid" || session.status === "complete";
  if (!paid) {
    return orders.upsert(session.id, {
      payment_status: session.payment_status,
      status: session.status,
      amount_total: session.amount_total,
      email: session.customer_details?.email || session.customer_email || null,
      webhook: Boolean(existing?.webhook) || webhook,
    });
  }

  let lineItems = [];
  try {
    const listed = await stripe.checkout.sessions.listLineItems(session.id, {
      limit: 20,
    });
    lineItems = listed.data.map((item) => ({
      name: item.description,
      description: item.description,
      quantity: item.quantity,
      amount: item.amount_total,
    }));
  } catch (error) {
    console.warn("Could not list checkout line items:", error.message);
  }

  const email = session.customer_details?.email || session.customer_email;
  let emailSent = Boolean(existing?.emailSent);

  if (email && !emailSent) {
    try {
      const result = await sendOrderConfirmation({
        to: email,
        amountTotal: session.amount_total || 0,
        lineItems,
        sessionId: session.id,
      });
      emailSent = result.sent || result.saved;
    } catch (error) {
      console.warn("Order email failed:", error.message);
    }
  }

  return orders.upsert(session.id, {
    payment_status: "paid",
    status: session.status,
    amount_total: session.amount_total,
    email: email || null,
    lineItems,
    webhook: Boolean(existing?.webhook) || webhook,
    emailSent,
    confirmedAt: existing?.confirmedAt || new Date().toISOString(),
  });
}

app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();

    if (!secret) {
      return res.status(500).json({
        error: "STRIPE_WEBHOOK_SECRET is missing. Run stripe listen and add the whsec_ key.",
      });
    }

    try {
      const stripe = getStripe();
      const event = stripe.webhooks.constructEvent(req.body, signature, secret);

      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        await confirmPaidSession(event.data.object, stripe, { webhook: true });
      }

      res.json({ received: true });
    } catch (error) {
      console.error("Webhook error:", error.message);
      res.status(400).json({ error: error.message });
    }
  }
);

app.use(express.json());

app.use((req, res, next) => {
  const blocked = new Set([
    "/server.js",
    "/products.js",
    "/mail.js",
    "/tax.js",
    "/orders.js",
    "/package.json",
    "/package-lock.json",
  ]);
  if (blocked.has(req.path) || req.path.startsWith("/data")) {
    return res.status(404).end();
  }
  next();
});

app.use(express.static(__dirname));

app.get("/api/products", (_req, res) => {
  res.json(catalog);
});

app.post("/api/tax-preview", async (req, res) => {
  try {
    let stripe = null;
    try {
      stripe = getStripe();
    } catch {
      stripe = null;
    }
    const lineItems = resolveCart(req.body.items);
    const tax = await previewTax({
      stripe,
      lineItems,
      address: req.body.address,
    });
    res.json({
      subtotalCents: tax.subtotalCents,
      taxCents: tax.taxCents,
      totalCents: tax.totalCents,
      source: tax.source,
      rate: tax.rate,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const stripe = getStripe();
    const lineItems = resolveCart(req.body.items);
    const address = normalizeAddress(req.body.address);
    const email = String(req.body.email || "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Please enter a valid email address.");
    }

    const tax = await previewTax({ stripe, lineItems, address });
    const session = await createCheckoutSession(stripe, {
      lineItems,
      tax,
      email: email || undefined,
      origin: originFrom(req),
    });

    res.json({ url: session.url });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/contact", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const orderId = String(req.body?.orderId || "").trim();
    const message = String(req.body?.message || "").trim();

    if (name.length < 2) {
      throw new Error("Please enter your name.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Please enter a valid email address.");
    }
    if (message.length < 10) {
      throw new Error("Please include a short message (at least 10 characters).");
    }
    if (message.length > 2000) {
      throw new Error("Message is too long.");
    }

    const result = await sendContactEmail({ name, email, orderId, message });
    const note = result.sent
      ? "Message emailed to the studio."
      : "Message saved. Add RESEND_API_KEY and CONTACT_TO_EMAIL to send email.";
    res.json({ ok: true, sent: result.sent, message: note });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/checkout-session/:id", async (req, res) => {
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    const stored = orders.get(session.id);

    if (session.payment_status === "paid" && !stored?.emailSent) {
      await confirmPaidSession(session, stripe, { webhook: false });
    }

    const confirmed = orders.get(session.id);
    res.json({
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      webhook_confirmed: Boolean(confirmed?.webhook && confirmed.payment_status === "paid"),
      email_sent: Boolean(confirmed?.emailSent),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  const key = stripeSecretKey();
  const kind = key.startsWith("sk_test_") || key.startsWith("rk_test_")
    ? "test"
    : key.startsWith("sk_live_") || key.startsWith("rk_live_")
      ? "live"
      : "missing";
  console.log(`Order summary running at http://localhost:${PORT}`);
  console.log(`Stripe key: ${kind}`);
  console.log(
    `Webhooks: ${process.env.STRIPE_WEBHOOK_SECRET ? "secret set" : "missing STRIPE_WEBHOOK_SECRET"}`
  );
  console.log(
    `Email: ${process.env.RESEND_API_KEY ? "Resend configured" : "outbox only (set RESEND_API_KEY)"}`
  );
});
