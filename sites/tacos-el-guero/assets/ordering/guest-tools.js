/* Gift card and rewards pages. Add <div id="ro-gift"></div> and/or <div id="ro-rewards"></div>, with window.RO. */
(function () {
  const cfg = window.RO;
  if (!cfg) return;
  const API = `${cfg.url}/functions/v1/ordering`;
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const post = (body) => fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant: cfg.restaurant, ...body }) }).then((r) => r.json()).catch(() => ({ ok: false, error: 'Something went wrong. Please try again or call us.' }));
  const field = (name, label, type = 'text', extra = '') => `<label class="ro-field">${label}<input name="${name}" type="${type}" ${extra}></label>`;

  function checker(form, run) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = form.querySelector('.ro-ok'), err = form.querySelector('.ro-err'), btn = form.querySelector('button[type=submit]');
      msg.textContent = ''; err.textContent = ''; btn.disabled = true;
      const out = await run(Object.fromEntries(new FormData(form).entries()));
      btn.disabled = false;
      if (out.error) err.textContent = out.error; else msg.textContent = out.ok;
    });
  }

  async function giftPage(root) {
    const token = new URLSearchParams(location.search).get('g');
    const info = await post({ action: 'rewards_info' });
    const min = info.gift_min_cents ?? 1000, max = info.gift_max_cents ?? 50000;
    let amount = 5000;
    const buy = () => `${info.test_mode ? '<p class="ro-test">Test mode. No real gift cards or charges.</p>' : ''}
      <section class="ro-box"><h2>Order your gift card today</h2><form id="ro-gift-buy" novalidate>
        <div class="ro-amounts">${[2500, 5000, 7500, 10000].map((c) => `<button type="button" data-amount="${c}"${c === amount ? ' aria-pressed="true"' : ''}>$${c / 100}</button>`).join('')}</div>
        ${field('amount', 'Amount in dollars', 'number', `min="${min / 100}" max="${max / 100}" step="1" inputmode="numeric" value="${amount / 100}" required`)}
        <div class="ro-two">${field('buyer_name', 'Your name', 'text', 'autocomplete="name" required')}${field('buyer_email', 'Your email', 'email', 'autocomplete="email" required')}</div>
        <div class="ro-two">${field('recipient_name', 'Recipient name (optional)')}${field('recipient_email', 'Recipient email (optional)', 'email')}</div>
        ${field('message', 'Message (optional)', 'text', 'maxlength="300"')}
        <p class="ro-err" role="alert"></p><button class="ro-add" type="submit">${info.test_mode ? 'Create test gift card' : 'Continue to payment'}</button></form></section>
      <section class="ro-box"><h2>Check your balance</h2><form id="ro-gift-check" novalidate>${field('code', 'Gift card code', 'text', 'autocomplete="off" required')}
        <p class="ro-err" role="alert"></p><p class="ro-ok" role="status"></p><button class="ro-add" type="submit">Check balance</button></form></section>`;
    root.innerHTML = buy();
    if (token) {
      const r = await post({ action: 'gift_view', token });
      const box = document.createElement('section');
      box.className = 'ro-box';
      box.innerHTML = !r.ok ? '<h2>Gift card not found</h2>' : r.card.status !== 'active' ? '<h2>Almost there</h2><p>Your payment is still finishing. Refresh this page in a minute.</p>'
        : `<h2>Your ${money(r.card.initial_cents)} gift card</h2>${r.card.test_mode ? '<p class="ro-test">Test card. It has no real value.</p>' : ''}<p class="ro-code">${esc(r.card.code)}</p><p>Balance: <strong>${money(r.card.balance_cents)}</strong>. Save this code. Use it at checkout online or show it at the restaurant.</p>`;
      root.prepend(box);
    }
    const f = root.querySelector('#ro-gift-buy');
    const input = f.elements.amount;
    f.querySelectorAll('[data-amount]').forEach((b) => { b.onclick = () => { input.value = +b.dataset.amount / 100; f.querySelectorAll('[data-amount]').forEach((x) => x.removeAttribute('aria-pressed')); b.setAttribute('aria-pressed', 'true'); }; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = f.querySelector('.ro-err'), btn = f.querySelector('button[type=submit]');
      const d = Object.fromEntries(new FormData(f).entries());
      err.textContent = ''; btn.disabled = true;
      const r = await post({ action: 'gift_buy', ...d, amount_cents: Math.round(Number(d.amount) * 100), return_url: location.origin });
      if (!r.ok) { err.textContent = r.error; btn.disabled = false; return; }
      location.href = r.redirect || `${location.pathname}?g=${r.token}`;
    });
    checker(root.querySelector('#ro-gift-check'), async (d) => {
      const r = await post({ action: 'gift_check', code: d.code });
      return r.ok ? { ok: `Balance: ${money(r.balance_cents)}` } : { error: r.error };
    });
  }

  async function rewardsPage(root) {
    const i = await post({ action: 'rewards_info' });
    root.innerHTML = `${i.ok ? `<section class="ro-box"><h2>How it works</h2><p>Earn ${i.rewards_points_per_dollar} point${i.rewards_points_per_dollar === 1 ? '' : 's'} for every $1 on picked-up online orders. Every ${i.rewards_redeem_points} points gets you ${money(i.rewards_redeem_cents)} off.</p></section>` : ''}
      <section class="ro-box"><h2>Check your points</h2><form id="ro-points" novalidate>${field('phone', 'Mobile phone', 'tel', 'autocomplete="tel" required')}${field('code', 'Rewards code', 'text', 'autocomplete="off" required')}
        <p class="ro-err" role="alert"></p><p class="ro-ok" role="status"></p><button class="ro-add" type="submit">Check points</button></form></section>`;
    checker(root.querySelector('#ro-points'), async (d) => {
      const r = await post({ action: 'rewards_check', phone: d.phone, code: d.code });
      return r.ok ? { ok: `${r.name}, you have ${r.points} points.` } : { error: r.error };
    });
  }

  const g = document.getElementById('ro-gift'), w = document.getElementById('ro-rewards');
  if (g) giftPage(g);
  if (w) rewardsPage(w);
})();
