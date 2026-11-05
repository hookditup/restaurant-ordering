/* Guest order tracking. Page needs <div id="ro-status"></div> and window.RO. */
(function () {
  const cfg = window.RO, box = document.getElementById('ro-status');
  if (!cfg || !box) return;
  const token = new URLSearchParams(location.search).get('t');
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STEP = { new: 0, accepted: 1, ready: 2, completed: 2 };
  const WORD = {
    awaiting_payment: 'Waiting for your payment to finish…', new: 'We got your order and the kitchen will confirm it shortly.',
    accepted: 'The kitchen is making your order.', ready: 'Your order is ready for pickup!', completed: 'Picked up. Thank you!',
    cancelled: 'This order was cancelled.', expired: 'This order expired before payment finished.',
  };
  let timer, shown = '';
  async function load() {
    const r = await fetch(`${cfg.url}/functions/v1/ordering`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'status', token }) }).then((x) => x.json()).catch(() => null);
    if (!r?.ok) { box.innerHTML = '<h1>Order not found</h1><p>Please check your link, or call the restaurant.</p>'; return; }
    if (JSON.stringify(r.order) === shown) return; // only announce real changes
    shown = JSON.stringify(r.order);
    const o = r.order, tz = o.restaurant.timezone;
    const when = new Date(o.pickup_at).toLocaleString('en-US', { timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit' });
    const step = STEP[o.status];
    const going = o.fulfillment === 'delivery';
    const a = o.delivery_address;
    const words = going ? { ...WORD, ready: 'Your order is ready and waiting for the driver.', completed: 'On its way. Thank you!' } : WORD;
    box.innerHTML = `<h1>Order ${esc(o.order_no)}</h1>
      ${o.test_mode ? '<p class="ro-test">Test order. No card was charged.</p>' : ''}
      <p><strong>${esc(words[o.status])}</strong>${o.cancel_reason ? ` ${esc(o.cancel_reason)}` : ''}</p>
      ${step != null ? `<ol class="ro-steps">${['Received', 'Being made', 'Ready'].map((s, i) => `<li class="${i <= step ? 'on' : ''}">${s}</li>`).join('')}</ol>` : ''}
      <p>${going ? 'Delivery' : 'Pickup'}: <strong>${esc(when)}</strong><br>${going && a ? esc(`${a.street}${a.unit ? ` ${a.unit}` : ''}, ${a.city}`) : esc(o.restaurant.address)}<br><a href="tel:${esc(o.restaurant.phone)}">Call the restaurant</a>${o.delivery_tracking_url ? `<br><a href="${esc(o.delivery_tracking_url)}" rel="noopener">Track your driver</a>` : ''}</p>
      <ul class="ro-lines">${o.items.map((i) => `<li><div><strong>${i.qty} × ${esc(i.name)}</strong><span>${esc(i.options.map((x) => x.name).join(', '))}</span>${i.note ? `<span>${esc(i.note)}</span>` : ''}</div><b>${money(i.line_total_cents)}</b></li>`).join('')}</ul>
      <dl class="ro-sum"><dt>Subtotal</dt><dd>${money(o.subtotal_cents)}</dd>${o.discount_cents ? `<dt>Rewards</dt><dd>−${money(o.discount_cents)}</dd>` : ''}${o.guest_fee_cents ? `<dt>Service fee</dt><dd>${money(o.guest_fee_cents)}</dd>` : ''}${o.delivery_fee_cents ? `<dt>Delivery</dt><dd>${money(o.delivery_fee_cents)}</dd>` : ''}<dt>Tax</dt><dd>${money(o.tax_cents)}</dd>${o.tip_cents ? `<dt>Tip</dt><dd>${money(o.tip_cents)}</dd>` : ''}<dt class="ro-total">Total</dt><dd class="ro-total">${money(o.total_cents)}</dd>${o.gift_applied_cents ? `<dt>Gift card</dt><dd>−${money(o.gift_applied_cents)}</dd><dt class="ro-total">Amount due</dt><dd class="ro-total">${money(o.amount_due_cents)}</dd>` : ''}</dl>`;
    if (['completed', 'cancelled', 'expired'].includes(o.status)) clearInterval(timer);
  }
  if (!token) { box.innerHTML = '<h1>Order not found</h1>'; return; }
  load();
  timer = setInterval(load, 15000);
})();
