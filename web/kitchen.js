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
  let session = keep.get(), restaurant = null, seen = new Set(), first = true, timer, lastOk = Date.now(), audio;

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
    const b = { new: [['accept', 'Accept']], accepted: [['ready', 'Ready']], ready: [['complete', 'Picked up']] }[o.status];
    return `<article class="k-card k-${o.status}"><header><strong>#${esc(o.order_no)}</strong><span>${esc(when)}</span></header>
      <p class="k-who">${esc(o.first_name)} ${esc(o.last_name)} · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>${o.test_mode ? ' · TEST' : ''}</p>
      <ul>${o.order_items.map((i) => `<li><strong>${i.qty} × ${esc(i.name)}</strong>${i.options.length ? `<span>${esc(i.options.map((x) => x.name).join(', '))}</span>` : ''}${i.note ? `<em>${esc(i.note)}</em>` : ''}</li>`).join('')}</ul>
      ${o.note ? `<p class="k-note">${esc(o.note)}</p>` : ''}<p class="k-total">${money(o.total_cents)}</p>
      <div class="k-btns">${b.map(([m, t]) => `<button data-id="${o.id}" data-move="${m}">${t}</button>`).join('')}<button class="k-cancel" data-id="${o.id}" data-move="cancel">Cancel</button></div></article>`;
  };

  async function tick() {
    try {
      const orders = await api(`orders?select=id,order_no,status,pickup_at,first_name,last_name,phone,note,total_cents,test_mode,order_items(name,qty,options,note)&restaurant_id=eq.${restaurant.id}&status=in.(new,accepted,ready)&order=pickup_at.asc`);
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
  function draw(orders, accepting) {
    const col = (s, t) => `<section><h2>${t} (${orders.filter((o) => o.status === s).length})</h2>${orders.filter((o) => o.status === s).map((o) => card(o, restaurant.timezone)).join('')}</section>`;
    root.innerHTML = `<header class="k-top"><h1>${esc(restaurant.name)}</h1><p class="k-offline" hidden>Connection lost. Retrying…</p>
      <button class="k-pause ${accepting ? '' : 'off'}">${accepting ? 'Taking orders · Pause' : 'PAUSED · Resume'}</button><button class="k-out">Sign out</button></header>
      <div class="k-cols">${col('new', 'New')}${col('accepted', 'Cooking')}${col('ready', 'Ready')}</div>`;
    root.querySelector('.k-out').onclick = () => { session = null; keep.set(null); loginView(); };
    root.querySelector('.k-pause').onclick = async () => { await act({ action: 'pause', restaurant: cfg.restaurant, accepting: !accepting }); tick(); };
    root.querySelectorAll('[data-move]').forEach((b) => {
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
