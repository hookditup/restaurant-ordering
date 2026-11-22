// Card processors other than Stripe. Each restaurant picks one in the admin (Card payments tab);
// Stripe stays the default and lives in index.ts. Every processor does the same jobs:
//   test(ctx)                 check the keys work; returns a short description
//   checkout(ctx, p)          start a hosted payment page -> { session, ref?, redirect } or { session, post: { url, fields } }
//   hook(ctx, raw, headers)   check a webhook really came from the processor -> { session?, txn?, approved? } or null
//   confirm(ctx, pay)         ask the processor whether a payment went through -> { paid, cents, txn } or null (can't tell)
//   refund(ctx, r)            give money back -> { id }
//   cancel(ctx, pay)          optional: stop an expired payment page from taking money
// ctx = { settings, env, key, hook_key, http, hook_url }, http(method, url, { headers, body }) -> { ok, status, text }.
// The webhook only tells us *which* payment to look at. Where the processor lets us, the
// payment itself is then read back from its API with the restaurant's own keys.

export class PayError extends Error {}

const dollars = (c) => (c / 100).toFixed(2);
const cents = (v) => Math.round(Number(v) * 100);
const parse = (t) => { try { return JSON.parse(String(t || '').replace(/^﻿/, '')); } catch { return {}; } };
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
async function hmac(hash, key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
function same(a, b) {
  a = String(a); b = String(b);
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const header = (h, name) => (typeof h?.get === 'function' ? h.get(name) : h?.[name] ?? h?.[name.toLowerCase()]) || '';

async function call(ctx, method, url, body, headers) {
  const r = await ctx.http(method, url, { headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = parse(r.text);
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) throw new PayError(`${r.status}: The key was not accepted. Check it belongs to this account, and that Live or Sandbox matches the key.`);
    if (r.status === 404) throw new PayError('404: Not found. Check the ID, and that Live or Sandbox matches.');
    const msg = j.message || j.errors?.[0]?.detail || j.errors?.[0]?.code || j.error?.message || j.error || `HTTP ${r.status}`;
    throw new PayError(`${r.status}: ${String(msg).slice(0, 200)}`);
  }
  return j;
}

// ---------- Authorize.net (Accept Hosted) ----------
// https://developer.authorize.net/api/reference/features/accept-hosted.html
// Keys: API Login ID (setting), Transaction Key, Signature Key (webhooks). Element order matters in its JSON API.
const anetApi = (ctx) => (ctx.env === 'sandbox' ? 'https://apitest.authorize.net/xml/v1/request.api' : 'https://api.authorize.net/xml/v1/request.api');
const anetForm = (ctx) => (ctx.env === 'sandbox' ? 'https://test.authorize.net/payment/payment' : 'https://accept.authorize.net/payment/payment');
const PAID_ANET = ['capturedPendingSettlement', 'settledSuccessfully'];
async function anet(ctx, name, body) {
  const j = await call(ctx, 'POST', anetApi(ctx), { [name]: { merchantAuthentication: { name: ctx.settings.api_login_id, transactionKey: ctx.key }, ...body } });
  if (j.messages?.resultCode !== 'Ok') {
    const m = j.transactionResponse?.errors?.[0]?.errorText || j.messages?.message?.[0]?.text || 'Authorize.net said no.';
    if (/authentication failed|E00007/i.test(`${m} ${j.messages?.message?.[0]?.code}`)) throw new PayError('Authorize.net did not accept the API Login ID and Transaction Key. Check them, and that Live or Sandbox matches.');
    throw new PayError(`Authorize.net: ${m}`);
  }
  return j;
}
export const authorizenet = {
  label: 'Authorize.net',
  check(s, key) {
    if (!/^[A-Za-z0-9]{6,25}$/.test(s.api_login_id || '')) throw new PayError('Enter the Authorize.net API Login ID (Account > Settings > API Credentials and Keys).');
    if (!key) throw new PayError('Add the Authorize.net Transaction Key.');
  },
  async test(ctx) {
    authorizenet.check(ctx.settings, ctx.key);
    await anet(ctx, 'authenticateTestRequest', {});
    return `Connected to Authorize.net${ctx.env === 'sandbox' ? ' (sandbox)' : ''}.${ctx.hook_key ? '' : ' Add the Signature Key so payments confirm right away.'}`;
  },
  async checkout(ctx, p) {
    authorizenet.check(ctx.settings, ctx.key);
    const invoice = p.ref.replace(/-/g, '').slice(0, 20);
    const set = (settingName, v) => ({ settingName, settingValue: JSON.stringify(v) });
    const j = await anet(ctx, 'getHostedPaymentPageRequest', {
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: dollars(p.cents),
        order: { invoiceNumber: invoice, description: p.name.slice(0, 255) },
        customer: { email: p.email },
        billTo: { firstName: (p.first_name || '').slice(0, 50), lastName: (p.last_name || '').slice(0, 50) },
      },
      hostedPaymentSettings: { setting: [
        set('hostedPaymentReturnOptions', { showReceipt: false, url: p.success_url, urlText: 'Continue', cancelUrl: p.cancel_url, cancelUrlText: 'Cancel' }),
        set('hostedPaymentButtonOptions', { text: 'Pay' }),
        set('hostedPaymentPaymentOptions', { cardCodeRequired: true, showCreditCard: true, showBankAccount: false }),
        set('hostedPaymentOrderOptions', { show: true }),
      ] },
    });
    return { session: invoice, post: { url: anetForm(ctx), fields: { token: j.token } } };
  },
  // X-ANET-Signature: "sha512=" + HMAC-SHA512(Signature Key, body) in hex.
  async hook(ctx, raw, headers) {
    if (!ctx.hook_key) return null;
    const got = header(headers, 'x-anet-signature').replace(/^sha512=/i, '').toLowerCase();
    if (!same(hex(await hmac('SHA-512', ctx.hook_key, raw)), got)) return null;
    const ev = parse(raw);
    if (!/^net\.authorize\.payment\.(authcapture|capture)\.created$/.test(ev.eventType || '')) return { ignore: true };
    const txn = String(ev.payload?.id || '');
    if (!txn) return { ignore: true };
    // The notice only carries the transaction; its invoice number says which order it paid for.
    const t = (await anet(ctx, 'getTransactionDetailsRequest', { transId: txn })).transaction;
    return { session: t?.order?.invoiceNumber || '', txn };
  },
  async confirm(ctx, pay) {
    let t;
    if (pay.txn) {
      t = (await anet(ctx, 'getTransactionDetailsRequest', { transId: pay.txn })).transaction;
      if (!t || t.order?.invoiceNumber !== pay.session) return { paid: false };
    } else {
      // No transaction ID yet (no webhook): look for the invoice among today's unsettled payments.
      const j = await anet(ctx, 'getUnsettledTransactionListRequest', { sorting: { orderBy: 'submitTimeUTC', orderDescending: true }, paging: { limit: 100, offset: 1 } });
      t = (j.transactions || []).find((x) => x.invoiceNumber === pay.session && PAID_ANET.includes(x.transactionStatus));
      if (!t) return { paid: false };
    }
    const amount = t.authAmount ?? t.settleAmount;
    return { paid: PAID_ANET.includes(t.transactionStatus), cents: cents(amount), txn: String(t.transId) };
  },
  // Before the nightly settlement a payment can only be voided in full; after it, refunded (needs the card's last 4).
  async refund(ctx, r) {
    const t = (await anet(ctx, 'getTransactionDetailsRequest', { transId: r.txn })).transaction;
    if (t?.transactionStatus === 'capturedPendingSettlement') {
      if (r.cents !== r.charged_cents || r.refunded_cents) throw new PayError("Authorize.net can only give back the full amount until tonight's settlement. Refund the full amount now, or a part tomorrow.");
      const j = await anet(ctx, 'createTransactionRequest', { transactionRequest: { transactionType: 'voidTransaction', refTransId: r.txn } });
      return { id: String(j.transactionResponse?.transId || r.txn) };
    }
    if (t?.transactionStatus !== 'settledSuccessfully') throw new PayError(`Authorize.net can't refund this payment (${t?.transactionStatus || 'not found'}).`);
    const card = t.payment?.creditCard;
    if (!card?.cardNumber) throw new PayError('Authorize.net did not return the card for this payment. Refund it in the Authorize.net account.');
    const j = await anet(ctx, 'createTransactionRequest', { transactionRequest: {
      transactionType: 'refundTransaction', amount: dollars(r.cents),
      payment: { creditCard: { cardNumber: card.cardNumber.slice(-4), expirationDate: 'XXXX' } }, refTransId: r.txn,
    } });
    if (j.transactionResponse?.responseCode !== '1') throw new PayError(`Authorize.net: ${j.transactionResponse?.errors?.[0]?.errorText || 'refund declined'}`);
    return { id: String(j.transactionResponse.transId) };
  },
};

// ---------- Clover (Ecommerce Hosted Checkout) ----------
// https://docs.clover.com/docs/hosted-checkout-api — money goes to the restaurant's Clover merchant account.
// Keys: Merchant ID (setting), Ecommerce private key, webhook Signing Secret (Hosted Checkout settings).
const cloverBase = (ctx) => (ctx.env === 'sandbox' ? 'https://apisandbox.dev.clover.com' : 'https://api.clover.com');
const cloverEcom = (ctx) => (ctx.env === 'sandbox' ? 'https://scl-sandbox.dev.clover.com' : 'https://scl.clover.com');
const lower = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));
export const clover = {
  label: 'Clover',
  check(s, key) {
    if (!/^[A-Z0-9]{10,16}$/i.test(s.merchant_id || '')) throw new PayError('Enter the Clover Merchant ID (13 letters and numbers).');
    if (!key) throw new PayError('Add the Clover Ecommerce private key (Settings > Ecommerce > API Tokens).');
  },
  session(ctx, p) {
    return call(ctx, 'POST', `${cloverBase(ctx)}/invoicingcheckoutservice/v1/checkouts`, {
      customer: { email: p.email },
      shoppingCart: { lineItems: [{ name: p.name.slice(0, 127), price: p.cents, unitQty: 1 }] },
      redirectUrls: { success: p.success_url, failure: p.cancel_url },
    }, { Authorization: `Bearer ${ctx.key}`, 'X-Clover-Merchant-Id': ctx.settings.merchant_id });
  },
  async test(ctx) {
    clover.check(ctx.settings, ctx.key);
    const j = await clover.session(ctx, { email: 'test@example.com', name: 'Connection test', cents: 100, success_url: 'https://example.com/', cancel_url: 'https://example.com/' });
    if (!j.href) throw new PayError('Clover did not return a checkout page. Turn on Hosted Checkout in Clover (Settings > Ecommerce).');
    return `Connected to Clover${ctx.env === 'sandbox' ? ' (sandbox)' : ''}. Nothing was charged.${ctx.hook_key ? '' : ' Add the webhook Signing Secret, or payments will not be confirmed.'}`;
  },
  async checkout(ctx, p) {
    clover.check(ctx.settings, ctx.key);
    const j = await clover.session(ctx, p);
    if (!j.href || !j.checkoutSessionId) throw new PayError('Clover did not return a checkout page.');
    return { session: j.checkoutSessionId, redirect: j.href };
  },
  // Clover-Signature: t=<time>,v1=<HMAC-SHA256(secret, "<time>.<body>") hex>. Body: status, type, id (payment), data (checkout session).
  async hook(ctx, raw, headers) {
    if (!ctx.hook_key) return null;
    const parts = Object.fromEntries(header(headers, 'clover-signature').split(',').map((x) => x.trim().split('=')));
    if (!parts.t || !parts.v1 || !same(hex(await hmac('SHA-256', ctx.hook_key, `${parts.t}.${raw}`)), parts.v1.toLowerCase())) return null;
    const ev = lower(parse(raw));
    if (ev.merchantid && ev.merchantid !== ctx.settings.merchant_id) return null;
    if (String(ev.type).toUpperCase() !== 'PAYMENT') return { ignore: true };
    return { session: String(ev.data || ''), txn: String(ev.id || ''), approved: String(ev.status).toUpperCase() === 'APPROVED' };
  },
  confirm(_ctx, _pay) { return null; }, // Clover's signed webhook is the confirmation.
  async refund(ctx, r) {
    const j = await call(ctx, 'POST', `${cloverEcom(ctx)}/v1/refunds`, { charge: r.txn, amount: r.cents }, { Authorization: `Bearer ${ctx.key}` });
    if (!j.id) throw new PayError('Clover did not confirm the refund. Check the Clover dashboard.');
    return { id: j.id };
  },
};

// ---------- Square (payment links) ----------
// https://developer.squareup.com/reference/square/checkout-api/create-payment-link — money goes to the restaurant's Square account.
// Keys: Location ID (setting), access token, webhook signature key.
const squareBase = (ctx) => (ctx.env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com');
const sq = (ctx, method, path, body) => call(ctx, method, `${squareBase(ctx)}${path}`, body, { Authorization: `Bearer ${ctx.key}` });
export const square = {
  label: 'Square',
  check(s, key) {
    if (!/^[A-Z0-9]{6,40}$/i.test(s.location_id || '')) throw new PayError('Enter the Square Location ID (Square Dashboard > Account & Settings > Locations).');
    if (!key) throw new PayError('Add the Square access token.');
  },
  async test(ctx) {
    square.check(ctx.settings, ctx.key);
    const j = await sq(ctx, 'GET', `/v2/locations/${ctx.settings.location_id}`);
    return `Connected to ${j.location?.name || 'Square'}${ctx.env === 'sandbox' ? ' (sandbox)' : ''}.${ctx.hook_key ? '' : ' Add the webhook signature key so payments confirm right away.'}`;
  },
  async checkout(ctx, p) {
    square.check(ctx.settings, ctx.key);
    const j = await sq(ctx, 'POST', '/v2/online-checkout/payment-links', {
      idempotency_key: p.ref,
      quick_pay: { name: p.name.slice(0, 255), price_money: { amount: p.cents, currency: 'USD' }, location_id: ctx.settings.location_id },
      checkout_options: { redirect_url: p.success_url, ask_for_shipping_address: false },
      pre_populated_data: { buyer_email: p.email },
      payment_note: p.name.slice(0, 500),
    });
    const l = j.payment_link;
    if (!l?.url || !l.order_id) throw new PayError('Square did not return a payment page.');
    return { session: l.order_id, ref: l.id, redirect: l.url };
  },
  // x-square-hmacsha256-signature = base64(HMAC-SHA256(key, notification URL + body)), as in Square's WebhooksHelper.
  async hook(ctx, raw, headers) {
    if (!ctx.hook_key || !ctx.hook_url) return null;
    if (!same(b64(await hmac('SHA-256', ctx.hook_key, ctx.hook_url + raw)), header(headers, 'x-square-hmacsha256-signature'))) return null;
    const ev = parse(raw), pay = ev.data?.object?.payment;
    if (!/^payment\.(created|updated)$/.test(ev.type || '') || !pay?.order_id) return { ignore: true };
    return { session: String(pay.order_id), txn: String(pay.id || '') };
  },
  async confirm(ctx, pay) {
    const o = (await sq(ctx, 'GET', `/v2/orders/${encodeURIComponent(pay.session)}`)).order;
    if (!o || o.location_id !== ctx.settings.location_id) return { paid: false };
    let total = 0, txn = '';
    for (const t of o.tenders || []) {
      if (!t.payment_id) continue;
      const p = (await sq(ctx, 'GET', `/v2/payments/${encodeURIComponent(t.payment_id)}`)).payment;
      if (p?.status === 'COMPLETED') { total += p.amount_money?.amount || 0; txn ||= p.id; }
    }
    return { paid: total > 0, cents: total, txn };
  },
  async refund(ctx, r) {
    const j = await sq(ctx, 'POST', '/v2/refunds', { idempotency_key: r.key.slice(0, 45), payment_id: r.txn, amount_money: { amount: r.cents, currency: 'USD' }, reason: (r.reason || 'Refund').slice(0, 192) });
    if (!j.refund?.id) throw new PayError('Square did not confirm the refund.');
    return { id: j.refund.id };
  },
  // An expired order's payment link is deleted so it can't be paid later.
  async cancel(ctx, pay) {
    if (pay.ref) await sq(ctx, 'DELETE', `/v2/online-checkout/payment-links/${encodeURIComponent(pay.ref)}`).catch(() => null);
  },
};

export const PROCESSORS = { authorizenet, clover, square };
