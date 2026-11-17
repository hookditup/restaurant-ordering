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
  let session = keep.get(), r = null, access = [], tab = 'dashboard', days = 30, menu = null;
  const ALL_TABS = [['dashboard', 'Dashboard'], ['orders', 'Orders'], ['reservations', 'Reservations'], ['messages', 'Messages'], ['rewards', 'Rewards'], ['gift', 'Gift cards'], ['menu', 'Menu'], ['choices', 'Choices'], ['pairs', 'Popular and pairings'], ['marketing', 'Marketing'], ['settings', 'Settings'], ['team', 'Team'], ['account', 'My login']];
  const SECTION_NAMES = { kitchen: 'Kitchen screen', dashboard: 'Dashboard', orders: 'Orders', reservations: 'Reservations', messages: 'Messages', rewards: 'Rewards', gift: 'Gift cards', menu: 'Menu', choices: 'Choices', pairs: 'Popular and pairings', settings: 'Settings', marketing: 'Marketing', team: 'Team' };
  const tabs = () => ALL_TABS.filter(([k]) => k === 'account' || r.perms.includes(k));
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

  const views = {
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
      view().innerHTML = `<p><button id="a-csv">Download CSV</button></p><div class="a-scroll" tabindex="0" role="group" aria-label="Orders table"><table class="a-table"><caption>Latest 200 orders</caption><thead><tr>${['Order', 'Placed', 'Guest', 'Type', 'Status', 'Payment', 'Total'].map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>
        ${rows.map((o) => `<tr><th scope="row">${esc(o.order_no)}</th><td>${esc(when(o.created_at))}</td><td>${esc(o.first_name)} ${esc(o.last_name)}</td><td>${esc(o.fulfillment)}</td><td>${esc(o.status.replace(/_/g, ' '))}</td><td>${esc(o.payment_status.replace(/_/g, ' '))}</td><td>${money(o.total_cents)}</td></tr>`).join('') || '<tr><td colspan="7">No orders yet.</td></tr>'}</tbody></table></div>`;
      view().querySelector('#a-csv').onclick = () => {
        const q = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
        const heads = ['order_no', 'created_at', 'status', 'payment_status', 'fulfillment', 'first_name', 'last_name', 'subtotal_cents', 'tax_cents', 'tip_cents', 'delivery_fee_cents', 'total_cents'];
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([[heads.join(','), ...rows.map((o) => heads.map((h) => q(o[h])).join(','))].join('\n')], { type: 'text/csv' }));
        a.download = 'orders.csv'; a.click(); URL.revokeObjectURL(a.href);
      };
    },
    async reservations() {
      const { rows } = await staff('reservations');
      view().innerHTML = `<p class="a-help">Confirming or declining emails the guest once email is connected.</p>${rows.map((x) => `<section class="a-box"><h2>${esc(x.res_date)} at ${esc(x.res_time)}</h2><p>${x.status === 'requested' ? '<strong>Needs reply</strong>' : 'Confirmed'}</p><p>${esc(x.name)} · party of ${esc(x.party_size)}<br><a href="tel:${esc(x.phone)}">${esc(x.phone)}</a> · ${esc(x.email)}${x.requests ? `<br>${esc(x.requests)}` : ''}</p>
        <div class="a-btns">${x.status === 'requested' ? `<button data-r="${x.id}" data-m="confirm" aria-label="Confirm ${esc(x.name)}">Confirm</button><button class="a-alt" data-r="${x.id}" data-m="decline" aria-label="Decline ${esc(x.name)}">Decline</button>` : `<button class="a-alt" data-r="${x.id}" data-m="cancel" aria-label="Cancel ${esc(x.name)}">Cancel</button>`}</div></section>`).join('') || '<p>No upcoming reservations.</p>'}`;
      view().querySelectorAll('[data-r]').forEach((b) => { b.onclick = () => attempt(async () => { await staff('reservation', { id: b.dataset.r, move: b.dataset.m }); await views.reservations(); }); });
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
