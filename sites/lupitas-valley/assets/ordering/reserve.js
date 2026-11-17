/* Table reservations as a step-by-step booking: guests, day, time, details. One step shows at a time.
   Add <div id="ro-reserve"></div> to a page that sets window.RO. Cancel links: ?cancel=<token>. */
(function () {
  const cfg = window.RO;
  const root = document.getElementById('ro-reserve');
  if (!cfg || !root) return;
  const API = `${cfg.url}/functions/v1/ordering`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (body) => fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant: cfg.restaurant, ...body }) })
    .then((r) => r.json()).catch(() => ({ ok: false, error: 'Something went wrong. Please try again or call us.' }));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const longDate = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  const shortDate = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const monthName = (y, m) => new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const telHref = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
  const telText = (p) => { const d = String(p).replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };
  const STEPS = ['Guests', 'Day', 'Time', 'Details'];

  const cancelToken = new URLSearchParams(location.search).get('cancel');
  if (cancelToken) return cancelView(cancelToken);

  const st = { info: null, step: 0, guests: 0, y: 0, m: 0, open: new Set(), date: '', slots: [], min: null, label: '', who: {} };
  const large = () => st.guests > st.info.max_online;

  async function start() {
    root.innerHTML = '<p>Loading…</p>';
    st.info = await post({ action: 'res_info' });
    if (!st.info.ok) { root.innerHTML = `<p class="ro-err" role="alert">${esc(st.info.error)}</p>`; return; }
    [st.y, st.m] = st.info.today.split('-').map(Number);
    root.innerHTML = `<div class="ro-wiz">
      <ol class="ro-rs-steps" aria-label="Booking steps"></ol>
      <section class="ro-box ro-step" aria-labelledby="ro-step-h"><h2 id="ro-step-h" tabindex="-1"></h2><p class="ro-sum"></p><div class="ro-step-body"></div>
        <div class="ro-nav"><button type="button" class="ro-rs-back">‹ Back</button></div></section></div>`;
    root.querySelector('.ro-rs-back').addEventListener('click', () => go(st.step - 1));
    root.querySelector('.ro-rs-steps').addEventListener('click', (e) => { const b = e.target.closest('button[data-to]'); if (b) go(+b.dataset.to); });
    go(0, false);
  }

  // Which steps the guest can jump back to: any step whose earlier answers are filled in.
  const reachable = (i) => i === 0 || (i === 1 && st.guests) || (i === 2 && st.date) || (i === 3 && st.min != null);

  function go(i, focus = true) {
    st.step = Math.max(0, Math.min(3, i));
    root.querySelector('.ro-rs-steps').innerHTML = STEPS.map((name, k) => {
      const state = k < st.step ? 'past' : k === st.step ? 'now' : 'next';
      const inner = `<span class="ro-dot" aria-hidden="true">${k < st.step ? '✓' : k + 1}</span><span>${name}</span>`;
      return `<li class="ro-st-${state}"${k === st.step ? ' aria-current="step"' : ''}>${k < st.step && reachable(k) ? `<button type="button" data-to="${k}" aria-label="Step ${k + 1}, ${name}: change">${inner}</button>` : `<span class="ro-lbl">${inner}<span class="ro-sr"> (step ${k + 1}${k > st.step ? ', not started' : ''})</span></span>`}</li>`;
    }).join('');
    const bits = [];
    if (st.step > 0 && st.guests) bits.push(`Party of ${st.guests}`);
    if (st.step > 1 && st.date) bits.push(st.step === 2 ? longDate(st.date) : shortDate(st.date));
    if (st.step > 2 && st.min != null) bits.push(st.label);
    root.querySelector('.ro-sum').textContent = bits.join(' · ');
    root.querySelector('.ro-rs-back').hidden = st.step === 0;
    [stepGuests, stepDay, stepTime, stepDetails][st.step]();
    if (focus) {
      const h = root.querySelector('#ro-step-h');
      h.focus({ preventScroll: true });
      const top = root.getBoundingClientRect().top + scrollY - 110;
      if (Math.abs(scrollY - top) > 40) scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
  const body = (title, html) => { root.querySelector('#ro-step-h').textContent = title; const b = root.querySelector('.ro-step-body'); b.innerHTML = html; return b; };

  function stepGuests() {
    const big = st.info.max_online, isBig = st.guests > big;
    const b = body('How many guests?', `
      <div class="ro-amounts ro-party">${Array.from({ length: big }, (_, i) => `<button type="button" data-g="${i + 1}" aria-pressed="${st.guests === i + 1}">${i + 1}</button>`).join('')}<button type="button" data-g="big" aria-pressed="${isBig}">${big + 1}+</button></div>
      <div class="ro-big"${isBig ? '' : ' hidden'}><label class="ro-field">Party size<input type="number" name="big" min="${big + 1}" max="200" inputmode="numeric" value="${isBig ? st.guests : big + 1}"></label>
        <p class="ro-note">For groups over ${big}, pick a time and we'll confirm with you by phone or email. For private events, see <a href="/page/parties">Parties</a>.</p>
        <button type="button" class="ro-add ro-next">Continue</button></div>`);
    const bigBox = b.querySelector('.ro-big'), bigIn = bigBox.querySelector('input');
    const choose = (n) => { if (n !== st.guests) { st.guests = n; st.date = ''; st.min = null; } go(1); };
    b.querySelector('.ro-party').addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      if (btn.dataset.g === 'big') {
        b.querySelectorAll('.ro-party button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
        bigBox.hidden = false; bigIn.focus(); return;
      }
      choose(+btn.dataset.g);
    });
    b.querySelector('.ro-next').addEventListener('click', () => choose(Math.max(big + 1, Math.min(200, Math.floor(+bigIn.value) || big + 1))));
    bigIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') b.querySelector('.ro-next').click(); });
  }

  const limitMonth = () => { const t = new Date(`${st.info.today}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + st.info.days_ahead); return [t.getUTCFullYear(), t.getUTCMonth() + 1]; };

  async function stepDay() {
    const b = body('Pick a day', '<div class="ro-cal"><p>Checking open days…</p></div>');
    const key = `${st.y}-${pad(st.m)}`, g = st.guests;
    const r = await post({ action: 'res_month', month: key, guests: g });
    if (st.step !== 1 || key !== `${st.y}-${pad(st.m)}` || g !== st.guests) return; // the guest moved on
    const box = b.querySelector('.ro-cal');
    if (!r.ok) { box.innerHTML = `<p class="ro-err" role="alert">${esc(r.error)}</p>`; return; }
    st.open = new Set(r.days);
    const [ty, tm] = st.info.today.split('-').map(Number), [ly, lm] = limitMonth();
    const canPrev = st.y * 12 + st.m > ty * 12 + tm, canNext = st.y * 12 + st.m < ly * 12 + lm;
    const first = new Date(Date.UTC(st.y, st.m - 1, 1)).getUTCDay(), days = new Date(Date.UTC(st.y, st.m, 0)).getUTCDate();
    let cells = '<span aria-hidden="true"></span>'.repeat(first);
    for (let d = 1; d <= days; d++) {
      const s = ymd(st.y, st.m, d);
      cells += st.open.has(s)
        ? `<button type="button" data-d="${s}" aria-pressed="${s === st.date}" aria-label="${esc(longDate(s))}${s === st.info.today ? ', today' : ''}">${d}</button>`
        : `<span class="ro-off" aria-hidden="true">${d}</span>`;
    }
    box.innerHTML = `<div class="ro-cal-head"><button type="button" data-step="-1" ${canPrev ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <h3 aria-live="polite">${monthName(st.y, st.m)}</h3><button type="button" data-step="1" ${canNext ? '' : 'disabled'} aria-label="Next month">›</button></div>
      <div class="ro-week" aria-hidden="true"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
      <div class="ro-days" role="group" aria-label="Open days in ${monthName(st.y, st.m)}">${cells}</div>
      ${st.open.size ? '<p class="ro-note">Crossed-out days are closed or full.</p>' : `<p class="ro-note">No open tables this month${canNext ? '. Try next month' : ''}.</p>`}`;
    box.querySelectorAll('[data-step]').forEach((x) => x.addEventListener('click', () => {
      st.m += +x.dataset.step;
      if (st.m < 1) { st.m = 12; st.y--; } else if (st.m > 12) { st.m = 1; st.y++; }
      stepDay().then(() => box.querySelector(`[data-step="${x.dataset.step}"]:not(:disabled)`)?.focus());
    }));
    box.querySelector('.ro-days').addEventListener('click', (e) => {
      const d = e.target.closest('button'); if (!d) return;
      if (d.dataset.d !== st.date) { st.date = d.dataset.d; st.min = null; }
      go(2);
    });
  }

  async function stepTime() {
    const b = body('Pick a time', '<p>Loading times…</p>');
    const d = st.date;
    const r = await post({ action: 'res_slots', date: d });
    if (st.step !== 2 || d !== st.date) return;
    if (!r.ok) { b.innerHTML = `<p class="ro-err" role="alert">${esc(r.error)}</p>`; return; }
    st.slots = r.slots.filter((s) => large() || s.left >= st.guests);
    b.innerHTML = st.slots.length
      ? `<div class="ro-times" role="group" aria-label="Open times">${st.slots.map((s) => `<button type="button" data-m="${s.min}" aria-pressed="${s.min === st.min}">${esc(s.label)}${!large() && s.left - st.guests < 6 ? `<small>Only ${s.left} seats left</small>` : ''}</button>`).join('')}</div>`
      : `<p>That day just filled up. Please go back and pick another day, or call <a href="${telHref(st.info.phone)}">${telText(st.info.phone)}</a>.</p>`;
    b.querySelector('.ro-times')?.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      st.min = +t.dataset.m; st.label = st.slots.find((s) => s.min === st.min).label;
      go(3);
    });
  }

  function stepDetails() {
    const w = st.who;
    const b = body('Your details', `
      ${large() ? `<p class="ro-pick">Groups over ${st.info.max_online} are confirmed by phone or email after you send your request.</p>` : ''}
      <form novalidate>
        <div class="ro-hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
        <label class="ro-field">Name<input name="name" autocomplete="name" required maxlength="80" value="${esc(w.name)}"></label>
        <div class="ro-two"><label class="ro-field">Email<input name="email" type="email" autocomplete="email" required value="${esc(w.email)}"></label>
        <label class="ro-field">Phone<input name="phone" type="tel" autocomplete="tel" required value="${esc(w.phone)}"></label></div>
        <label class="ro-field">Special requests (optional)<textarea name="requests" rows="3" maxlength="500" placeholder="High chair, birthday, booth if possible…">${esc(w.requests)}</textarea></label>
        <p class="ro-err" role="alert"></p><button class="ro-add" type="submit">${large() ? 'Send request' : 'Book table'}</button>
      </form>`);
    const f = b.querySelector('form');
    f.addEventListener('input', () => { st.who = Object.fromEntries(new FormData(f).entries()); }); // kept if the guest goes back
    f.addEventListener('submit', book);
  }

  async function book(e) {
    e.preventDefault();
    const f = e.target, err = f.querySelector('.ro-err'), btn = f.querySelector('button[type=submit]'), label = btn.textContent;
    err.textContent = '';
    const bad = [...f.querySelectorAll('[required]')].find((i) => !i.value.trim() || !i.checkValidity());
    if (bad) { err.textContent = bad.name === 'email' ? 'Please enter a valid email.' : bad.name === 'phone' ? 'Please enter your phone number.' : 'Please enter your name.'; bad.focus(); return; }
    btn.disabled = true; btn.textContent = 'Booking…';
    const v = Object.fromEntries(new FormData(f).entries());
    const r = await post({ action: 'form', form: 'reservation', page: location.pathname, website: v.website,
      data: { name: v.name, email: v.email, phone: v.phone, requests: v.requests, date: st.date, start_min: st.min, guests: st.guests },
      attribution: window.HRA ? window.HRA.get() : undefined });
    if (!r.ok) {
      btn.disabled = false; btn.textContent = label;
      if (/available|filled/.test(r.error || '')) { st.min = null; go(2); root.querySelector('.ro-step-body').insertAdjacentHTML('afterbegin', `<p class="ro-err" role="alert">${esc(r.error)}</p>`); return; }
      err.textContent = r.error || 'Something went wrong. Please try again or call us.';
      return;
    }
    root.innerHTML = `<section class="ro-box ro-done" tabindex="-1"><p class="ro-check" aria-hidden="true">✓</p><h2>${r.status === 'confirmed' ? "You're booked!" : 'Request received'}</h2>
      <p><strong>${esc(r.when)}</strong>, party of ${r.guests}.</p>
      <p>${r.status === 'confirmed' ? 'We emailed your confirmation, with a link if you need to cancel.' : 'For larger groups we confirm by phone or email shortly. We emailed you a copy of your request.'}</p>
      <p>Questions or running late? Call <a href="${telHref(st.info.phone)}">${telText(st.info.phone)}</a>.</p></section>`;
    root.querySelector('.ro-done').focus();
  }

  async function cancelView(token) {
    root.innerHTML = `<section class="ro-box"><h2>Cancel your reservation?</h2><p>If your plans changed, you can cancel below. This frees your table for other guests.</p>
      <p class="ro-err" role="alert"></p><button class="ro-add" type="button">Cancel my reservation</button>
      <p><a href="/reservations">Keep it and go back</a></p></section>`;
    const btn = root.querySelector('button'), err = root.querySelector('.ro-err');
    btn.addEventListener('click', async () => {
      btn.disabled = true; err.textContent = '';
      const r = await post({ action: 'res_cancel', token });
      if (!r.ok) { err.textContent = r.error; btn.disabled = false; return; }
      history.replaceState(null, '', location.pathname);
      root.innerHTML = `<section class="ro-box ro-done" tabindex="-1"><h2>Reservation cancelled</h2><p>Your reservation for ${esc(r.when)} is cancelled. We hope to see you another time!</p><p><a href="/reservations">Book a new time</a></p></section>`;
      root.querySelector('.ro-done').focus();
    });
  }

  start();
})();
