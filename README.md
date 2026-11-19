# Cutline

Cutline turns long videos into vertical clips with captions.

## How it's built

- `src/app.html` is the whole page.
- `src/index.js` is the server. It runs on Cloudflare Workers, serves the page, keeps accounts in a D1 database, and handles Stripe checkout.
- `migrations/` sets up the database tables.

Every push to `main` deploys automatically through Cloudflare.

## Secrets to set in Cloudflare

Worker, Settings, Variables and Secrets. Add each one as a Secret.

| Name | What it is |
| --- | --- |
| `ADMIN_EMAIL` | The email you sign up with. That account sees the Admin page. |
| `STRIPE_SECRET_KEY` | A Stripe restricted key (starts with `rk_`). Permissions: Customers, Products, Prices, Checkout Sessions and Customer portal set to Write, Subscriptions set to Read. |
| `STRIPE_WEBHOOK_SECRET` | From the Stripe webhook you create. Starts with `whsec_`. |
| `RESEND_API_KEY` | Optional. Turns on password reset emails. From resend.com. |
| `EMAIL_FROM` | Optional. The sender, like `Cutline <support@yourdomain.com>`. |

## Stripe webhook

Point it at `https://yourdomain.com/api/stripe/webhook`, use API version `2026-10-28.endive`, and send these events:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- `invoice.paid`, `invoice.payment_failed`
- `charge.refunded`, `charge.dispute.created`, `radar.early_fraud_warning.created`

Products and prices are created in Stripe automatically the first time someone checks out. Each one has a lookup key like `cutline_pro_monthly`, so don't delete them.

## Run it locally

```
npm install
npx wrangler d1 migrations apply cutline-db --local
npx wrangler dev
```
