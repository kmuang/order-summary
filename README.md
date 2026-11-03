# order-summary

Order summary with Stripe Checkout.

## Setup

1. Copy `.env.example` to `.env`.
2. Add your [Stripe secret key](https://dashboard.stripe.com/apikeys) (`sk_test_...` for test mode).
3. Install and start the server:

```bash
npm install
npm start
```

Open [http://localhost:4242](http://localhost:4242), adjust quantities, and click **Pay with Stripe**.

Use Stripe test cards such as `4242 4242 4242 4242` with any future expiry and CVC.
