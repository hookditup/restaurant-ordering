/* Table reservations: party size, then a month calendar, then open times, then contact details.
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
  const monthName = (y, m) => new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const telHref = (p) => `tel:${String(p).replace(/[^\d+]/g, '')}`;
  const telText = (p) => { const d = String(p).replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };

  const cancelToken = new URLSearchParams(location.search).get('cancel');
  if (cancelToken) return cancelView(cancelToken);

  const st = { info: null, guests: 0, y: 0, m: 0, open: new Set(), date: '', slots: [], min: null, label: '' };

  async function start() {
    root.innerHTML = '<p>Loading…</p>';
    st.info = await post({ action: 'res_info' });
    if (!st.info.ok) { root.innerHTML = `<p class="ro-err" role="alert">${esc(st.info.error)}</p>`; return; }
    const [y, m] = st.info.today.split('-').map(Number);
    st.y = y; st.m = m;
    const big = st.info.max_online;
    root.innerHTML = `
      <section class="ro-box ro-res-step" aria-labelledby="ro-r1"><h2 id="ro-r1" tabindex="-1">1. How many guests?</h2>
        <div class="ro-amounts ro-party">${Array.from({ length: big }, (_, i) => `<button type="button" data-g="${i + 1}" aria-pressed="false">${i + 1}</button>`).join('')}<button type="button" data-g="big" aria-pressed="false">${big + 1}+</button></div>
        <div class="ro-big" hidden><label class="ro-field">Party size<input type="number" name="big" min="${big + 1}" max="200" inputmode="numeric" value="${big + 1}"></label>
        <p class="ro-note">For groups over ${big}, pick a time and we'll confirm with you by phone or email. For private events, see <a href="/page/parties">Parties</a>.</p></div></section>
      <section class="ro-box ro-res-step" id="ro-cal" aria-labelledby="ro-r2" hidden><h2 id="ro-r2" tabindex="-1">2. Pick a day</h2><div class="ro-cal"></div></section>
      <section class="ro-box ro-res-step" id="ro-times" aria-labelledby="ro-r3" hidden><h2 id="ro-r3" tabindex="-1">3. Pick a time</h2><div class="ro-slots"></div></section>
      <section class="ro-box ro-res-step" id="ro-who" aria-labelledby="ro-r4" hidden><h2 id="ro-r4" tabindex="-1">4. Your details</h2>
        <p class="ro-pick" aria-live="polite"></p>
        <form novalidate>
          <div class="ro-hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
          <label class="ro-field">Name<input name="name" autocomplete="name" required maxlength="80"></label>
          <div class="ro-two"><label class="ro-field">Email<input name="email" type="email" autocomplete="email" required></label>
          <label class="ro-field">Phone<input name="phone" type="tel" autocomplete="tel" required></label></div>
          <label class="ro-field">Special requests (optional)<textarea name="requests" rows="3" maxlength="500" placeholder="High chair, birthday, booth if possible…"></textarea></label>
          <p class="ro-err" role="alert"></p><button class="ro-add" type="submit">Book table</button>
        </form></section>`;
    const party = root.querySelector('.ro-party'), bigBox = root.querySelector('.ro-big'), bigIn = bigBox.querySelector('input');
    party.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      party.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      bigBox.hidden = b.dataset.g !== 'big';
      setGuests(b.dataset.g === 'big' ? +bigIn.value : +b.dataset.g, b.dataset.g !== 'big');
    });
    bigIn.addEventListener('change', () => { const n = Math.max(big + 1, Math.min(200, Math.floor(+bigIn.value) || big + 1)); bigIn.value = n; setGuests(n, false); });
    root.querySelector('#ro-who form').addEventListener('submit', book);
  }

  function setGuests(n, jump) {
    st.guests = n;
    reset('date');
    const cal = root.querySelector('#ro-cal');
    cal.hidden = false;
    loadMonth();
    if (jump) cal.querySelector('h2').focus();
  }

  // Clear everything after a step so a changed answer never keeps a stale pick.
  function reset(from) {
    if (from === 'date') { st.date = ''; root.querySelector('#ro-times').hidden = true; }
    st.min = null; root.querySelector('#ro-who').hidden = true;
  }

  const limitMonth = () => { const t = new Date(`${st.info.today}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + st.info.days_ahead); return [t.getUTCFullYear(), t.getUTCMonth() + 1]; };

  async function loadMonth() {
    const box = root.querySelector('.ro-cal');
    box.innerHTML = '<p>Checking open days…</p>';
    const key = `${st.y}-${pad(st.m)}`, g = st.guests;
    const r = await post({ action: 'res_month', month: key, guests: g });
    if (key !== `${st.y}-${pad(st.m)}` || g !== st.guests) return; // a newer request replaced this one
    if (!r.ok) { box.innerHTML = `<p class="ro-err" role="alert">${esc(r.error)}</p>`; return; }
    st.open = new Set(r.days);
    drawMonth();
  }

  function drawMonth() {
    const box = root.querySelector('.ro-cal');
    const [ty, tm] = st.info.today.split('-').map(Number), [ly, lm] = limitMonth();
    const canPrev = st.y * 12 + st.m > ty * 12 + tm, canNext = st.y * 12 + st.m < ly * 12 + lm;
    const first = new Date(Date.UTC(st.y, st.m - 1, 1)).getUTCDay(), days = new Date(Date.UTC(st.y, st.m, 0)).getUTCDate();
    let cells = '<span aria-hidden="true"></span>'.repeat(first);
    for (let d = 1; d <= days; d++) {
      const s = ymd(st.y, st.m, d), open = st.open.has(s);
      cells += open
        ? `<button type="button" data-d="${s}" aria-pressed="${s === st.date}" aria-label="${esc(longDate(s))}${s === st.info.today ? ', today' : ''}">${d}</button>`
        : `<span class="ro-off" aria-hidden="true">${d}</span>`;
    }
    box.innerHTML = `<div class="ro-cal-head"><button type="button" data-step="-1" ${canPrev ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <h3 aria-live="polite">${monthName(st.y, st.m)}</h3><button type="button" data-step="1" ${canNext ? '' : 'disabled'} aria-label="Next month">›</button></div>
      <div class="ro-week" aria-hidden="true"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
      <div class="ro-days" role="group" aria-label="Open days in ${monthName(st.y, st.m)}">${cells}</div>
      ${st.open.size ? '' : `<p class="ro-note">No open tables this month${canNext ? '. Try next month' : ''}.</p>`}`;
    box.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      st.m += +b.dataset.step;
      if (st.m < 1) { st.m = 12; st.y--; } else if (st.m > 12) { st.m = 1; st.y++; }
      loadMonth();
    }));
    box.querySelector('.ro-days').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pickDate(b.dataset.d); });
  }

  async function pickDate(d) {
    st.date = d; reset('time');
    root.querySelectorAll('.ro-days button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.d === d)));
    const sec = root.querySelector('#ro-times'), box = sec.querySelector('.ro-slots');
    sec.hidden = false; box.innerHTML = '<p>Loading times…</p>';
    sec.querySelector('h2').textContent = `3. Pick a time on ${longDate(d)}`;
    sec.querySelector('h2').focus();
    const r = await post({ action: 'res_slots', date: d });
    if (d !== st.date) return;
    if (!r.ok) { box.innerHTML = `<p class="ro-err" role="alert">${esc(r.error)}</p>`; return; }
    const large = st.guests > st.info.max_online;
    st.slots = r.slots.filter((s) => large || s.left >= st.guests);
    box.innerHTML = st.slots.length
      ? `<div class="ro-times" role="group" aria-label="Open times">${st.slots.map((s) => `<button type="button" data-m="${s.min}" aria-pressed="false">${esc(s.label)}${!large && s.left - st.guests < 6 ? `<small>Only ${s.left} seats left</small>` : ''}</button>`).join('')}</div>`
      : `<p>That day just filled up. Please pick another day or call <a href="${telHref(st.info.phone)}">${telText(st.info.phone)}</a>.</p>`;
    box.querySelector('.ro-times')?.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      st.min = +b.dataset.m; st.label = st.slots.find((s) => s.min === st.min).label;
      const who = root.querySelector('#ro-who');
      who.hidden = false;
      who.querySelector('.ro-pick').innerHTML = `<strong>${esc(longDate(st.date))} at ${esc(st.label)}</strong>, party of ${st.guests}${large ? '. We\'ll confirm your group by phone or email.' : '.'}`;
      who.querySelector('h2').focus();
    });
  }

  async function book(e) {
    e.preventDefault();
    const f = e.target, err = f.querySelector('.ro-err'), btn = f.querySelector('button[type=submit]');
    err.textContent = '';
    const bad = [...f.querySelectorAll('[required]')].find((i) => !i.value.trim() || !i.checkValidity());
    if (bad) { err.textContent = bad.name === 'email' ? 'Please enter a valid email.' : bad.name === 'phone' ? 'Please enter your phone number.' : 'Please enter your name.'; bad.focus(); return; }
    if (st.min == null) { err.textContent = 'Please pick a time.'; return; }
    btn.disabled = true; btn.textContent = 'Booking…';
    const v = Object.fromEntries(new FormData(f).entries());
    const r = await post({ action: 'form', form: 'reservation', page: location.pathname, website: v.website,
      data: { name: v.name, email: v.email, phone: v.phone, requests: v.requests, date: st.date, start_min: st.min, guests: st.guests },
      attribution: window.HRA ? window.HRA.get() : undefined });
    if (!r.ok) {
      err.textContent = r.error || 'Something went wrong. Please try again or call us.';
      btn.disabled = false; btn.textContent = 'Book table';
      if (/available|filled/.test(r.error || '')) pickDate(st.date); // refresh times so the full one disappears
      return;
    }
    root.innerHTML = `<section class="ro-box ro-done" tabindex="-1"><h2>${r.status === 'confirmed' ? 'You\'re booked!' : 'Request received'}</h2>
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
