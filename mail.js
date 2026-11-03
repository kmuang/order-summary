const fs = require("fs");
const path = require("path");
const { Resend } = require("resend");

const outboxFile = path.join(__dirname, "data", "outbox.json");

function fromAddress() {
  return process.env.EMAIL_FROM || "Studio Shop <onboarding@resend.dev>";
}

function contactTo() {
  return (process.env.CONTACT_TO_EMAIL || "").trim();
}

function readOutbox() {
  try {
    return JSON.parse(fs.readFileSync(outboxFile, "utf8"));
  } catch {
    return [];
  }
}

function appendOutbox(entry) {
  fs.mkdirSync(path.dirname(outboxFile), { recursive: true });
  const rows = readOutbox();
  rows.push(entry);
  fs.writeFileSync(outboxFile, JSON.stringify(rows, null, 2));
}

function wrap(title, body) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;background:#f3eee6;font-family:Georgia,serif;color:#1c1917;">
  <div style="max-width:560px;margin:24px auto;padding:28px;background:#fffdf8;border-radius:24px;">
    <p style="letter-spacing:.2em;text-transform:uppercase;font-size:11px;color:#78716c;">Studio Shop</p>
    <h1 style="font-weight:400;font-size:28px;margin:8px 0 16px;">${title}</h1>
    ${body}
  </div>
</body>
</html>`;
}

async function sendEmail({ to, subject, html, replyTo }) {
  const record = {
    to,
    subject,
    html,
    replyTo: replyTo || null,
    at: new Date().toISOString(),
    sent: false,
  };

  const key = (process.env.RESEND_API_KEY || "").trim();
  if (key) {
    const resend = new Resend(key);
    const { error } = await resend.emails.send({
      from: fromAddress(),
      to,
      subject,
      html,
      replyTo,
    });
    if (error) {
      throw new Error(error.message);
    }
    record.sent = true;
  }

  appendOutbox(record);
  return record;
}

async function sendContactEmail({ name, email, orderId, message }) {
  const to = contactTo();
  if (!to) {
    appendOutbox({
      to: null,
      subject: `Contact from ${name}`,
      html: message,
      fromName: name,
      fromEmail: email,
      orderId,
      at: new Date().toISOString(),
      sent: false,
      reason: "CONTACT_TO_EMAIL is not set",
    });
    return { sent: false, saved: true };
  }

  const html = wrap(
    "New customer message",
    `<p style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#44403c;">
      <strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) wrote:
    </p>
    <p style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;white-space:pre-wrap;color:#44403c;">${escapeHtml(message)}</p>
    ${orderId ? `<p style="font-family:system-ui,sans-serif;font-size:13px;color:#78716c;">Order ID: ${escapeHtml(orderId)}</p>` : ""}`
  );

  const result = await sendEmail({
    to,
    subject: `Studio Shop contact from ${name}`,
    html,
    replyTo: email,
  });
  return { sent: result.sent, saved: true };
}

async function sendOrderConfirmation({ to, amountTotal, lineItems, sessionId }) {
  if (!to) return { sent: false, saved: false };

  const rows = (lineItems || [])
    .map(
      (item) =>
        `<tr>
          <td style="padding:8px 0;border-bottom:1px solid #e7e5e4;font-family:system-ui,sans-serif;font-size:14px;">${escapeHtml(item.description || item.name)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #e7e5e4;text-align:right;font-family:system-ui,sans-serif;font-size:14px;">×${item.quantity}</td>
        </tr>`
    )
    .join("");

  const html = wrap(
    "Your order is confirmed",
    `<p style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6;color:#44403c;">
      Thank you for shopping with Studio Shop. We received your payment.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">${rows}</table>
    <p style="font-family:Georgia,serif;font-size:28px;margin:12px 0;">$${(amountTotal / 100).toFixed(2)}</p>
    <p style="font-family:system-ui,sans-serif;font-size:12px;color:#78716c;">Reference ${escapeHtml(sessionId)}</p>`
  );

  const result = await sendEmail({
    to,
    subject: "Your Studio Shop order confirmation",
    html,
  });
  return { sent: result.sent, saved: true };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  sendContactEmail,
  sendOrderConfirmation,
};
