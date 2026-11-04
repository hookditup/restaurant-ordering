// Online ordering API. One function, several actions (POST JSON { action, ... }):
//   slots      guest: pickup times
//   quote      guest: price a cart on the server
//   checkout   guest: create the order and a Stripe Checkout page
//   status     guest: order progress by private token
//   kitchen    staff: accept | ready | complete | cancel an order
//   pause      staff: stop or resume taking orders
//   ?hook=stripe  Stripe webhook
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, EMAIL_FROM.
// With no Stripe key, a restaurant in test mode marks orders as test-paid. Live mode never does.
import { cleanGuest, NEXT, OrderError, pickupSlots, priceCart, totals, validPickup } from './core.js';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const STRIPE_HOOK = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
const RESEND = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('EMAIL_FROM') ?? '';

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

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const timeText = (iso: string, tz: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });

async function menuFor(slug: string) {
  const m = await rpc('get_menu', { p_slug: String(slug ?? '') });
  if (!m) throw new OrderError('Restaurant not found.');
  return m;
}

async function sendEmail(to: string | null, subject: string, text: string, orderId: string | null) {
  if (!to) return;
  if (!RESEND || !FROM) { await log(orderId, 'email', 'not_sent_no_provider', { subject }); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, text }),
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

async function markPaid(o: any, payment_status: string, intent?: string) {
  const rows = await patch('orders', `id=eq.${o.id}&status=eq.awaiting_payment`, {
    status: 'new', payment_status, paid_at: new Date().toISOString(), stripe_payment_intent: intent ?? null,
  });
  if (!rows?.length) return;
  const [r] = await db(`restaurants?select=name,timezone,alert_email,site_url&id=eq.${o.restaurant_id}`);
  await log(o.id, 'payment', payment_status);
  await sendEmail(o.email, `${r.name} order ${o.order_no} received`,
    `Thanks ${o.first_name}! We got your order. Pickup: ${timeText(o.pickup_at, r.timezone)}.\nTotal: ${money(o.total_cents)}\n\nTrack it: ${r.site_url}/order/?t=${o.token}`, o.id);
  await sendEmail(r.alert_email, `New online order ${o.order_no}`, `${o.first_name} ${o.last_name}, pickup ${timeText(o.pickup_at, r.timezone)}, ${money(o.total_cents)}.`, o.id);
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
  const orderId = s.metadata?.order_id;
  if (!orderId) return json({ ok: true });
  const [o] = await db(`orders?select=*&id=eq.${encodeURIComponent(orderId)}`);
  if (!o) return json({ ok: true });
  if (ev.type === 'checkout.session.completed' && s.payment_status === 'paid') {
    if (s.amount_total !== o.total_cents) { await log(o.id, 'stripe', 'amount_mismatch', { paid: s.amount_total }); return json({ ok: true }); }
    await markPaid(o, 'paid', s.payment_intent);
  } else if (ev.type === 'checkout.session.expired') {
    await patch('orders', `id=eq.${o.id}&status=eq.awaiting_payment`, { status: 'expired' });
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
  if (!pickup_at || !validPickup(r, pickup_at)) throw new OrderError('That pickup time is no longer available. Please pick another.');
  const guest = cleanGuest(body.guest);
  const lines = priceCart(menu, body.items, pickup_at);
  const t = totals(lines, r, body.tip_cents);

  const [full] = await db(`restaurants?select=stripe_account_id,site_url&id=eq.${r.id}`);
  const [o] = await insert('orders', {
    restaurant_id: r.id, pickup_at: new Date(pickup_at).toISOString(), ...guest, ...t, test_mode: r.test_mode,
  });
  await insert('order_items', lines.map((l) => ({ ...l, order_id: o.id })));
  await log(o.id, 'guest', 'placed', { ip });
  const status_url = `${full.site_url}/order/?t=${o.token}`;

  if (!STRIPE) {
    if (!r.test_mode) throw new Error('Stripe is not configured for a live restaurant.');
    await markPaid(o, 'test_paid');
    return json({ ok: true, order_no: o.order_no, token: o.token, redirect: status_url, test: true });
  }
  const origin = /^https:\/\//.test(String(body.return_url ?? '')) ? String(body.return_url).replace(/\/$/, '') : full.site_url;
  const session = await stripe('checkout/sessions', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(t.total_cents),
    'line_items[0][price_data][product_data][name]': `${r.name} order ${o.order_no}`,
    customer_email: guest.email,
    success_url: `${origin}/order/?t=${o.token}`,
    cancel_url: `${origin}/menu/?cancelled=1`,
    expires_at: String(Math.floor(Date.now() / 1000) + 1800),
    'metadata[order_id]': o.id,
    'payment_intent_data[metadata][order_id]': o.id,
  }, full.stripe_account_id, `order-${o.id}`);
  await patch('orders', `id=eq.${o.id}`, { stripe_session_id: session.id });
  return json({ ok: true, order_no: o.order_no, token: o.token, redirect: session.url });
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
  if (to === 'accepted') up.accepted_at = now;
  if (to === 'ready') up.ready_at = now;
  if (to === 'completed') up.completed_at = now;
  if (to === 'cancelled') {
    up.cancelled_at = now;
    up.cancel_reason = String(body.reason ?? '').replace(/[<>]/g, '').slice(0, 200) || 'Cancelled by the restaurant';
    if (o.payment_status === 'paid' && o.stripe_payment_intent) {
      const [res] = await db(`restaurants?select=stripe_account_id&id=eq.${o.restaurant_id}`);
      await stripe('refunds', { payment_intent: o.stripe_payment_intent }, res.stripe_account_id, `refund-${o.id}`);
      up.payment_status = 'refunded';
    }
  }
  const rows = await patch('orders', `id=eq.${o.id}&status=eq.${o.status}`, up);
  if (!rows?.length) return json({ ok: false, error: 'Someone else just updated this order.' });
  await log(o.id, 'kitchen', to, { by: staff.name });
  const [r] = await db(`restaurants?select=name,site_url,phone&id=eq.${o.restaurant_id}`);
  if (to === 'ready') await sendEmail(o.email, `Your ${r.name} order is ready`, `Hi ${o.first_name}, order ${o.order_no} is ready for pickup.`, o.id);
  if (to === 'cancelled') {
    await sendEmail(o.email, `Your ${r.name} order was cancelled`,
      `Hi ${o.first_name}, we had to cancel order ${o.order_no}. ${up.cancel_reason}. ${o.payment_status === 'paid' ? 'A full refund is on its way to your card.' : ''}\nQuestions? Call ${r.phone}.`, o.id);
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
        return json({ ok: true, accepting: restaurant.accepting_orders, slots: pickupSlots(restaurant) });
      }
      case 'quote': {
        const menu = await menuFor(body.restaurant);
        const when = body.pickup_at || pickupSlots(menu.restaurant)[0];
        if (!when) throw new OrderError('We have no pickup times available right now.');
        return json({ ok: true, ...totals(priceCart(menu, body.items, when), menu.restaurant, body.tip_cents) });
      }
      case 'checkout':
        return await checkout(req, body);
      case 'status': {
        const token = String(body.token ?? '').replace(/[^a-f0-9]/g, '');
        if (!token) return json({ ok: false, error: 'Order not found.' }, 404);
        const rows = await db(`orders?select=order_no,status,payment_status,pickup_at,first_name,subtotal_cents,tax_cents,guest_fee_cents,tip_cents,total_cents,test_mode,cancel_reason,restaurant:restaurants(name,phone,address,timezone),items:order_items(name,qty,line_total_cents,options,note)&token=eq.${token}`);
        return rows?.[0] ? json({ ok: true, order: rows[0] }) : json({ ok: false, error: 'Order not found.' }, 404);
      }
      case 'kitchen':
        return await kitchen(req, body);
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
