const STATE_RATES = {
  AL: 0.04,
  AK: 0,
  AZ: 0.056,
  AR: 0.065,
  CA: 0.0725,
  CO: 0.029,
  CT: 0.0635,
  DE: 0,
  FL: 0.06,
  GA: 0.04,
  HI: 0.04,
  ID: 0.06,
  IL: 0.0625,
  IN: 0.07,
  IA: 0.06,
  KS: 0.065,
  KY: 0.06,
  LA: 0.0445,
  ME: 0.055,
  MD: 0.06,
  MA: 0.0625,
  MI: 0.06,
  MN: 0.06875,
  MS: 0.07,
  MO: 0.04225,
  MT: 0,
  NE: 0.055,
  NV: 0.0685,
  NH: 0,
  NJ: 0.06625,
  NM: 0.04875,
  NY: 0.08,
  NC: 0.0475,
  ND: 0.05,
  OH: 0.0575,
  OK: 0.045,
  OR: 0,
  PA: 0.06,
  RI: 0.07,
  SC: 0.06,
  SD: 0.045,
  TN: 0.07,
  TX: 0.0625,
  UT: 0.0485,
  VT: 0.06,
  VA: 0.053,
  WA: 0.065,
  WV: 0.06,
  WI: 0.05,
  WY: 0.04,
  DC: 0.06,
};

function dollarsToCents(amount) {
  return Math.round(amount * 100);
}

function subtotalCents(lineItems) {
  return lineItems.reduce(
    (sum, item) => sum + dollarsToCents(item.price) * item.quantity,
    0
  );
}

function normalizeAddress(address = {}) {
  return {
    country: String(address.country || "US").toUpperCase().trim() || "US",
    state: String(address.state || "").toUpperCase().trim(),
    postal_code: String(address.postal_code || address.zip || "").trim(),
    line1: String(address.line1 || "").trim(),
    city: String(address.city || "").trim(),
  };
}

function addressRateTax(lineItems, address) {
  const subtotal = subtotalCents(lineItems);
  const addr = normalizeAddress(address);
  const rate = addr.country === "US" ? STATE_RATES[addr.state] ?? 0 : 0;
  const taxCents = Math.round(subtotal * rate);
  return {
    subtotalCents: subtotal,
    taxCents,
    totalCents: subtotal + taxCents,
    source: "address",
    automaticTax: false,
    rate,
    address: addr,
  };
}

async function previewTax({ stripe, lineItems, address }) {
  const fallback = addressRateTax(lineItems, address);
  const addr = fallback.address;

  if (!stripe || !addr.country) {
    return fallback;
  }

  const taxAddress = {
    country: addr.country,
    ...(addr.postal_code ? { postal_code: addr.postal_code } : {}),
    ...(addr.state ? { state: addr.state } : {}),
    ...(addr.line1 ? { line1: addr.line1 } : {}),
    ...(addr.city ? { city: addr.city } : {}),
  };

  try {
    const calculation = await stripe.tax.calculations.create({
      currency: "usd",
      line_items: lineItems.map((item) => ({
        amount: dollarsToCents(item.price) * item.quantity,
        reference: String(item.id),
        tax_behavior: "exclusive",
      })),
      customer_details: {
        address: taxAddress,
        address_source: "shipping",
      },
    });

    return {
      subtotalCents: fallback.subtotalCents,
      taxCents: calculation.tax_amount_exclusive,
      totalCents: calculation.amount_total,
      source: "stripe",
      automaticTax: true,
      rate: fallback.subtotalCents
        ? calculation.tax_amount_exclusive / fallback.subtotalCents
        : 0,
      address: addr,
    };
  } catch (error) {
    console.warn("Stripe Tax preview failed, using address rates:", error.message);
    return fallback;
  }
}

module.exports = {
  dollarsToCents,
  normalizeAddress,
  previewTax,
  subtotalCents,
};
