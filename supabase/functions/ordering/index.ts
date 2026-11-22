// Online ordering API. One function, several actions (POST JSON { action, ... }):
//   slots      guest: pickup times
//   quote      guest: price a cart on the server
//   checkout   guest: create the order and a payment page (Stripe, or the restaurant's own processor)
//   status     guest: order progress by private token
//   kitchen    staff: accept | ready | complete | cancel an order
//   pause      staff: stop or resume taking orders
//   form       guest: website forms, table bookings and rewards sign-ups
//   res_info, res_month, res_slots, res_cancel   guest: reservation calendar
//   rewards_info, rewards_check, gift_buy, gift_view, gift_check   guest
//   staff      staff: reservations, messages, rewards and gift cards
//   ?hook=stripe  Stripe webhook
//   /ordering/pay/<authorizenet|clover|square>/<restaurant id>   that restaurant's processor webhook (payments.js)
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, EMAIL_FROM,
//   DOORDASH_DEVELOPER_ID, DOORDASH_KEY_ID, DOORDASH_SIGNING_SECRET (DoorDash Drive),
//   ATTRIBUTION_URL + ATTRIBUTION_KEYS (marketing attribution; JSON map of restaurant slug -> API key).
// With no Stripe key, a restaurant in test mode marks orders as test-paid. Live mode never does.
import { PayError, PROCESSORS } from './payments.js';
import { addressLine, applyGift, cleanAddress, cleanCode, cleanGuest, makeCode, NEXT, normPhone, OrderError, pickupSlots, priceCart, promoDiscount, totals, validPickup, windowsFor } from './core.js';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_HOOK = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const RESEND = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('EMAIL_FROM') ?? '';
const DD_DEV = Deno.env.get('DOORDASH_DEVELOPER_ID') ?? '';
const DD_KEY = Deno.env.get('DOORDASH_KEY_ID') ?? '';
const DD_SECRET = Deno.env.get('DOORDASH_SIGNING_SECRET') ?? '';
const JOB_KEY = Deno.env.get('JOB_KEY') ?? '';               // optional; otherwise the key in Vault (migration 0014) is used

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
  await withExceptions(m.restaurant);
  return m;
}

/** Attach special hours (next 60 days) so pickup times and checks respect closures. */
async function withExceptions(r: any) {
  const from = new Intl.DateTimeFormat('en-CA', { timeZone: r.timezone }).format(new Date());
  const rows = await db(`hours_exceptions?select=day,closed,ranges,note&restaurant_id=eq.${r.id}&day=gte.${from}&order=day.asc&limit=60`).catch(() => []);
  r.exceptions = Object.fromEntries(rows.map((x: any) => [x.day, { closed: x.closed, ranges: x.ranges, note: x.note }]));
  return r;
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

// ---------- the restaurant's own card processor (payments.js) ----------
async function http(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  const r = await fetch(url, { method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(20000) });
  return { ok: r.ok, status: r.status, text: await r.text() };
}
const hookUrl = (provider: string, rid: string) => `${SB_URL}/functions/v1/ordering/pay/${provider}/${rid}`;
/** null = Stripe (the default). Otherwise the processor and its keys; ctx is null when no key is saved yet. */
async function payFor(restaurantId: string) {
  const [p] = await db(`payment_settings?select=provider,env,settings&restaurant_id=eq.${restaurantId}`);
  if (!p || p.provider === 'stripe' || !PROCESSORS[p.provider as keyof typeof PROCESSORS]) return null;
  const sec = JSON.parse((await rpc('payment_secret', { rid: restaurantId })) || '{}');
  const ctx = sec.key ? { settings: p.settings ?? {}, env: p.env, key: sec.key, hook_key: sec.hook_key ?? '', http, hook_url: hookUrl(p.provider, restaurantId) } : null;
  return { provider: p.provider as keyof typeof PROCESSORS, ctx };
}
const payNote = (restaurantId: string, ok: boolean, error?: unknown) =>
  patch('payment_settings', `restaurant_id=eq.${restaurantId}`, ok ? { last_ok_at: new Date().toISOString(), last_error: null } : { last_error: String(error).slice(0, 300) }).catch(() => null);

/** Start the processor's payment page. Guests see a plain message if the processor fails. */
type PayPage = { session: string; ref?: string; redirect?: string; post?: { url: string; fields: Record<string, string> } };
async function startPayment(pay: any, restaurantId: string, p: any): Promise<PayPage> {
  try {
    const out: PayPage = await PROCESSORS[pay.provider as keyof typeof PROCESSORS].checkout(pay.ctx, p);
    await payNote(restaurantId, true);
    return out;
  } catch (e) {
    console.error('payment page', pay.provider, e instanceof Error ? e.message : e);
    await payNote(restaurantId, false, e instanceof Error ? e.message : e);
    throw new OrderError("Card payments aren't working right now. Please try again in a minute or call us.");
  }
}

/** Mark an order or gift card paid once the processor says so (from a webhook, the status page or the sweep). */
async function settleOrder(o: any, res: { paid: boolean; cents?: number; txn?: string } | null) {
  if (!res?.paid) return false;
  const due = o.amount_due_cents ?? o.total_cents;
  if (res.cents != null && res.cents !== due) { await log(o.id, o.payment_provider, 'amount_mismatch', { paid: res.cents, due }); return false; }
  if (o.status === 'awaiting_payment') { await markPaid(o, 'paid', undefined, res.txn); return true; }
  if (o.status === 'expired' && !o.payment_ref) {
    // Paid after the order timed out (credits already released): tell the restaurant instead of silently keeping the money.
    const rows = await patch('orders', `id=eq.${o.id}&payment_ref=is.null`, { payment_ref: res.txn ?? null });
    if (rows?.length) {
      await log(o.id, o.payment_provider, 'paid_after_expiry', { txn: res.txn, cents: res.cents });
      const [r] = await db(`restaurants?select=name,alert_email&id=eq.${o.restaurant_id}`);
      await sendEmail(r.alert_email, `Late payment on expired order ${o.order_no}`, `${o.first_name} ${o.last_name} paid ${money(due)} for order ${o.order_no} after it had expired, so it never reached the kitchen. Call them at ${o.phone} to make it, or refund it in your card processor's dashboard.`, o.id);
    }
  }
  return false;
}
async function settleGift(card: any, res: { paid: boolean; cents?: number; txn?: string } | null) {
  if (!res?.paid || card.status !== 'pending') return false;
  if (res.cents != null && res.cents !== card.initial_cents) { await log(null, card.payment_provider, 'gift_amount_mismatch', { card: card.id, paid: res.cents }); return false; }
  await activateGift(card, undefined, res.txn);
  return true;
}
/** Ask the processor about one awaiting order or pending gift card. */
async function checkPayment(kind: 'order' | 'gift', row: any) {
  const pay = await payFor(row.restaurant_id);
  if (!pay?.ctx || pay.provider !== row.payment_provider || !row.payment_session) return false;
  const res = await PROCESSORS[pay.provider].confirm(pay.ctx, { session: row.payment_session, txn: null });
  return kind === 'order' ? settleOrder(row, res) : settleGift(row, res);
}

// Processor webhook: POST /functions/v1/ordering/pay/<provider>/<restaurant id>
async function handlePayHook(req: Request, provider: string, restaurantId: string) {
  const raw = await req.text();
  if (!/^[0-9a-f-]{36}$/.test(restaurantId)) return json({ ok: false }, 404);
  const pay = await payFor(restaurantId);
  if (!pay?.ctx || pay.provider !== provider) return json({ ok: false }, 404);
  const P = PROCESSORS[pay.provider];
  const ev = await P.hook(pay.ctx, raw, req.headers);
  if (!ev) { console.error('pay hook: bad signature', provider, restaurantId); return json({ ok: false }, 401); }
  if ((ev as any).ignore) return json({ ok: true });
  const e = ev as { session?: string; txn?: string; approved?: boolean };
  const session = e.session ?? '';
  if (!session) return json({ ok: true });
  const sel = `payment_provider=eq.${provider}&payment_session=eq.${encodeURIComponent(session)}&restaurant_id=eq.${restaurantId}`;
  const [o] = await db(`orders?select=*&${sel}`);
  const [card] = o ? [null] : await db(`gift_cards?select=*&${sel}`);
  if (!o && !card) return json({ ok: true });
  const confirmed = await P.confirm(pay.ctx, { session, txn: e.txn ?? null });
  const res = confirmed ?? (e.approved ? { paid: true, txn: e.txn } : null); // Clover: the signed webhook is the confirmation
  if (o) await settleOrder(o, res); else await settleGift(card, res);
  return json({ ok: true });
}

// Every 5 minutes: confirm payments a webhook missed, and time out abandoned payment pages.
async function paymentSweep() {
  const cut = (min: number) => new Date(Date.now() - min * 60000).toISOString();
  const orders = await db(`orders?select=*&status=eq.awaiting_payment&payment_provider=neq.stripe&created_at=lt.${cut(2)}&order=created_at.asc&limit=100`);
  const cards = await db(`gift_cards?select=*&status=eq.pending&payment_provider=neq.stripe&payment_session=not.is.null&created_at=lt.${cut(2)}&order=created_at.asc&limit=100`);
  let paid = 0, expired = 0;
  for (const [kind, row] of [...orders.map((o: any) => ['order', o]), ...cards.map((c: any) => ['gift', c])] as ['order' | 'gift', any][]) {
    try {
      if (await checkPayment(kind, row)) { paid++; continue; }
      if (row.created_at > cut(45)) continue;
      const pay = await payFor(row.restaurant_id);
      if (pay?.ctx && pay.provider === row.payment_provider) await (PROCESSORS[pay.provider] as any).cancel?.(pay.ctx, { session: row.payment_session, ref: row.payment_ref });
      if (kind === 'order') {
        const gone = await patch('orders', `id=eq.${row.id}&status=eq.awaiting_payment`, { status: 'expired' });
        if (gone?.length) { await rpc('order_release_credits', { p_order: row.id }); expired++; }
      } else {
        await patch('gift_cards', `id=eq.${row.id}&status=eq.pending`, { status: 'void' });
        expired++;
      }
    } catch (e) { console.error('payment sweep', row.id, e instanceof Error ? e.message : e); }
  }
  return { payments_confirmed: paid, payments_expired: expired };
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

async function markPaid(o: any, payment_status: string, intent?: string, ref?: string) {
  const rows = await patch('orders', `id=eq.${o.id}&status=eq.awaiting_payment`, {
    status: 'new', payment_status, paid_at: new Date().toISOString(), stripe_payment_intent: intent ?? null, ...(ref ? { payment_ref: ref } : {}),
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
  const [admin] = await db(`platform_admins?select=user_id&user_id=eq.${user.id}`);
  if (admin) return { id: user.id, email: user.email, name: user.email, role: 'agency', perms: ALL_PERMS, agency: true };
  const rows = await db(`staff?select=name,role,permissions&user_id=eq.${user.id}&restaurant_id=eq.${restaurantId}`);
  return rows?.[0] ? { id: user.id, email: user.email, name: rows[0].name || user.email, role: rows[0].role, perms: rows[0].permissions as string[], agency: false } : null;
}
// Admin sections a login can be given. 'team' lets someone add people and set their access.
const ALL_PERMS = ['kitchen', 'dashboard', 'orders', 'reservations', 'messages', 'customers', 'campaigns', 'rewards', 'gift', 'menu', 'choices', 'pairs', 'website', 'settings', 'marketing', 'team'];
const ROLE_PERMS: Record<string, string[]> = {
  owner: ALL_PERMS,
  manager: ALL_PERMS.filter((p) => p !== 'team'),
  kitchen: ['kitchen'],
};


// ---------- texting and email ----------
// Each restaurant has its own Twilio account (token in Vault) and optional from-address.
// Every message goes through the messages table so the admin can see what was sent and why.
type MsgCfg = { twilio_sid?: string; sms_from?: string; token?: string | null; email_from?: string; email_reply_to?: string; quiet_start_min: number; quiet_end_min: number; r: any };
async function msgConfig(rid: string, cache: Map<string, MsgCfg>) {
  if (cache.has(rid)) return cache.get(rid)!;
  const [[m], [r]] = await Promise.all([db(`messaging_settings?select=*&restaurant_id=eq.${rid}`), db(`restaurants?select=id,name,phone,timezone,site_url,forms_email&id=eq.${rid}`)]);
  const token = m?.twilio_secret_id ? await rpc('messaging_secret', { rid }) : null;
  const cfg = { ...(m ?? {}), token, quiet_start_min: m?.quiet_start_min ?? 540, quiet_end_min: m?.quiet_end_min ?? 1200, r };
  cache.set(rid, cfg);
  return cfg;
}
const localMinutes = (tz: string) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return +p.hour * 60 + +p.minute; };

async function twilioSend(cfg: MsgCfg, to: string, body: string) {
  const form: Record<string, string> = { To: to, Body: body };
  if (String(cfg.sms_from).startsWith('MG')) form.MessagingServiceSid = cfg.sms_from!; else form.From = cfg.sms_from!;
  form.StatusCallback = `${SB_URL}/functions/v1/ordering?hook=twilio&r=${cfg.r.id}&status=1`;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio_sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: `Basic ${btoa(`${cfg.twilio_sid}:${cfg.token}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message ?? `Twilio ${r.status}`);
  return d.sid as string;
}

async function resendSend(cfg: MsgCfg, to: string, subject: string, textBody: string, unsubUrl: string | null, oneClick: string | null) {
  const headers: Record<string, string> = {};
  if (unsubUrl && oneClick) { headers['List-Unsubscribe'] = `<${oneClick}>`; headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'; }
  const footer = `\n\n—\n${cfg.r.name}${cfg.r.phone ? ` · ${cfg.r.phone}` : ''}${unsubUrl ? `\nDon't want these emails? Unsubscribe: ${unsubUrl}` : ''}`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.email_from || FROM, to, subject, text: textBody + footer, ...(cfg.email_reply_to ? { reply_to: cfg.email_reply_to } : {}), headers }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message ?? `Resend ${r.status}`);
  return d.id as string;
}

/** Send one queued message now. Consent is checked again at send time. */
async function deliver(m: any, cache: Map<string, MsgCfg>): Promise<{ status: string; error?: string }> {
  const cfg = await msgConfig(m.restaurant_id, cache);
  const c = m.customer_id ? (await db(`customers?select=sms_marketing,sms_updates,sms_stopped_at,email_marketing,unsub_token&id=eq.${m.customer_id}`))[0] : null;
  const finish = async (status: string, extra: Record<string, unknown> = {}) => {
    await patch('messages', `id=eq.${m.id}`, { status, ...extra, ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}) });
    return { status, error: extra.error as string | undefined };
  };
  // Claim it so two runs never send the same message.
  const claimed = await patch('messages', `id=eq.${m.id}&status=eq.queued`, { send_after: new Date(Date.now() + 15 * 60000).toISOString() });
  if (!claimed?.length) return { status: 'busy' };
  try {
    if (m.channel === 'sms') {
      if (!cfg.twilio_sid || !cfg.token || !cfg.sms_from) return await finish('skipped', { error: 'Texting is not connected yet.' });
      if (c && (c.sms_stopped_at || (m.marketing ? !c.sms_marketing : !(c.sms_updates || c.sms_marketing)) && m.kind !== 'test')) return await finish('skipped', { error: 'Guest has not agreed to these texts.' });
      const bodyText = m.marketing ? `${m.body} Reply STOP to opt out.` : m.body;
      return await finish('sent', { provider_id: await twilioSend(cfg, m.to_addr, bodyText) });
    }
    if (!RESEND || !(cfg.email_from || FROM)) return await finish('skipped', { error: 'Email is not connected yet.' });
    if (m.marketing && c && !c.email_marketing) return await finish('skipped', { error: 'Guest unsubscribed from marketing email.' });
    const unsub = c && m.marketing ? `${cfg.r.site_url}/unsubscribe/?t=${c.unsub_token}` : null;
    const oneClick = c && m.marketing ? `${SB_URL}/functions/v1/ordering?unsub=${c.unsub_token}` : null;
    return await finish('sent', { provider_id: await resendSend(cfg, m.to_addr, m.subject || cfg.r.name, m.body, unsub, oneClick) });
  } catch (e) {
    return await finish('failed', { error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
  }
}

/** Send what's due. Marketing and reminders wait for each restaurant's texting hours. */
async function sendQueued(restaurantId: string | null, limit = 200) {
  const cache = new Map<string, MsgCfg>();
  const rows = await db(`messages?select=*&status=eq.queued&send_after=lte.${new Date().toISOString()}${restaurantId ? `&restaurant_id=eq.${restaurantId}` : ''}&order=created_at.asc&limit=${limit}`);
  let sent = 0, skipped = 0, failed = 0, waiting = 0;
  for (const m of rows) {
    if (m.channel === 'sms' && m.kind !== 'order_ready' && m.kind !== 'test' && m.kind !== 'staff') {
      const cfg = await msgConfig(m.restaurant_id, cache), now = localMinutes(cfg.r.timezone);
      if (now < cfg.quiet_start_min || now >= cfg.quiet_end_min) { waiting++; continue; }
    }
    const res = await deliver(m, cache);
    if (res.status === 'sent') sent++; else if (res.status === 'failed') failed++; else if (res.status === 'skipped') skipped++;
  }
  return { sent, skipped, failed, waiting };
}

/** Called every few minutes by the scheduler: queue due automations, then send. */
async function tick() {
  const rs = await db('restaurants?select=id&active=eq.true');
  let queued = 0;
  for (const r of rs) queued += (await rpc('automations_tick', { rid: r.id }).catch((e) => { console.error(e); return 0; })) ?? 0;
  const sweep = await paymentSweep().catch((e) => { console.error('payment sweep', e); return {}; });
  return { queued, ...sweep, ...(await sendQueued(null, 300)) };
}

/** Merge fields filled in here for messages sent straight from an event (order ready, welcome). */
const fill = (t: string, v: Record<string, string>) => t.replace(/\{([a-z_]+)\}/g, (_, k) => v[k] ?? '');
async function automationSms(rid: string, customerId: string | null, phone: string, kind: string, vars: Record<string, string>, dedupe: string, marketing: boolean) {
  try {
    const [a] = await db(`automations?select=*&restaurant_id=eq.${rid}&kind=eq.${kind}&enabled=eq.true&sms=eq.true`);
    if (!a || !phone) return;
    const [r] = await db(`restaurants?select=name,site_url&id=eq.${rid}`);
    const [c] = customerId ? await db(`customers?select=first_name&id=eq.${customerId}`) : [null];
    const body = fill(a.sms_body, { restaurant: r.name, first_name: c?.first_name || 'friend', link: `${r.site_url}/menu`, ...vars });
    const rows = await db('messages?on_conflict=restaurant_id,dedupe', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ restaurant_id: rid, customer_id: customerId, channel: 'sms', kind, to_addr: phone, body, marketing, dedupe }) });
    if (rows?.[0]) await deliver(rows[0], new Map());
  } catch (e) { console.error('sms', kind, e instanceof Error ? e.message : e); }
}

/** Record what a guest agreed to at checkout or booking. Never removes consent except email marketing they unticked. */
async function saveConsent(rid: string, who: Record<string, string>, consent: any) {
  const p: Record<string, unknown> = { ...who };
  if (consent?.sms_updates === true) p.sms_updates = true;
  if (consent?.sms_marketing === true) p.sms_marketing = true;
  if (typeof consent?.email_marketing === 'boolean') p.email_marketing = consent.email_marketing;
  await rpc('upsert_customer', { rid, p }).catch((e) => console.error('consent', e));
}

async function saveMessaging(r: any, body: any) {
  const sid = text(body.twilio_sid, 64), from = text(body.sms_from, 40), token = String(body.twilio_token ?? '').trim();
  if (sid && !/^AC[0-9a-f]{32}$/i.test(sid)) throw new OrderError('The Twilio Account SID starts with AC and is 34 characters.');
  if (from && !/^(\+1\d{10}|MG[0-9a-f]{32})$/i.test(from)) throw new OrderError('Use the texting number as +1XXXXXXXXXX, or a Messaging Service SID (MG…).');
  if (token && !/^[0-9a-f]{32}$/i.test(token)) throw new OrderError('The Twilio Auth Token is 32 letters and numbers.');
  const emailFrom = text(body.email_from, 120), replyTo = text(body.email_reply_to, 120).toLowerCase(), review = text(body.review_url, 500);
  if (replyTo && !validEmail(replyTo)) throw new OrderError('Check the reply-to email.');
  if (review && !/^https:\/\//.test(review)) throw new OrderError('The review link must start with https://');
  const qs = Math.max(0, Math.min(1439, Math.floor(Number(body.quiet_start_min) || 540))), qe = Math.max(qs + 60, Math.min(1440, Math.floor(Number(body.quiet_end_min) || 1200)));
  await db('messaging_settings?on_conflict=restaurant_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ restaurant_id: r.id, twilio_sid: sid || null, sms_from: from || null, email_from: emailFrom || null, email_reply_to: replyTo || null, review_url: review || null, quiet_start_min: qs, quiet_end_min: qe, updated_at: new Date().toISOString() }) });
  if (token) await rpc('set_messaging_secret', { rid: r.id, token });
  return json({ ok: true });
}

// Twilio webhook: STOP/START/HELP keywords, delivery updates, and guest replies (shown in Messages).
async function handleTwilio(req: Request, rid: string) {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw));
  if (!/^[0-9a-f-]{36}$/.test(rid)) return new Response('', { status: 400 });
  const cfg = await msgConfig(rid, new Map());
  if (!cfg.token) return new Response('', { status: 403 });
  const url = `${SB_URL}/functions/v1/ordering${new URL(req.url).search}`;
  const signed = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(cfg.token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed)))));
  if (sig !== req.headers.get('x-twilio-signature')) return new Response('', { status: 403 });
  const twiml = (msg = '') => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${msg.replace(/[<>&]/g, '')}</Message>` : ''}</Response>`, { headers: { 'Content-Type': 'text/xml' } });
  if (new URL(req.url).searchParams.get('status')) {
    if (params.MessageSid && /failed|undelivered/.test(params.MessageStatus ?? '')) await patch('messages', `provider_id=eq.${params.MessageSid}`, { status: 'failed', error: `Carrier: ${params.ErrorCode ?? params.MessageStatus}` });
    return twiml();
  }
  const from = normPhone(params.From), word = String(params.Body ?? '').trim().toUpperCase();
  if (!from) return twiml();
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPTOUT)$/.test(word)) {
    await patch('customers', `restaurant_id=eq.${rid}&phone=eq.${encodeURIComponent(from)}`, { sms_marketing: false, sms_updates: false, sms_stopped_at: new Date().toISOString() });
    await patch('rewards_accounts', `restaurant_id=eq.${rid}&phone=eq.${encodeURIComponent(from)}`, { sms_consent: false });
    return twiml(); // Twilio sends the standard opt-out confirmation
  }
  if (/^(START|UNSTOP|YES)$/.test(word)) {
    await patch('customers', `restaurant_id=eq.${rid}&phone=eq.${encodeURIComponent(from)}`, { sms_stopped_at: null, sms_updates: true });
    return twiml();
  }
  if (/^(HELP|INFO)$/.test(word)) return twiml(`${cfg.r.name}: For help call ${cfg.r.phone}. Msg & data rates may apply. Reply STOP to opt out.`);
  const [c] = await db(`customers?select=first_name,last_name,email&restaurant_id=eq.${rid}&phone=eq.${encodeURIComponent(from)}`);
  const name = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '';
  await insert('form_submissions', { restaurant_id: rid, kind: 'text', data: { name: name || from, phone: from, message: text(params.Body, 1600) } });
  await sendEmail(cfg.r.forms_email, `${cfg.r.name}: text from ${name || from}`, `${name || from} (${from}) texted:\n\n${text(params.Body, 1600)}\n\nReply from the admin's Messages tab or call them.`, null);
  return twiml();
}

/** Refund through the restaurant's own processor. Staff see the processor's message if it says no. */
async function processorRefund(o: any, cents: number, reason: string | null) {
  if (!o.payment_ref) throw new OrderError('This payment has no processor reference. Refund it in your card processor\'s dashboard.');
  const pay = await payFor(o.restaurant_id);
  if (!pay?.ctx || pay.provider !== o.payment_provider) throw new OrderError(`This order was paid through ${o.payment_provider}, which is no longer connected. Refund it in that dashboard.`);
  try {
    const res = await PROCESSORS[pay.provider].refund(pay.ctx, { txn: o.payment_ref, cents, charged_cents: o.amount_due_cents ?? o.total_cents, refunded_cents: o.refunded_cents, reason, key: `rf-${o.id.slice(0, 8)}-${o.refunded_cents}-${cents}` });
    return res.id as string;
  } catch (e) {
    if (e instanceof PayError) throw new OrderError(e.message);
    throw e;
  }
}

// Partial or full refund from the admin. Gift card amounts go back to the card.
async function refundOrder(r: any, me: any, body: any) {
  const [o] = await db(`orders?select=*&order_no=eq.${encodeURIComponent(String(body.order_no ?? ''))}&restaurant_id=eq.${r.id}`);
  if (!o) throw new OrderError('Order not found.');
  if (!['paid', 'test_paid', 'partly_refunded'].includes(o.payment_status)) throw new OrderError(`This order can't be refunded (${o.payment_status.replace(/_/g, ' ')}).`);
  const paidByCard = (o.amount_due_cents ?? o.total_cents) - o.refunded_cents;
  const cents = Math.round(Number(body.cents));
  if (!Number.isInteger(cents) || cents <= 0) throw new OrderError('Enter an amount to refund.');
  if (cents > paidByCard) throw new OrderError(`You can refund up to ${money(paidByCard)} on this order.`);
  let stripeId: string | null = null, providerId: string | null = null;
  const reason = text(body.reason, 200) || null;
  if (o.payment_status !== 'test_paid' && o.payment_provider !== 'stripe') {
    providerId = await processorRefund(o, cents, reason);
  } else if (o.payment_status !== 'test_paid' && o.stripe_payment_intent) {
    const [x] = await db(`restaurants?select=stripe_account_id&id=eq.${r.id}`);
    stripeId = (await stripe('refunds', { payment_intent: o.stripe_payment_intent, amount: String(cents) }, x.stripe_account_id, `refund-${o.id}-${o.refunded_cents}-${cents}`)).id;
  }
  await insert('refunds', { order_id: o.id, cents, reason, by_name: me.name, stripe_refund_id: stripeId, provider_refund_id: providerId });
  const total = o.refunded_cents + cents;
  await patch('orders', `id=eq.${o.id}`, { refunded_cents: total, payment_status: total >= paidByCard + o.refunded_cents && o.payment_status !== 'test_paid' ? 'refunded' : o.payment_status === 'test_paid' ? 'test_paid' : 'partly_refunded' });
  await log(o.id, 'admin', 'refund', { cents, by: me.name, reason });
  await sendEmail(o.email, `Refund from ${r.name}`, `Hi ${o.first_name}, we refunded ${money(cents)} on order ${o.order_no}${reason ? ` (${reason})` : ''}. It can take 5 to 10 business days to show on your card.`, o.id);
  return json({ ok: true, refunded_cents: total });
}

// Website: banner, specials and this week's hours (with special hours), read by every page.
async function siteInfo(body: any) {
  const r = await rid(body.restaurant, 'id,timezone,hours');
  await withExceptions(r);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: r.timezone }).format(new Date());
  const notices = await db(`site_notices?select=kind,title,body,link_text,link_url&restaurant_id=eq.${r.id}&active=eq.true&or=(starts_on.is.null,starts_on.lte.${today})&or=(ends_on.is.null,ends_on.gte.${today})&order=sort.asc,created_at.desc&limit=20`);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    const ymd = d.toISOString().slice(0, 10), day = d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }).toLowerCase().slice(0, 3);
    return { date: ymd, ranges: windowsFor(r, ymd, day), special: r.exceptions[ymd] ? (r.exceptions[ymd].note || 'Special hours') : null };
  });
  return json({ ok: true, banner: notices.filter((n: any) => n.kind === 'banner')[0] ?? null, specials: notices.filter((n: any) => n.kind === 'special'), days });
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
  const c = await priceWithCredits(r.id, lines, r, body.tip_cents, guest.phone, body.rewards_code, body.gift_code, fee, body.promo_code);
  const { t } = c;

  const [full] = await db(`restaurants?select=stripe_account_id,site_url&id=eq.${r.id}`);
  const [o] = await insert('orders', {
    restaurant_id: r.id, pickup_at: new Date(pickup_at).toISOString(), ...guest, ...t, gift_applied_cents: c.gift_applied_cents,
    amount_due_cents: c.amount_due_cents, test_mode: r.test_mode, fulfillment: delivering ? 'delivery' : 'pickup', delivery_address: address,
    attribution: cleanAttribution(body.attribution, req),
    promo_code_id: c.promo?.id ?? null, promo_cents: c.promo_cents, sms_updates: body.consent?.sms_updates === true,
  });
  await insert('order_items', lines.map((l) => ({ ...l, order_id: o.id })));
  await log(o.id, 'guest', 'placed', { ip });
  await saveConsent(r.id, { phone: guest.phone, email: guest.email, first_name: guest.first_name, last_name: guest.last_name }, body.consent);
  const status_url = `${full.site_url}/order/?t=${o.token}`;
  try {
    if (c.account && (await rpc('rewards_change', { p_account: c.account.id, p_delta: -c.points, p_reason: 'redeemed', p_order: o.id })) === null) throw new OrderError('Your rewards balance changed. Please try again.');
    if (c.card && (await rpc('gift_change', { p_card: c.card.id, p_delta: -c.gift_applied_cents, p_reason: 'redeemed', p_order: o.id })) === null) throw new OrderError('Your gift card balance changed. Please try again.');
  } catch (e) {
    await patch('orders', `id=eq.${o.id}`, { status: 'expired' });
    await rpc('order_release_credits', { p_order: o.id });
    throw e;
  }

  const pay = await payFor(r.id);
  const unpaid = async (e: unknown) => {
    await patch('orders', `id=eq.${o.id}`, { status: 'expired' });
    await rpc('order_release_credits', { p_order: o.id });
    throw e;
  };
  if (pay ? !pay.ctx : !STRIPE) {
    if (!r.test_mode) await unpaid(new OrderError("Card payments aren't set up yet. Please call us to order."));
    await markPaid(o, 'test_paid');
    return json({ ok: true, order_no: o.order_no, token: o.token, redirect: status_url, test: true });
  }
  if (c.amount_due_cents === 0) {
    await markPaid(o, 'gift_card');
    return json({ ok: true, order_no: o.order_no, token: o.token, redirect: status_url });
  }
  const origin = /^https:\/\//.test(String(body.return_url ?? '')) ? String(body.return_url).replace(/\/$/, '') : full.site_url;
  if (pay) {
    const page = await startPayment(pay, r.id, {
      cents: c.amount_due_cents, name: `${r.name} order ${o.order_no}`, email: guest.email, first_name: guest.first_name, last_name: guest.last_name,
      ref: o.id, success_url: `${origin}/order/?t=${o.token}`, cancel_url: `${origin}/menu/?cancelled=1`,
    }).catch(unpaid);
    await patch('orders', `id=eq.${o.id}`, { payment_provider: pay.provider, payment_session: page.session, payment_ref: page.ref ?? null });
    return json({ ok: true, order_no: o.order_no, token: o.token, redirect: page.redirect, post: page.post });
  }
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

async function priceWithCredits(restaurantId: string, lines: any[], r: any, tip: unknown, phone: string, rewardsCode: unknown, giftCode: unknown, deliveryCents = 0, promoCode: unknown = '') {
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
  let promo: any = null, promo_cents = 0;
  const pc = cleanCode(promoCode);
  if (pc) {
    [promo] = await db(`promo_codes?select=*&restaurant_id=eq.${restaurantId}&code=eq.${pc}&active=eq.true`);
    const now = Date.now();
    if (!promo || (promo.starts_at && Date.parse(promo.starts_at) > now) || (promo.ends_at && Date.parse(promo.ends_at) < now)) throw new OrderError("That promo code isn't valid right now.");
    const sub = lines.reduce((n, l) => n + l.line_total_cents, 0);
    if (sub < promo.min_subtotal_cents) throw new OrderError(`That code needs an order of ${money(promo.min_subtotal_cents)} or more.`);
    const live = 'status=in.(awaiting_payment,new,accepted,ready,completed)';
    if (promo.max_uses != null && (await db(`orders?select=id&promo_code_id=eq.${promo.id}&${live}&limit=${promo.max_uses}`)).length >= promo.max_uses) throw new OrderError('That promo code has been used up.');
    if (promo.once_per_guest) {
      if (!phone) throw new OrderError('Enter your phone number to use a promo code.');
      if ((await db(`orders?select=id&promo_code_id=eq.${promo.id}&phone=eq.${encodeURIComponent(phone)}&${live}&limit=1`)).length) throw new OrderError("You've already used this code.");
    }
    promo_cents = promoDiscount(promo, Math.max(0, sub - discount));
  }
  const t = totals(lines, r, tip, discount + promo_cents, deliveryCents);
  let card: any = null, gift = { gift_applied_cents: 0, amount_due_cents: t.total_cents };
  const gc = cleanCode(giftCode);
  if (gc) {
    [card] = await db(`gift_cards?select=id,balance_cents&restaurant_id=eq.${restaurantId}&code=eq.${gc}&status=eq.active`);
    if (!card) throw new OrderError("We couldn't find that gift card.");
    if (card.balance_cents <= 0) throw new OrderError('That gift card has no balance left.');
    gift = applyGift(t.total_cents, card.balance_cents);
  }
  return { t, account, points, card, promo, promo_cents, ...gift };
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
  const bm = Math.floor(Number(d.birth_month)), bd = Math.floor(Number(d.birth_day));
  if (bm >= 1 && bm <= 12 && bd >= 1 && bd <= 31) await rpc('upsert_customer', { rid: r.id, p: { phone, birth_month: bm, birth_day: bd } }).catch(() => null);
  if (d.sms_consent === 'yes') await automationSms(r.id, a.customer_id, phone, 'welcome', { code }, `welcome:${a.id}`, true);
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
    res = await bookTable(r, data, String(body.restaurant), attribution);
  }
  if (kind !== 'reservation' && kind !== 'rewards') await insert('form_submissions', { restaurant_id: r.id, kind, data });
  const lines = Object.entries(data).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('\n');
  await sendEmail(r.forms_email, `${r.name}: new ${kind.replace(/-/g, ' ')} form`, `${lines}\n\nSent from ${text(body.page, 100) || 'the website'}.`, null, validEmail(data.email ?? '') ? data.email : undefined);
  return res ?? json({ ok: true });
}

// ---------- reservations ----------
const resDateText = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });

async function bookTable(r: any, data: Record<string, string>, slug: string, attribution: any) {
  const phone = normPhone(data.phone), email = (data.email ?? '').toLowerCase(), name = text(data.name, 80);
  const guests = Math.floor(Number(data.guests)), start_min = Math.floor(Number(data.start_min));
  if (!name) throw new OrderError('Please enter your name.');
  if (!validEmail(email)) throw new OrderError('Please enter a valid email.');
  if (!phone) throw new OrderError('Please enter a 10-digit phone number.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date))) throw new OrderError('Please pick a date.');
  if (!Number.isInteger(guests) || guests < 1 || guests > 200) throw new OrderError('Please pick your party size.');
  if (!Number.isInteger(start_min) || start_min < 0 || start_min > 1439) throw new OrderError('Please pick a time.');
  const b = await rpc('res_book', { rid: r.id, p: { name, email, phone, date: data.date, start_min, guests, requests: text(data.requests, 500) } });
  if (!b.ok) throw new OrderError(b.error);
  if (attribution) await patch('reservations', `id=eq.${b.id}`, { attribution });
  await reportConversion(slug, {
    type: 'reservation', externalId: b.id, reservationId: b.id, valueCents: 0, customer: { phone, email },
    extra: { res_date: data.date, res_time: b.label, party_size: String(guests) },
  }, attribution, null);
  if (data.sms_updates === 'yes') {
    await patch('reservations', `id=eq.${b.id}`, { sms_updates: true });
    await saveConsent(r.id, { phone, email }, { sms_updates: true });
  }
  data.time = b.label; data.status = b.status; delete data.start_min; // readable in the restaurant's email
  const [x] = await db(`restaurants?select=name,phone,site_url&id=eq.${r.id}`);
  const when = `${resDateText(data.date)} at ${b.label}`;
  const cancel = `${x.site_url}/reservations/?cancel=${b.token}`;
  await sendEmail(email, b.status === 'confirmed' ? `Your ${x.name} reservation is confirmed` : `We got your ${x.name} reservation request`,
    b.status === 'confirmed'
      ? `Hi ${name}, you're all set for ${when}, party of ${guests}. We look forward to seeing you!\n\nNeed to cancel? ${cancel}\nQuestions? Call ${x.phone}.`
      : `Hi ${name}, thanks for your request for ${when}, party of ${guests}. For larger groups we confirm by phone or email shortly.\n\nNeed to cancel? ${cancel}\nQuestions? Call ${x.phone}.`, null);
  return json({ ok: true, status: b.status, when, guests, large: b.large });
}

async function resInfo(body: any) {
  const r = await rid(body.restaurant, 'id,phone,timezone,res_max_online,res_days_ahead,res_slot_minutes');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: r.timezone }).format(new Date());
  return json({ ok: true, phone: r.phone, max_online: r.res_max_online, days_ahead: r.res_days_ahead, today });
}

// ---------- gift cards ----------
async function activateGift(card: any, intent?: string, ref?: string) {
  const rows = await patch('gift_cards', `id=eq.${card.id}&status=eq.pending`, { status: 'active', balance_cents: card.initial_cents, activated_at: new Date().toISOString(), stripe_payment_intent: intent ?? null, ...(ref ? { payment_ref: ref } : {}) });
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
  const pay = await payFor(r.id);
  if (pay ? !pay.ctx : !STRIPE) {
    if (!r.test_mode) throw new OrderError("Gift cards can't be bought online yet. Please call us.");
  }
  const [card] = await insert('gift_cards', { restaurant_id: r.id, code: makeCode(16), initial_cents: cents, buyer_name, buyer_email, recipient_name: recipient_name || null, recipient_email: recipient_email || null, message: text(body.message, 300) || null, test_mode: r.test_mode });
  if (pay ? !pay.ctx : !STRIPE) {
    await activateGift(card);
    return json({ ok: true, token: card.token, test: true });
  }
  const origin = /^https:\/\//.test(String(body.return_url ?? '')) ? String(body.return_url).replace(/\/$/, '') : r.site_url;
  if (pay) {
    const page = await startPayment(pay, r.id, {
      cents, name: `${r.name} gift card`, email: buyer_email, first_name: buyer_name.split(' ')[0], last_name: buyer_name.split(' ').slice(1).join(' '),
      ref: card.id, success_url: `${origin}/gift-cards/?g=${card.token}`, cancel_url: `${origin}/gift-cards/`,
    }).catch(async (e) => { await patch('gift_cards', `id=eq.${card.id}`, { status: 'void' }); throw e; });
    await patch('gift_cards', `id=eq.${card.id}`, { payment_provider: pay.provider, payment_session: page.session, payment_ref: page.ref ?? null });
    return json({ ok: true, token: card.token, redirect: page.redirect, post: page.post });
  }
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
  const r = await rid(body.restaurant, 'id,slug,name,phone,site_url,rewards_redeem_points,rewards_redeem_cents,test_mode');
  const me = await staffFor(req, r.id);
  if (!me) return json({ ok: false, error: 'Please sign in again.' }, 401);
  const need = (perm: string) => { if (!me.perms.includes(perm)) throw new OrderError("Your login doesn't have access to this. Ask the owner."); };
  const op = String(body.op ?? '');
  const SECTION: Record<string, string> = {
    reservations: 'reservations', reservation: 'reservations', messages: 'messages', message: 'messages',
    rewards_find: 'rewards', rewards_adjust: 'rewards', gift_find: 'gift', gift_redeem: 'gift', gift_issue: 'gift',
    refund: 'orders', pay_test: 'settings', res_status: 'reservations', msg_settings: 'settings', msg_test: 'campaigns', campaign_send: 'campaigns', message_customer: 'customers',
    team_list: 'team', team_save: 'team', team_remove: 'team',
    mkt_report: 'marketing', mkt_campaigns: 'marketing', mkt_link: 'marketing', mkt_spend: 'marketing',
  };
  if (SECTION[op]) need(SECTION[op]);
  if (op.startsWith('mkt_')) return await marketing(r, op, body);
  if (op.startsWith('team_')) return await team(r, me, op, body);
  const id = encodeURIComponent(String(body.id ?? ''));
  const scope = `restaurant_id=eq.${r.id}`;
  switch (op) {
    case 'counts': {
      const count = async (t: string, q: string) => (await db(`${t}?select=id&${scope}&${q}`)).length;
      return json({ ok: true, reservations: me.perms.includes('reservations') ? await count('reservations', 'status=eq.requested') : 0, messages: me.perms.includes('messages') ? await count('form_submissions', 'status=eq.new') : 0 });
    }
    case 'reservations': {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) {
        const rows = await db(`reservations?select=*&${scope}&res_date=eq.${body.date}&status=in.(requested,confirmed,seated,no_show)&order=start_min.asc.nullslast,res_time.asc&limit=300`);
        const [cap] = await db(`restaurants?select=res_capacity&id=eq.${r.id}`);
        const blocks = await db(`res_blocks?select=id,start_min,end_min,reason&${scope}&block_date=eq.${body.date}&order=start_min.asc.nullsfirst`);
        return json({ ok: true, rows, slots: await rpc('res_day', { rid: r.id, d: body.date }), capacity: cap.res_capacity, blocks });
      }
      const today = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      return json({ ok: true, rows: await db(`reservations?select=*&${scope}&res_date=gte.${today}&status=in.(requested,confirmed)&order=res_date.asc,start_min.asc.nullslast&limit=100`) });
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
    case 'refund': return await refundOrder(r, me, body);
    case 'pay_test': {
      const pay = await payFor(r.id);
      if (!pay) return json({ ok: true, message: STRIPE ? 'Using Stripe.' : 'Stripe is not set up yet.' });
      if (!pay.ctx) throw new OrderError('Save the key first.');
      try {
        const message = await PROCESSORS[pay.provider].test(pay.ctx);
        await payNote(r.id, true);
        return json({ ok: true, message });
      } catch (e) {
        await payNote(r.id, false, e instanceof Error ? e.message : e);
        if (e instanceof PayError) throw new OrderError(e.message);
        throw e;
      }
    }
    case 'res_status': {
      const to = { seated: 'seated', no_show: 'no_show' }[String(body.move)];
      if (!to) throw new OrderError('Unknown action.');
      const [row] = await patch('reservations', `id=eq.${id}&${scope}&status=in.(confirmed,requested,seated,no_show)`, { status: to, handled_by: me.name });
      return row ? json({ ok: true, status: to }) : json({ ok: false, error: 'Reservation not found.' });
    }
    case 'msg_settings': return await saveMessaging(r, body);
    case 'msg_test': {
      const to = String(body.to ?? '').trim();
      const ch = body.channel === 'sms' ? 'sms' : 'email';
      const addr = ch === 'sms' ? normPhone(to) : to.toLowerCase();
      if (!addr || (ch === 'email' && !validEmail(addr))) throw new OrderError(ch === 'sms' ? 'Enter a 10-digit phone number.' : 'Enter a valid email.');
      const [m] = await insert('messages', { restaurant_id: r.id, channel: ch, kind: 'test', to_addr: addr, subject: text(body.subject, 200) || `Test from ${r.name}`, body: text(body.body, 1500) || `This is a test message from ${r.name}.`, marketing: false });
      return json({ ok: true, ...(await deliver(m, new Map())) });
    }
    case 'campaign_send': {
      const [cp] = await patch('msg_campaigns', `id=eq.${id}&${scope}&status=in.(draft,scheduled)`, { status: 'scheduled', send_at: new Date().toISOString() });
      if (!cp) throw new OrderError('This campaign was already sent.');
      const queued = await rpc('campaign_queue', { cid: cp.id });
      const sent = await sendQueued(r.id, 300);
      return json({ ok: true, queued, ...sent });
    }
    case 'message_customer': {
      const [c] = await db(`customers?select=*&id=eq.${id}&${scope}`);
      if (!c) throw new OrderError('Customer not found.');
      const ch = body.channel === 'sms' ? 'sms' : 'email';
      const msg = text(body.body, 1500);
      if (!msg) throw new OrderError('Write a message first.');
      if (ch === 'sms' && (!c.phone || c.sms_stopped_at || !(c.sms_updates || c.sms_marketing))) throw new OrderError("This guest hasn't agreed to texts. Email them or call instead.");
      if (ch === 'email' && !c.email) throw new OrderError('This guest has no email on file.');
      const [m] = await insert('messages', { restaurant_id: r.id, customer_id: c.id, channel: ch, kind: 'staff', to_addr: ch === 'sms' ? c.phone : c.email, subject: text(body.subject, 200) || `A note from ${r.name}`, body: msg, marketing: false });
      return json({ ok: true, ...(await deliver(m, new Map())) });
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

// ---------- team access ----------
// Anyone with 'team' access can add people, choose what they see, and remove them.
// New logins get a one-time temporary password that the person adding them passes on.
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(14));
  return [...b].map((x) => abc[x % abc.length]).join('');
}
async function team(r: any, me: any, op: string, body: any) {
  const scope = `restaurant_id=eq.${r.id}`;
  if (op === 'team_list') {
    const rows = await db(`staff?select=user_id,name,role,permissions,created_at&${scope}&order=created_at.asc`);
    const users = await Promise.all(rows.map(async (s: any) => {
      const u = await fetch(`${SB_URL}/auth/v1/admin/users/${s.user_id}`, { headers: svc }).then((x) => x.json()).catch(() => ({}));
      return { ...s, email: u.email ?? '', last_sign_in_at: u.last_sign_in_at ?? null, you: s.user_id === me.id };
    }));
    return json({ ok: true, rows: users, sections: ALL_PERMS, roles: ROLE_PERMS });
  }
  if (op === 'team_save') {
    const email = text(body.email, 120).toLowerCase(), name = text(body.name, 80);
    const role = ['owner', 'manager', 'kitchen', 'custom'].includes(body.role) ? body.role : 'custom';
    const perms: string[] = role === 'custom' ? [...new Set<string>((Array.isArray(body.permissions) ? body.permissions : []).map(String))].filter((p) => ALL_PERMS.includes(p)) : ROLE_PERMS[role];
    if (!validEmail(email)) throw new OrderError('Enter a valid email.');
    if (!perms.length) throw new OrderError('Pick at least one section this person can use.');
    let id = await rpc('auth_user_id', { p_email: email });
    if (id === me.id && !perms.includes('team')) throw new OrderError("You can't remove your own team access.");
    let password: string | null = null;
    if (!id) {
      password = tempPassword();
      const made = await fetch(`${SB_URL}/auth/v1/admin/users`, { method: 'POST', headers: svc, body: JSON.stringify({ email, password, email_confirm: true }) });
      const d = await made.json().catch(() => ({}));
      if (!made.ok) throw new Error(`auth ${made.status}: ${d.msg ?? d.message ?? 'could not create login'}`);
      id = d.id;
    }
    await db('staff?on_conflict=user_id,restaurant_id', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: id, restaurant_id: r.id, name: name || null, role, permissions: perms }),
    });
    await log(null, 'team', 'saved', { restaurant: r.id, user: id, role, permissions: perms, by: me.email });
    return json({ ok: true, email, temp_password: password });
  }
  if (op === 'team_remove') {
    const uid = String(body.user_id ?? '');
    if (!/^[0-9a-f-]{36}$/.test(uid)) throw new OrderError('Person not found.');
    if (uid === me.id) throw new OrderError("You can't remove yourself.");
    await db(`staff?user_id=eq.${uid}&${scope}`, { method: 'DELETE' });
    await log(null, 'team', 'removed', { restaurant: r.id, user: uid, by: me.email });
    return json({ ok: true });
  }
  return json({ ok: false, error: 'Unknown action.' }, 400);
}

// ---------- marketing (attribution service) ----------
// The admin's Marketing tab goes through here, so staff never handle the restaurant's API key.
async function marketing(r: any, op: string, body: any) {
  const ATTR_URL = (Deno.env.get('ATTRIBUTION_URL') ?? '').trim().replace(/\/$/, '');
  const key = attrKeys()[r.slug] || attrKeys()['*'];
  if (!ATTR_URL || !key) throw new OrderError('Marketing tracking is not set up for this restaurant yet.');
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${ATTR_URL}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new OrderError(d.error ? `Marketing: ${d.error}` : 'Marketing data is not available right now.');
    return d;
  };
  const q = `restaurant=${encodeURIComponent(r.slug)}`;
  if (op === 'mkt_report') {
    const [report, c] = await Promise.all([call(`/api/report?${q}`), call(`/api/campaigns?${q}`)]);
    return json({ ok: true, report, campaigns: c.campaigns, qr_url: `${ATTR_URL}/api/qr` });
  }
  if (op === 'mkt_link') {
    const c = body.campaign ?? {};
    return json({ ok: true, ...(await call('/api/links', { method: 'POST', body: JSON.stringify({
      restaurant: r.slug, slug: text(body.slug, 80) || undefined, destinationUrl: text(body.destinationUrl, 1000), isQr: body.isQr === true,
      campaign: { name: text(c.name, 200), channel: text(c.channel, 50), promoCode: text(c.promoCode, 64) || undefined, trackingPhone: text(c.trackingPhone, 40) || undefined },
    }) })) });
  }
  if (op === 'mkt_spend') {
    return json({ ok: true, ...(await call('/api/spend', { method: 'POST', body: JSON.stringify({ restaurant: r.slug, campaignId: String(body.campaignId ?? ''), date: String(body.date ?? ''), amount: Number(body.amount) }) })) });
  }
  return json({ ok: false, error: 'Unknown action.' }, 400);
}

async function kitchen(req: Request, body: any) {
  const [o] = await db(`orders?select=*&id=eq.${encodeURIComponent(String(body.order_id ?? ''))}`);
  if (!o) return json({ ok: false, error: 'Order not found.' }, 404);
  const staff = await staffFor(req, o.restaurant_id);
  if (!staff) return json({ ok: false, error: 'Please sign in again.' }, 401);
  if (!staff.perms.includes('kitchen')) return json({ ok: false, error: "Your login doesn't have kitchen access." }, 403);
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
    if (o.payment_status === 'paid' && o.payment_provider !== 'stripe') {
      const left = (o.amount_due_cents ?? o.total_cents) - o.refunded_cents;
      if (left > 0) {
        const id = await processorRefund(o, left, up.cancel_reason as string);
        await insert('refunds', { order_id: o.id, cents: left, reason: up.cancel_reason, by_name: staff.name, provider_refund_id: id });
        up.refunded_cents = o.refunded_cents + left;
      }
      up.payment_status = 'refunded';
    } else if (o.payment_status === 'paid' && o.stripe_payment_intent) {
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
  if (to === 'ready' && o.sms_updates) await automationSms(o.restaurant_id, o.customer_id, o.phone, 'order_ready', { order_no: o.order_no }, `ready:${o.id}`, false);
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
    const url = new URL(req.url), qs = url.searchParams;
    const payHook = url.pathname.match(/\/pay\/(authorizenet|clover|square)\/([0-9a-f-]{36})\/?$/);
    if (payHook) return await handlePayHook(req, payHook[1], payHook[2]);
    if (qs.get('hook') === 'stripe') return await handleStripeHook(req);
    if (qs.get('hook') === 'twilio') return await handleTwilio(req, qs.get('r') ?? '');
    if (qs.get('unsub')) {
      await patch('customers', `unsub_token=eq.${qs.get('unsub')!.replace(/[^a-f0-9]/g, '')}`, { email_marketing: false, email_unsub_at: new Date().toISOString() });
      return json({ ok: true });
    }
    if (qs.get('job') === 'tick') {
      const key = JOB_KEY || (await rpc('job_key', {}).catch(() => null));
      if (!key || req.headers.get('x-job-key') !== key) return json({ ok: false }, 401);
      return json({ ok: true, ...(await tick()) });
    }
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
        const c = await priceWithCredits(menu.restaurant.id, lines, menu.restaurant, body.tip_cents, normPhone(body.phone), body.rewards_code, body.gift_code, fee, body.promo_code);
        return json({ ok: true, ...c.t, promo_cents: c.promo_cents, promo_code: c.promo?.code ?? null, gift_applied_cents: c.gift_applied_cents, amount_due_cents: c.amount_due_cents });
      }
      case 'checkout':
        return await checkout(req, body);
      case 'status': {
        const token = String(body.token ?? '').replace(/[^a-f0-9]/g, '');
        if (!token) return json({ ok: false, error: 'Order not found.' }, 404);
        const [w] = await db(`orders?select=*&token=eq.${token}&status=eq.awaiting_payment&payment_provider=neq.stripe`);
        if (w && (await rpc('rate_limit', { p_key: `paycheck:${w.id}`, p_max: 1, p_seconds: 8 }))) await checkPayment('order', w).catch((e) => console.error('pay check', e instanceof Error ? e.message : e));
        const rows = await db(`orders?select=order_no,status,payment_status,pickup_at,first_name,subtotal_cents,discount_cents,gift_applied_cents,amount_due_cents,delivery_fee_cents,fulfillment,delivery_address,delivery_tracking_url,delivery_status,tax_cents,guest_fee_cents,tip_cents,total_cents,test_mode,cancel_reason,restaurant:restaurants(name,phone,address,timezone),items:order_items(name,qty,line_total_cents,options,note,menu_item_id,option_ids)&token=eq.${token}`);
        return rows?.[0] ? json({ ok: true, order: rows[0] }) : json({ ok: false, error: 'Order not found.' }, 404);
      }
      case 'kitchen':
        return await kitchen(req, body);
      case 'form':
        return await submitForm(req, body);
      case 'site_info': return await siteInfo(body);
      case 'unsubscribe': {
        const token = String(body.token ?? '').replace(/[^a-f0-9]/g, '');
        const resub = body.resubscribe === true;
        const rows = token ? await patch('customers', `unsub_token=eq.${token}`, resub ? { email_marketing: true, email_unsub_at: null } : { email_marketing: false, email_unsub_at: new Date().toISOString() }) : [];
        return rows?.length ? json({ ok: true, subscribed: resub }) : json({ ok: false, error: 'That link has expired.' });
      }
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
      case 'res_info':
        return await resInfo(body);
      case 'res_month': {
        await limited(req, 'res-cal', 120);
        const r = await rid(body.restaurant);
        if (!/^\d{4}-\d{2}$/.test(String(body.month))) throw new OrderError('Pick a month.');
        const guests = Math.max(1, Math.min(200, Math.floor(Number(body.guests)) || 2));
        return json({ ok: true, days: await rpc('res_month', { rid: r.id, month_start: `${body.month}-01`, p_guests: guests }) });
      }
      case 'res_slots': {
        await limited(req, 'res-cal', 120);
        const r = await rid(body.restaurant);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) throw new OrderError('Pick a date.');
        return json({ ok: true, slots: await rpc('res_day', { rid: r.id, d: body.date }) });
      }
      case 'res_cancel': {
        await limited(req, 'res-cancel', 10);
        const token = String(body.token ?? '').replace(/[^a-f0-9]/g, '');
        const c = token ? await rpc('res_cancel', { p_token: token }) : { ok: false, error: 'Reservation not found.' };
        if (!c.ok) return json(c);
        const [x] = await db(`restaurants?select=name,phone,forms_email&id=eq.${c.restaurant_id}`);
        const when = `${resDateText(c.date)} at ${c.label}`;
        await sendEmail(c.email, `Your ${x.name} reservation is cancelled`, `Hi ${c.name}, your reservation for ${when} is cancelled. We hope to see you another time!`, null);
        await sendEmail(x.forms_email, `${x.name}: reservation cancelled`, `${c.name} cancelled their reservation for ${when}, party of ${c.guests}.`, null);
        return json({ ok: true, when });
      }
      case 'gift_buy':
        return await giftBuy(req, body);
      case 'gift_view': {
        const token = String(body.token ?? '').replace(/[^a-f0-9]/g, '');
        const [w] = token ? await db(`gift_cards?select=*&token=eq.${token}&status=eq.pending&payment_provider=neq.stripe`) : [];
        if (w && (await rpc('rate_limit', { p_key: `paycheck:${w.id}`, p_max: 1, p_seconds: 8 }))) await checkPayment('gift', w).catch((e) => console.error('pay check', e instanceof Error ? e.message : e));
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
        const who = r ? await staffFor(req, r.id) : null;
        if (!who) return json({ ok: false, error: 'Please sign in again.' }, 401);
        if (!who.perms.includes('kitchen')) return json({ ok: false, error: "Your login doesn't have kitchen access." }, 403);
        await patch('restaurants', `id=eq.${r.id}`, { accepting_orders: !!body.accepting });
        return json({ ok: true, accepting: !!body.accepting });
      }
      default:
        return json({ ok: false, error: 'Unknown action.' }, 400);
    }
  } catch (e) {
    if (e instanceof OrderError) return json({ ok: false, error: e.message });
    if (e instanceof PayError) return json({ ok: false, error: e.message });
    console.error(e instanceof Error ? e.message : e);
    return json({ ok: false, error: 'Something went wrong. Please try again or call us.' }, 500);
  }
});
