// Online ordering API. One function, several actions (POST JSON { action, ... }):
//   slots      guest: pickup times
//   quote      guest: price a cart on the server
//   checkout   guest: create the order and a Stripe Checkout page
//   status     guest: order progress by private token
//   kitchen    staff: accept | ready | complete | cancel an order
//   pause      staff: stop or resume taking orders
//   form       guest: website forms, reservation requests and rewards sign-ups
//   rewards_info, rewards_check, gift_buy, gift_view, gift_check   guest
//   staff      staff: reservations, messages, rewards and gift cards
//   ?hook=stripe  Stripe webhook
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, EMAIL_FROM,
//   DOORDASH_DEVELOPER_ID, DOORDASH_KEY_ID, DOORDASH_SIGNING_SECRET (DoorDash Drive),
//   ATTRIBUTION_URL + ATTRIBUTION_KEYS (marketing attribution; JSON map of restaurant slug -> API key).
// With no Stripe key, a restaurant in test mode marks orders as test-paid. Live mode never does.
import { addressLine, applyGift, cleanAddress, cleanCode, cleanGuest, makeCode, NEXT, normPhone, OrderError, pickupSlots, priceCart, totals, validPickup, validReservationDate } from './core.js';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_HOOK = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const RESEND = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('EMAIL_FROM') ?? '';
const DD_DEV = Deno.env.get('DOORDASH_DEVELOPER_ID') ?? '';
const DD_KEY = Deno.env.get('DOORDASH_KEY_ID') ?? '';
const DD_SECRET = Deno.env.get('DOORDASH_SIGNING_SECRET') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...svc, ...(init.headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`db ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const rpc = (fn: string, args: unknown) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const insert = (t: string, row: unknown) =>
  db(t, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
const patch = (t: string, q: string, row: unknown) =>
  db(`${t}?${q}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
const log = (order_id: string | null, source: string, event: string, data: unknown = {}) =>
  insert('order_events', { order_id, source, event, data }).catch(() => null);

// ---------- marketing attribution ----------
// The website's tracking script (window.HRA) sends where the guest came from. We keep it on the
// order or reservation, then report the sale to the attribution service once it is final.
// Reporting is best-effort: it never blocks or fails an order, and it is off until
// ATTRIBUTION_URL and a key for the restaurant are set.
function cleanAttribution(raw: any, req: Request) {
  if (!raw || typeof raw !== 'object') return null;
  const s = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const touch = (v: unknown) => {
    if (!v || typeof v !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
      if (/^[a-z_]{1,20}$/.test(k) && typeof x === 'string' && x) out[k] = x.slice(0, 500);
    }
    return Object.keys(out).length ? out : null;
  };
  return {
    visitorId: s(raw.visitorId, 64), firstTouch: touch(raw.firstTouch), lastTouch: touch(raw.lastTouch),
    gaClientId: s(raw.gaClientId, 100), fbc: s(raw.fbc, 500), fbp: s(raw.fbp, 200),
    clientIp: (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null,
    userAgent: s(req.headers.get('user-agent'), 500),
  };
}

// Read on every call so new secrets apply without a redeploy. ATTRIBUTION_KEYS is normally JSON
// ({"slug":"hra_..."}); a bare hra_ key is accepted for all restaurants. Stray characters from
// copy-paste (byte-order mark, curly quotes, surrounding quotes or spaces) are cleaned up.
function attrKeys(): Record<string, string> {
  let raw = (Deno.env.get('ATTRIBUTION_KEYS') ?? '').replace(/^\uFEFF/, '').replace(/[\u201C\u201D]/g, '"').trim();
  if (/^'.*'$/.test(raw)) raw = raw.slice(1, -1).trim();
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [String(k).trim(), String(x).trim()]));
    if (typeof v === 'string' && v.startsWith('hra_')) return { '*': v.trim() };
  } catch { /* not JSON */ }
  // Plain text: "slug: key" / "slug=key" lines, or a single bare key for every restaurant.
  const pairs = raw.split(/[\n,]+/).map((l) => l.match(/^\s*\{?\s*\"?([a-z0-9-]+)\"?\s*[:=]\s*\"?([^\"\s}]+)\"?\s*\}?\s*$/i)).filter(Boolean) as RegExpMatchArray[];
  if (pairs.length) return Object.fromEntries(pairs.map((m) => [m[1], m[2]]));
  return /\s/.test(raw) ? {} : { '*': raw };
}

async function reportConversion(slug: string, conv: Record<string, unknown>, attr: any, orderId: string | null) {
  const ATTR_URL = (Deno.env.get('ATTRIBUTION_URL') ?? '').trim().replace(/\/$/, '');
  if (!ATTR_URL) return;
  const keys = attrKeys();
  const key = keys[slug] || keys['*'];
  if (!key) {
    // Names only, never key values, so a setup mistake is visible in order_events.
    await log(orderId, 'attribution', 'skipped', { reason: 'no key for this restaurant', restaurant: slug, configured_for: Object.keys(keys), secret_length: (Deno.env.get('ATTRIBUTION_KEYS') ?? '').length, starts_with_brace: (Deno.env.get('ATTRIBUTION_KEYS') ?? '').trim().startsWith('{') });
    return;
  }
  const a = attr ?? {};
  const body = {
    restaurant: slug, ...conv,
    visitorId: a.visitorId ?? undefined, firstTouch: a.firstTouch ?? undefined, lastTouch: a.lastTouch ?? undefined,
    gaClientId: a.gaClientId ?? undefined, fbc: a.fbc ?? undefined, fbp: a.fbp ?? undefined,
    clientIp: a.clientIp ?? undefined, userAgent: a.userAgent ?? undefined,
  };
  try {
    const res = await fetch(`${ATTR_URL}/api/conversions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const out = await res.json().catch(() => ({}));
    await log(orderId, 'attribution', res.ok ? 'reported' : 'report_failed',
      res.ok ? { type: conv.type, campaign: out.campaignId ?? null, method: out.attributionMethod ?? null } : { status: res.status, error: out.error ?? null });
  } catch (e) {
    await log(orderId, 'attribution', 'report_failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

// Revenue credited to marketing: food and drink after discounts (no tax, tip, or fees).
const orderConversion = (o: any, status: string) => ({
  type: 'online_order', externalId: o.id, orderId: o.id, status,
  valueCents: Math.max(0, (o.subtotal_cents ?? 0) - (o.discount_cents ?? 0)),
  occurredAt: o.paid_at ?? o.created_at,
  customer: { phone: o.phone, email: o.email },
  extra: { order_no: o.order_no, total_cents: o.total_cents, fulfillment: o.fulfillment, test_mode: o.test_mode },
});

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const timeText = (iso: string, tz: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });

async function menuFor(slug: string) {
  const m = await rpc('get_menu', { p_slug: String(slug ?? '') });
  if (!m) throw new OrderError('Restaurant not found.');
  return m;
}

async function sendEmail(to: string | null, subject: string, text: string, orderId: string | null, replyTo?: string) {
  if (!to) return;
  if (!RESEND || !FROM) { await log(orderId, 'email', 'not_sent_no_provider', { subject }); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  }).catch(() => null);
  await log(orderId, 'email', r?.ok ? 'sent' : 'failed', { subject, status: r?.status });
}

// ---------- Stripe ----------
async function stripe(path: string, form: Record<string, string>, account?: string | null, idempotency?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${STRIPE}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (account) headers['Stripe-Account'] = account;
  if (idempotency) headers['Idempotency-Key'] = idempotency;
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers, body: new URLSearchParams(form) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`stripe ${r.status}: ${data?.error?.message ?? 'error'}`);
  return data;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function stripeSignatureOk(raw: string, header: string) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(STRIPE_HOOK), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${raw}`)));
  if (sig.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

// ---------- DoorDash Drive ----------
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function doordashToken() {
  const now = Math.floor(Date.now() / 1000), enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' })));
  const body = b64url(enc.encode(JSON.stringify({ aud: 'doordash', iss: DD_DEV, kid: DD_KEY, iat: now, exp: now + 300 })));
  const raw = Uint8Array.from(atob(DD_SECRET.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}
async function doordash(path: string, method: string, body?: unknown) {
  const r = await fetch(`https://openapi.doordash.com/drive/v2/${path}`, {
    method, headers: { Authorization: `Bearer ${await doordashToken()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`doordash ${r.status}: ${data?.message ?? data?.code ?? 'error'}`);
  return data;
}
const deliveryMode = (r: any) => {
  if (r.delivery_enabled && DD_DEV && DD_KEY && DD_SECRET) return 'drive';
  if (r.delivery_enabled && r.test_mode) return 'test';
  return r.doordash_store_url ? 'link' : 'off';
};
const toE164 = (p: string) => (normPhone(p) || p);

async function deliveryFee(r: any, address: any, phone: string, valueCents: number) {
  const mode = deliveryMode(r);
  if (mode === 'test') {
    if (!address.zip.startsWith('84')) throw new OrderError("We can't deliver to that address. Pickup is available.");
    const [s] = await db(`restaurants?select=delivery_test_fee_cents&id=eq.${r.id}`);
    return s.delivery_test_fee_cents;
  }
  if (mode !== 'drive') throw new OrderError('Delivery is not available right now.');
  try {
    const q = await doordash('quotes', 'POST', {
      external_delivery_id: `quote-${crypto.randomUUID()}`, pickup_address: r.address, pickup_business_name: r.name, pickup_phone_number: toE164(r.phone),
      dropoff_address: addressLine(address), dropoff_phone_number: phone, order_value: valueCents,
    });
    return Math.round(Number(q.fee) || 0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    throw new OrderError("We can't deliver to that address. Pickup is available.");
  }
}

// The kitchen's Accept sends the driver. A failed request leaves a warning, not a stuck order.
async function dispatchDelivery(o: any) {
  const [r] = await db(`restaurants?select=id,name,phone,address,test_mode,delivery_enabled,doordash_store_url&id=eq.${o.restaurant_id}`);
  if (deliveryMode(r) !== 'drive') return { delivery_id: `test-${o.order_no}`, delivery_status: 'test' };
  try {
    const d = await doordash('deliveries', 'POST', {
      external_delivery_id: o.id, pickup_address: r.address, pickup_business_name: r.name, pickup_phone_number: toE164(r.phone),
      pickup_instructions: `Order ${o.order_no}`, dropoff_address: addressLine(o.delivery_address), dropoff_phone_number: o.phone,
      dropoff_contact_given_name: o.first_name, dropoff_contact_family_name: o.last_name, dropoff_instructions: o.delivery_address.instructions || undefined,
      order_value: o.subtotal_cents, tip: o.tip_cents, dropoff_time: o.pickup_at,
    });
    return { delivery_id: o.id, delivery_status: d.delivery_status ?? 'created', delivery_tracking_url: d.tracking_url ?? null };
  } catch (e) {
    await log(o.id, 'doordash', 'dispatch_failed', { error: e instanceof Error ? e.message : String(e) });
    return { delivery_status: 'failed' };
  }
}

async function markPaid(o: any, payment_status: string, intent?: string) {
  const rows = await patch('orders', `id=eq.${o.id}&status=eq.awaiting_payment`, {
    status: 'new', payment_status, paid_at: new Date().toISOString(), stripe_payment_intent: intent ?? null,
  });
  if (!rows?.length) return;
  const [r] = await db(`restaurants?select=slug,name,timezone,alert_email,site_url&id=eq.${o.restaurant_id}`);
  await log(o.id, 'payment', payment_status);
  await reportConversion(r.slug, orderConversion(rows[0], 'completed'), rows[0].attribution, o.id);
  await sendEmail(o.email, `${r.name} order ${o.order_no} received`,
    `Thanks ${o.first_name}! We got your order. ${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}: ${timeText(o.pickup_at, r.timezone)}.\nTotal: ${money(o.total_cents)}${o.gift_applied_cents ? ` (${money(o.gift_applied_cents)} paid by gift card)` : ''}\n\nTrack it: ${r.site_url}/order/?t=${o.token}`, o.id);
  await sendEmail(r.alert_email, `New online order ${o.order_no}`, `${o.first_name} ${o.last_name}, ${o.fulfillment === 'delivery' ? 'delivery' : 'pickup'} ${timeText(o.pickup_at, r.timezone)}, ${money(o.total_cents)}.`, o.id);
}

async function handleStripeHook(req: Request) {
  const raw = await req.text();
  if (!STRIPE_HOOK || !(await stripeSignatureOk(raw, req.headers.get('stripe-signature') ?? ''))) return json({ ok: false }, 400);
  const ev = JSON.parse(raw);
  const fresh = await fetch(`${SB_URL}/rest/v1/stripe_events`, {
    method: 'POST', headers: { ...svc, Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify({ id: ev.id }),
  }).then((r) => r.json()).catch(() => []);
  if (!fresh?.length) return json({ ok: true, duplicate: true });
  const s = ev.data?.object ?? {};
  if (s.metadata?.gift_card_id) {
    const [card] = await db(`gift_cards?select=*&id=eq.${encodeURIComponent(s.metadata.gift_card_id)}`);
    if (card && ev.type === 'checkout.session.completed' && s.payment_status === 'paid') {
      if (s.amount_total !== card.initial_cents) { await log(null, 'stripe', 'gift_amount_mismatch', { card: card.id, paid: s.amount_total }); return json({ ok: true }); }
      await activateGift(card, s.payment_intent);
    }
    return json({ ok: true });
  }
  const orderId = s.metadata?.order_id;
  if (!orderId) return json({ ok: true });
  const [o] = await db(`orders?select=*&id=eq.${encodeURIComponent(orderId)}`);
  if (!o) return json({ ok: true });
  if (ev.type === 'checkout.session.completed' && s.payment_status === 'paid') {
    if (s.amount_total !== (o.amount_due_cents ?? o.total_cents)) { await log(o.id, 'stripe', 'amount_mismatch', { paid: s.amount_total }); return json({ ok: true }); }
    await markPaid(o, 'paid', s.payment_intent);
  } else if (ev.type === 'checkout.session.expired') {
    const gone = await patch('orders', `id=eq.${o.id}&status=eq.awaiting_payment`, { status: 'expired' });
    if (gone?.length) await rpc('order_release_credits', { p_order: o.id });
  }
  return json({ ok: true });
}

async function staffFor(req: Request, restaurantId: string) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!u.ok) return null;
  const user = await u.json();
  const rows = await db(`staff?select=name,role&user_id=eq.${user.id}&restaurant_id=eq.${restaurantId}`);
  return rows?.[0] ? { id: user.id, email: user.email, name: rows[0].name || user.email, role: rows[0].role } : null;
}

// ---------- actions ----------
async function checkout(req: Request, body: any) {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  if (!(await rpc('rate_limit', { p_key: `checkout:${ip}`, p_max: 12, p_seconds: 600 }))) {
    return json({ ok: false, error: 'Too many tries. Please wait a few minutes or call us.' }, 429);
  }
  const menu = await menuFor(body.restaurant);
  const r = menu.restaurant;
  if (!r.accepting_orders) throw new OrderError('Online ordering is paused right now. Please call us.');
  const pickup_at = String(body.pickup_at ?? '');
  const delivering = body.fulfillment === 'delivery';
  if (!pickup_at || !validPickup(delivering ? forDelivery(r) : r, pickup_at)) throw new OrderError('That time is no longer available. Please pick another.');
  const guest = cleanGuest(body.guest);
  const lines = priceCart(menu, body.items, pickup_at);
  const address = delivering ? cleanAddress(body.address) : null;
  const fee = address ? await feeFor(r, address, guest.phone, lines) : 0;
  const c = await priceWithCredits(r.id, lines, r, body.tip_cents, guest.phone, body.rewards_code, body.gift_code, fee);
  const { t } = c;

  const [full] = await db(`restaurants?select=stripe_account_id,site_url&id=eq.${r.id}`);
  const [o] = await insert('orders', {
    restaurant_id: r.id, pickup_at: new Date(pickup_at).toISOString(), ...guest, ...t, gift_applied_cents: c.gift_applied_cents,
    amount_due_cents: c.amount_due_cents, test_mode: r.test_mode, fulfillment: delivering ? 'delivery' : 'pickup', delivery_address: address,
    attribution: cleanAttribution(body.attribution, req),
  });
  await insert('order_items', lines.map((l) => ({ ...l, order_id: o.id })));
  await log(o.id, 'guest', 'placed', { ip });
  const status_url = `${full.site_url}/order/?t=${o.token}`;
  try {
    if (c.account && (await rpc('rewards_change', { p_account: c.account.id, p_delta: -c.points, p_reason: 'redeemed', p_order: o.id })) === null) throw new OrderError('Your rewards balance changed. Please try again.');
    if (c.card && (await rpc('gift_change', { p_card: c.card.id, p_delta: -c.gift_applied_cents, p_reason: 'redeemed', p_order: o.id })) === null) throw new OrderError('Your gift card balance changed. Please try again.');
  } catch (e) {
    await patch('orders', `id=eq.${o.id}`, { status: 'expired' });
    await rpc('order_release_credits', { p_order: o.id });
    throw e;
  }

  if (!STRIPE) {
    if (!r.test_mode) throw new Error('Stripe is not configured for a live restaurant.');
    await markPaid(o, 'test_paid');
    return json({ ok: true, order_no: o.order_no, token: o.token, redirect: status_url, test: true });
  }
  if (c.amount_due_cents === 0) {
    await markPaid(o, 'gift_card');
    return json({ ok: true, order_no: o.order_no, token: o.token, redirect: status_url });
  }
  const origin = /^https:\/\//.test(String(body.return_url ?? '')) ? String(body.return_url).replace(/\/$/, '') : full.site_url;
  const session = await stripe('checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(c.amount_due_cents),
    'line_items[0][price_data][product_data][name]': `${r.name} order ${o.order_no}`,
    customer_email: guest.email,
    success_url: `${origin}/order/?t=${o.token}`,
    cancel_url: `${origin}/menu/?cancelled=1`,
    expires_at: String(Math.floor(Date.now() / 1000) + 1800),
    'metadata[order_id]': o.id,
    'payment_intent_data[metadata][order_id]': o.id,
  }, full.stripe_account_id, `order-${o.id}`).catch(async (e) => {
    await patch('orders', `id=eq.${o.id}`, { status: 'expired' });
    await rpc('order_release_credits', { p_order: o.id });
    throw e;
  });
  await patch('orders', `id=eq.${o.id}`, { stripe_session_id: session.id });
  return json({ ok: true, order_no: o.order_no, token: o.token, redirect: session.url });
}

const forDelivery = (r: any) => ({ ...r, pickup_lead_minutes: r.delivery_lead_minutes });
async function feeFor(r: any, address: any, phone: string, lines: any[]) {
  const value = lines.reduce((s, l) => s + l.line_total_cents, 0);
  if (value < r.delivery_min_cents) throw new OrderError(`Delivery orders start at ${money(r.delivery_min_cents)}.`);
  return await deliveryFee(r, address, phone, value);
}

async function priceWithCredits(restaurantId: string, lines: any[], r: any, tip: unknown, phone: string, rewardsCode: unknown, giftCode: unknown, deliveryCents = 0) {
  let account: any = null, points = 0, discount = 0;
  const code = cleanCode(rewardsCode);
  if (code) {
    if (!phone) throw new OrderError('Enter your phone number to use rewards.');
    const [rules] = await db(`restaurants?select=rewards_redeem_points,rewards_redeem_cents&id=eq.${restaurantId}`);
    [account] = await db(`rewards_accounts?select=id,points&restaurant_id=eq.${restaurantId}&code=eq.${code}&phone=eq.${encodeURIComponent(phone)}`);
    if (!account) throw new OrderError("We couldn't match that rewards code to this phone number.");
    if (account.points < rules.rewards_redeem_points) throw new OrderError(`You need ${rules.rewards_redeem_points} points for a reward. You have ${account.points}.`);
    points = rules.rewards_redeem_points;
    discount = rules.rewards_redeem_cents;
  }
  const t = totals(lines, r, tip, discount, deliveryCents);
  let card: any = null, gift = { gift_applied_cents: 0, amount_due_cents: t.total_cents };
  const gc = cleanCode(giftCode);
  if (gc) {
    [card] = await db(`gift_cards?select=id,balance_cents&restaurant_id=eq.${restaurantId}&code=eq.${gc}&status=eq.active`);
    if (!card) throw new OrderError("We couldn't find that gift card.");
    if (card.balance_cents <= 0) throw new OrderError('That gift card has no balance left.');
    gift = applyGift(t.total_cents, card.balance_cents);
  }
  return { t, account, points, card, ...gift };
}

const ipOf = (req: Request) => (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
async function limited(req: Request, name: string, max: number, seconds = 600) {
  if (await rpc('rate_limit', { p_key: `${name}:${ipOf(req)}`, p_max: max, p_seconds: seconds })) return false;
  throw new OrderError('Too many tries. Please wait a few minutes or call us.');
}
const text = (v: unknown, n: number) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const validEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v);
const rid = async (slug: unknown, fields = 'id') => {
  const [r] = await db(`restaurants?select=${fields}&slug=eq.${encodeURIComponent(String(slug ?? ''))}&active=eq.true`);
  if (!r) throw new OrderError('Restaurant not found.');
  return r;
};

// ---------- website forms ----------
async function rewardsJoin(r: any, d: Record<string, string>) {
  const phone = normPhone(d.phone), name = text(d.name, 80), email = text(d.email, 120).toLowerCase();
  if (!name) throw new OrderError('Please enter your name.');
  if (!phone) throw new OrderError('Please enter a 10-digit phone number.');
  if (email && !validEmail(email)) throw new OrderError('Please enter a valid email.');
  const [old] = await db(`rewards_accounts?select=id,email,code&restaurant_id=eq.${r.id}&phone=eq.${encodeURIComponent(phone)}`);
  if (old) {
    await sendEmail(old.email, `Your ${r.name} rewards code`, `Your rewards code is ${old.code}.`, null);
    return json({ ok: true, existing: true });
  }
  const code = makeCode(8);
  const [a] = await insert('rewards_accounts', { restaurant_id: r.id, phone, name, email: email || null, code, sms_consent: d.sms_consent === 'yes' });
  await sendEmail(a.email, `Welcome to ${r.name} Rewards`, `Thanks for joining, ${name}! Your rewards code is ${code}. Use it with your phone number when you order online.`, null);
  return json({ ok: true, member: { code, points: 0 } });
}

async function submitForm(req: Request, body: any) {
  await limited(req, 'form', 10);
  const r = await rid(body.restaurant, 'id,name,timezone,hours,forms_email');
  const kind = String(body.form ?? '');
  if (!/^[a-z-]{2,30}$/.test(kind)) throw new OrderError('Please check the form and try again.');
  if (body.website) return json({ ok: true }); // hidden field only bots fill in
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.data ?? {}).slice(0, 25)) {
    if (/^[a-z_]{1,30}$/.test(k)) data[k] = text(v, 2000);
  }
  let res: Response | null = null;
  const attribution = cleanAttribution(body.attribution, req);
  if (kind === 'rewards') {
    res = await rewardsJoin(r, data);
    const phone = normPhone(data.phone);
    if (phone) await reportConversion(String(body.restaurant), {
      type: 'vip_signup', externalId: `rewards-${phone}`, valueCents: 0, customer: { phone, email: data.email || undefined },
    }, attribution, null);
  } else if (kind === 'reservation') {
    const phone = normPhone(data.phone), email = (data.email ?? '').toLowerCase();
    if (!data.name) throw new OrderError('Please enter your name.');
    if (!validEmail(email)) throw new OrderError('Please enter a valid email.');
    if (!phone) throw new OrderError('Please enter a 10-digit phone number.');
    if (!validReservationDate(r, data.date)) throw new OrderError("We can't take a reservation on that date. Please pick a day we're open.");
    if (!data.time || !data.party_size) throw new OrderError('Please pick a time and party size.');
    const [booking] = await insert('reservations', { restaurant_id: r.id, name: data.name, email, phone, res_date: data.date, res_time: text(data.time, 20), party_size: text(data.party_size, 20), requests: data.requests || null, attribution });
    await reportConversion(String(body.restaurant), {
      type: 'reservation', externalId: booking.id, reservationId: booking.id, valueCents: 0, customer: { phone, email },
      extra: { res_date: data.date, res_time: text(data.time, 20), party_size: text(data.party_size, 20) },
    }, attribution, null);
  }
  if (kind !== 'reservation' && kind !== 'rewards') await insert('form_submissions', { restaurant_id: r.id, kind, data });
  const lines = Object.entries(data).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('\n');
  await sendEmail(r.forms_email, `${r.name}: new ${kind.replace(/-/g, ' ')} form`, `${lines}\n\nSent from ${text(body.page, 100) || 'the website'}.`, null, validEmail(data.email ?? '') ? data.email : undefined);
  return res ?? json({ ok: true });
}

// ---------- gift cards ----------
async function activateGift(card: any, intent?: string) {
  const rows = await patch('gift_cards', `id=eq.${card.id}&status=eq.pending`, { status: 'active', balance_cents: card.initial_cents, activated_at: new Date().toISOString(), stripe_payment_intent: intent ?? null });
  if (!rows?.length) return;
  await insert('gift_card_events', { gift_card_id: card.id, cents: card.initial_cents, reason: 'purchased', by_name: card.source });
  const [r] = await db(`restaurants?select=name,site_url,forms_email&id=eq.${card.restaurant_id}`);
  const to = card.recipient_email || card.buyer_email;
  await sendEmail(to, `Your ${money(card.initial_cents)} ${r.name} gift card`,
    `${card.recipient_name ? `Hi ${card.recipient_name}, ` : ''}${card.buyer_name ? `${card.buyer_name} sent you ` : 'Here is '}a ${money(card.initial_cents)} gift card.${card.message ? `\n\n"${card.message}"` : ''}\n\nCode: ${card.code}\n\nUse it at checkout on ${r.site_url}/menu or show it at the restaurant.`, null);
  if (card.recipient_email && card.buyer_email) await sendEmail(card.buyer_email, `Your ${r.name} gift card was sent`, `We sent the ${money(card.initial_cents)} gift card to ${card.recipient_email}.`, null);
  await sendEmail(r.forms_email, `${r.name}: gift card sold`, `${money(card.initial_cents)} gift card ending ${card.code.slice(-4)}, bought by ${card.buyer_name || 'staff'}.`, null);
}

async function giftBuy(req: Request, body: any) {
  await limited(req, 'gift-buy', 6);
  const r = await rid(body.restaurant, 'id,name,test_mode,site_url,stripe_account_id,gift_min_cents,gift_max_cents');
  const cents = Math.round(Number(body.amount_cents));
  if (!Number.isInteger(cents) || cents % 100 || cents < r.gift_min_cents || cents > r.gift_max_cents) throw new OrderError(`Choose a whole-dollar amount from ${money(r.gift_min_cents)} to ${money(r.gift_max_cents)}.`);
  const buyer_name = text(body.buyer_name, 80), buyer_email = text(body.buyer_email, 120).toLowerCase();
  const recipient_name = text(body.recipient_name, 80), recipient_email = text(body.recipient_email, 120).toLowerCase();
  if (!buyer_name) throw new OrderError('Please enter your name.');
  if (!validEmail(buyer_email)) throw new OrderError('Please enter a valid email.');
  if (recipient_email && !validEmail(recipient_email)) throw new OrderError("Please check the recipient's email.");
  const [card] = await insert('gift_cards', { restaurant_id: r.id, code: makeCode(16), initial_cents: cents, buyer_name, buyer_email, recipient_name: recipient_name || null, recipient_email: recipient_email || null, message: text(body.message, 300) || null, test_mode: r.test_mode });
  if (!STRIPE) {
    if (!r.test_mode) throw new Error('Stripe is not configured for a live restaurant.');
    await activateGift(card);
    return json({ ok: true, token: card.token, test: true });
  }
  const origin = /^https:\/\//.test(String(body.return_url ?? '')) ? String(body.return_url).replace(/\/$/, '') : r.site_url;
  const session = await stripe('checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(cents),
    'line_items[0][price_data][product_data][name]': `${r.name} gift card`,
    customer_email: buyer_email,
    success_url: `${origin}/gift-cards/?g=${card.token}`,
    cancel_url: `${origin}/gift-cards/`,
    expires_at: String(Math.floor(Date.now() / 1000) + 1800),
    'metadata[gift_card_id]': card.id,
  }, r.stripe_account_id, `gift-${card.id}`);
  return json({ ok: true, token: card.token, redirect: session.url });
}

// ---------- staff tools ----------
async function staffTools(req: Request, body: any) {
  const r = await rid(body.restaurant, 'id,name,phone,site_url,rewards_redeem_points,rewards_redeem_cents,test_mode');
  const me = await staffFor(req, r.id);
  if (!me) return json({ ok: false, error: 'Please sign in again.' }, 401);
  const manager = () => { if (me.role !== 'manager') throw new OrderError('Ask a manager to do this.'); };
  const id = encodeURIComponent(String(body.id ?? ''));
  const scope = `restaurant_id=eq.${r.id}`;
  switch (String(body.op ?? '')) {
    case 'counts': {
      const count = async (t: string, q: string) => (await db(`${t}?select=id&${scope}&${q}`)).length;
      return json({ ok: true, reservations: await count('reservations', 'status=eq.requested'), messages: await count('form_submissions', 'status=eq.new') });
    }
    case 'reservations': {
      const today = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      return json({ ok: true, rows: await db(`reservations?select=*&${scope}&res_date=gte.${today}&status=in.(requested,confirmed)&order=res_date.asc,res_time.asc&limit=100`) });
    }
    case 'reservation': {
      const to = { confirm: 'confirmed', decline: 'declined', cancel: 'cancelled' }[String(body.move)];
      if (!to) throw new OrderError('Unknown action.');
      const [row] = await patch('reservations', `id=eq.${id}&${scope}`, { status: to, handled_by: me.name });
      if (!row) throw new OrderError('Reservation not found.');
      const when = `${row.res_date} at ${row.res_time}`;
      await sendEmail(row.email, to === 'confirmed' ? `Your ${r.name} reservation is confirmed` : `About your ${r.name} reservation`,
        to === 'confirmed' ? `Hi ${row.name}, we'll see you ${when} (party of ${row.party_size}). Questions? Call ${r.phone}.` : `Hi ${row.name}, we can't hold your table for ${when}. Please call ${r.phone} and we'll help you find another time.`, null);
      return json({ ok: true, status: to });
    }
    case 'messages':
      return json({ ok: true, rows: await db(`form_submissions?select=*&${scope}&status=eq.new&order=created_at.desc&limit=100`) });
    case 'message': {
      const [row] = await patch('form_submissions', `id=eq.${id}&${scope}`, { status: 'done' });
      return row ? json({ ok: true }) : json({ ok: false, error: 'Message not found.' });
    }
    case 'rewards_find': {
      const phone = normPhone(body.phone);
      if (!phone) throw new OrderError('Enter a 10-digit phone number.');
      const [a] = await db(`rewards_accounts?select=id,name,phone,email,code,points&${scope}&phone=eq.${encodeURIComponent(phone)}`);
      return a ? json({ ok: true, account: a, redeem_points: r.rewards_redeem_points, redeem_cents: r.rewards_redeem_cents }) : json({ ok: false, error: 'No member with that phone number.' });
    }
    case 'rewards_adjust': {
      const delta = Math.round(Number(body.points));
      if (!Number.isInteger(delta) || !delta || Math.abs(delta) > 100000) throw new OrderError('Enter a number of points.');
      if (delta > 0) manager();
      const [a] = await db(`rewards_accounts?select=id&id=eq.${id}&${scope}`);
      if (!a) throw new OrderError('Member not found.');
      const points = await rpc('rewards_change', { p_account: a.id, p_delta: delta, p_reason: delta > 0 ? 'added_by_staff' : 'redeemed_in_store', p_by: me.name });
      if (points === null) throw new OrderError('Not enough points.');
      return json({ ok: true, points });
    }
    case 'gift_find': {
      const [c] = await db(`gift_cards?select=id,code,balance_cents,initial_cents,status,recipient_name,buyer_name&${scope}&code=eq.${cleanCode(body.code)}`);
      return c ? json({ ok: true, card: c }) : json({ ok: false, error: 'Gift card not found.' });
    }
    case 'gift_redeem': {
      const cents = Math.round(Number(body.cents));
      if (!Number.isInteger(cents) || cents <= 0) throw new OrderError('Enter an amount.');
      const [c] = await db(`gift_cards?select=id&id=eq.${id}&${scope}`);
      if (!c) throw new OrderError('Gift card not found.');
      const balance_cents = await rpc('gift_change', { p_card: c.id, p_delta: -cents, p_reason: 'redeemed_in_store', p_by: me.name });
      if (balance_cents === null) throw new OrderError('Not enough on this card.');
      return json({ ok: true, balance_cents });
    }
    case 'gift_issue': {
      manager();
      const cents = Math.round(Number(body.cents));
      if (!Number.isInteger(cents) || cents <= 0 || cents > 100000) throw new OrderError('Enter an amount.');
      const [card] = await insert('gift_cards', { restaurant_id: r.id, code: makeCode(16), initial_cents: cents, source: 'staff', buyer_name: text(body.name, 80) || me.name, test_mode: r.test_mode });
      await activateGift(card);
      return json({ ok: true, code: card.code, balance_cents: cents });
    }
    default:
      return json({ ok: false, error: 'Unknown action.' }, 400);
  }
}

async function kitchen(req: Request, body: any) {
  const [o] = await db(`orders?select=*&id=eq.${encodeURIComponent(String(body.order_id ?? ''))}`);
  if (!o) return json({ ok: false, error: 'Order not found.' }, 404);
  const staff = await staffFor(req, o.restaurant_id);
  if (!staff) return json({ ok: false, error: 'Please sign in again.' }, 401);
  const to = { accept: 'accepted', ready: 'ready', complete: 'completed', cancel: 'cancelled' }[String(body.move)];
  if (!to || !(NEXT as any)[o.status]?.includes(to)) return json({ ok: false, error: `This order is already ${o.status}.` });
  const now = new Date().toISOString();
  const up: Record<string, unknown> = { status: to };
  if (to === 'accepted') {
    up.accepted_at = now;
    if (o.fulfillment === 'delivery') Object.assign(up, await dispatchDelivery(o));
  }
  if (to === 'ready') up.ready_at = now;
  if (to === 'completed') up.completed_at = now;
  if (to === 'cancelled') {
    up.cancelled_at = now;
    up.cancel_reason = String(body.reason ?? '').replace(/[<>]/g, '').slice(0, 200) || 'Cancelled by the restaurant';
    if (o.delivery_id && !o.delivery_id.startsWith('test-')) {
      await doordash(`deliveries/${o.delivery_id}/cancel`, 'PUT').catch((e) => log(o.id, 'doordash', 'cancel_failed', { error: String(e) }));
      up.delivery_status = 'cancelled';
    }
    if (o.payment_status === 'paid' && o.stripe_payment_intent) {
      const [res] = await db(`restaurants?select=stripe_account_id&id=eq.${o.restaurant_id}`);
      await stripe('refunds', { payment_intent: o.stripe_payment_intent }, res.stripe_account_id, `refund-${o.id}`);
      up.payment_status = 'refunded';
    } else if (o.payment_status === 'gift_card') {
      up.payment_status = 'refunded';
    }
  }
  const rows = await patch('orders', `id=eq.${o.id}&status=eq.${o.status}`, up);
  if (!rows?.length) return json({ ok: false, error: 'Someone else just updated this order.' });
  await log(o.id, 'kitchen', to, { by: staff.name });
  if (to === 'cancelled') await rpc('order_release_credits', { p_order: o.id });
  if (to === 'cancelled' && o.paid_at) {
    const [slugRow] = await db(`restaurants?select=slug&id=eq.${o.restaurant_id}`);
    await reportConversion(slugRow.slug, orderConversion(o, up.payment_status === 'refunded' ? 'refunded' : 'cancelled'), o.attribution, o.id);
  }
  if (to === 'completed') await log(o.id, 'rewards', 'earned', { points: await rpc('order_earn_points', { p_order: o.id }) });
  const [r] = await db(`restaurants?select=name,site_url,phone&id=eq.${o.restaurant_id}`);
  if (to === 'ready') await sendEmail(o.email, `Your ${r.name} order is ready`, `Hi ${o.first_name}, order ${o.order_no} is ready${o.fulfillment === 'delivery' ? ' and waiting for your driver' : ' for pickup'}.`, o.id);
  if (to === 'cancelled') {
    await sendEmail(o.email, `Your ${r.name} order was cancelled`,
      `Hi ${o.first_name}, we had to cancel order ${o.order_no}. ${up.cancel_reason}. ${o.payment_status === 'paid' ? 'A full refund is on its way to your card.' : ''}${o.gift_applied_cents ? ' Your gift card balance has been restored.' : ''}\nQuestions? Call ${r.phone}.`, o.id);
  }
  return json({ ok: true, status: to });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  try {
    if (new URL(req.url).searchParams.get('hook') === 'stripe') return await handleStripeHook(req);
    const body = await req.json().catch(() => ({}));
    switch (String(body.action ?? '')) {
      case 'slots': {
        const { restaurant } = await menuFor(body.restaurant);
        const delivery_mode = deliveryMode(restaurant);
        return json({ ok: true, accepting: restaurant.accepting_orders, slots: pickupSlots(restaurant), delivery_mode, delivery_slots: ['drive', 'test'].includes(delivery_mode) ? pickupSlots(forDelivery(restaurant)) : [] });
      }
      case 'quote': {
        const menu = await menuFor(body.restaurant);
        const when = body.pickup_at || pickupSlots(menu.restaurant)[0];
        if (!when) throw new OrderError('We have no pickup times available right now.');
        if (body.rewards_code || body.gift_code) await limited(req, 'codes', 30);
        const lines = priceCart(menu, body.items, when);
        let fee = 0;
        if (body.fulfillment === 'delivery') {
          await limited(req, 'delivery', 30);
          fee = await feeFor(menu.restaurant, cleanAddress(body.address), normPhone(body.phone) || toE164(menu.restaurant.phone), lines);
        }
        const c = await priceWithCredits(menu.restaurant.id, lines, menu.restaurant, body.tip_cents, normPhone(body.phone), body.rewards_code, body.gift_code, fee);
        return json({ ok: true, ...c.t, gift_applied_cents: c.gift_applied_cents, amount_due_cents: c.amount_due_cents });
      }
      case 'checkout':
        return await checkout(req, body);
      case 'status': {
        const token = String(body.token ?? '').replace(/[^a-f0-9]/g, '');
        if (!token) return json({ ok: false, error: 'Order not found.' }, 404);
        const rows = await db(`orders?select=order_no,status,payment_status,pickup_at,first_name,subtotal_cents,discount_cents,gift_applied_cents,amount_due_cents,delivery_fee_cents,fulfillment,delivery_address,delivery_tracking_url,delivery_status,tax_cents,guest_fee_cents,tip_cents,total_cents,test_mode,cancel_reason,restaurant:restaurants(name,phone,address,timezone),items:order_items(name,qty,line_total_cents,options,note)&token=eq.${token}`);
        return rows?.[0] ? json({ ok: true, order: rows[0] }) : json({ ok: false, error: 'Order not found.' }, 404);
      }
      case 'kitchen':
        return await kitchen(req, body);
      case 'form':
        return await submitForm(req, body);
      case 'rewards_info': {
        const r = await rid(body.restaurant, 'rewards_points_per_dollar,rewards_redeem_points,rewards_redeem_cents,gift_min_cents,gift_max_cents,test_mode');
        return json({ ok: true, ...r });
      }
      case 'rewards_check': {
        await limited(req, 'rewards-check', 10);
        const r = await rid(body.restaurant);
        const [a] = await db(`rewards_accounts?select=name,points&restaurant_id=eq.${r.id}&code=eq.${cleanCode(body.code)}&phone=eq.${encodeURIComponent(normPhone(body.phone))}`);
        return a ? json({ ok: true, points: a.points, name: a.name }) : json({ ok: false, error: "We couldn't match that phone number and code." });
      }
      case 'gift_buy':
        return await giftBuy(req, body);
      case 'gift_view': {
        const token = String(body.token ?? '').replace(/[^a-f0-9]/g, '');
        const rows = token ? await db(`gift_cards?select=code,status,initial_cents,balance_cents,recipient_name,test_mode&token=eq.${token}`) : [];
        return rows?.[0] ? json({ ok: true, card: rows[0] }) : json({ ok: false, error: 'Gift card not found.' }, 404);
      }
      case 'gift_check': {
        await limited(req, 'gift-check', 10);
        const r = await rid(body.restaurant);
        const [c] = await db(`gift_cards?select=balance_cents&restaurant_id=eq.${r.id}&code=eq.${cleanCode(body.code)}&status=eq.active`);
        return c ? json({ ok: true, balance_cents: c.balance_cents }) : json({ ok: false, error: "We couldn't find that gift card." });
      }
      case 'staff':
        return await staffTools(req, body);
      case 'pause': {
        const [r] = await db(`restaurants?select=id&slug=eq.${encodeURIComponent(String(body.restaurant ?? ''))}`);
        if (!r || !(await staffFor(req, r.id))) return json({ ok: false, error: 'Please sign in again.' }, 401);
        await patch('restaurants', `id=eq.${r.id}`, { accepting_orders: !!body.accepting });
        return json({ ok: true, accepting: !!body.accepting });
      }
      default:
        return json({ ok: false, error: 'Unknown action.' }, 400);
    }
  } catch (e) {
    if (e instanceof OrderError) return json({ ok: false, error: e.message });
    console.error(e instanceof Error ? e.message : e);
    return json({ ok: false, error: 'Something went wrong. Please try again or call us.' }, 500);
  }
});
