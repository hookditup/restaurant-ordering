# Restaurant Ordering

Reusable online ordering for independent restaurants. One database serves many restaurants, and any website can add it with a few lines. Nothing here runs on Vercel, so it uses no Fluid compute.

## What's here

- `supabase/migrations/`: database, security rules, menu importer
- `supabase/functions/ordering/`: API. `core.js` holds the pricing and hours rules; `index.ts` handles checkout, Stripe, the kitchen and emails
- `web/`: guest menu and cart (`ordering.js`), order tracking (`order-status.js`), kitchen tablet screen (`kitchen.js`)
- `seed/lupitas/`: Lupita's Valley menu and the script that builds it
- `test/`: `npm test` for the rules, `e2e-api.mjs` and `e2e-browser.cjs` for full runs against a test restaurant

## Add it to a website

```html
<link rel="stylesheet" href="/assets/ordering/ordering.css">
<script>window.RO = { url: 'https://PROJECT.supabase.co', key: 'PUBLISHABLE_KEY', restaurant: 'restaurant-slug' };</script>
<div id="ro-menu"></div>
<script src="/assets/ordering/ordering.js" defer></script>
```

Add `/order/` with `<div id="ro-status">` and `order-status.js`, and `/kitchen/` with `<div id="ro-kitchen">` and `kitchen.js`.

## Add a restaurant

1. Build a JSON payload like `seed/lupitas/lupitas-seed.json`.
2. Run `select public.import_menu('<payload>'::jsonb);` as the service role. This replaces that restaurant's whole menu, so run it before orders exist or on a new slug.
3. Create a staff login in Supabase Auth and add it to `public.staff`.

A lunch and dinner version of a menu are two categories with different `hours`. Guests only see what's available at their pickup time, and the server enforces it.

## Test mode

Restaurants start in test mode. With no `STRIPE_SECRET_KEY`, test orders are marked test-paid and no card is involved. A restaurant with `test_mode = false` refuses orders until Stripe is set up.

## Before going live

1. Confirm the sales tax rate (`restaurants.tax_rate_bps`).
2. Set function secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`.
3. Connect the restaurant's Stripe account (`restaurants.stripe_account_id`) and point a webhook at `/functions/v1/ordering?hook=stripe` for `checkout.session.completed` and `checkout.session.expired`.
4. Create the real kitchen login and set `restaurants.alert_email`.
5. Set `test_mode = false`, then place and refund one real order.
6. Use a Supabase plan that doesn't pause projects.
