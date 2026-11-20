// POS and kitchen-printer connections for paid online orders.
//   POST ?job=send                     scheduler / database trigger: send due jobs (x-job-key)
//   POST|GET|DELETE ?print=<key>       Star CloudPRNT printer: poll, fetch ticket, confirm
//   POST ?job=sync                     scheduler: sold-out sync from POS menus (x-job-key)
//   POST { action: 'test' | 'sync', restaurant, connection_id }   staff (Settings): check a connection / sync now
// Jobs are created by the orders trigger (migration 0015) when an order is paid.
import { PosError, PROVIDERS, planSync, testTicket, ticketText } from './adapters.js';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...svc, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`db ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const rpc = (fn: string, args: unknown) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const patch = (t: string, q: string, row: unknown) => db(`${t}?${q}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });

const http = async (method: string, url: string, init: { headers?: Record<string, string>; body?: string }) => {
  const r = await fetch(url, { method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  let j: unknown = null; try { j = t ? JSON.parse(t) : null; } catch { j = { message: t.slice(0, 200) }; }
  return { ok: r.ok, status: r.status, json: j as any };
};

async function orderFor(id: string) {
  const [o] = await db(`orders?select=*,restaurant:restaurants(name,timezone),items:order_items(menu_item_id,name,qty,unit_price_cents,line_total_cents,options,note)&id=eq.${id}`);
  return o;
}
async function ctxFor(c: any) {
  const ctx: any = { settings: c.settings ?? {}, token: c.secret_id ? await rpc('pos_secret', { cid: c.id }) : null, http };
  if (c.provider === 'toast') { // Toast needs to know which Toast item each dish is
    const links = await db(`pos_item_links?select=item_id,pos_id&connection_id=eq.${c.id}&pos_id=not.is.null`);
    ctx.links = new Map(links.map((l: any) => [l.item_id, l.pos_id]));
  }
  return ctx;
}

// Back off 1, 5, 15, 60 minutes; give up after 5 tries and show it in the admin.
const BACKOFF = [1, 5, 15, 60];
async function sendDue() {
  const jobs = await db(`pos_jobs?select=*,connection:pos_connections(*)&status=eq.pending&next_try_at=lte.${new Date().toISOString()}&order=created_at.asc&limit=25`);
  let sent = 0, failed = 0;
  for (const j of jobs) {
    const c = j.connection, p = PROVIDERS[c.provider as keyof typeof PROVIDERS];
    if (!c.enabled || c.provider === 'cloudprnt') continue; // printers pull their own jobs
    const claimed = await patch('pos_jobs', `id=eq.${j.id}&status=eq.pending`, { status: 'sending', attempts: j.attempts + 1 });
    if (!claimed?.length) continue;
    try {
      const ctx = await ctxFor(c);
      const res = j.kind === 'test' ? { external_id: null, note: await p.test(ctx) } : await p.send(ctx, await orderFor(j.order_id));
      await patch('pos_jobs', `id=eq.${j.id}`, { status: 'sent', sent_at: new Date().toISOString(), external_id: res.external_id, error: null });
      await patch('pos_connections', `id=eq.${c.id}`, { last_ok_at: new Date().toISOString(), last_error: null });
      sent++;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      const n = j.attempts + 1, last = n >= 5 || e instanceof PosError && /^4(0[0-3]|22)/.test(msg) && n >= 2;
      await patch('pos_jobs', `id=eq.${j.id}`, { status: last ? 'failed' : 'pending', error: msg, next_try_at: new Date(Date.now() + BACKOFF[Math.min(n - 1, 3)] * 60000).toISOString() });
      await patch('pos_connections', `id=eq.${c.id}`, { last_error: msg });
      failed++;
    }
  }
  return { sent, failed };
}

// ---------- menu sync: sold-out dishes and choices follow the POS ----------
async function syncOne(c: any) {
  const p = PROVIDERS[c.provider as keyof typeof PROVIDERS] as any;
  if (!p?.catalog) throw new PosError('This connection has no menu to sync.');
  const catalog = await p.catalog(await ctxFor(c));
  const rid = c.restaurant_id;
  const items = await db(`menu_items?select=id,name,available&restaurant_id=eq.${rid}`);
  const options = await db(`modifier_options?select=id,name,available&restaurant_id=eq.${rid}`);
  const links = await db(`pos_item_links?select=item_id,pos_id,auto,last_pos_available&connection_id=eq.${c.id}`);
  const plan = planSync({ items, options }, catalog, links, c.option_states ?? {});
  for (const l of plan.links) {
    if (l.drop) await db(`pos_item_links?connection_id=eq.${c.id}&item_id=eq.${l.item_id}`, { method: 'DELETE' });
    else await db('pos_item_links?on_conflict=connection_id,item_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ connection_id: c.id, restaurant_id: rid, item_id: l.item_id, pos_id: l.pos_id, auto: l.auto, last_pos_available: l.last_pos_available }) });
  }
  for (const it of plan.items) await patch('menu_items', `id=eq.${it.id}&restaurant_id=eq.${rid}`, { available: it.available });
  for (const o of plan.options) await patch('modifier_options', `id=eq.${o.id}&restaurant_id=eq.${rid}`, { available: o.available });
  const summary = { matched: plan.matched, unmatched: plan.unmatched.length, missing: plan.missing, changed: [...plan.items, ...plan.options].map((x) => `${x.name}: ${x.available ? 'back on' : 'sold out'}`).slice(0, 30) };
  await patch('pos_connections', `id=eq.${c.id}`, { last_sync_at: new Date().toISOString(), sync_summary: summary, option_states: plan.optionStates,
    pos_catalog: catalog.items.map((i: any) => ({ id: i.id, name: i.name })), last_ok_at: new Date().toISOString(), last_error: null });
  return summary;
}
async function syncDue() {
  const cons = await db('pos_connections?select=*&enabled=is.true&settings->>sync_menu=eq.true');
  let ok = 0, failed = 0;
  for (const c of cons) {
    try { await syncOne(c); ok++; } catch (e) {
      failed++; await patch('pos_connections', `id=eq.${c.id}`, { last_error: `Menu sync: ${(e instanceof Error ? e.message : String(e)).slice(0, 280)}` });
    }
  }
  return { synced: ok, failed };
}

// ---------- Star CloudPRNT ----------
// Printer setup: Server URL = <function url>?print=<key>, polling every 5 seconds.
// POST poll -> { jobReady, mediaTypes, jobToken }; GET returns the ticket; DELETE ?code=OK confirms.
async function cloudPrnt(req: Request, key: string) {
  if (!/^[a-f0-9]{36}$/.test(key)) return new Response('', { status: 404 });
  const [c] = await db(`pos_connections?select=*,restaurant:restaurants(name)&print_key=eq.${key}&provider=eq.cloudprnt`);
  if (!c || !c.enabled) return new Response('', { status: 404 });
  const qs = new URL(req.url).searchParams;
  const now = new Date().toISOString();
  // A job left "sending" for 2 minutes without a confirmation goes back in line.
  await patch('pos_jobs', `connection_id=eq.${c.id}&status=eq.sending&next_try_at=lt.${new Date(Date.now() - 120000).toISOString()}`, { status: 'pending' });
  const next = async () => (await db(`pos_jobs?select=*&connection_id=eq.${c.id}&status=in.(pending,sending)&order=created_at.asc&limit=1`))[0];

  if (req.method === 'POST') {
    await req.json().catch(() => ({}));
    await patch('pos_connections', `id=eq.${c.id}`, { last_seen_at: now });
    const j = await next();
    return new Response(JSON.stringify(j ? { jobReady: true, mediaTypes: ['text/plain'], jobToken: j.id } : { jobReady: false }), { headers: { 'Content-Type': 'application/json' } });
  }
  const token = qs.get('token') ?? '';
  const j = /^[0-9a-f-]{36}$/.test(token) ? (await db(`pos_jobs?select=*&id=eq.${token}&connection_id=eq.${c.id}`))[0] : await next();
  if (req.method === 'DELETE' || qs.has('delete')) {
    if (j) {
      const code = qs.get('code') ?? '';
      const ok = /^(OK|2\d\d)/i.test(code);
      await patch('pos_jobs', `id=eq.${j.id}`, ok ? { status: 'sent', sent_at: now, error: null } : { status: 'failed', error: `Printer: ${code}`.slice(0, 200) });
      await patch('pos_connections', `id=eq.${c.id}`, ok ? { last_ok_at: now, last_error: null } : { last_error: `Printer: ${code}`.slice(0, 200) });
    }
    return new Response('', { status: 200 });
  }
  if (!j) return new Response('', { status: 404 });
  const width = Number(c.settings?.width) || 42, copies = Math.max(1, Math.min(3, Number(c.settings?.copies) || 1));
  const one = j.kind === 'test' ? testTicket(c.restaurant.name, width) : ticketText(await orderFor(j.order_id), width);
  await patch('pos_jobs', `id=eq.${j.id}`, { status: 'sending', attempts: j.attempts + 1, next_try_at: now });
  return new Response(Array(copies).fill(one).join('\n\n\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ---------- staff: test a connection ----------
async function staffCan(req: Request, restaurantId: string) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token || !ANON) return false;
  const r = await fetch(`${SB_URL}/rest/v1/rpc/can`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ rid: restaurantId, perm: 'settings' }) });
  return r.ok && (await r.json()) === true;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const qs = new URL(req.url).searchParams;
    if (qs.has('print')) return await cloudPrnt(req, qs.get('print') ?? '');
    if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
    if (qs.get('job') === 'send' || qs.get('job') === 'sync') {
      const key = await rpc('job_key', {}).catch(() => null);
      if (!key || req.headers.get('x-job-key') !== key) return json({ ok: false }, 401);
      return json({ ok: true, ...(qs.get('job') === 'send' ? await sendDue() : await syncDue()) });
    }
    const body = await req.json().catch(() => ({}));
    if (body.action === 'test' || body.action === 'sync') {
      const [c] = await db(`pos_connections?select=*,restaurant:restaurants(slug)&id=eq.${encodeURIComponent(String(body.connection_id ?? ''))}`);
      if (!c || c.restaurant.slug !== body.restaurant || !(await staffCan(req, c.restaurant_id))) return json({ ok: false, error: 'Please sign in again.' }, 401);
      if (body.action === 'sync') {
        try {
          const s = await syncOne(c);
          return json({ ok: true, message: `Synced. ${s.matched} dishes matched, ${s.unmatched} not matched.${s.changed.length ? ` Changed: ${s.changed.join('; ')}.` : ' Nothing changed.'}` });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await patch('pos_connections', `id=eq.${c.id}`, { last_error: `Menu sync: ${msg.slice(0, 280)}` });
          return json({ ok: false, error: msg });
        }
      }
      if (c.provider === 'cloudprnt') {
        await db('pos_jobs', { method: 'POST', body: JSON.stringify({ restaurant_id: c.restaurant_id, connection_id: c.id, kind: 'test' }) });
        return json({ ok: true, message: c.last_seen_at && Date.now() - Date.parse(c.last_seen_at) < 120000 ? 'Test ticket sent. It should print in a few seconds.' : "Test ticket queued. The printer hasn't checked in yet; it will print as soon as it does." });
      }
      try {
        const msg = await PROVIDERS[c.provider as keyof typeof PROVIDERS].test(await ctxFor(c));
        await patch('pos_connections', `id=eq.${c.id}`, { last_ok_at: new Date().toISOString(), last_error: null });
        return json({ ok: true, message: msg });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await patch('pos_connections', `id=eq.${c.id}`, { last_error: msg.slice(0, 300) });
        return json({ ok: false, error: msg });
      }
    }
    return json({ ok: false, error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }
});
