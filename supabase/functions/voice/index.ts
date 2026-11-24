// AI phone host (HighLevel Voice AI custom action): reservations, messages for the manager, and text links.
//   POST /functions/v1/voice   header Authorization: Bearer <the restaurant's phone key (Settings > AI phone ordering)>
//   body: { mode, ...fields }  (HighLevel may nest fields under "parameters"; both work)
// modes: check | book | request | find | reschedule | party | cancel | late | callback | order_link | join_link
//        order_menu | order_quote | order_place (passed to /ordering/phone/*) | ping (no key; HighLevel's save test)
// The agent reads `say` to the caller, or asks the caller `ask` when something is missing.
// Food orders go through the ordering function (/ordering/phone/menu|quote|place), same key.
import { dayText, listTimes, localDay, nearestOpen, parseClock, parseDay } from './voice.js';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('EMAIL_FROM') ?? '';
const svc = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const say = (text: string, extra: Record<string, unknown> = {}) => json({ ok: true, say: text, ...extra });
const ask = (text: string) => json({ ok: false, ask: text });

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...svc, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`db ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const rpc = (fn: string, args: unknown) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const insert = (t: string, row: unknown) => db(t, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
const patch = (t: string, q: string, row: unknown) => db(`${t}?${q}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (v: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
const text = (v: unknown, n: number) => String(v ?? '').replace(/[<>]/g, '').trim().slice(0, n);
const normPhone = (v: unknown) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 10 ? `+1${d}` : d.length === 11 && d[0] === '1' ? `+${d}` : ''; };
const yes = (v: unknown) => v === true || /^(y|yes|true|1)$/i.test(String(v ?? '').trim());
const validEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v);

async function sendEmail(to: string | null, subject: string, body: string) {
  if (!to || !RESEND || !FROM) return false;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: FROM, to, subject, text: body }) }).catch(() => null);
  return !!r?.ok;
}

/** Text one message through the restaurant's own Twilio, logged in the messages table. false when texting isn't set up. */
async function sendText(r: any, to: string, body: string, kind: string, marketing = false) {
  const [m] = await db(`messaging_settings?select=*&restaurant_id=eq.${r.id}`);
  const token = m?.twilio_secret_id ? await rpc('messaging_secret', { rid: r.id }) : null;
  const row = { restaurant_id: r.id, channel: 'sms', kind, to_addr: to, body, marketing };
  if (!m?.twilio_sid || !token || !m.sms_from) { await insert('messages', { ...row, status: 'skipped', error: 'Texting is not connected yet.' }).catch(() => null); return false; }
  const form: Record<string, string> = { To: to, Body: marketing ? `${body} Reply STOP to opt out.` : body };
  if (String(m.sms_from).startsWith('MG')) form.MessagingServiceSid = m.sms_from; else form.From = m.sms_from;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${m.twilio_sid}/Messages.json`, {
    method: 'POST', headers: { Authorization: `Basic ${btoa(`${m.twilio_sid}:${token}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
  }).catch(() => null);
  const d = await res?.json().catch(() => ({}));
  await insert('messages', { ...row, status: res?.ok ? 'sent' : 'failed', provider_id: d?.sid ?? null, error: res?.ok ? null : String(d?.message ?? 'Twilio error').slice(0, 300), sent_at: res?.ok ? new Date().toISOString() : null }).catch(() => null);
  return !!res?.ok;
}

const nameOf = (a: any) => [text(a.first_name, 40), text(a.last_name, 40)].filter(Boolean).join(' ');
/** The caller's upcoming reservations (today on), soonest first. */
const upcoming = (r: any, phone: string, date?: string | null) =>
  db(`reservations?select=*&restaurant_id=eq.${r.id}&phone=eq.${encodeURIComponent(phone)}&status=in.(requested,confirmed)&res_date=gte.${localDay(r.timezone)}${date ? `&res_date=eq.${date}` : ''}&order=res_date.asc,start_min.asc&limit=5`);
const resLine = (x: any) => `${x.name}, party of ${x.guests}, ${dayText(x.res_date)} at ${x.res_time}`;

async function handle(r: any, a: any) {
  const mode = String(a.mode ?? '').toLowerCase().trim();
  const phone = normPhone(a.phone);
  const guests = Math.floor(Number(a.party_size ?? a.guests));
  const day = a.date ? parseDay(a.date, r.timezone) : null;
  const wanted = a.time ? parseClock(a.time) : null;
  const notes = text(a.call_notes, 1500);

  if (mode === 'check') {
    if (!day) return ask('Ask which day they would like.');
    if (!Number.isInteger(guests) || guests < 1) return ask('Ask how many people.');
    const slots = await rpc('res_day', { rid: r.id, d: day });
    if (!slots.length) return say(`We don't have reservations open on ${dayText(day)}. Offer another day.`, { date: day });
    const exact = wanted != null && slots.find((s: any) => s.min === wanted && (guests > r.res_max_online || s.left >= guests));
    if (exact) return say(`${exact.label} on ${dayText(day)} is open for ${guests}.`, { date: day, times: [exact.label] });
    const open = nearestOpen(slots, wanted, guests, r.res_max_online);
    if (!open.length) return say(`${dayText(day)} is full for a party of ${guests}. Offer another day.`, { date: day, times: [] });
    return say(`${wanted != null ? "That time isn't open. " : ''}Open times on ${dayText(day)}: ${listTimes(open.map((s: any) => s.label))}.`, { date: day, times: open.map((s: any) => s.label) });
  }

  if (mode === 'book' || mode === 'request') {
    if (!day) return ask('Ask which day they would like.');
    if (wanted == null) return ask('Ask what time they would like.');
    if (!Number.isInteger(guests) || guests < 1 || guests > 200) return ask('Ask how many people.');
    if (!text(a.first_name, 40) || !text(a.last_name, 40)) return ask('Ask for their first and last name.');
    if (!phone) return ask('Ask for the best phone number.');
    const email = text(a.email, 120).toLowerCase();
    const requests = [a.occasion ? `Occasion: ${text(a.occasion, 80)}` : '', a.dietary ? `Dietary: ${text(a.dietary, 200)}` : '', text(a.special_requests, 300), 'Booked by phone host'].filter(Boolean).join(' · ');
    const b = await rpc('res_book', { rid: r.id, p: { name: nameOf(a), email: validEmail(email) ? email : null, phone, date: day, start_min: wanted, guests, requests } });
    if (!b.ok) {
      const slots = await rpc('res_day', { rid: r.id, d: day });
      const open = nearestOpen(slots, wanted, guests, r.res_max_online);
      return ask(`That time isn't available.${open.length ? ` Offer: ${listTimes(open.map((s: any) => s.label))}.` : ' Offer another day.'}`);
    }
    await patch('reservations', `id=eq.${b.id}`, { channel: 'phone', source: 'ai_voice', ...(yes(a.sms_consent) ? { sms_updates: true } : {}) });
    if (yes(a.sms_consent)) await rpc('upsert_customer', { rid: r.id, p: { phone, sms_updates: true } }).catch(() => null);
    const when = `${dayText(day)} at ${b.label}`;
    await sendEmail(r.forms_email, `${r.name}: ${b.status === 'confirmed' ? 'phone reservation' : 'large party request'}, ${when}`, `${nameOf(a)} (${phone}), party of ${guests}, ${when}.${requests ? `\n${requests}` : ''}${notes ? `\n\nCall notes: ${notes}` : ''}`);
    if (email && validEmail(email)) await sendEmail(email, b.status === 'confirmed' ? `Your ${r.name} reservation is confirmed` : `We got your ${r.name} reservation request`, `Hi ${text(a.first_name, 40)}, ${b.status === 'confirmed' ? "you're all set" : 'thanks for your request'} for ${when}, party of ${guests}.${b.status === 'confirmed' ? '' : ' Our team will confirm with you shortly.'}\n\nNeed to cancel? ${r.site_url}/reservations/?cancel=${b.token}\nQuestions? Call ${r.phone}.`);
    return b.status === 'confirmed'
      ? say(`Booked: ${nameOf(a)}, party of ${guests}, ${when}.`, { status: 'confirmed' })
      : say(`Request sent for ${nameOf(a)}, party of ${guests}, ${when}. It's a request, not confirmed yet; our team will confirm shortly.`, { status: 'requested' });
  }

  if (mode === 'find' || mode === 'reschedule' || mode === 'party' || mode === 'cancel' || mode === 'late') {
    if (!phone) return ask('Ask for the phone number the reservation is under.');
    const rows = await upcoming(r, phone, mode === 'cancel' || mode === 'late' ? day : null);
    if (!rows.length) {
      return mode === 'cancel' || mode === 'reschedule'
        ? ask("There's no reservation under that number in our system. It may be written in the book at the restaurant: get their name, day and time, then run mode=callback with the change they want.")
        : ask("There's no upcoming reservation under that number. Ask if it might be under a different number.");
    }
    const x = rows[0];
    if (mode === 'find' || (mode === 'reschedule' && !day)) return say(`Found: ${resLine(x)}.${rows.length > 1 ? ` (They have ${rows.length} upcoming reservations; this is the soonest.)` : ''}`, { reservation: resLine(x) });
    if (mode === 'late') {
      const mins = Math.floor(Number(String(a.special_requests ?? '').replace(/\D/g, ''))) || null;
      await patch('reservations', `id=eq.${x.id}`, { requests: [x.requests, `Running ${mins ? `${mins} min ` : ''}late (called ${new Date().toLocaleTimeString('en-US', { timeZone: r.timezone, hour: 'numeric', minute: '2-digit' })})`].filter(Boolean).join(' · ') });
      await sendEmail(r.forms_email, `${r.name}: ${x.name} running ${mins ? `${mins} minutes ` : ''}late`, `${resLine(x)}. Called to say they're running ${mins ? `about ${mins} minutes ` : ''}late.`);
      return say(`Thanks for letting us know. I've told the team you're running ${mins ? `about ${mins} minutes ` : ''}late.`);
    }
    if (mode === 'cancel') {
      if (!yes(a.consent)) return say(`Found: ${resLine(x)}. Ask: "Would you like me to cancel it?"`);
      const [c] = await patch('reservations', `id=eq.${x.id}&status=in.(requested,confirmed)`, { status: 'cancelled', handled_by: 'Phone host' });
      if (!c) return ask('That reservation was already changed. Offer a manager callback.');
      await sendEmail(r.forms_email, `${r.name}: reservation cancelled by phone`, `${resLine(x)} was cancelled by phone.`);
      return say(`Your reservation for ${dayText(x.res_date)} at ${x.res_time} is cancelled. We hope to see you another time.`);
    }
    const newDay = mode === 'party' ? x.res_date : day!;
    const newMin = mode === 'party' ? x.start_min : wanted;
    const newGuests = mode === 'party' ? guests : x.guests;
    if (mode === 'party' && (!Number.isInteger(guests) || guests < 1 || guests > 200)) return ask('Ask how many people it will be now.');
    if (newMin == null) {
      const open = nearestOpen(await rpc('res_day', { rid: r.id, d: newDay }), null, newGuests, r.res_max_online, 5);
      return open.length ? say(`Open times on ${dayText(newDay)}: ${listTimes(open.map((s: any) => s.label))}.`) : say(`${dayText(newDay)} has no openings for ${newGuests}. Offer another day.`);
    }
    const mv = await rpc('res_move', { rid: r.id, res_id: x.id, d: newDay, m: newMin, g: newGuests });
    if (!mv.ok) {
      const open = nearestOpen(await rpc('res_day', { rid: r.id, d: newDay }), newMin, newGuests, r.res_max_online);
      return ask(`That ${mode === 'party' ? 'party size' : 'time'} doesn't fit.${open.length ? ` Open on ${dayText(newDay)}: ${listTimes(open.map((s: any) => s.label))}.` : ' Offer another day, or a manager callback.'}`);
    }
    await sendEmail(r.forms_email, `${r.name}: reservation changed by phone`, `${x.name} (${phone}) changed ${resLine(x)} to party of ${mv.guests}, ${dayText(mv.date)} at ${mv.label}.${mv.status === 'requested' ? ' Large party: please confirm.' : ''}`);
    return say(`Done: ${x.name}, party of ${mv.guests}, ${dayText(mv.date)} at ${mv.label}.${mv.status === 'requested' ? ' For a group this size our team will confirm shortly.' : ''}`);
  }

  if (mode === 'callback') {
    if (!text(a.first_name, 40)) return ask("Ask for the caller's first and last name.");
    if (!phone) return ask('Ask for the best callback number.');
    const reason = text(a.special_requests, 500) || 'Callback requested';
    await insert('form_submissions', { restaurant_id: r.id, kind: 'callback', channel: 'phone', source: 'ai_voice', data: { name: nameOf(a), phone, message: reason, call_notes: notes || undefined } });
    await sendEmail(r.forms_email || r.alert_email, `${r.name}: call back ${nameOf(a)}`, `${nameOf(a)} (${phone}) asked for a callback.\n\nReason: ${reason}${notes ? `\n\nCall notes: ${notes}` : ''}`);
    return say("I've passed that to our team, and someone will call you back as soon as they can.");
  }

  if (mode === 'order_link' || mode === 'join_link') {
    if (!phone) return ask('Ask for their mobile number.');
    if (!yes(a.consent)) return ask('Only send the link after they clearly say yes.');
    const link = mode === 'order_link' ? `${r.site_url}/menu/?utm_source=phone&utm_medium=sms&utm_campaign=ai-host` : `${r.site_url}/rewards/?utm_source=phone&utm_medium=sms&utm_campaign=ai-host`;
    const body = mode === 'order_link' ? `${r.name}: order online for pickup here: ${link}` : `${r.name} Rewards: join free here: ${link}`;
    const sent = await sendText(r, phone, body, 'staff');
    return sent ? say(mode === 'order_link' ? 'I just texted you the link to order online.' : 'I just texted you the link to join.') : say(`I'm not able to text right now. The website is ${r.site_url.replace(/^https?:\/\//, '')}.`, { texted: false });
  }

  return json({ ok: false, error: 'Unknown mode. Use check, book, request, find, reschedule, party, cancel, late, callback, order_link or join_link.' }, 400);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const a = { ...(b?.parameters ?? b?.args ?? b?.data ?? {}), ...b };
    // HighLevel only saves a custom action after a 2xx test call; a ping answers without a key and returns nothing else.
    if (a.ping === true || a.ping === 'true' || String(a.mode ?? '').toLowerCase() === 'ping') return json({ ok: true, ping: true });
    const key = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!/^rok_[a-f0-9]{48}$/.test(key)) return json({ ok: false, error: 'Missing or wrong key.' }, 401);
    // Food orders: one endpoint for the agent; the ordering function checks the key and does the work.
    const order = String(a.mode ?? '').toLowerCase().match(/^order_(menu|quote|place)$/);
    if (order) {
      const res = await fetch(`${SB_URL}/functions/v1/ordering/phone/${order[1]}`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '' }, body: JSON.stringify(a),
      });
      return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
    }
    const [r] = await db(`restaurants?select=id,slug,name,timezone,site_url,phone,res_max_online,forms_email,alert_email&phone_key_hash=eq.${await sha256(key)}&phone_enabled=eq.true&active=eq.true`);
    if (!r) return json({ ok: false, error: 'Phone host is not connected. Check the key, and that AI phone ordering is on.' }, 401);
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
    if (!(await rpc('rate_limit', { p_key: `voice:${ip}`, p_max: 200, p_seconds: 600 }))) return json({ ok: false, say: 'Our system is busy. Please hold for a team member.' }, 429);
    return await handle(r, a);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return json({ ok: false, ask: 'Something went wrong on our side. Offer to take a message for a manager callback.' }, 500);
  }
});
