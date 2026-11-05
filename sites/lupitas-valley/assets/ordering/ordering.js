/* Restaurant ordering widget. No dependencies.
   Page needs: <div id="ro-menu"></div> and window.RO = { url, key, restaurant }.
   Prices shown here are for display only; the server prices every order. */
(function () {
  const cfg = window.RO;
  const root = document.getElementById('ro-menu');
  if (!cfg || !root) return;

  const API = `${cfg.url}/functions/v1/ordering`;
  const KEY = `ro-cart-${cfg.restaurant}`;
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* cart still works this visit */ } },
  };

  let menu, slots = [], pickup = null, cart = store.get(), tip = 0, tipPct = 0, accepting = true;
  const items = new Map();

  const post = (body) => fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant: cfg.restaurant, ...body }) }).then((r) => r.json());

  const zoned = (date, tz) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((x) => [x.type, x.value]));
    return { day: p.weekday.toLowerCase().slice(0, 3), minutes: +p.hour * 60 + +p.minute };
  };
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const openAt = (hours, d) => {
    const z = zoned(d, menu.restaurant.timezone);
    return (hours?.[z.day] ?? []).some(([a, b]) => z.minutes >= toMin(a) && z.minutes < toMin(b));
  };
  const catOpen = (c) => pickup && (!c.hours || openAt(c.hours, new Date(pickup)));
  const slotText = (iso) => {
    const tz = menu.restaurant.timezone, d = new Date(iso);
    const day = (x) => x.toLocaleDateString('en-US', { timeZone: tz });
    const now = new Date(), tom = new Date(now.getTime() + 86400000);
    const label = day(d) === day(now) ? 'Today' : day(d) === day(tom) ? 'Tomorrow' : d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
    return `${label}, ${d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })}`;
  };
  // Lowest possible price, counting choices that must be made.
  const fromPrice = (i) => {
    let min = i.price_cents, more = false;
    for (const g of i.groups) {
      const prices = g.options.map((o) => o.price_cents);
      if (g.min > 0 && prices.length) { const low = Math.min(...prices); min += low; if (Math.max(...prices) > low) more = true; }
    }
    return money(min) + (more ? '+' : '');
  };

  // Highlights the category in view and keeps its pill visible in the bar.
  const watchJump = (function (selector) {
    var nav = null, active = null, queued = false;
    function update() {
      queued = false;
      nav = document.querySelector(selector);
      if (!nav) return;
      var links = [].slice.call(nav.querySelectorAll('a[href^="#"]'));
      var line = nav.getBoundingClientRect().bottom + 24, hit = links[0];
      var pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
      links.forEach(function (a) {
        var s = document.getElementById(a.getAttribute('href').slice(1));
        // A tapped link can land its section lower than the bar, so allow for that gap.
        if (s && s.getBoundingClientRect().top <= Math.max(line, pad + (parseFloat(getComputedStyle(s).scrollMarginTop) || 0) + 8)) hit = a;
      });
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) hit = links[links.length - 1];
      links.forEach(function (a) { if (a !== hit) a.removeAttribute('aria-current'); });
      if (!hit || hit.getAttribute('aria-current')) return;
      hit.setAttribute('aria-current', 'true');
      var moved = active !== hit;
      active = hit;
      if (moved) nav.scrollTo({ left: hit.offsetLeft - (nav.clientWidth - hit.offsetWidth) / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    function queue() { if (!queued) { queued = true; requestAnimationFrame(update); } }
    addEventListener('scroll', queue, { passive: true });
    addEventListener('resize', queue);
    return queue;
  })('.ro-jump');

  async function start() {
    try {
      const [m, s] = await Promise.all([
        fetch(`${cfg.url}/rest/v1/rpc/get_menu`, { method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_slug: cfg.restaurant }) }).then((r) => r.json()),
        post({ action: 'slots' }),
      ]);
      menu = m; slots = s.slots || []; accepting = s.accepting !== false && slots.length > 0;
      pickup = slots[0] || null;
      for (const c of menu.categories) for (const i of c.items) items.set(i.id, { item: i, category: c });
      cart = cart.filter((l) => items.has(l.id));
      render();
      window.dispatchEvent(new CustomEvent('ro:ready'));
    } catch {
      /* keep the static menu already on the page */
    }
  }

  function render() {
    const cats = menu.categories.filter(catOpen);
    const test = menu.restaurant.test_mode ? '<p class="ro-test">Test mode. No real orders or charges.</p>' : '';
    const closed = accepting ? '' : `<p class="ro-closed">Online ordering isn't available right now. Please call ${esc(menu.restaurant.phone)}.</p>`;
    root.innerHTML = `${test}${closed}
      <div class="ro-bar">
        <label>Pickup time
          <select id="ro-time">${slots.map((s) => `<option value="${s}"${s === pickup ? ' selected' : ''}>${esc(slotText(s))}</option>`).join('')}</select>
        </label>
      </div>
      <nav class="ro-jump" aria-label="Menu categories">${cats.map((c) => `<a href="#ro-${c.id}">${esc(c.name)}</a>`).join('')}</nav>
      ${cats.map((c) => `<section class="ro-cat" id="ro-${c.id}"><h2>${esc(c.name)}</h2>
        ${c.note ? `<p class="ro-note">${esc(c.note)}</p>` : ''}${c.description ? `<p class="ro-note">${esc(c.description)}</p>` : ''}
        <div class="ro-items">${c.items.map(card).join('')}</div></section>`).join('')}
      <button class="ro-cartbtn" id="ro-open" type="button" hidden></button>`;
    root.querySelector('#ro-time').addEventListener('change', (e) => { pickup = e.target.value; render(); });
    root.querySelector('#ro-open').addEventListener('click', openCart);
    root.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => openItem(b.dataset.item)));
    updateCartButton();
    watchJump();
  }

  const card = (i) => `<button class="ro-item" type="button" data-item="${i.id}">
      <span class="ro-item-t"><strong>${esc(i.name)}</strong><span>${esc(i.description)}</span><b>${fromPrice(i)}</b></span>
      ${i.image ? `<img src="${esc(i.image)}" alt="${esc(i.name)}" width="110" height="110" loading="lazy">` : ''}
    </button>`;

  function updateCartButton() {
    const b = root.querySelector('#ro-open');
    if (!b) return;
    const n = cart.reduce((s, l) => s + l.qty, 0);
    b.hidden = !n;
    b.textContent = `View cart (${n}) · ${money(cartTotal())}`;
  }

  // ----- item -----
  const dialog = document.createElement('dialog');
  dialog.className = 'ro-dialog';
  document.body.appendChild(dialog);
  const close = () => dialog.close();
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });

  const linePrice = (item, picked) => {
    let c = item.price_cents;
    const walk = (gs) => { for (const g of gs) for (const o of g.options) if (picked.has(o.id)) { c += o.price_cents; walk(o.groups || []); } };
    walk(item.groups);
    return c;
  };
  const optionNames = (item, ids) => {
    const set = new Set(ids), out = [];
    const walk = (gs) => { for (const g of gs) for (const o of g.options) if (set.has(o.id)) { out.push(o.name); walk(o.groups || []); } };
    walk(item.groups);
    return out;
  };
  const cartTotal = () => cart.reduce((s, l) => { const hit = items.get(l.id); return s + (hit ? linePrice(hit.item, new Set(l.options)) * l.qty : 0); }, 0);

  function openItem(id, editIndex) {
    const { item } = items.get(id);
    const old = editIndex != null ? cart[editIndex] : null;
    const picked = new Set(old ? old.options : []);
    let qty = old ? old.qty : 1;

    const groupHtml = (g) => {
      const radio = g.max === 1 && g.min === 1;
      const need = g.min > 0 ? (g.max === g.min ? `Choose ${g.min}` : `Choose ${g.min} to ${g.max ?? 'any'}`) : (g.max ? `Optional, up to ${g.max}` : 'Optional');
      return `<fieldset data-group="${g.id}"><legend>${esc(g.name)} <small>${need}</small></legend>
        ${g.options.map((o) => `<label class="ro-opt"><input type="${radio ? 'radio' : 'checkbox'}" name="g${g.id}" value="${o.id}"${picked.has(o.id) ? ' checked' : ''}>
          <span>${esc(o.name)}</span>${o.price_cents ? `<em>+${money(o.price_cents)}</em>` : ''}</label>${(o.groups || []).length && picked.has(o.id) ? o.groups.map(groupHtml).join('') : ''}`).join('')}
      </fieldset>`;
    };
    const missing = () => {
      const bad = [];
      const walk = (gs) => { for (const g of gs) {
        const n = g.options.filter((o) => picked.has(o.id));
        if (n.length < g.min) bad.push(g.name);
        n.forEach((o) => walk(o.groups || []));
      } };
      walk(item.groups);
      return bad;
    };
    const tags = [item.gluten_free && 'Gluten free', item.vegetarian && 'Vegetarian', item.allergens.length && `Contains: ${item.allergens.join(', ')}`].filter(Boolean).join(' · ');

    const draw = () => {
      dialog.innerHTML = `<form method="dialog" class="ro-sheet">
        <button class="ro-x" type="button" aria-label="Close">×</button>
        ${item.image ? `<img class="ro-hero" src="${esc(item.image)}" alt="${esc(item.name)}">` : ''}
        <h2>${esc(item.name)}</h2><p>${esc(item.description)}</p>${tags ? `<p class="ro-tags">${esc(tags)}</p>` : ''}
        ${item.groups.map(groupHtml).join('')}
        <label class="ro-field">Special instructions<textarea id="ro-note" rows="2" maxlength="200">${esc(noteText)}</textarea></label>
        <p class="ro-err" role="alert"></p>
        <div class="ro-foot"><div class="ro-qty"><button type="button" data-q="-1" aria-label="Fewer">−</button><span>${qty}</span><button type="button" data-q="1" aria-label="More">+</button></div>
        <button class="ro-add" type="button">${old ? 'Update' : 'Add to cart'} · ${money(linePrice(item, picked) * qty)}</button></div></form>`;
      dialog.querySelector('.ro-x').onclick = close;
      dialog.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => { noteDraft(); qty = Math.max(1, Math.min(50, qty + +b.dataset.q)); draw(); }; });
      dialog.querySelectorAll('fieldset input').forEach((inp) => {
        inp.onchange = () => {
          noteDraft();
          const g = findGroup(item.groups, inp.closest('fieldset').dataset.group);
          if (g.max === 1 && inp.checked) g.options.forEach((o) => picked.delete(o.id));
          if (inp.checked) {
            if (g.max && g.options.filter((o) => picked.has(o.id)).length >= g.max) { inp.checked = false; return; }
            picked.add(inp.value);
          } else picked.delete(inp.value);
          draw();
        };
      });
      dialog.querySelector('.ro-add').onclick = () => {
        const bad = missing();
        if (bad.length) { dialog.querySelector('.ro-err').textContent = `Please choose: ${bad.join(', ')}`; return; }
        const line = { id, qty, options: [...picked], note: dialog.querySelector('#ro-note').value.trim() };
        if (old) cart[editIndex] = line; else cart.push(line);
        store.set(cart); close(); updateCartButton();
      };
    };
    let noteText = old?.note ?? '';
    const noteDraft = () => { const n = dialog.querySelector('#ro-note'); if (n) noteText = n.value; };
    draw();
    dialog.showModal();
  }
  const findGroup = (gs, id) => { for (const g of gs) { if (g.id === id) return g; for (const o of g.options) { const f = findGroup(o.groups || [], id); if (f) return f; } } return null; };

  // ----- cart and checkout -----
  function openCart() {
    const draft = cartDraft;
    const sub = cartTotal();
    const pct = [0, 15, 18, 20];
    dialog.innerHTML = `<div class="ro-sheet"><button class="ro-x" type="button" aria-label="Close">×</button><h2>Your order</h2>
      <ul class="ro-lines">${cart.map((l, n) => {
        const { item } = items.get(l.id);
        const open = catOpen(items.get(l.id).category);
        return `<li><div><strong>${l.qty} × ${esc(item.name)}</strong> <span>${esc(optionNames(item, l.options).join(', '))}</span>${l.note ? `<span>${esc(l.note)}</span>` : ''}
          ${open ? '' : '<span class="ro-err">Not available at this pickup time</span>'}
          <button type="button" data-edit="${n}">Edit</button><button type="button" data-del="${n}">Remove</button></div><b>${money(linePrice(item, new Set(l.options)) * l.qty)}</b></li>`;
      }).join('')}</ul>
      <p class="ro-when">Pickup: <strong>${esc(slotText(pickup))}</strong></p>
      <form id="ro-pay" novalidate>
        <div class="ro-two"><label class="ro-field">First name<input name="first_name" autocomplete="given-name" required value="${esc(draft.first_name)}"></label>
        <label class="ro-field">Last name<input name="last_name" autocomplete="family-name" required value="${esc(draft.last_name)}"></label></div>
        <label class="ro-field">Mobile phone<input name="phone" type="tel" autocomplete="tel" required value="${esc(draft.phone)}"></label>
        <label class="ro-field">Email for your receipt<input name="email" type="email" autocomplete="email" required value="${esc(draft.email)}"></label>
        <label class="ro-field">Order note<input name="note" maxlength="300" value="${esc(draft.note)}"></label>
        <details class="ro-credits"${draft.gift_code || draft.rewards_code ? ' open' : ''}><summary>Gift card or rewards code</summary>
          <label class="ro-field">Gift card code<input name="gift_code" autocomplete="off" value="${esc(draft.gift_code)}"></label>
          <label class="ro-field">Rewards code<input name="rewards_code" autocomplete="off" value="${esc(draft.rewards_code)}"></label>
          <button type="button" class="ro-apply" id="ro-apply">Apply</button></details>
        <fieldset class="ro-tip"><legend>Tip</legend>${pct.map((p) => `<button type="button" data-tip="${p}"${tipPct === p ? ' aria-pressed="true"' : ''}>${p ? `${p}%` : 'None'}</button>`).join('')}</fieldset>
        <dl class="ro-sum" id="ro-sum"><dt>Subtotal</dt><dd>${money(sub)}</dd></dl>
        <p class="ro-err" role="alert"></p>
        <button class="ro-add" type="submit">${menu.restaurant.test_mode ? 'Place test order' : 'Continue to payment'}</button>
      </form></div>`;
    dialog.querySelector('.ro-x').onclick = close;
    const keep = () => { const f = new FormData(dialog.querySelector('#ro-pay')); cartDraft = Object.fromEntries(f.entries()); };
    dialog.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { keep(); cart.splice(+b.dataset.del, 1); store.set(cart); updateCartButton(); cart.length ? openCart() : close(); }; });
    dialog.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => { keep(); close(); openItem(cart[+b.dataset.edit].id, +b.dataset.edit); }; });
    dialog.querySelectorAll('[data-tip]').forEach((b) => { b.onclick = () => { keep(); tipPct = +b.dataset.tip; tip = Math.round(cartTotal() * tipPct / 100); openCart(); }; });
    dialog.querySelector('#ro-apply').onclick = () => { keep(); refreshTotals(); };
    dialog.querySelector('#ro-pay').addEventListener('submit', submit);
    if (!dialog.open) dialog.showModal();
    refreshTotals();
  }
  let cartDraft = { first_name: '', last_name: '', phone: '', email: '', note: '', gift_code: '', rewards_code: '' };

  async function refreshTotals() {
    tip = Math.round(cartTotal() * tipPct / 100);
    const form = dialog.querySelector('#ro-pay');
    const val = (n) => form?.elements[n]?.value.trim() || undefined;
    const r = await post({ action: 'quote', pickup_at: pickup, tip_cents: tip, items: cart, phone: val('phone'), gift_code: val('gift_code'), rewards_code: val('rewards_code') }).catch(() => null);
    const box = dialog.querySelector('#ro-sum');
    if (!box) return;
    const msg = dialog.querySelector('#ro-pay .ro-err');
    if (!r?.ok) { msg.textContent = r?.error || 'Could not price your order.'; return; }
    msg.textContent = '';
    box.innerHTML = `<dt>Subtotal</dt><dd>${money(r.subtotal_cents)}</dd>${r.discount_cents ? `<dt>Rewards</dt><dd>−${money(r.discount_cents)}</dd>` : ''}${r.guest_fee_cents ? `<dt>Service fee</dt><dd>${money(r.guest_fee_cents)}</dd>` : ''}
      <dt>Tax</dt><dd>${money(r.tax_cents)}</dd>${r.tip_cents ? `<dt>Tip</dt><dd>${money(r.tip_cents)}</dd>` : ''}<dt class="ro-total">Total</dt><dd class="ro-total">${money(r.total_cents)}</dd>${r.gift_applied_cents ? `<dt>Gift card</dt><dd>−${money(r.gift_applied_cents)}</dd><dt class="ro-total">Amount due</dt><dd class="ro-total">${money(r.amount_due_cents)}</dd>` : ''}`;
  }

  async function submit(e) {
    e.preventDefault();
    const f = e.target, err = f.querySelector('.ro-err'), btn = f.querySelector('.ro-add');
    const guest = Object.fromEntries(new FormData(f).entries());
    err.textContent = '';
    btn.disabled = true;
    const { gift_code, rewards_code } = guest;
    const r = await post({ action: 'checkout', pickup_at: pickup, tip_cents: tip, items: cart, guest, gift_code, rewards_code, return_url: location.origin }).catch(() => null);
    if (!r?.ok) { err.textContent = r?.error || 'Something went wrong. Please try again or call us.'; btn.disabled = false; return; }
    cart = []; store.set(cart);
    location.href = r.test ? `/order/?t=${r.token}` : r.redirect;
  }

  start();
})();
