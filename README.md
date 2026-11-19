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
| `STRIPE_SECRET_KEY` | From Stripe, Developers, API keys. Starts with `sk_`. |
| `STRIPE_WEBHOOK_SECRET` | From the Stripe webhook you create. Starts with `whsec_`. |
| `RESEND_API_KEY` | Optional. Turns on password reset emails. From resend.com. |
| `EMAIL_FROM` | Optional. The sender, like `Cutline <support@yourdomain.com>`. |

## Stripe webhook

Point it at `https://yourdomain.com/api/stripe/webhook` and send these events:
`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`.

## Run it locally

```
npm install
npx wrangler d1 migrations apply cutline-db --local
npx wrangler dev
```
