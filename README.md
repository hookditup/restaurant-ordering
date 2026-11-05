# Restaurant Ordering

Reusable online ordering for independent restaurants. One database serves many restaurants, and any website can add it with a few lines. Nothing here runs on Vercel, so it uses no Fluid compute.

## What's here

- `supabase/migrations/`: database, security rules, menu importer
- `supabase/functions/ordering/`: API. `core.js` holds the pricing and hours rules; `index.ts` handles checkout, Stripe, the kitchen and emails
- `web/`: guest menu and cart (`ordering.js`), order tracking (`order-status.js`), gift card and rewards pages (`guest-tools.js`), staff screen (`kitchen.js`)
- `seed/lupitas/`: Lupita's Valley menu and the script that builds it
- `sites/lupitas-valley/`: built test site, deployed as static files
- `test/`: `npm test` for the rules, plus `e2e-api.mjs`, `e2e-programs.mjs`, `e2e-admin.mjs` and the two `-browser.cjs` scripts for full runs against a test restaurant

## Add it to a website

```html
<link rel="stylesheet" href="/assets/ordering/ordering.css">
<script>window.RO = { url: 'https://PROJECT.supabase.co', key: 'PUBLISHABLE_KEY', restaurant: 'restaurant-slug' };</script>
<div id="ro-menu"></div>
<script src="/assets/ordering/ordering.js" defer></script>
```

Add `/order/` with `<div id="ro-status">` and `order-status.js`, `/kitchen/` with `<main id="ro-kitchen">` and `kitchen.js`, and `/admin/` with `<main id="ro-admin">` and `admin.js`.

Add `<div id="ro-gift"></div>` and `<div id="ro-rewards"></div>` with `guest-tools.js` for the gift card and rewards pages.

## Forms, reservations, rewards, gift cards

- **Forms:** POST `{ action: 'form', restaurant, form, data }`. Every form is saved, shown in the staff Messages tab and emailed to `restaurants.forms_email`.
- **Reservations:** the `reservation` form creates a request. Staff confirm or decline it in the Reservations tab, and the guest is emailed.
- **Rewards:** the `rewards` form creates a member and shows their code once. Picked-up orders earn points when the phone matches. Rules are `rewards_points_per_dollar`, `rewards_redeem_points` and `rewards_redeem_cents`. Rewards discounts lower taxable sales.
- **Gift cards:** bought online with Stripe, or sold in the staff screen by a manager. They work at checkout and in store. Limits are `gift_min_cents` and `gift_max_cents`.
- Cancelling an order, or a Stripe session expiring, returns its points and gift card balance.
- Guests and staff reach these tables only through the edge function.

## Owner admin

`/admin/` is for `manager` staff logins. It has sales and order statistics, an order list with CSV download, a menu editor with photo uploads, add-on prices, Popular and pairing settings, and restaurant settings. Every admin function checks the login in the database.

## Popular and pairings

The menu opens with the dishes in the most picked-up orders over `popular_days`, once there are `popular_min_orders` orders. Until then it shows dishes marked Featured. Pairings appear in the item popup and cart, and apply to the lunch and dinner versions of a dish.

## Delivery

With `DOORDASH_DEVELOPER_ID`, `DOORDASH_KEY_ID` and `DOORDASH_SIGNING_SECRET` set, checkout gets a DoorDash Drive quote, and the kitchen's Accept requests the driver. Without keys, test mode uses a simulated $5.99 fee and driver. A live restaurant without keys shows a link to `doordash_store_url` instead. Delivery fees are not taxed; confirm that with the restaurant's accountant.

## Add a restaurant

1. Build a JSON payload like `seed/lupitas/lupitas-seed.json`.
2. Run `select public.import_menu('<payload>'::jsonb);` as the service role. This replaces that restaurant's whole menu, including pairings, so run it before orders exist or on a new slug.
3. Create a staff login in Supabase Auth and add it to `public.staff`.

A lunch and dinner version of a menu are two categories with different `hours`. Guests only see what's available at their pickup time, and the server enforces it.

## Test mode

Restaurants start in test mode. With no `STRIPE_SECRET_KEY`, test orders are marked test-paid and no card is involved. A restaurant with `test_mode = false` refuses orders until Stripe is set up.

## Before going live

1. Confirm the sales tax rate (`restaurants.tax_rate_bps`).
2. Set function secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, and the three DoorDash keys.
3. Connect the restaurant's Stripe account (`restaurants.stripe_account_id`) and point a webhook at `/functions/v1/ordering?hook=stripe` for `checkout.session.completed` and `checkout.session.expired`.
4. Create the real kitchen login and set `restaurants.alert_email` and `restaurants.forms_email`.
5. Set `test_mode = false`, then place and refund one real order.
6. Use a Supabase plan that doesn't pause projects.
