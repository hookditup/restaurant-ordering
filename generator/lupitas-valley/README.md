# Lupita's Valley site generator

Source for `sites/lupitas-valley/`. Not yet a reusable theme: the name, menu, copy and colors are written into `build.py`.

Images, menu PDFs and the video are not stored here. Before building, copy `sites/lupitas-valley/img` into `site/img`,
and `sites/lupitas-valley/menus` and `video` into `assets/menus` and `assets/video`. Original photos came from Owner's CDN
via `fetch_assets.py` and `opt.py`. After a build, copy `site/` to `sites/lupitas-valley/`, keeping that folder's
`robots.txt` and the `headers` in `vercel.json`.

`site/` is the finished static website. Deploy that folder to Vercel, Netlify, or Cloudflare Pages.
`build.py` and `menu.txt` regenerate it: edit a price in `menu.txt`, run `python3 build.py`.

## Settings
Edit `site/assets/config.js` (and `src/config.js` so rebuilds keep it):
- `formEndpoint`: where all forms post as JSON. Forms show "please call us" until this is set.
- `reviewUrl`: Google "Ask for reviews" link from the Business Profile.
- `orderUrl`: online ordering link. Every "Call to order" button becomes "Order online".

## Before the domain moves
1. Connect forms and send one real test from each.
2. Set the Google review link.
3. Export customers, rewards balances, and gift card balances from Owner.
4. Have Lupita's confirm they hold rights to anything Owner created (hero video, drink images).
5. Approve the draft privacy, terms, and gift card wording.
6. Copy the Zoho MX, SPF, and Google verification records to the new DNS.
7. Point DNS at the new host, then test every page and form before cancelling Owner.

## QR codes
`site/qr/` has print-ready PNG and SVG codes for review, rewards, questions, and reservations.
They point to lupitasvalley.com paths, so they only work once the domain has moved.

## Old URLs
All current URLs are kept. These 301 (see `vercel.json` / `_redirects`): /tags/blt and /tags/delivery
to /menu, /heber-city to /, /gift-cards/check to /gift-cards, /contact to /page/contact-us,
/login and /account to /rewards.
