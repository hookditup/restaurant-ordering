/* Restaurant admin. Page needs <main id="ro-admin"></main> and window.RO.
   Each login sees only the sections it has been given (Team tab). Agency logins can switch restaurants. */
(function () {
  const cfg = window.RO, root = document.getElementById('ro-admin');
  if (!cfg || !root) return;
  const AUTH = `${cfg.url}/auth/v1`, REST = `${cfg.url}/rest/v1`, STORE = `${cfg.url}/storage/v1/object`, KEY = 'ro-kitchen-session';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const toCents = (v) => Math.round(Number(v) * 100);
  const keep = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* signs in again next load */ } },
  };
  let session = keep.get(), r = null, access = [], tab = 'dashboard', days = 30, menu = null, resDay = '', cust = { q: '', seg: 'all', sort: 'last_order', offset: 0 };
  const ALL_TABS = [['dashboard', 'Dashboard'], ['orders', 'Orders'], ['reservations', 'Reservations'], ['messages', 'Messages'], ['customers', 'Customers'], ['campaigns', 'Texts & emails'], ['rewards', 'Rewards'], ['gift', 'Gift cards'], ['menu', 'Menu'], ['choices', 'Choices'], ['pairs', 'Popular and pairings'], ['website', 'Website'], ['marketing', 'Marketing'], ['settings', 'Settings'], ['pos', 'POS & printers'], ['team', 'Team'], ['account', 'My login']];
  const SECTION_NAMES = { kitchen: 'Kitchen screen', dashboard: 'Dashboard', orders: 'Orders', reservations: 'Reservations', messages: 'Messages', customers: 'Customers', campaigns: 'Texts and emails', website: 'Website notices and hours', rewards: 'Rewards', gift: 'Gift cards', menu: 'Menu', choices: 'Choices', pairs: 'Popular and pairings', settings: 'Settings', marketing: 'Marketing', team: 'Team' };
  const tabs = () => ALL_TABS.filter(([k]) => (k !== 'reservations' || r.reservations !== false) && (k === 'account' || r.perms.includes(k === 'pos' ? 'settings' : k)));
  const PICK = 'ro-admin-restaurant';

  async function refresh() {
    const x = await fetch(`${AUTH}/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session?.refresh_token }) });
    if (!x.ok) return false;
    session = await x.json(); keep.set(session); return true;
  }
  async function call(path, init = {}) {
    const go = () => fetch(`${REST}/${path}`, { ...init, headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    let x = await go();
    if (x.status === 401 && await refresh()) x = await go();
    if (x.status === 401) { session = null; keep.set(null); loginView('Please sign in again.'); throw new Error('auth'); }
    const text = await x.text(), data = text ? JSON.parse(text) : null;
    if (!x.ok) throw new Error(data?.message || 'That did not save.');
    return data;
  }
  const staff = async (op, extra = {}) => {
    const go = () => fetch(`${cfg.url}/functions/v1/ordering`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ action: 'staff', restaurant: r.slug, op, ...extra }) });
    let x = await go();
    if (x.status === 401 && await refresh()) x = await go();
    const d = await x.json();
    if (!d.ok) throw new Error(d.error || 'That did not save.');
    return d;
  };
  const rpc = (fn, args) => call(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  const say = (msg, bad) => { const p = root.querySelector('#a-msg'); if (p) { p.textContent = msg; p.className = bad ? 'a-msg a-bad' : 'a-msg'; } };
  const attempt = async (fn, done = 'Saved.') => { try { await fn(); say(done); } catch (e) { if (e.message !== 'auth') say(e.message, true); } };

  function loginView(msg) {
    root.innerHTML = `<form class="a-login"><h1>Admin sign in</h1><label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label><p class="a-bad" role="alert">${esc(msg || '')}</p><button>Sign in</button></form>`;
    root.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const x = await fetch(`${AUTH}/token?grant_type=password`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: f.get('email'), password: f.get('password') }) });
      const d = await x.json();
      if (!x.ok) { root.querySelector('.a-bad').textContent = 'Wrong email or password.'; return; }
      session = d; keep.set(d); start();
    };
  }

  async function counts() {
    const b = root.querySelector('.a-badge');
    if (!b) return;
    const c = await staff('counts').catch(() => null);
    if (!c) return;
    b.hidden = !c.messages;
    b.textContent = c.messages;
    b.setAttribute('aria-label', `${c.messages} new`);
  }
  function shell() {
    if (!tabs().some(([k]) => k === tab)) tab = tabs()[0][0];
    const picker = access.length > 1 ? `<label class="a-pick">Restaurant <select id="a-pick">${access.map((x) => `<option value="${esc(x.slug)}"${x.slug === r.slug ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : '';
    root.innerHTML = `<header class="a-top"><h1>${esc(r.name)} admin</h1><div class="a-acts">${picker}${r.perms.includes('kitchen') && r.slug === cfg.restaurant ? '<a href="/kitchen/">Kitchen screen</a>' : ''}<button id="a-out" class="a-alt">Sign out</button></div></header>
      <label class="a-sec">Section <select id="a-sec">${tabs().map(([k, t]) => `<option value="${k}"${k === tab ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <nav class="a-tabs" aria-label="Admin sections">${tabs().map(([k, t]) => `<button data-tab="${k}"${k === tab ? ' aria-current="page"' : ''}>${t}${k === 'messages' ? '<span class="a-badge" hidden></span>' : ''}</button>`).join('')}</nav>
      <p id="a-msg" class="a-msg" role="status"></p><div id="a-view"></div>`;
    root.querySelector('#a-out').onclick = () => { session = null; keep.set(null); loginView(); };
    root.querySelector('#a-sec').onchange = (e) => { tab = e.target.value; shell(); };
    const pk = root.querySelector('#a-pick');
    if (pk) pk.onchange = () => { r = access.find((x) => x.slug === pk.value); try { localStorage.setItem(PICK, r.slug); } catch { /* fine */ } shell(); };
    root.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; shell(); }; });
    counts();
    views[tab]().catch((e) => { if (e.message !== 'auth') say(e.message, true); });
  }
  const view = () => root.querySelector('#a-view');
  const change = (now, was) => { if (!was) return ''; const p = Math.round((now - was) / was * 100); return `<small>${p >= 0 ? '+' : ''}${p}% vs. prior period</small>`; };
  const stat = (label, value, note = '') => `<div class="a-stat"><span>${esc(label)}</span><strong>${value}</strong>${note}</div>`;
  const bars = (caption, heads, rows, value) => {
    const top = Math.max(1, ...rows.map(value));
    return `<table class="a-table"><caption>${esc(caption)}</caption><thead><tr>${heads.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}<th scope="col"><span class="sr">Share</span></th></tr></thead><tbody>
      ${rows.map((x) => `<tr>${x.cells.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}<td class="a-bar"><i style="width:${Math.round(value(x) / top * 100)}%"></i></td></tr>`).join('') || `<tr><td colspan="${heads.length + 1}">No orders in this period yet.</td></tr>`}</tbody></table>`;
  };
  const hourText = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
  const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];


  // A destructive button asks twice: the first press arms it, the second within 6 seconds does it.
  const confirmStep = (form, label) => {
    if (form.dataset.armed && Date.now() - +form.dataset.armed < 6000) { delete form.dataset.armed; return true; }
    form.dataset.armed = String(Date.now()); say(label + ' Press again to confirm.', true); return false;
  };
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
  const download = (name, heads, rows) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([[heads.map(csvCell).join(','), ...rows.map((x) => x.map(csvCell).join(','))].join('\n')], { type: 'text/csv' }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  };
  const shortDate = (d) => (d ? new Date(d).toLocaleDateString('en-US', { timeZone: r.timezone, month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const phoneText = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || ''); };
  const SEGMENTS = [['all', 'Everyone'], ['recent', 'Ordered in the last 30 days'], ['lapsed', "Haven't ordered in 45+ days"], ['regulars', 'Regulars (3+ orders)'], ['never_ordered', 'Never ordered online'], ['rewards', 'Rewards members'], ['birthday_month', 'Birthday this month']];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  async function customersView() {
    const d = await rpc('admin_customers', { p_restaurant: r.id, p: { q: cust.q, segment: { kind: cust.seg }, sort: cust.sort, limit: 50, offset: cust.offset } });
    view().innerHTML = `<p class="a-help">Everyone who ordered online, booked a table or joined rewards, in one list. Totals count online orders only.</p>
      <form class="a-form" id="a-cfind" role="search"><label>Search <input name="q" type="search" value="${esc(cust.q)}" placeholder="Name, phone or email"></label>
        <label>Show <select name="seg">${SEGMENTS.map(([k, t]) => `<option value="${k}"${k === cust.seg ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>Sort <select name="sort">${[['last_order', 'Last order'], ['spent', 'Most spent'], ['orders', 'Most orders'], ['new', 'Newest'], ['name', 'Name']].map(([k, t]) => `<option value="${k}"${k === cust.sort ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <button>Search</button><button type="button" class="a-alt" id="a-cexport">Download CSV</button><button type="button" class="a-alt" id="a-cadd">Add a guest</button></form>
      <div id="a-cform"></div>
      <p><strong>${d.total}</strong> guest${d.total === 1 ? '' : 's'}</p>
      <div class="a-scroll" tabindex="0" role="group" aria-label="Guests"><table class="a-table"><caption class="sr">Guests</caption><thead><tr><th scope="col">Guest</th><th scope="col">Phone</th><th scope="col">Orders</th><th scope="col">Spent</th><th scope="col">Last order</th><th scope="col">Can receive</th></tr></thead><tbody>
      ${d.rows.map((c) => `<tr><th scope="row"><button class="a-link" data-c="${c.id}">${esc([c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || phoneText(c.phone))}</button></th><td>${esc(phoneText(c.phone))}</td><td>${c.order_count}</td><td>${money(c.spent_cents)}</td><td>${shortDate(c.last_order_at)}</td>
        <td>${[c.email_marketing && c.email ? 'Email' : '', c.sms_marketing && !c.sms_stopped_at ? 'Texts' : '', c.points != null ? `${c.points} pts` : ''].filter(Boolean).join(' · ') || '—'}</td></tr>`).join('') || '<tr><td colspan="6">No guests match.</td></tr>'}</tbody></table></div>
      <div class="a-btns">${cust.offset ? '<button class="a-alt" data-page="-1">‹ Previous 50</button>' : ''}${cust.offset + 50 < d.total ? '<button class="a-alt" data-page="1">Next 50 ›</button>' : ''}</div>`;
    const v = view(), f = v.querySelector('#a-cfind');
    f.onsubmit = (e) => { e.preventDefault(); cust = { q: f.elements.q.value.trim(), seg: f.elements.seg.value, sort: f.elements.sort.value, offset: 0 }; customersView(); };
    v.querySelectorAll('[data-page]').forEach((b) => { b.onclick = () => { cust.offset = Math.max(0, cust.offset + 50 * +b.dataset.page); customersView(); }; });
    v.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => customerView(b.dataset.c); });
    v.querySelector('#a-cexport').onclick = () => attempt(async () => {
      const all = await rpc('admin_customers', { p_restaurant: r.id, p: { q: cust.q, segment: { kind: cust.seg }, sort: cust.sort, limit: 5000 } });
      download('guests.csv', ['first_name', 'last_name', 'phone', 'email', 'orders', 'spent', 'first_order', 'last_order', 'reservations', 'no_shows', 'rewards_points', 'birthday', 'email_marketing', 'text_marketing', 'tags', 'source', 'added'],
        all.rows.map((c) => [c.first_name, c.last_name, c.phone, c.email, c.order_count, (c.spent_cents / 100).toFixed(2), c.first_order_at, c.last_order_at, c.reservation_count, c.no_shows, c.points, c.birth_month ? `${c.birth_month}/${c.birth_day}` : '', c.email_marketing ? 'yes' : 'no', c.sms_marketing && !c.sms_stopped_at ? 'yes' : 'no', (c.tags || []).join('; '), c.source, c.created_at]));
    }, 'Downloaded.');
    v.querySelector('#a-cadd').onclick = () => {
      v.querySelector('#a-cform').innerHTML = `<form class="a-box" id="a-cnew"><h3>Add a guest</h3><div class="a-grid2">
        <label>First name <input name="first_name" required maxlength="40"></label><label>Last name <input name="last_name" maxlength="40"></label>
        <label>Mobile phone <input name="phone" type="tel"></label><label>Email <input name="email" type="email"></label></div>
        <label class="a-check"><input type="checkbox" name="sms"> The guest asked, in person or in writing, to get deals by text</label>
        <label class="a-check"><input type="checkbox" name="em" checked> Send them marketing email (every email has an unsubscribe link)</label>
        <div class="a-btns"><button>Add guest</button></div></form>`;
      const nf = v.querySelector('#a-cnew'); nf.elements.first_name.focus();
      nf.onsubmit = (e) => { e.preventDefault(); const x = nf.elements; attempt(async () => {
        const digits = x.phone.value.replace(/\D/g, ''), phone = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits[0] === '1' ? `+${digits}` : '';
        if (x.phone.value && !phone) throw new Error('Enter a 10-digit phone number.');
        if (!phone && !x.email.value) throw new Error('Enter a phone number or email.');
        const id = await rpc('admin_save_customer', { p_restaurant: r.id, p: { first_name: x.first_name.value, last_name: x.last_name.value, phone, email: x.email.value, sms_marketing: x.sms.checked, consent_confirmed: x.sms.checked, email_marketing: x.em.checked } });
        await customerView(id);
      }, 'Guest added.'); };
    };
  }

  async function customerView(id) {
    const d = await rpc('admin_customer', { p_restaurant: r.id, p_id: id });
    const c = d.customer, name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Guest';
    const canText = c.phone && !c.sms_stopped_at && (c.sms_updates || c.sms_marketing);
    view().innerHTML = `<p><button class="a-alt" id="a-cback">‹ All guests</button></p><h2>${esc(name)}</h2>
      <div class="a-stats">${stat('Orders', c.order_count)}${stat('Spent online', money(c.spent_cents))}${stat('Last order', shortDate(c.last_order_at))}${stat('Reservations', c.reservation_count, c.no_shows ? `<small>${c.no_shows} no-show${c.no_shows === 1 ? '' : 's'}</small>` : '')}${d.rewards ? stat('Rewards points', d.rewards.points, `<small>Code ${esc(d.rewards.code)}</small>`) : ''}</div>
      <form class="a-box" id="a-cedit"><h3>Details</h3><div class="a-grid2">
        <label>First name <input name="first_name" value="${esc(c.first_name)}" maxlength="40"></label><label>Last name <input name="last_name" value="${esc(c.last_name)}" maxlength="40"></label>
        <label>Phone <input value="${esc(phoneText(c.phone))}" disabled></label><label>Email <input name="email" type="email" value="${esc(c.email)}"></label>
        <label>Birthday month <select name="birth_month"><option value="">—</option>${MONTHS.map((m, i) => `<option value="${i + 1}"${c.birth_month === i + 1 ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>Birthday day <input name="birth_day" type="number" min="1" max="31" value="${c.birth_day ?? ''}"></label></div>
        <label>Tags (comma separated) <input name="tags" value="${esc((c.tags || []).join(', '))}" placeholder="VIP, catering, allergy: nuts"></label>
        <label>Staff notes <textarea name="notes" rows="3" maxlength="2000">${esc(c.notes)}</textarea></label>
        <fieldset><legend>Messages they get</legend>
          <label class="a-check"><input type="checkbox" name="em"${c.email_marketing ? ' checked' : ''}> Marketing email${c.email_unsub_at ? ` (unsubscribed ${shortDate(c.email_unsub_at)})` : ''}</label>
          <label class="a-check"><input type="checkbox" name="sms"${c.sms_marketing && !c.sms_stopped_at ? ' checked' : ''}> Marketing texts${c.sms_stopped_at ? ` (replied STOP ${shortDate(c.sms_stopped_at)})` : c.sms_marketing_at ? ` (agreed ${shortDate(c.sms_marketing_at)})` : ''}</label>
          <label class="a-check" id="a-cconsent" hidden><input type="checkbox" name="consent"> The guest asked us to text them deals</label>
          <p class="a-help">Order and reservation texts: ${c.sms_updates && !c.sms_stopped_at ? 'yes' : 'no'}. Only the guest can turn texts on, at checkout, rewards sign-up or by asking you.</p></fieldset>
        <div class="a-btns"><button>Save</button></div></form>
      <form class="a-box" id="a-cmsg"><h3>Send a message</h3><div class="a-grid2"><label>Send by <select name="channel">${c.email ? '<option value="email">Email</option>' : ''}${canText ? '<option value="sms">Text</option>' : ''}</select></label><label>Subject (email) <input name="subject" maxlength="200" placeholder="A note from ${esc(r.name)}"></label></div>
        <label>Message <textarea name="body" rows="3" maxlength="1500" required></textarea></label><div class="a-btns"><button${!c.email && !canText ? ' disabled' : ''}>Send</button></div>${!c.email && !canText ? '<p class="a-help">No email on file and no permission to text. Call them instead.</p>' : ''}</form>
      <h3>Online orders</h3>${d.orders.length ? `<ul class="a-list">${d.orders.map((o) => `<li><strong>${esc(o.order_no)}</strong> · ${shortDate(o.created_at)} · ${money(o.total_cents)} · ${esc(o.status)}<br><small>${esc(o.items || '')}</small></li>`).join('')}</ul>` : '<p>None yet.</p>'}
      <h3>Reservations</h3>${d.reservations.length ? `<ul class="a-list">${d.reservations.map((x) => `<li>${esc(x.res_date)} at ${esc(x.res_time)} · party of ${esc(x.guests)} · ${esc(String(x.status).replace('_', '-'))}</li>`).join('')}</ul>` : '<p>None yet.</p>'}
      <h3>Messages sent</h3>${d.messages.length ? `<ul class="a-list">${d.messages.map((m) => `<li>${shortDate(m.created_at)} · ${m.channel === 'sms' ? 'Text' : 'Email'} · ${esc(m.kind.replace('_', ' '))} · <strong>${esc(m.status)}</strong>${m.error ? ` (${esc(m.error)})` : ''}<br><small>${esc(m.subject ? `${m.subject}: ` : '')}${esc(m.body)}</small></li>`).join('')}</ul>` : '<p>None yet.</p>'}`;
    const v = view(), f = v.querySelector('#a-cedit');
    v.querySelector('#a-cback').onclick = () => customersView();
    const wasSms = c.sms_marketing && !c.sms_stopped_at;
    f.elements.sms.onchange = () => { v.querySelector('#a-cconsent').hidden = !f.elements.sms.checked || wasSms; };
    f.onsubmit = (e) => { e.preventDefault(); const x = f.elements; attempt(async () => {
      if (x.sms.checked && !wasSms && !x.consent.checked) throw new Error('Tick the box to confirm the guest asked for texts.');
      await rpc('admin_save_customer', { p_restaurant: r.id, p: { id, first_name: x.first_name.value, last_name: x.last_name.value, email: x.email.value, birth_month: x.birth_month.value, birth_day: x.birth_day.value,
        tags: x.tags.value.split(','), notes: x.notes.value, email_marketing: x.em.checked, sms_marketing: x.sms.checked, consent_confirmed: x.consent.checked } });
      await customerView(id);
    }); };
    v.querySelector('#a-cmsg').onsubmit = (e) => { e.preventDefault(); const x = e.target.elements; attempt(async () => {
      const res = await staff('message_customer', { id, channel: x.channel.value, subject: x.subject.value, body: x.body.value });
      if (res.status !== 'sent') throw new Error(res.error || 'Not sent.');
      await customerView(id);
    }, 'Sent.'); };
  }

  const AUTO = {
    order_ready: ['Order ready text', 'Texts the guest when the kitchen marks the order ready. Only for guests who ticked "text me order updates".', null],
    reservation_reminder: ['Reservation reminder', 'Sent on the day, this many hours before the table time. Texts only go to guests who asked for a text reminder.', 'hours before'],
    welcome: ['Rewards welcome text', 'Texts new rewards members who agreed to texts. (The welcome email always goes out.)', null],
    winback: ['We miss you', "Goes to guests whose last online order was this many days ago. Each guest gets it at most once every 60 days.", 'days since last order'],
    birthday: ['Birthday', 'Sent this many days before the birthday guests gave you.', 'days before birthday'],
    review: ['Review request', 'Asks for a review this many hours after an order is completed. At most once a month per guest.', 'hours after the order'],
    points: ['Reward waiting', 'Reminds rewards members who have enough points for a reward and haven\'t ordered in this many days.', 'days since last order'],
  };
  const FIELDS = '{first_name}, {restaurant}, {link}';

  async function campaignsView() {
    const d = await rpc('admin_marketing', { p_restaurant: r.id });
    const st = d.settings || {};
    const textsOn = st.twilio_sid && st.has_token && st.sms_from;
    const segOpts = (cur) => SEGMENTS.map(([k, t]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${t}</option>`).join('');
    view().innerHTML = `
      <div class="a-stats">${stat('Guests', d.audience.customers)}${stat('Can email', d.audience.email)}${stat('Can text', d.audience.sms)}${stat('Sent, 30 days', (d.sent30.sms || 0) + (d.sent30.email || 0), `<small>${d.sent30.sms || 0} texts · ${d.sent30.email || 0} emails${d.sent30.failed ? ` · ${d.sent30.failed} failed` : ''}${d.sent30.skipped ? ` · ${d.sent30.skipped} not sent` : ''}</small>`)}</div>
      ${textsOn ? '' : '<p class="a-test">Texting isn\'t connected yet, so texts are saved as "not sent". Add the restaurant\'s Twilio details under Connections below.</p>'}
      <h2>Automatic messages</h2><p class="a-help">These run on their own every few minutes. Marketing texts only go out between your texting hours and only to guests who opted in. Merge fields: ${FIELDS}, plus the ones noted.</p>
      ${d.automations.map((a) => `<details class="a-box"><summary>${esc(AUTO[a.kind][0])} · <strong>${a.enabled ? 'On' : 'Off'}</strong></summary>
        <form class="a-auto-f" data-kind="${a.kind}"><p class="a-help">${esc(AUTO[a.kind][1])}</p>
          <label class="a-check"><input type="checkbox" name="enabled"${a.enabled ? ' checked' : ''}> On</label>
          <div class="a-grid2"><label class="a-check"><input type="checkbox" name="sms"${a.sms ? ' checked' : ''}${a.kind === 'order_ready' ? '' : ''}> Text</label>${a.kind === 'order_ready' || a.kind === 'welcome' ? '' : `<label class="a-check"><input type="checkbox" name="email"${a.email ? ' checked' : ''}> Email</label>`}</div>
          ${AUTO[a.kind][2] ? `<label>${esc(AUTO[a.kind][2])} <input type="number" name="wait" min="0" max="365" value="${a.wait}"></label>` : `<input type="hidden" name="wait" value="${a.wait}">`}
          ${['winback', 'birthday'].includes(a.kind) ? `<label>Promo code to include (optional) <input name="promo_code" value="${esc(a.promo_code)}" maxlength="24" placeholder="WEMISSYOU"></label>` : ''}
          ${a.kind === 'order_ready' || a.kind === 'welcome' ? '' : `<label>Email subject <input name="subject" value="${esc(a.subject)}" maxlength="200"></label><label>Email message <textarea name="body" rows="4" maxlength="5000">${esc(a.body)}</textarea></label>`}
          <label>Text message <textarea name="sms_body" rows="2" maxlength="600">${esc(a.sms_body)}</textarea></label>
          <p class="a-help">${{ order_ready: 'Also: {order_no}.', reservation_reminder: 'Also: {time}, {guests}, {cancel_link}.', welcome: 'Also: {code}.', winback: 'Also: {promo_line}.', birthday: 'Also: {promo_line}.', review: 'Also: {review_link}.', points: 'Also: {points}, {code}.' }[a.kind]} Marketing texts end with "Reply STOP to opt out."</p>
          <div class="a-btns"><button>Save</button></div></form></details>`).join('')}
      <h2>Send a campaign</h2>
      <form class="a-box" id="a-camp"><div class="a-grid2"><label>Name (staff only) <input name="name" required maxlength="120" placeholder="Taco Tuesday"></label>
        <label>Send to <select name="seg">${segOpts('all')}</select></label>
        <label>Send by <select name="channel"><option value="email">Email</option><option value="sms">Text</option><option value="both">Email and text</option></select></label>
        <label>When <input type="datetime-local" name="send_at"></label></div>
        <p class="a-help" id="a-reach" aria-live="polite"></p>
        <label>Email subject <input name="subject" maxlength="200"></label><label>Email message <textarea name="body" rows="5" maxlength="5000" placeholder="Hi {first_name}, ..."></textarea></label>
        <label>Text message <textarea name="sms_body" rows="2" maxlength="600" placeholder="{restaurant}: ..."></textarea></label>
        <p class="a-help">Leave "When" empty to send now. Only guests who agreed to marketing get it.</p>
        <div class="a-btns"><button name="go" value="send">Send or schedule</button><button class="a-alt" name="go" value="draft">Save draft</button></div></form>
      ${d.campaigns.length ? `<div class="a-scroll" tabindex="0" role="group" aria-label="Campaigns"><table class="a-table"><caption>Campaigns</caption><thead><tr><th scope="col">Name</th><th scope="col">By</th><th scope="col">Status</th><th scope="col">When</th><th scope="col">Messages</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>
        ${d.campaigns.map((c) => `<tr><th scope="row">${esc(c.name)}</th><td>${c.channel === 'both' ? 'Email + text' : c.channel === 'sms' ? 'Text' : 'Email'}</td><td>${esc(c.status)}</td><td>${shortDate(c.sent_at || c.send_at)}</td><td>${c.queued || '—'}</td>
          <td>${['draft', 'scheduled'].includes(c.status) ? `<button class="a-alt" data-send="${c.id}">Send now</button> <button class="a-alt" data-cancel='${esc(JSON.stringify(c))}'>Cancel</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <h2>Promo codes</h2>
      <form class="a-form" id="a-promo"><label>Code <input name="code" required maxlength="24" placeholder="TACO10"></label><label>Type <select name="kind"><option value="percent">% off</option><option value="amount">$ off</option></select></label>
        <label>Amount <input name="value" type="number" min="1" step="0.01" required></label><label>Minimum order ($) <input name="min" type="number" min="0" step="0.01" value="0"></label>
        <label>Max uses <input name="max" type="number" min="1" placeholder="No limit"></label><label>Ends <input name="ends" type="date"></label>
        <label class="a-check"><input type="checkbox" name="once" checked> Once per guest</label><button>Add code</button></form>
      ${d.promos.length ? `<ul class="a-list">${d.promos.map((x) => `<li><strong>${esc(x.code)}</strong> · ${x.kind === 'percent' ? `${x.value}% off` : `${money(x.value)} off`}${x.min_subtotal_cents ? ` orders ${money(x.min_subtotal_cents)}+` : ''} · used ${x.uses}${x.max_uses ? ` of ${x.max_uses}` : ''}${x.ends_at ? ` · ends ${shortDate(x.ends_at)}` : ''} · ${x.active ? 'active' : 'off'} <button class="a-alt" data-promo="${x.id}" data-on="${!x.active}">${x.active ? 'Turn off' : 'Turn on'}</button></li>`).join('')}</ul>` : '<p>No codes yet.</p>'}
      <h2>Connections</h2>
      <details class="a-box"${textsOn ? '' : ' open'}><summary>Texting (Twilio) and email</summary>
        <form id="a-msgset"><p class="a-help">Each restaurant uses its own Twilio account. Find these in the Twilio console under Account info. The auth token is stored encrypted and never shown again.</p>
          <div class="a-grid2"><label>Account SID <input name="twilio_sid" value="${esc(st.twilio_sid)}" placeholder="AC…" autocomplete="off"></label>
          <label>Auth token <input name="twilio_token" type="password" autocomplete="new-password" placeholder="${st.has_token ? 'Saved. Leave blank to keep it.' : '32 characters'}"></label>
          <label>Texting number or Messaging Service <input name="sms_from" value="${esc(st.sms_from)}" placeholder="+14355551234 or MG…"></label>
          <label>Send emails from <input name="email_from" value="${esc(st.email_from)}" placeholder="${esc(r.name)} &lt;hello@yourdomain.com&gt;"></label>
          <label>Replies go to <input name="email_reply_to" type="email" value="${esc(st.email_reply_to)}"></label>
          <label>Google review link <input name="review_url" value="${esc(st.review_url)}" placeholder="https://g.page/r/…"></label>
          <label>Texts start at <input name="qs" type="time" value="${String(Math.floor((st.quiet_start_min ?? 540) / 60)).padStart(2, '0')}:${String((st.quiet_start_min ?? 540) % 60).padStart(2, '0')}"></label>
          <label>Texts stop at <input name="qe" type="time" value="${String(Math.floor((st.quiet_end_min ?? 1200) / 60)).padStart(2, '0')}:${String((st.quiet_end_min ?? 1200) % 60).padStart(2, '0')}"></label></div>
          <p class="a-help">In Twilio, set the number's "A message comes in" webhook to <code>${esc(cfg.url)}/functions/v1/ordering?hook=twilio&amp;r=${r.id}</code> so STOP, HELP and guest replies work.</p>
          <div class="a-btns"><button>Save connections</button></div></form>
        <form class="a-form" id="a-test"><label>Send a test to <input name="to" required placeholder="Your phone or email"></label><label>By <select name="channel"><option value="email">Email</option><option value="sms">Text</option></select></label><button class="a-alt">Send test</button></form></details>`;
    const v = view();
    v.querySelectorAll('.a-auto-f').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); const x = f.elements; attempt(async () => {
      await rpc('admin_save_automation', { p_restaurant: r.id, p: { kind: f.dataset.kind, enabled: x.enabled.checked, sms: x.sms.checked, email: x.email ? x.email.checked : false, wait: +x.wait.value || 0,
        subject: x.subject?.value ?? '', body: x.body?.value ?? (f.dataset.kind === 'order_ready' ? 'Your order is ready.' : 'Welcome!'), sms_body: x.sms_body.value, promo_code: x.promo_code?.value ?? '' } });
      await campaignsView();
    }); }; });
    const cf = v.querySelector('#a-camp'), reach = v.querySelector('#a-reach');
    const showReach = async () => { const n = await rpc('admin_segment_count', { p_restaurant: r.id, seg: { kind: cf.elements.seg.value } }).catch(() => null); if (n) reach.textContent = `Reaches ${n.email} by email and ${n.sms} by text (of ${n.all} guests in this group).`; };
    cf.elements.seg.onchange = showReach; showReach();
    let go = 'send';
    cf.querySelectorAll('button[name=go]').forEach((b) => { b.onclick = () => { go = b.value; }; });
    cf.onsubmit = (e) => { e.preventDefault(); const x = cf.elements; attempt(async () => {
      const ch = x.channel.value;
      if (ch !== 'sms' && (!x.subject.value.trim() || !x.body.value.trim())) throw new Error('Add an email subject and message.');
      if (ch !== 'email' && !x.sms_body.value.trim()) throw new Error('Add the text message.');
      const later = x.send_at.value ? new Date(x.send_at.value) : null;
      if (go === 'send' && !later && !confirmStep(cf, 'Send this campaign now?')) throw new Error('Press Send again to confirm.');
      const id = await rpc('admin_save_campaign', { p_restaurant: r.id, p_by: session?.user?.email || 'staff', p: { name: x.name.value, channel: ch, subject: x.subject.value, body: x.body.value, sms_body: x.sms_body.value,
        segment: { kind: x.seg.value }, status: go === 'draft' ? 'draft' : 'scheduled', send_at: later ? later.toISOString() : '' } });
      if (go === 'send' && !later) { const res = await staff('campaign_send', { id }); say(`Sent ${res.sent}. ${res.waiting ? `${res.waiting} texts wait for texting hours. ` : ''}${res.skipped ? `${res.skipped} not sent (not connected or no permission).` : ''}`); }
      await campaignsView();
    }, go === 'draft' ? 'Draft saved.' : 'Scheduled.'); };
    v.querySelectorAll('[data-send]').forEach((b) => { b.onclick = () => attempt(async () => { const res = await staff('campaign_send', { id: b.dataset.send }); await campaignsView(); say(`Sent ${res.sent}.`); }); });
    v.querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = () => attempt(async () => { const c = JSON.parse(b.dataset.cancel); await rpc('admin_save_campaign', { p_restaurant: r.id, p_by: '', p: { ...c, status: 'cancelled' } }); await campaignsView(); }, 'Cancelled.'); });
    const pf = v.querySelector('#a-promo');
    pf.onsubmit = (e) => { e.preventDefault(); const x = pf.elements; attempt(async () => {
      const pct = x.kind.value === 'percent', val = pct ? Math.round(+x.value.value) : toCents(x.value.value);
      if (pct && (val < 1 || val > 100)) throw new Error('Percent off must be 1 to 100.');
      await rpc('admin_save_promo', { p_restaurant: r.id, p: { code: x.code.value, kind: x.kind.value, value: val, min_subtotal_cents: toCents(x.min.value || 0), max_uses: x.max.value, once_per_guest: x.once.checked, ends_at: x.ends.value ? new Date(`${x.ends.value}T23:59:59`).toISOString() : '' } });
      await campaignsView();
    }, 'Code added.'); };
    v.querySelectorAll('[data-promo]').forEach((b) => { b.onclick = () => attempt(async () => { await rpc('admin_save_promo', { p_restaurant: r.id, p: { id: b.dataset.promo, active: b.dataset.on === 'true' } }); await campaignsView(); }); });
    const toMin = (t) => { const [h, m] = String(t || '').split(':').map(Number); return h * 60 + (m || 0); };
    v.querySelector('#a-msgset').onsubmit = (e) => { e.preventDefault(); const x = e.target.elements; attempt(async () => {
      await staff('msg_settings', { twilio_sid: x.twilio_sid.value.trim(), twilio_token: x.twilio_token.value.trim(), sms_from: x.sms_from.value.trim(), email_from: x.email_from.value.trim(), email_reply_to: x.email_reply_to.value.trim(), review_url: x.review_url.value.trim(), quiet_start_min: toMin(x.qs.value), quiet_end_min: toMin(x.qe.value) });
      await campaignsView();
    }); };
    v.querySelector('#a-test').onsubmit = (e) => { e.preventDefault(); const x = e.target.elements; attempt(async () => {
      const res = await staff('msg_test', { to: x.to.value, channel: x.channel.value });
      if (res.status !== 'sent') throw new Error(res.error || 'Not sent.');
    }, 'Test sent.'); };
  }

  async function websiteView() {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: r.timezone }).format(new Date());
    const [notices, ex] = await Promise.all([call(`site_notices?select=*&restaurant_id=eq.${r.id}&order=kind.asc,sort.asc,created_at.desc`), call(`hours_exceptions?select=*&restaurant_id=eq.${r.id}&day=gte.${today}&order=day.asc`)]);
    const item = (n) => `<li><strong>${n.kind === 'banner' ? 'Banner' : 'Special'}: ${esc(n.title)}</strong>${n.body ? ` · ${esc(n.body)}` : ''}${n.starts_on || n.ends_on ? ` · ${esc(n.starts_on || 'now')} to ${esc(n.ends_on || 'no end')}` : ''} <button class="a-alt" data-rm="${n.id}" aria-label="Remove ${esc(n.title)}">Remove</button></li>`;
    view().innerHTML = `<p class="a-help">Changes show on the website within a few minutes. No rebuild needed.</p>
      <h2>Banner and specials</h2><p class="a-help">The banner shows at the top of every page (one at a time). Specials show on the home page.</p>
      ${notices.length ? `<ul class="a-list">${notices.map(item).join('')}</ul>` : '<p>Nothing posted.</p>'}
      <form class="a-box" id="a-notice"><div class="a-grid2"><label>Type <select name="kind"><option value="banner">Banner (every page)</option><option value="special">Special (home page)</option></select></label>
        <label>Title <input name="title" required maxlength="120" placeholder="Taco Tuesday: $2 tacos"></label>
        <label>Details (optional) <input name="body" maxlength="600"></label><label>Button text (optional) <input name="link_text" maxlength="40" placeholder="Order now"></label>
        <label>Button link (optional) <input name="link_url" placeholder="/menu or https://…"></label><label>Show from <input name="starts_on" type="date"></label><label>Show until <input name="ends_on" type="date"></label></div>
        <div class="a-btns"><button>Post</button></div></form>
      <h2>Special hours and closures</h2><p class="a-help">Holidays, early closes and private events. Online ordering, reservations and the hours on the website all follow these. Special hours can shorten a day, not add a day you're normally closed.</p>
      ${ex.length ? `<ul class="a-list">${ex.map((x) => `<li><strong>${esc(new Date(`${x.day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }))}</strong>: ${x.closed ? 'Closed' : x.ranges.map(([a, b]) => `${a}–${b}`).join(', ')}${x.note ? ` · ${esc(x.note)}` : ''} <button class="a-alt" data-day="${x.day}">Remove</button></li>`).join('')}</ul>` : '<p>No special hours coming up.</p>'}
      <form class="a-form" id="a-hours"><label>Date <input type="date" name="day" min="${today}" required></label><label class="a-check"><input type="checkbox" name="closed" checked> Closed all day</label>
        <label>Open <input type="time" name="open" value="10:30" disabled></label><label>Close <input type="time" name="close" value="15:00" disabled></label>
        <label>Note (shown to guests) <input name="note" maxlength="120" placeholder="Thanksgiving"></label><button>Save</button></form>`;
    const v = view();
    v.querySelector('#a-notice').onsubmit = (e) => { e.preventDefault(); const x = e.target.elements; attempt(async () => {
      if (x.ends_on.value && x.starts_on.value && x.ends_on.value < x.starts_on.value) throw new Error('"Show until" is before "Show from".');
      await rpc('admin_save_notice', { p_restaurant: r.id, p: { kind: x.kind.value, title: x.title.value, body: x.body.value, link_text: x.link_text.value, link_url: x.link_url.value.trim(), starts_on: x.starts_on.value, ends_on: x.ends_on.value } });
      await websiteView();
    }, 'Posted.'); };
    v.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => attempt(async () => { await rpc('admin_save_notice', { p_restaurant: r.id, p: { remove: b.dataset.rm } }); await websiteView(); }, 'Removed.'); });
    const hf = v.querySelector('#a-hours');
    hf.elements.closed.onchange = () => { hf.elements.open.disabled = hf.elements.close.disabled = hf.elements.closed.checked; };
    hf.onsubmit = (e) => { e.preventDefault(); const x = hf.elements; attempt(async () => {
      if (!x.closed.checked && !(x.close.value > x.open.value)) throw new Error('Closing time must be after opening time.');
      await rpc('admin_save_hours_exception', { p_restaurant: r.id, p: { day: x.day.value, closed: x.closed.checked, ranges: x.closed.checked ? [] : [[x.open.value, x.close.value]], note: x.note.value } });
      await websiteView();
    }); };
    v.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => attempt(async () => { await rpc('admin_save_hours_exception', { p_restaurant: r.id, p: { day: b.dataset.day, remove: true } }); await websiteView(); }, 'Removed.'); });
  }

  // ---------- POS and kitchen printers ----------
  const POS = {
    clover: { label: 'Clover', help: 'Paid online orders appear on your Clover as open orders at the price the guest paid, and print to your Clover kitchen printer.' },
    square: { label: 'Square', help: 'Paid online orders appear in Square Orders, marked paid. Square charges the app developer about 1% of each online order sent this way; ask us how that is billed before you turn it on.' },
    toast: { label: 'Toast', help: 'Paid online orders go into Toast as paid takeout orders and print in the kitchen. Toast prices each order itself, so online prices need to match Toast. Toast gives you the API hostname, client ID and secret. Press Test connection to see the takeout and payment type IDs to copy in.' },
    cloudprnt: { label: 'Cloud kitchen printer (Star CloudPRNT)', help: 'Works with any POS, or none. A Star printer with CloudPRNT (for example the mC-Print3 or TSP143IV) prints each paid order.' },
  };
  const posFn = async (body) => {
    const go = () => fetch(`${cfg.url}/functions/v1/pos`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ restaurant: r.slug, ...body }) });
    let x = await go();
    if (x.status === 401 && await refresh()) x = await go();
    const d = await x.json().catch(() => ({}));
    if (!d.ok) throw new Error(d.error || 'That did not work.');
    return d;
  };
  const when = (d) => (d ? new Date(d).toLocaleString('en-US', { timeZone: r.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const posFields = (p, c = {}) => {
    const s = c.settings || {};
    const env = `<label>Account type <select name="env"><option value="production"${s.env !== 'sandbox' ? ' selected' : ''}>Live</option><option value="sandbox"${s.env === 'sandbox' ? ' selected' : ''}>Sandbox (testing)</option></select></label>`;
    const tok = (what) => `<label>${what} <input name="token" type="password" autocomplete="new-password" placeholder="${c.has_token ? 'Saved. Leave blank to keep it.' : 'Paste the token'}"${c.id ? '' : ' required'}></label>`;
    if (p === 'clover') return `<label>Merchant ID <input name="merchant_id" value="${esc(s.merchant_id || '')}" required placeholder="13 letters and numbers"></label>${env}${tok('API token')}
      <label>Order type ID (optional) <input name="order_type_id" value="${esc(s.order_type_id || '')}" placeholder="For example, Online Pickup"></label>
      <label class="a-check"><input type="checkbox" name="print"${s.print !== false ? ' checked' : ''}> Print a kitchen ticket on Clover</label>
      <label class="a-check"><input type="checkbox" name="sync_menu"${s.sync_menu ? ' checked' : ''}> Sold out on Clover = sold out online (checked every 5 minutes)</label>`;
    const sync = (pos) => `<label class="a-check"><input type="checkbox" name="sync_menu"${s.sync_menu ? ' checked' : ''}> Sold out on ${pos} = sold out online (checked every 5 minutes)</label>`;
    if (p === 'toast') return `<label>API hostname <input name="api_host" value="${esc(s.api_host || '')}" required placeholder="From Toast"></label>
      <label>Restaurant GUID <input name="restaurant_guid" value="${esc(s.restaurant_guid || '')}" required></label>
      <label>Client ID <input name="client_id" value="${esc(s.client_id || '')}" required autocomplete="off"></label>${tok('Client secret')}
      <label>Takeout dining option GUID <input name="dining_option_guid" value="${esc(s.dining_option_guid || '')}" placeholder="Shown by Test connection"></label>
      <label>Online payment type GUID <input name="payment_type_guid" value="${esc(s.payment_type_guid || '')}" placeholder="Shown by Test connection"></label>${sync('Toast')}`;
    if (p === 'square') return `<label>Location ID <input name="location_id" value="${esc(s.location_id || '')}" required></label>${env}${tok('Access token')}`;
    return `<label>Paper width <select name="width">${[[32, '58 mm (2 inch)'], [42, '80 mm (3 inch)'], [48, '80 mm, small font']].map(([v, t]) => `<option value="${v}"${+(s.width || 42) === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Copies <select name="copies">${[1, 2, 3].map((n) => `<option${+(s.copies || 1) === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`;
  };
  const posSettings = (p, x) => (p === 'clover' ? { merchant_id: x.merchant_id.value.trim(), env: x.env.value, order_type_id: x.order_type_id.value.trim(), print: x.print.checked, sync_menu: x.sync_menu.checked }
    : p === 'toast' ? { api_host: x.api_host.value.trim(), restaurant_guid: x.restaurant_guid.value.trim(), client_id: x.client_id.value.trim(), dining_option_guid: x.dining_option_guid.value.trim(), payment_type_guid: x.payment_type_guid.value.trim(), sync_menu: x.sync_menu.checked }
    : p === 'square' ? { location_id: x.location_id.value.trim(), env: x.env.value } : { width: +x.width.value, copies: +x.copies.value });
  const JOB = { pending: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', cancelled: 'Cancelled' };

  // Menu sync status and dish matching (Clover, Toast). Toast also needs the matches to send orders.
  const MENU_POS = ['clover', 'toast'];
  const syncBox = (c) => {
    const P = POS[c.provider].label;
    const sm = c.sync_summary;
    const head = c.last_sync_at ? `Last menu sync ${esc(when(c.last_sync_at))}: ${sm.matched} dishes matched, ${sm.unmatched} not matched${sm.missing?.length ? `, ${sm.missing.length} linked to a ${P} item that no longer exists` : ''}.` : (c.settings?.sync_menu ? 'Menu sync is on. It runs within 5 minutes, or press Sync sold-out items now.' : 'Menu sync is off.');
    const changed = sm?.changed?.length ? `<p class="a-help">Last changes: ${esc(sm.changed.join('; '))}</p>` : '';
    if (!c.catalog.length) return `<p class="a-help">${head}</p>${changed}`;
    const opts = (l) => `<option value="auto"${l.linked && l.auto ? ' selected' : ''}>${l.linked && l.auto && l.pos_id ? 'Matched automatically' : 'Match automatically'}</option><option value=""${l.linked && !l.auto && !l.pos_id ? ' selected' : ''}>Not on ${P}</option>${c.catalog.map((x) => `<option value="${esc(x.id)}"${!l.auto && l.pos_id === x.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}`;
    const rows = c.links.map((l) => `<tr><td>${esc(l.item)}</td><td>${l.pos_id ? esc(c.catalog.find((x) => x.id === l.pos_id)?.name || `Missing on ${P}`) : (l.linked && !l.auto ? `Not on ${P}` : '<span class="a-bad">Not matched</span>')}</td>
      <td><select data-poslink="${l.item_id}" data-conn="${c.id}" aria-label="${P} item for ${esc(l.item)}">${opts(l)}</select></td></tr>`).join('');
    const unmatched = c.links.filter((l) => !l.linked).length;
    return `<p class="a-help">${head} Dishes are matched to ${P} items by name.${c.provider === 'toast' ? ' Toast orders need every dish matched.' : ''} A choice like "Asada" is sold out here when it is sold out on ${P}.</p>${changed}
      <details><summary>Dish matching${unmatched ? ` (${unmatched} not matched)` : ''}</summary><table class="a-table"><caption class="sr">Online dishes and their ${P} items</caption><thead><tr><th scope="col">Online dish</th><th scope="col">${P} item</th><th scope="col">Change</th></tr></thead><tbody>${rows}</tbody></table></details>`;
  };

  async function posView() {
    const d = await rpc('admin_pos', { p_restaurant: r.id });
    const status = (c) => {
      if (!c.enabled) return 'Off';
      if (c.last_error) return `<span class="a-bad">Problem: ${esc(c.last_error)}</span>`;
      if (c.provider === 'cloudprnt') return c.last_seen_at ? `Printer last checked in ${esc(when(c.last_seen_at))}` : 'Waiting for the printer to check in';
      return c.last_ok_at ? `Working. Last success ${esc(when(c.last_ok_at))}` : 'Not tested yet';
    };
    view().innerHTML = `<p class="a-help">Send every paid online order to your POS or a kitchen printer, so the kitchen doesn't have to watch this screen. You can have more than one, for example Clover plus a bar printer. Orders also stay on the Kitchen screen.</p>
      ${d.connections.map((c) => `<section class="a-box"><h2>${esc(c.name || POS[c.provider].label)}</h2>
        <p>${esc(POS[c.provider].label)} · ${status(c)}</p>
        ${c.provider === 'cloudprnt' ? `<p class="a-help">In the printer's web page (type its IP address into a browser), turn on CloudPRNT and set the Server URL to:<br><code>${esc(cfg.url)}/functions/v1/pos?print=${esc(c.print_key)}</code><br>Polling every 5 seconds is fine. Keep this link private: anyone with it can read your tickets.</p>` : ''}
        <form class="a-pos-f" data-id="${c.id}" data-provider="${c.provider}"><div class="a-grid2"><label>Name <input name="name" value="${esc(c.name)}" maxlength="60"></label>${posFields(c.provider, c)}</div>
          <label class="a-check"><input type="checkbox" name="enabled"${c.enabled ? ' checked' : ''}> On</label>
          <div class="a-btns"><button>Save</button><button type="button" class="a-alt" data-postest="${c.id}">${c.provider === 'cloudprnt' ? 'Print a test ticket' : 'Test connection'}</button>${MENU_POS.includes(c.provider) ? `<button type="button" class="a-alt" data-possync="${c.id}">Sync sold-out items now</button>` : ''}</div></form>
        ${MENU_POS.includes(c.provider) ? syncBox(c) : ''}</section>`).join('')}
      <details class="a-box"${d.connections.length ? '' : ' open'}><summary>Add a POS or printer</summary>
        <form id="a-pos-new"><label>Type <select name="provider">${Object.entries(POS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></label>
          <p class="a-help" id="a-pos-help"></p><div class="a-grid2"><label>Name <input name="name" maxlength="60" placeholder="For example, Kitchen printer"></label><div id="a-pos-fields" class="a-grid2"></div></div>
          <div class="a-btns"><button>Add</button></div></form></details>
      <h2>Recent sends</h2>
      ${d.jobs.length ? `<table class="a-table"><caption class="sr">Orders sent to POS and printers</caption><thead><tr><th scope="col">When</th><th scope="col">Order</th><th scope="col">To</th><th scope="col">Status</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>
        ${d.jobs.map((j) => `<tr><td>${esc(when(j.created_at))}</td><td>${j.kind === 'test' ? 'Test' : `#${esc(j.order_no)}`}</td><td>${esc(j.connection || POS[j.provider].label)}</td>
          <td>${JOB[j.status]}${j.attempts > 1 ? ` (${j.attempts} tries)` : ''}${j.error ? `<br><small class="a-bad">${esc(j.error)}</small>` : ''}</td>
          <td>${['failed', 'cancelled'].includes(j.status) ? `<button class="a-alt" data-posjob="${j.id}" data-move="retry">Send again</button>` : ''}${['pending', 'failed'].includes(j.status) ? ` <button class="a-alt" data-posjob="${j.id}" data-move="cancel">Cancel</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p>Nothing sent yet.</p>'}`;
    const v = view(), nf = v.querySelector('#a-pos-new');
    const pick = () => { const p = nf.elements.provider.value; v.querySelector('#a-pos-fields').innerHTML = posFields(p); v.querySelector('#a-pos-help').textContent = POS[p].help; };
    nf.elements.provider.onchange = pick; pick();
    nf.onsubmit = (e) => { e.preventDefault(); const x = nf.elements, p = x.provider.value; attempt(async () => {
      await rpc('admin_save_pos', { p_restaurant: r.id, p: { provider: p, name: x.name.value.trim() || POS[p].label, settings: posSettings(p, x), token: x.token ? x.token.value.trim() : '' } });
      await posView();
    }, p === 'cloudprnt' ? 'Added. Copy the Server URL into the printer.' : 'Added. Press Test connection to check it.'); };
    v.querySelectorAll('.a-pos-f').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); const x = f.elements, p = f.dataset.provider; attempt(async () => {
      await rpc('admin_save_pos', { p_restaurant: r.id, p: { id: f.dataset.id, name: x.name.value.trim(), enabled: x.enabled.checked, settings: posSettings(p, x), token: x.token ? x.token.value.trim() : '' } });
      await posView();
    }); }; });
    v.querySelectorAll('[data-postest]').forEach((b) => { b.onclick = async () => {
      b.disabled = true;
      try { const res = await posFn({ action: 'test', connection_id: b.dataset.postest }); await posView(); say(res.message); } catch (e) { await posView().catch(() => {}); say(e.message, true); }
    }; });
    v.querySelectorAll('[data-possync]').forEach((b) => { b.onclick = async () => {
      b.disabled = true; b.textContent = 'Syncing…';
      try { const res = await posFn({ action: 'sync', connection_id: b.dataset.possync }); await posView(); say(res.message); } catch (e) { await posView().catch(() => {}); say(e.message, true); }
    }; });
    v.querySelectorAll('[data-poslink]').forEach((sel) => { sel.onchange = () => attempt(async () => {
      await rpc('admin_pos_link', { p_restaurant: r.id, p: { connection_id: sel.dataset.conn, item_id: sel.dataset.poslink, pos_id: sel.value === 'auto' ? null : sel.value } });
      await posView();
    }, sel.value === 'auto' ? 'Set to match automatically. It updates on the next sync.' : 'Saved.'); });
    v.querySelectorAll('[data-posjob]').forEach((b) => { b.onclick = () => attempt(async () => { await rpc('admin_pos_job', { p_restaurant: r.id, p: { id: b.dataset.posjob, move: b.dataset.move } }); await posView(); }, b.dataset.move === 'retry' ? 'Sending again.' : 'Cancelled.'); });
  }

  const views = {
    pos: posView,
    async dashboard() {
      const s = await rpc('admin_stats', { p_restaurant: r.id, p_days: days });
      const avg = s.orders ? s.sales_cents / s.orders : 0;
      view().innerHTML = `${s.test_mode ? '<p class="a-test">Test mode: these numbers are test orders only.</p>' : ''}
        <label class="a-range">Period <select id="a-days">${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']].map(([v, t]) => `<option value="${v}"${v === days ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <div class="a-stats">${stat('Sales', money(s.sales_cents), change(s.sales_cents, s.prev_sales_cents))}${stat('Orders', s.orders, change(s.orders, s.prev_orders))}${stat('Average order', money(avg))}${stat('Tips', money(s.tips_cents))}
        ${stat('Pickup orders', s.pickup_orders)}${stat('Delivery orders', s.delivery_orders)}${stat('Delivery fees', money(s.delivery_fee_cents))}${stat('Cancelled', s.cancelled)}
        ${stat('Sales tax collected', money(s.tax_cents))}${stat('Rewards discounts', money(s.discount_cents))}${stat('Rewards members', s.rewards_members, `<small>${s.rewards_new} new</small>`)}${stat('Points outstanding', s.rewards_points)}
        ${stat('Gift cards sold', money(s.gift_sold_cents))}${stat('Gift balance outstanding', money(s.gift_outstanding_cents))}${stat('Reservation requests', s.reservations)}${stat('Form messages', s.messages)}</div>
        <div class="a-grid">
        ${bars('Top dishes', ['Dish', 'Sold', 'Sales'], s.top_items.map((x) => ({ cells: [x.name, x.qty, money(x.sales_cents)], n: x.qty })), (x) => x.n)}
        <div>${bars('Busiest hours', ['Hour', 'Orders'], s.by_hour.map((x) => ({ cells: [hourText(x.hour), x.orders], n: x.orders })), (x) => x.n)}
        ${bars('Busiest days', ['Day', 'Orders', 'Sales'], s.by_weekday.map((x) => ({ cells: [WEEK[x.day], x.orders, money(x.sales_cents)], n: x.orders })), (x) => x.n)}</div></div>
        ${bars('Sales by day', ['Date', 'Orders', 'Sales'], s.by_day.slice(-31).map((x) => ({ cells: [x.day, x.orders, money(x.sales_cents)], n: x.sales_cents })), (x) => x.n)}`;
      view().querySelector('#a-days').onchange = (e) => { days = +e.target.value; views.dashboard(); };
    },
    async orders() {
      const rows = await call(`orders?select=order_no,created_at,status,payment_status,fulfillment,first_name,last_name,subtotal_cents,tax_cents,tip_cents,delivery_fee_cents,total_cents,test_mode&restaurant_id=eq.${r.id}&order=created_at.desc&limit=200`);
      const when = (d) => new Date(d).toLocaleString('en-US', { timeZone: r.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: r.timezone }).format(new Date());
      const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      view().innerHTML = `<p><button id="a-csv">Download orders CSV</button></p>
        <details class="a-box"><summary>Refund an order</summary><p class="a-help">Refund part or all of an online payment. Gift card and rewards amounts aren't refunded to the card. The guest gets an email.</p>
          <form class="a-form" id="a-refund"><label>Order number <input name="order_no" required autocomplete="off"></label><label>Amount ($) <input name="amount" type="number" min="0.01" step="0.01" required></label>
          <label>Reason (shown to the guest) <input name="reason" maxlength="200" placeholder="Missing item"></label><button>Refund</button></form></details>
        <details class="a-box"><summary>Sales by dish</summary><form class="a-form" id="a-items"><label>From <input type="date" name="from" value="${monthAgo}" required></label><label>To <input type="date" name="to" value="${today}" required></label><button>Show</button><button type="button" class="a-alt" id="a-items-csv">Download CSV</button></form><div id="a-items-out"></div></details><div class="a-scroll" tabindex="0" role="group" aria-label="Orders table"><table class="a-table"><caption>Latest 200 orders</caption><thead><tr>${['Order', 'Placed', 'Guest', 'Type', 'Status', 'Payment', 'Total'].map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>
        ${rows.map((o) => `<tr><th scope="row">${esc(o.order_no)}</th><td>${esc(when(o.created_at))}</td><td>${esc(o.first_name)} ${esc(o.last_name)}</td><td>${esc(o.fulfillment)}</td><td>${esc(o.status.replace(/_/g, ' '))}</td><td>${esc(o.payment_status.replace(/_/g, ' '))}</td><td>${money(o.total_cents)}</td></tr>`).join('') || '<tr><td colspan="7">No orders yet.</td></tr>'}</tbody></table></div>`;
      view().querySelector('#a-csv').onclick = () => {
        const q = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
        const heads = ['order_no', 'created_at', 'status', 'payment_status', 'fulfillment', 'first_name', 'last_name', 'subtotal_cents', 'tax_cents', 'tip_cents', 'delivery_fee_cents', 'total_cents'];
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([[heads.join(','), ...rows.map((o) => heads.map((h) => q(o[h])).join(','))].join('\n')], { type: 'text/csv' }));
        a.download = 'orders.csv'; a.click(); URL.revokeObjectURL(a.href);
      };
      view().querySelector('#a-refund').onsubmit = (e) => { e.preventDefault(); const f = e.target.elements; attempt(async () => {
        const cents = toCents(f.amount.value);
        if (!confirmStep(e.target, `Refund ${money(cents)} on order ${f.order_no.value.trim()}?`)) throw new Error('Press Refund again to confirm.');
        await staff('refund', { order_no: f.order_no.value.trim(), cents, reason: f.reason.value });
        await views.orders();
      }, 'Refunded.'); };
      let itemRows = [];
      const items = view().querySelector('#a-items');
      items.onsubmit = (e) => { e.preventDefault(); attempt(async () => {
        itemRows = await rpc('admin_item_sales', { p_restaurant: r.id, p_from: items.elements.from.value, p_to: items.elements.to.value });
        view().querySelector('#a-items-out').innerHTML = `<div class="a-scroll" tabindex="0" role="group" aria-label="Sales by dish"><table class="a-table"><caption>Sales by dish</caption><thead><tr><th scope="col">Dish</th><th scope="col">Sold</th><th scope="col">Orders</th><th scope="col">Sales</th></tr></thead><tbody>
          ${itemRows.map((x) => `<tr><th scope="row">${esc(x.name)}</th><td>${x.qty}</td><td>${x.orders}</td><td>${money(x.sales_cents)}</td></tr>`).join('') || '<tr><td colspan="4">No sales in these dates.</td></tr>'}</tbody></table></div>`;
      }, 'Loaded.'); };
      view().querySelector('#a-items-csv').onclick = () => attempt(async () => {
        if (!itemRows.length) itemRows = await rpc('admin_item_sales', { p_restaurant: r.id, p_from: items.elements.from.value, p_to: items.elements.to.value });
        download(`dish-sales-${items.elements.from.value}-to-${items.elements.to.value}.csv`, ['dish', 'quantity', 'orders', 'sales'], itemRows.map((x) => [x.name, x.qty, x.orders, (x.sales_cents / 100).toFixed(2)]));
      }, 'Downloaded.');
    },
    async customers() { await customersView(); },
    async campaigns() { await campaignsView(); },
    async website() { await websiteView(); },
    async reservations() {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: r.timezone }).format(new Date());
      if (!resDay) resDay = today;
      const longDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
      const label = (m) => `${(Math.floor(m / 60) % 12) || 12}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`;
      const toMin = (v) => { const [h, m] = String(v).split(':').map(Number); return h * 60 + m; };
      const [day, upcoming, [cfg2]] = await Promise.all([staff('reservations', { date: resDay }), staff('reservations'),
        call(`restaurants?select=res_capacity,res_slot_minutes,res_dining_minutes,res_max_online,res_days_ahead,res_lead_minutes,res_last_seating_minutes,res_auto_confirm&id=eq.${r.id}`)]);
      const asks = upcoming.rows.filter((x) => x.status === 'requested');
      const card = (x) => `<section class="a-box"><h3>${esc(x.res_time)} · party of ${esc(x.guests ?? x.party_size)}${x.status === 'requested' ? ' · <strong>Needs reply</strong>' : ''}</h3>
        <p>${esc(x.name)}<br><a href="tel:${esc(x.phone)}">${esc(x.phone)}</a> · ${esc(x.email)}${x.requests ? `<br>Note: ${esc(x.requests)}` : ''}</p>
        <div class="a-btns">${x.status === 'requested' ? `<button data-r="${x.id}" data-m="confirm" aria-label="Confirm ${esc(x.name)}">Confirm</button><button class="a-alt" data-r="${x.id}" data-m="decline" aria-label="Decline ${esc(x.name)}">Decline</button>` : x.status === 'confirmed' ? `<button data-rs="${x.id}" data-m="seated" aria-label="Mark ${esc(x.name)} seated">Seated</button><button class="a-alt" data-rs="${x.id}" data-m="no_show" aria-label="Mark ${esc(x.name)} no-show">No-show</button><button class="a-alt" data-r="${x.id}" data-m="cancel" aria-label="Cancel ${esc(x.name)}">Cancel</button>` : `<span class="a-tag">${esc(x.status === 'no_show' ? 'No-show' : 'Seated')}</span>`}${x.sms_updates ? ' <span class="a-tag">Text reminder</span>' : ''}</div></section>`;
      const seated = day.rows.reduce((n, x) => n + (x.guests || 0), 0);
      const free = new Map((day.slots || []).map((s) => [s.min, s.left]));
      const byTime = new Map();
      for (const x of day.rows) { const k = x.start_min ?? -1; byTime.set(k, [...(byTime.get(k) || []), x]); }
      view().innerHTML = `
        ${asks.length ? `<h2>Needs reply (${asks.length})</h2><p class="a-help">Large groups wait here until you confirm or decline. The guest gets an email either way once email is connected.</p>${asks.map((x) => card({ ...x, res_time: `${longDay(x.res_date)}, ${x.res_time}` })).join('')}` : ''}
        <h2>Day view</h2>
        <div class="a-form a-resnav"><button type="button" class="a-alt" data-day="-1">‹ Previous day</button>
          <label>Date <input type="date" id="a-resday" value="${resDay}"></label>
          <button type="button" class="a-alt" data-day="1">Next day ›</button>${resDay !== today ? '<button type="button" class="a-alt" data-day="0">Today</button>' : ''}</div>
        <p><strong>${esc(longDay(resDay))}</strong>: ${day.rows.length} reservation${day.rows.length === 1 ? '' : 's'}, ${seated} guest${seated === 1 ? '' : 's'}. Room holds ${day.capacity} seats.</p>
        ${(day.slots || []).length ? `<div class="a-scroll" tabindex="0" role="group" aria-label="Seats by time"><table class="a-table"><caption>Seats still open online</caption><thead><tr><th scope="col">Time</th><th scope="col">Seats left</th><th scope="col">Booked at this time</th></tr></thead><tbody>
          ${day.slots.map((s) => `<tr><th scope="row">${esc(s.label)}</th><td>${s.left} of ${day.capacity}</td><td>${(byTime.get(s.min) || []).map((x) => `${esc(x.name)} (${x.guests})`).join(', ') || '—'}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="a-help">No online times left for this day (closed, blocked, full, or already past).</p>'}
        ${day.rows.length ? day.rows.map(card).join('') : '<p>No reservations this day.</p>'}
        <h2>Blocked times</h2><p class="a-help">Block a whole day (holidays, private events) or part of a day. Guests can't book blocked times online. Existing reservations stay.</p>
        ${day.blocks.map((b) => `<p>${b.start_min == null ? 'Whole day' : `${label(b.start_min)} to ${label(b.end_min)}`}${b.reason ? ` · ${esc(b.reason)}` : ''} <button type="button" class="a-alt" data-unblock="${b.id}">Remove</button></p>`).join('') || '<p>Nothing blocked on this day.</p>'}
        <form class="a-form" id="a-block"><label>Date <input type="date" name="date" value="${resDay}" required></label>
          <label class="a-check"><input type="checkbox" name="whole" checked> Whole day</label>
          <label>From <input type="time" name="from" value="17:00" disabled></label><label>To <input type="time" name="to" value="21:00" disabled></label>
          <label>Reason (staff only) <input name="reason" maxlength="200" placeholder="Thanksgiving, private party…"></label><button>Block</button></form>
        <details class="a-box"><summary>Reservation settings</summary>
          <form id="a-resset">
            <label>Seats in the dining room <input type="number" name="res_capacity" min="1" max="1000" value="${cfg2.res_capacity}" required></label>
            <label>Largest party that books instantly <input type="number" name="res_max_online" min="1" max="100" value="${cfg2.res_max_online}" required></label>
            <label>Minutes a table is held <input type="number" name="res_dining_minutes" min="15" max="360" step="15" value="${cfg2.res_dining_minutes}" required></label>
            <label>Time between start times (minutes) <select name="res_slot_minutes">${[15, 30, 60].map((n) => `<option${n === cfg2.res_slot_minutes ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
            <label>Book at least this many minutes ahead <input type="number" name="res_lead_minutes" min="0" max="2880" step="15" value="${cfg2.res_lead_minutes}" required></label>
            <label>Last seating, minutes before close <input type="number" name="res_last_seating_minutes" min="0" max="240" step="15" value="${cfg2.res_last_seating_minutes}" required></label>
            <label>Days ahead guests can book <input type="number" name="res_days_ahead" min="1" max="365" value="${cfg2.res_days_ahead}" required></label>
            <label class="a-check"><input type="checkbox" name="res_auto_confirm"${cfg2.res_auto_confirm ? ' checked' : ''}> Confirm smaller parties instantly (off: every booking waits for you)</label>
            <button>Save settings</button></form></details>`;
      const v = view();
      v.querySelectorAll('[data-rs]').forEach((b) => { b.onclick = () => attempt(async () => { await staff('res_status', { id: b.dataset.rs, move: b.dataset.m }); await views.reservations(); }); });
      v.querySelectorAll('[data-r]').forEach((b) => { b.onclick = () => attempt(async () => { await staff('reservation', { id: b.dataset.r, move: b.dataset.m }); await views.reservations(); await counts(); }); });
      v.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => { const n = +b.dataset.day; if (!n) resDay = today; else { const d = new Date(`${resDay}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); resDay = d.toISOString().slice(0, 10); } views.reservations(); }; });
      v.querySelector('#a-resday').onchange = (e) => { if (e.target.value) { resDay = e.target.value; views.reservations(); } };
      const bf = v.querySelector('#a-block');
      bf.elements.whole.onchange = () => { bf.elements.from.disabled = bf.elements.to.disabled = bf.elements.whole.checked; };
      bf.onsubmit = (e) => { e.preventDefault(); const f = bf.elements; attempt(async () => {
        const whole = f.whole.checked, a = toMin(f.from.value), z = toMin(f.to.value);
        if (!f.date.value) throw new Error('Pick a date.');
        if (!whole && !(z > a)) throw new Error('The end time must be after the start time.');
        await rpc('admin_res_block', { p_restaurant: r.id, p: { date: f.date.value, start_min: whole ? null : a, end_min: whole ? null : z, reason: f.reason.value } });
        resDay = f.date.value; await views.reservations();
      }, 'Blocked.'); };
      v.querySelectorAll('[data-unblock]').forEach((b) => { b.onclick = () => attempt(async () => { await rpc('admin_res_block', { p_restaurant: r.id, p: { remove: b.dataset.unblock } }); await views.reservations(); }, 'Removed.'); });
      v.querySelector('#a-resset').onsubmit = (e) => { e.preventDefault(); const f = e.target.elements; attempt(async () => {
        const p = Object.fromEntries(['res_capacity', 'res_max_online', 'res_dining_minutes', 'res_slot_minutes', 'res_lead_minutes', 'res_last_seating_minutes', 'res_days_ahead'].map((k) => [k, Math.round(+f[k].value)]));
        p.res_auto_confirm = f.res_auto_confirm.checked;
        await rpc('admin_res_settings', { p_restaurant: r.id, p }); await views.reservations();
      }, 'Settings saved.'); };
    },
    async messages() {
      const { rows } = await staff('messages');
      view().innerHTML = `<p class="a-help">Catering, careers, party and question forms land here. Done clears it from this list. It doesn't reply to the guest.</p>${rows.map((m) => `<section class="a-box"><h2>${esc(m.kind.replace(/-/g, ' '))}</h2><p>${esc(new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</p>${Object.entries(m.data).filter(([k]) => k !== 'sms_consent' && m.data[k]).map(([k, v]) => `<p><strong>${esc(k.replace(/_/g, ' '))}:</strong> ${esc(v)}</p>`).join('')}<div class="a-btns"><button data-done="${m.id}" aria-label="Done with ${esc(m.kind.replace(/-/g, ' '))} from ${esc(m.data.name || 'guest')}">Done</button></div></section>`).join('') || '<p>No new messages.</p>'}`;
      view().querySelectorAll('[data-done]').forEach((b) => { b.onclick = () => attempt(async () => { await staff('message', { id: b.dataset.done }); await views.messages(); await counts(); }); });
    },
    async rewards() {
      view().innerHTML = `<form class="a-box" id="a-rw"><h2>Find a member</h2><label>Member phone <input name="phone" type="tel" required></label> <button>Find</button></form><div id="a-rw-out"></div>`;
      const out = view().querySelector('#a-rw-out');
      const find = async (phone) => {
        const r = await staff('rewards_find', { phone }), a = r.account;
        out.innerHTML = `<section class="a-box"><h2>${esc(a.name)}</h2><p>${esc(a.points)} points<br>Phone: ${esc(a.phone)}<br>Rewards code: ${esc(a.code)}</p>
          <div class="a-btns"><button data-use${a.points < r.redeem_points ? ' disabled' : ''}>Use ${esc(r.redeem_points)} points for ${money(r.redeem_cents)} off</button></div>
          <form id="a-rw-add"><label>Add points <input name="points" type="number" min="1" required></label> <button>Add</button></form></section>`;
        const change = (points) => attempt(async () => { await staff('rewards_adjust', { id: a.id, points }); await find(phone); });
        out.querySelector('[data-use]').onclick = () => change(-r.redeem_points);
        out.querySelector('#a-rw-add').onsubmit = (e) => { e.preventDefault(); change(+e.target.points.value); };
      };
      view().querySelector('#a-rw').onsubmit = (e) => { e.preventDefault(); out.innerHTML = ''; attempt(() => find(e.target.phone.value), ''); };
    },
    async gift() {
      view().innerHTML = `<form class="a-box" id="a-gc"><h2>Find a gift card</h2><label>Gift card code <input name="code" autocomplete="off" required></label> <button>Find</button></form><div id="a-gc-out"></div>
        <form class="a-box" id="a-gs"><h2>Sell a card in store</h2><label>Amount in dollars <input name="amount" type="number" min="1" step="0.01" required></label> <label>Buyer name <input name="name"></label> <button>Create card</button></form><div id="a-gs-out"></div>`;
      const out = view().querySelector('#a-gc-out');
      const find = async (code) => {
        const { card: c } = await staff('gift_find', { code });
        out.innerHTML = `<section class="a-box"><h2>${esc(c.code)}</h2><p>${money(c.balance_cents)} left<br>Status: ${esc(c.status)}</p><form id="a-gc-use"><label>Amount to take, in dollars <input name="amount" type="number" min="0.01" step="0.01" required></label> <button>Take off card</button></form></section>`;
        out.querySelector('#a-gc-use').onsubmit = (e) => { e.preventDefault(); attempt(async () => { await staff('gift_redeem', { id: c.id, cents: Math.round(+e.target.amount.value * 100) }); await find(code); }); };
      };
      view().querySelector('#a-gc').onsubmit = (e) => { e.preventDefault(); out.innerHTML = ''; attempt(() => find(e.target.code.value), ''); };
      view().querySelector('#a-gs').onsubmit = (e) => { e.preventDefault(); attempt(async () => { const o = await staff('gift_issue', { cents: Math.round(+e.target.amount.value * 100), name: e.target.name.value }); view().querySelector('#a-gs-out').innerHTML = `<section class="a-box"><h2>${esc(o.code)}</h2><p>${money(o.balance_cents)}. Give this code to the guest.</p></section>`; }); };
    },
    async menu() {
      menu = await rpc('admin_menu', { p_restaurant: r.id });
      view().innerHTML = `<p class="a-help">Sold out and Featured apply to a dish at both lunch and dinner. Price and text apply to the version you edit.</p>
        ${menu.categories.map((c) => `<details class="a-cat"><summary>${esc(c.name)}${c.lunch ? ' (lunch)' : ''} <small>${c.items.length} items</small></summary>
          ${c.items.map((i) => `<form class="a-item" data-id="${i.id}">${i.image ? `<img src="${esc(i.image)}" alt="${esc(i.name)}" width="72" height="72" loading="lazy">` : '<span class="a-noimg">No photo</span>'}
            <div class="a-fields"><label>Name<input name="name" value="${esc(i.name)}" required></label><label>Price ($)<input name="price" type="number" min="0" step="0.01" value="${(i.price_cents / 100).toFixed(2)}" required></label>
            <label class="a-wide">Description<textarea name="description" rows="2">${esc(i.description)}</textarea></label>
            <label class="a-check"><input type="checkbox" name="soldout"${i.available ? '' : ' checked'}> Sold out</label><label class="a-check"><input type="checkbox" name="popular"${i.popular ? ' checked' : ''}> Featured</label>
            <label class="a-check"><input type="checkbox" name="gluten_free"${i.gluten_free ? ' checked' : ''}> Gluten free</label><label class="a-check"><input type="checkbox" name="vegetarian"${i.vegetarian ? ' checked' : ''}> Vegetarian</label>
            <label class="a-wide">Replace photo<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label></div><button>Save ${esc(i.name)}</button></form>`).join('')}
          <form class="a-new" data-cat="${c.id}"><label>New item name<input name="name" required></label><label>Price ($)<input name="price" type="number" min="0" step="0.01" required></label><button>Add item</button></form></details>`).join('')}`;
      view().querySelectorAll('.a-item').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); attempt(async () => {
        const body = { name: f.elements.name.value.trim(), description: f.elements.description.value, price_cents: toCents(f.elements.price.value), available: !f.elements.soldout.checked, popular: f.elements.popular.checked, gluten_free: f.elements.gluten_free.checked, vegetarian: f.elements.vegetarian.checked };
        const file = f.elements.photo.files[0];
        if (file) {
          const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
          if (!ext) throw new Error('Use a JPG, PNG or WebP photo.');
          const slug = body.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const path = `menu-images/${r.id}/${slug}-heber-city-${Date.now()}.${ext}`;
          const up = await fetch(`${STORE}/${path}`, { method: 'POST', headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}`, 'Content-Type': file.type }, body: file });
          if (!up.ok) throw new Error('The photo did not upload. Use a file under 5 MB.');
          body.image = `${STORE}/public/${path}`;
        }
        await rpc('admin_save_item', { p_item: f.dataset.id, p: body });
      }); }; });
      view().querySelectorAll('.a-new').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); attempt(async () => {
        await rpc('admin_new_item', { p_category: f.dataset.cat, p: { name: f.elements.name.value, price_cents: toCents(f.elements.price.value) } });
        await views.menu();
      }, 'Item added.'); }; });
    },
    async choices() {
      const m = await rpc('admin_menu', { p_restaurant: r.id });
      view().innerHTML = `<p class="a-help">Change add-on prices or mark a choice sold out, such as a protein you ran out of.</p>
        ${m.groups.map((g, n) => `<details class="a-cat"><summary>${esc(g.name)} <small>${g.options.length} choices · set ${n + 1}</small></summary>
          ${g.options.map((o) => `<form class="a-opt" data-id="${o.id}"><span>${esc(o.name)}</span><label>Price ($)<input name="price" type="number" min="0" step="0.01" value="${(o.price_cents / 100).toFixed(2)}"></label><label class="a-check"><input type="checkbox" name="soldout"${o.available ? '' : ' checked'}> Sold out</label><button aria-label="Save ${esc(o.name)}">Save</button></form>`).join('')}</details>`).join('')}`;
      view().querySelectorAll('.a-opt').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); attempt(() => rpc('admin_save_option', { p_option: f.dataset.id, p: { price_cents: toCents(f.elements.price.value), available: !f.elements.soldout.checked } })); }; });
    },
    async pairs() {
      const [m, ideas, slugged, live] = await Promise.all([rpc('admin_menu', { p_restaurant: r.id }), rpc('admin_pair_ideas', { p_restaurant: r.id }), call(`restaurants?select=popular_days,popular_min_orders,popular_count,pairs_auto,pairs_days,pairs_min_orders&id=eq.${r.id}`), rpc('get_menu', { p_slug: r.slug })]);
      const names = new Map();
      m.categories.forEach((c) => c.items.forEach((i) => { if (!names.has(i.name)) names.set(i.name, i); }));
      const all = [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
      const byId = new Map(); m.categories.forEach((c) => c.items.forEach((i) => byId.set(i.id, i)));
      const s = slugged[0];
      const liveById = new Map(), learned = new Map();
      live.categories.forEach((c) => c.items.forEach((i) => liveById.set(i.id, i.name)));
      live.categories.forEach((c) => c.items.forEach((i) => { const set = new Set((names.get(i.name)?.pairs || []).map((id) => byId.get(id)?.name)); const extra = i.pairs.map((id) => liveById.get(id)).filter((n) => n && !set.has(n)); if (extra.length) learned.set(i.name, extra); }));
      const pick = (i, n) => { const cur = byId.get(i.pairs[n])?.name; return `<select name="p${n}" aria-label="${esc(i.name)} pairing ${n + 1}"><option value="">None</option>${all.filter((x) => x.name !== i.name).map((x) => `<option value="${x.id}"${x.name === cur ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`; };
      view().innerHTML = `<section class="a-box"><h2>Popular dishes</h2><p class="a-help">The menu opens with the most-ordered dishes once there are enough picked-up orders. Until then it shows dishes marked Featured in the Menu tab.</p>
        <form id="a-pop" class="a-form"><label>Count orders from the last (days)<input name="popular_days" type="number" min="1" max="365" value="${s.popular_days}"></label><label>Orders needed first<input name="popular_min_orders" type="number" min="0" value="${s.popular_min_orders}"></label><label>Dishes to show<input name="popular_count" type="number" min="1" max="24" value="${s.popular_count}"></label><button>Save</button></form></section>
        <section class="a-box"><h2>Automatic pairings</h2><p class="a-help">Dishes guests often order together fill the spots left after your picks, up to six per dish.</p>
        <form id="a-auto" class="a-form"><label class="a-check"><input name="pairs_auto" type="checkbox"${s.pairs_auto ? ' checked' : ''}> Use automatic pairings</label><label>Count orders from the last (days)<input name="pairs_days" type="number" min="1" max="365" value="${s.pairs_days}"></label><label>Shared orders needed<input name="pairs_min_orders" type="number" min="1" max="1000" value="${s.pairs_min_orders}"></label><button>Save</button></form>
        ${learned.size ? `<h3>Showing now</h3><ul>${[...learned].sort(([a], [b]) => a.localeCompare(b)).map(([n, l]) => `<li>${esc(n)}: ${l.map(esc).join(', ')}</li>`).join('')}</ul>` : '<p>Automatic pairings appear here once enough orders come in.</p>'}</section>
        <section class="a-box"><h2>Often ordered together</h2>${ideas.length ? `<ul>${ideas.map((x) => `<li>${esc(x.a)} and ${esc(x.b)}: ${x.orders} orders</li>`).join('')}</ul>` : '<p>Suggestions appear here once orders come in.</p>'}</section>
        <section class="a-box"><h2>Pairings</h2><p class="a-help">Guests see these first in the item popup and cart. Each dish can have up to three here.</p>
        ${all.map((i) => `<details class="a-cat"><summary>${esc(i.name)} <small>${i.pairs.length} set</small></summary><form class="a-pair" data-id="${i.id}">${[0, 1, 2].map((n) => pick(i, n)).join('')}<button aria-label="Save pairings for ${esc(i.name)}">Save</button></form></details>`).join('')}</section>`;
      view().querySelector('#a-pop').onsubmit = (e) => { e.preventDefault(); attempt(() => rpc('admin_save_settings', { p_restaurant: r.id, p: Object.fromEntries(new FormData(e.target).entries()) })); };
      view().querySelector('#a-auto').onsubmit = (e) => { e.preventDefault(); const f = e.target; attempt(async () => { await rpc('admin_save_pair_rules', { p_restaurant: r.id, p: { pairs_auto: f.elements.pairs_auto.checked, pairs_days: f.elements.pairs_days.value, pairs_min_orders: f.elements.pairs_min_orders.value } }); await views.pairs(); }); };
      view().querySelectorAll('.a-pair').forEach((f) => { f.onsubmit = (e) => { e.preventDefault(); attempt(() => rpc('admin_set_pairs', { p_item: f.dataset.id, p_pairs: [...f.querySelectorAll('select')].map((x) => x.value).filter(Boolean) })); }; });
    },
    async marketing() {
      const d = await staff('mkt_report');
      const t = d.report.totals, rows = d.report.campaigns || [], camps = d.campaigns || [];
      const qr = (u) => `${d.qr_url}?data=${encodeURIComponent(u)}`;
      const CH = [['facebook', 'Facebook post'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['meta_ads', 'Meta ads'], ['google_ads', 'Google ads'], ['email', 'Email'], ['sms', 'Text message'], ['billboard', 'Mobile billboard'], ['flyer', 'Flyer or mailer'], ['table_tent', 'Table tent or in-store QR'], ['other', 'Other']];
      const links = camps.flatMap((c) => (c.short_links || []).map((l) => ({ ...l, c })));
      const today = new Date().toLocaleDateString('en-CA');
      view().innerHTML = `<p class="a-help">Sales and bookings tied to each ad, post, QR code or billboard. Treat these as a floor: some guests can't be tracked.</p>
        <div class="a-stats">${stat('Revenue from marketing', money(t.revenue_cents), `<small>${t.conversions} tracked sales and bookings</small>`)}${stat('Ad spend', money(t.spend_cents), `<small>${t.spend_cents ? 'entered below' : 'none entered yet'}</small>`)}
        ${stat('Return on ad spend', t.roas != null ? `${t.roas}×` : '—', `<small>${t.roas != null ? `${money(Math.round(t.roas * 100))} back per $1` : 'add spend to see this'}</small>`)}${stat('Not tied to a campaign', money(t.unattributed_revenue_cents), '<small>walk-ins, direct, untracked</small>')}</div>
        <div class="a-scroll a-desk" tabindex="0" role="group" aria-label="Campaign results"><table class="a-table"><caption>By campaign</caption><thead><tr>${['Campaign', 'Clicks', 'Online', 'Phone', 'Bookings', 'Seated', 'Walk-in', 'Revenue', 'Spend', 'ROAS'].map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>
        ${rows.map((x) => `<tr><th scope="row">${esc(x.name)}<br><small>${esc(x.channel.replace(/_/g, ' '))}</small></th><td>${x.touches}</td><td>${x.online_orders}</td><td>${x.phone_orders}</td><td>${x.reservations}</td><td>${x.seated_checks}</td><td>${x.walk_in_redemptions}</td><td><strong>${money(x.revenue_cents)}</strong></td><td>${Number(x.spend_cents) ? money(x.spend_cents) : '—'}</td><td>${x.roas != null ? `${esc(x.roas)}×` : '—'}</td></tr>`).join('') || '<tr><td colspan="10">No campaigns yet. Make a tracked link below to start measuring.</td></tr>'}</tbody></table></div>
        <section class="a-box a-mcards"><h2>By campaign</h2>${rows.map((x) => `<div class="a-mc"><div class="a-mc-head"><strong>${esc(x.name)}</strong><strong>${money(x.revenue_cents)}</strong></div>
          <small>${esc(x.channel.replace(/_/g, ' '))}${x.roas != null ? ` · ${esc(x.roas)}× return` : ''}</small><p>${[[x.touches, 'clicks'], [x.online_orders, 'online'], [x.phone_orders, 'phone'], [x.reservations, 'bookings'], [x.seated_checks, 'seated'], [x.walk_in_redemptions, 'walk-in']].filter(([n]) => Number(n) > 0).map(([n, l]) => `${n} ${l}`).join(' · ') || 'No activity yet'}${Number(x.spend_cents) ? ` · ${money(x.spend_cents)} spent` : ''}</p></div>`).join('') || '<p>No campaigns yet. Make a tracked link below to start measuring.</p>'}</section>
        <div class="a-grid"><form class="a-box a-stack" id="a-link"><h2>New tracked link</h2>
          <label>Campaign name<input name="name" required placeholder="Taco Tuesday, November Facebook post"></label>
          <label>Where it's posted<select name="channel">${CH.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
          <label>Send people to<input name="dest" type="url" required value="${esc(location.origin)}/menu/"></label>
          <label>Short name (optional)<input name="slug" autocapitalize="none" placeholder="fb-taco"></label>
          <label>Promo code (optional)<input name="promo" autocapitalize="characters" placeholder="TACO10"></label>
          <label>Tracking phone number (optional)<input name="phone" type="tel"></label>
          <label class="a-check"><input type="checkbox" name="qr"> This link is for a printed QR code</label>
          <button>Create link</button><p id="a-link-out" role="status"></p></form>
        <form class="a-box a-stack" id="a-spend"><h2>Add ad spend</h2><p class="a-help">What a campaign cost (boost, ad budget, printing, billboard time). Saving the same day again replaces it.</p>
          <label>Campaign<select name="c" required><option value="">Choose a campaign</option>${camps.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
          <label>Date<input name="date" type="date" value="${today}" required></label><label>Amount ($)<input name="amount" type="number" min="0" step="0.01" required></label>
          <button${camps.length ? '' : ' disabled'}>Save spend</button></form></div>
        <section class="a-box"><h2>Your tracked links</h2>${links.length ? `<ul class="a-links">${links.map((l) => `<li><a href="${esc(qr(l.short_url))}" target="_blank" rel="noopener"><img src="${esc(qr(l.short_url))}" alt="QR code for ${esc(l.c.name)}" width="64" height="64" loading="lazy"></a>
          <div><strong>${esc(l.c.name)}</strong><br><small>${esc(l.short_url)}${l.c.promo_code ? ` · code ${esc(l.c.promo_code)}` : ''}${l.active ? '' : ' · paused'}</small></div><button class="a-alt" data-copy="${esc(l.short_url)}" aria-label="Copy link for ${esc(l.c.name)}">Copy</button></li>`).join('')}</ul>` : '<p>No links yet.</p>'}</section>`;
      view().querySelector('#a-link').onsubmit = (e) => { e.preventDefault(); const f = e.target.elements; attempt(async () => {
        const o = await staff('mkt_link', { destinationUrl: f.dest.value, slug: f.slug.value, isQr: f.qr.checked, campaign: { name: f.name.value, channel: f.channel.value, promoCode: f.promo.value, trackingPhone: f.phone.value } });
        await views.marketing();
        say(`Link created: ${o.shortUrl}`);
      }, ''); };
      view().querySelector('#a-spend').onsubmit = (e) => { e.preventDefault(); const f = e.target.elements; attempt(async () => { await staff('mkt_spend', { campaignId: f.c.value, date: f.date.value, amount: +f.amount.value }); await views.marketing(); }, 'Spend saved.'); };
      view().querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { say('Copy blocked. Press and hold the link to copy it.', true); } }; });
    },
    async team() {
      const d = await staff('team_list');
      const ROLES = [['owner', 'Owner (everything, including Team)'], ['manager', 'Manager (everything except Team)'], ['kitchen', 'Kitchen screen only'], ['custom', 'Custom (pick sections)']];
      const boxes = (have) => d.sections.map((p) => `<label class="a-check"><input type="checkbox" name="perm" value="${p}"${have.includes(p) ? ' checked' : ''}> ${esc(SECTION_NAMES[p])}</label>`).join('');
      const roleOf = (x) => { if (!x) return 'manager'; const same = (a, b) => a.length === b.length && a.every((p) => b.includes(p)); return Object.entries(d.roles).find(([, ps]) => same(ps, x.permissions))?.[0] || 'custom'; };
      const form = (x) => `<form class="a-box a-stack a-person"${x ? ` data-uid="${x.user_id}"` : ''}><h2>${x ? esc(x.name || x.email) : 'Add a person'}${x?.you ? ' (you)' : ''}</h2>
        ${x ? `<p class="a-help">${esc(x.email)} · ${x.last_sign_in_at ? `last signed in ${esc(new Date(x.last_sign_in_at).toLocaleDateString())}` : 'has not signed in yet'}</p><input type="hidden" name="email" value="${esc(x.email)}">` : '<label>Email<input name="email" type="email" required autocomplete="off"></label>'}
        <label>Name<input name="name" value="${esc(x?.name || '')}"></label>
        <label>Access<select name="role">${ROLES.map(([v, l]) => `<option value="${v}"${roleOf(x) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <fieldset class="a-perms"${roleOf(x) === 'custom' ? '' : ' hidden'}><legend>Sections this person can use</legend>${boxes(x?.permissions || [])}</fieldset>
        <div class="a-btns"><button>${x ? 'Save' : 'Add person'}</button>${x && !x.you ? `<button type="button" class="a-alt" data-remove="${x.user_id}">Remove</button>` : ''}</div></form>`;
      view().innerHTML = `<p class="a-help">Choose what each person can see and change. New people get a temporary password to sign in with here and on the kitchen screen.</p>
        ${r.agency ? '<p class="a-help">You have agency access to every restaurant, so you are not listed here.</p>' : ''}<div id="a-team-new"></div>${form(null)}${d.rows.map(form).join('')}`;
      view().querySelectorAll('.a-person').forEach((f) => {
        f.elements.role.onchange = () => { f.querySelector('.a-perms').hidden = f.elements.role.value !== 'custom'; };
        f.onsubmit = (e) => { e.preventDefault(); attempt(async () => {
          const o = await staff('team_save', { email: f.elements.email.value, name: f.elements.name.value, role: f.elements.role.value, permissions: [...f.querySelectorAll('[name=perm]:checked')].map((c) => c.value) });
          await views.team();
          if (o.temp_password) view().querySelector('#a-team-new').innerHTML = `<section class="a-box a-test"><h2>Login created for ${esc(o.email)}</h2><p>Temporary password: <code>${esc(o.temp_password)}</code></p><p>Send it to them privately. It won't be shown again. They can change it under My login.</p></section>`;
        }); };
        const rm = f.querySelector('[data-remove]');
        if (rm) rm.onclick = () => { if (confirm('Remove this person from this restaurant?')) attempt(async () => { await staff('team_remove', { user_id: rm.dataset.remove }); await views.team(); }, 'Removed.'); };
      });
    },
    async account() {
      view().innerHTML = `<form class="a-box a-stack" id="a-pw"><h2>Change my password</h2><label>New password<input name="pw" type="password" minlength="10" autocomplete="new-password" required></label>
        <label>Type it again<input name="pw2" type="password" minlength="10" autocomplete="new-password" required></label><button>Change password</button></form>`;
      view().querySelector('#a-pw').onsubmit = (e) => { e.preventDefault(); const f = e.target.elements; attempt(async () => {
        if (f.pw.value !== f.pw2.value) throw new Error("The two passwords don't match.");
        const go = () => fetch(`${AUTH}/user`, { method: 'PUT', headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: f.pw.value }) });
        let x = await go();
        if (x.status === 401 && await refresh()) x = await go();
        const d = await x.json().catch(() => ({}));
        if (!x.ok) throw new Error(d.msg || d.message || 'That password was not accepted.');
        e.target.reset();
      }, 'Password changed.'); };
    },
    async settings() {
      const [s] = await call(`restaurants?select=*&id=eq.${r.id}`);
      const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
      const num = (n, l, v, x = '') => `<label>${l}<input name="${n}" type="number" value="${v}" ${x}></label>`;
      const txt = (n, l, v, t = 'text') => `<label>${l}<input name="${n}" type="${t}" value="${esc(v ?? '')}"></label>`;
      view().innerHTML = `<form id="a-set">
        <section class="a-box"><h2>Hours</h2><p class="a-help">Leave both times empty for a closed day. Lunch and dinner menu times are set separately.</p>${DAYS.map(([k, t]) => { const h = (s.hours[k] || [])[0] || ['', '']; return `<fieldset class="a-day"><legend>${t}</legend><label>Open<input type="time" name="o_${k}" value="${h[0]}"></label><label>Close<input type="time" name="c_${k}" value="${h[1]}"></label></fieldset>`; }).join('')}</section>
        <section class="a-box"><h2>Orders</h2><div class="a-form">${num('pickup_lead_minutes', 'Pickup lead time (minutes)', s.pickup_lead_minutes, 'min="0" max="240"')}${txt('alert_email', 'New order email', s.alert_email, 'email')}${txt('forms_email', 'Website form email', s.forms_email, 'email')}</div></section>
        <section class="a-box"><h2>Delivery</h2><div class="a-form"><label class="a-check"><input type="checkbox" name="delivery_enabled"${s.delivery_enabled ? ' checked' : ''}> Offer delivery at checkout</label>${num('delivery_lead_minutes', 'Delivery lead time (minutes)', s.delivery_lead_minutes, 'min="0" max="240"')}${num('delivery_min', 'Delivery minimum ($)', s.delivery_min_cents / 100, 'min="0" step="0.01"')}${txt('doordash_store_url', 'DoorDash store link', s.doordash_store_url, 'url')}</div></section>
        <section class="a-box"><h2>Rewards</h2><div class="a-form">${num('rewards_points_per_dollar', 'Points per $1', s.rewards_points_per_dollar, 'min="0" max="100"')}${num('rewards_redeem_points', 'Points for a reward', s.rewards_redeem_points, 'min="1"')}${num('rewards_redeem', 'Reward value ($)', s.rewards_redeem_cents / 100, 'min="0.01" step="0.01"')}</div></section>
        <section class="a-box"><h2>Gift cards</h2><div class="a-form">${num('gift_min', 'Smallest online card ($)', s.gift_min_cents / 100, 'min="1"')}${num('gift_max', 'Largest online card ($)', s.gift_max_cents / 100, 'min="1"')}</div></section>
        <button>Save settings</button></form>`;
      view().querySelector('#a-set').onsubmit = (e) => { e.preventDefault(); const f = e.target.elements; attempt(async () => {
        const hours = {};
        for (const [k] of DAYS) { const o = f[`o_${k}`].value, c = f[`c_${k}`].value; if (!!o !== !!c) throw new Error('Enter both open and close times, or neither.'); hours[k] = o ? [[o, c]] : []; }
        await rpc('admin_save_settings', { p_restaurant: r.id, p: { hours, pickup_lead_minutes: f.pickup_lead_minutes.value, alert_email: f.alert_email.value, forms_email: f.forms_email.value, delivery_enabled: f.delivery_enabled.checked, delivery_lead_minutes: f.delivery_lead_minutes.value, delivery_min_cents: toCents(f.delivery_min.value), doordash_store_url: f.doordash_store_url.value, rewards_points_per_dollar: f.rewards_points_per_dollar.value, rewards_redeem_points: f.rewards_redeem_points.value, rewards_redeem_cents: toCents(f.rewards_redeem.value), gift_min_cents: toCents(f.gift_min.value), gift_max_cents: toCents(f.gift_max.value) } });
      }); };
    },
  };

  async function start() {
    if (!session) return loginView();
    try {
      access = (await rpc('my_access', {})).filter((x) => x.perms.some((p) => p !== 'kitchen'));
    } catch (e) {
      if (e.message !== 'auth') { session = null; keep.set(null); loginView('Something went wrong. Please sign in again.'); }
      return;
    }
    if (!access.length) { session = null; keep.set(null); return loginView('This login has no admin access. Ask the owner to add you on the Team tab.'); }
    let saved = null; try { saved = localStorage.getItem(PICK); } catch { /* fine */ }
    r = access.find((x) => x.slug === saved) || access.find((x) => x.slug === cfg.restaurant) || access[0];
    shell();
  }
  start();
})();
