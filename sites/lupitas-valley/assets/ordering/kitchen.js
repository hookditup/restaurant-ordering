/* Kitchen tablet screen. Page needs <div id="ro-kitchen"></div> and window.RO. */
(function () {
  const cfg = window.RO, root = document.getElementById('ro-kitchen');
  if (!cfg || !root) return;
  const AUTH = `${cfg.url}/auth/v1`, REST = `${cfg.url}/rest/v1`, FN = `${cfg.url}/functions/v1/ordering`;
  const KEY = 'ro-kitchen-session';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const keep = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* signs in again next load */ } },
  };
  let tab = 'orders', session = keep.get(), restaurant = null, seen = new Set(), first = true, timer, lastOk = Date.now(), audio;

  const beep = () => {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      [0, .25, .5].forEach((t) => { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; o.connect(g); g.connect(audio.destination); g.gain.value = .3; o.start(audio.currentTime + t); o.stop(audio.currentTime + t + .18); });
    } catch { /* screen still shows the order */ }
  };

  function loginView(msg) {
    clearInterval(timer);
    root.innerHTML = `<form class="k-login"><h1>Kitchen sign in</h1><label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="k-err" role="alert">${esc(msg || '')}</p><button>Sign in</button></form>`;
    root.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const r = await fetch(`${AUTH}/token?grant_type=password`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: f.get('email'), password: f.get('password') }) });
      const d = await r.json();
      if (!r.ok) { root.querySelector('.k-err').textContent = 'Wrong email or password.'; return; }
      session = d; keep.set(d); start();
    };
  }

  async function refresh() {
    const r = await fetch(`${AUTH}/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) return false;
    session = await r.json(); keep.set(session); return true;
  }
  async function api(path) {
    let r = await fetch(`${REST}/${path}`, { headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}` } });
    if (r.status === 401 && await refresh()) r = await fetch(`${REST}/${path}`, { headers: { apikey: cfg.key, Authorization: `Bearer ${session.access_token}` } });
    if (r.status === 401) throw new Error('auth');
    return r.json();
  }
  const act = (body) => fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(body) }).then((r) => r.json());

  const card = (o, tz) => {
    const when = new Date(o.pickup_at).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const out = o.fulfillment === 'delivery', a = o.delivery_address;
    const b = { new: [['accept', out ? 'Accept and send driver' : 'Accept']], accepted: [['ready', 'Ready']], ready: [['complete', out ? 'Driver took it' : 'Picked up']] }[o.status];
    return `<article class="k-card k-${o.status}"><header><strong>#${esc(o.order_no)}</strong><span>${esc(when)}</span></header>
      <p class="k-who">${esc(o.first_name)} ${esc(o.last_name)} · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>${o.test_mode ? ' · TEST' : ''}</p>
      ${out ? `<p class="k-note"><strong>DELIVERY</strong>${a ? ` · ${esc(a.street)}${a.unit ? ` ${esc(a.unit)}` : ''}, ${esc(a.city)}` : ''}${a?.instructions ? `<br>${esc(a.instructions)}` : ''}${o.delivery_status === 'failed' ? '<br><strong>Driver request failed. Call DoorDash or the guest.</strong>' : ''}</p>` : ''}
      <ul>${o.order_items.map((i) => `<li><strong>${i.qty} × ${esc(i.name)}</strong>${i.options.length ? `<span>${esc(i.options.map((x) => x.name).join(', '))}</span>` : ''}${i.note ? `<em>${esc(i.note)}</em>` : ''}</li>`).join('')}</ul>
      ${o.note ? `<p class="k-note">${esc(o.note)}</p>` : ''}<p class="k-total">${money(o.total_cents)}</p>
      <div class="k-btns">${b.map(([m, t]) => `<button data-id="${o.id}" data-move="${m}">${t}</button>`).join('')}<button class="k-cancel" data-id="${o.id}" data-move="cancel">Cancel</button></div></article>`;
  };

  async function tick() {
    try {
      const orders = await api(`orders?select=id,order_no,status,fulfillment,delivery_address,delivery_status,pickup_at,first_name,last_name,phone,note,total_cents,test_mode,order_items(name,qty,options,note)&restaurant_id=eq.${restaurant.id}&status=in.(new,accepted,ready)&order=pickup_at.asc`);
      const [r] = await api(`restaurants?select=accepting_orders&id=eq.${restaurant.id}`);
      lastOk = Date.now();
      const fresh = orders.filter((o) => o.status === 'new' && !seen.has(o.id));
      if (!first && fresh.length) beep();
      orders.forEach((o) => seen.add(o.id));
      first = false;
      draw(orders, r.accepting_orders);
    } catch (e) {
      if (e.message === 'auth') { session = null; keep.set(null); loginView('Please sign in again.'); return; }
      const w = root.querySelector('.k-offline');
      if (w && Date.now() - lastOk > 30000) w.hidden = false;
    }
  }
  const TABS = [['orders', 'Orders'], ['rewards', 'Rewards'], ['gift', 'Gift cards']];
  const staff = (op, extra = {}) => act({ action: 'staff', restaurant: cfg.restaurant, op, ...extra });
  function shell(accepting) {
    root.innerHTML = `<header class="k-top"><h1>${esc(restaurant.name)}</h1><p class="k-offline" hidden>Connection lost. Retrying…</p>
      <button class="k-pause ${accepting ? '' : 'off'}">${accepting ? 'Taking orders · Pause' : 'PAUSED · Resume'}</button><button class="k-out">Sign out</button></header>
      <nav class="k-tabs">${TABS.map(([k, t]) => `<button data-tab="${k}"${k === tab ? ' aria-current="page"' : ''}>${t}</button>`).join('')}</nav>
      <div id="k-view"></div>`;
    root.querySelector('.k-out').onclick = () => { session = null; keep.set(null); loginView(); };
    root.querySelector('.k-pause').onclick = async () => { await act({ action: 'pause', restaurant: cfg.restaurant, accepting: !accepting }); root.innerHTML = ''; tick(); };
    root.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; root.innerHTML = ''; tick(); }; });
  }
  function shellTab() { const wait = () => { if (root.querySelector('#k-view')) views[tab](); else setTimeout(wait, 100); }; wait(); }
  function draw(orders, accepting) {
    if (!root.querySelector('#k-view')) { shell(accepting); if (tab !== 'orders') return shellTab(); }
    if (tab !== 'orders') return;
    const col = (s, t) => `<section><h2>${t} (${orders.filter((o) => o.status === s).length})</h2>${orders.filter((o) => o.status === s).map((o) => card(o, restaurant.timezone)).join('')}</section>`;
    const view = root.querySelector('#k-view');
    view.innerHTML = `<div class="k-cols">${col('new', 'New')}${col('accepted', 'Cooking')}${col('ready', 'Ready')}</div>`;
    view.querySelectorAll('[data-move]').forEach((b) => {
      b.onclick = async () => {
        audioStart();
        let reason = '';
        if (b.dataset.move === 'cancel') {
          reason = await askReason();
          if (reason === null) return;
        }
        b.disabled = true;
        const r = await act({ action: 'kitchen', order_id: b.dataset.id, move: b.dataset.move, reason });
        if (!r.ok) showError(r.error);
        tick();
      };
    });
  }
  const view = () => root.querySelector('#k-view');
  const row = (label, value) => (value ? `<p><strong>${esc(label)}:</strong> ${esc(value)}</p>` : '');
  const views = {
    rewards() {
      view().innerHTML = `<div class="k-list"><form class="k-tool" id="k-rw"><label>Member phone<input name="phone" type="tel" required></label><button>Find</button></form><div id="k-rw-out"></div></div>`;
      const out = view().querySelector('#k-rw-out');
      const find = async (phone) => {
        const r = await staff('rewards_find', { phone });
        if (!r.ok) { out.innerHTML = `<p class="k-empty">${esc(r.error)}</p>`; return; }
        const a = r.account;
        out.innerHTML = `<article class="k-card k-ready"><header><strong>${esc(a.name)}</strong><span>${a.points} points</span></header>${row('Phone', a.phone)}${row('Rewards code', a.code)}
          <div class="k-btns"><button data-use="${r.redeem_points}"${a.points < r.redeem_points ? ' disabled' : ''}>Use ${r.redeem_points} pts · ${money(r.redeem_cents)} off</button></div>
          <form class="k-tool" id="k-rw-add"><label>Add points (manager)<input name="points" type="number" min="1" required></label><button>Add</button></form></article>`;
        const change = async (points) => { const o = await staff('rewards_adjust', { id: a.id, points }); if (!o.ok) showError(o.error); find(phone); };
        out.querySelector('[data-use]').onclick = () => change(-r.redeem_points);
        out.querySelector('#k-rw-add').onsubmit = (e) => { e.preventDefault(); change(+e.target.points.value); };
      };
      view().querySelector('#k-rw').onsubmit = (e) => { e.preventDefault(); find(e.target.phone.value); };
    },
    gift() {
      view().innerHTML = `<div class="k-list"><form class="k-tool" id="k-gc"><label>Gift card code<input name="code" autocomplete="off" required></label><button>Find</button></form><div id="k-gc-out"></div>
        <form class="k-tool" id="k-gs"><label>Sell a card in store, amount in dollars (manager)<input name="amount" type="number" min="1" step="0.01" required></label><label>Buyer name<input name="name"></label><button>Create card</button></form><div id="k-gs-out"></div></div>`;
      const out = view().querySelector('#k-gc-out');
      const find = async (code) => {
        const r = await staff('gift_find', { code });
        if (!r.ok) { out.innerHTML = `<p class="k-empty">${esc(r.error)}</p>`; return; }
        const c = r.card;
        out.innerHTML = `<article class="k-card k-ready"><header><strong>${esc(c.code)}</strong><span>${money(c.balance_cents)} left</span></header>${row('Status', c.status)}
          <form class="k-tool" id="k-gc-use"><label>Amount to take, in dollars<input name="amount" type="number" min="0.01" step="0.01" required></label><button>Take off card</button></form></article>`;
        out.querySelector('#k-gc-use').onsubmit = async (e) => { e.preventDefault(); const o = await staff('gift_redeem', { id: c.id, cents: Math.round(+e.target.amount.value * 100) }); if (!o.ok) showError(o.error); find(code); };
      };
      view().querySelector('#k-gc').onsubmit = (e) => { e.preventDefault(); find(e.target.code.value); };
      view().querySelector('#k-gs').onsubmit = async (e) => {
        e.preventDefault();
        const o = await staff('gift_issue', { cents: Math.round(+e.target.amount.value * 100), name: e.target.name.value });
        view().querySelector('#k-gs-out').innerHTML = o.ok ? `<article class="k-card k-ready"><header><strong>${esc(o.code)}</strong><span>${money(o.balance_cents)}</span></header><p>Give this code to the guest.</p></article>` : `<p class="k-empty">${esc(o.error)}</p>`;
      };
    },
  };
  const audioStart = () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* no sound */ } };
  function showError(msg) { const p = document.createElement('p'); p.className = 'k-toast'; p.textContent = msg; document.body.appendChild(p); setTimeout(() => p.remove(), 5000); }
  function askReason() {
    return new Promise((res) => {
      const d = document.createElement('dialog');
      d.innerHTML = `<form method="dialog" class="k-ask"><h2>Cancel this order?</h2><p>The guest is told and refunded if they paid.</p><label>Reason<input maxlength="200" value="We can't make this order right now"></label>
        <div><button value="no">Keep order</button><button value="yes" class="k-cancel">Cancel order</button></div></form>`;
      document.body.appendChild(d);
      d.addEventListener('close', () => { const v = d.returnValue === 'yes' ? d.querySelector('input').value : null; d.remove(); res(v); });
      d.showModal();
    });
  }

  async function start() {
    if (!session) return loginView();
    clearInterval(timer);
    try {
      const rows = await api(`restaurants?select=id,name,timezone&slug=eq.${encodeURIComponent(cfg.restaurant)}`);
      restaurant = rows[0];
      if (!restaurant) { session = null; keep.set(null); return loginView('This account is not set up for this restaurant.'); }
    } catch { session = null; keep.set(null); return loginView(); }
    root.addEventListener('pointerdown', audioStart, { once: true });
    await tick();
    timer = setInterval(tick, 8000);
  }
  start();
})();
