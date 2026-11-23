/* Driver page for the restaurant's own deliveries: address, directions, call, and Delivered. Page needs <main id="ro-driver"></main> and window.RO. */
(function () {
  const cfg = window.RO, root = document.getElementById('ro-driver');
  if (!cfg || !root) return;
  const token = new URLSearchParams(location.search).get('t') || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const call = (action) => fetch(`${cfg.url}/functions/v1/ordering`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, token }) }).then((r) => r.json()).catch(() => null);
  function draw(r) {
    if (!r?.ok) { root.innerHTML = `<h1>Delivery not found</h1><p>${esc(r?.error || 'Check your connection and try again.')}</p>`; return; }
    const d = r.delivery, a = d.address || {};
    const maps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(d.line)}`;
    root.innerHTML = `<h1>${esc(d.restaurant)} · #${esc(d.order_no)}</h1>
      <p class="d-who"><strong>${esc(d.name)}</strong><br><a href="tel:${esc(d.phone)}">Call ${esc(d.phone)}</a></p>
      <p class="d-addr">${esc(a.street)}${a.unit ? ` ${esc(a.unit)}` : ''}<br>${esc(a.city)}, ${esc(a.state)} ${esc(a.zip)}</p>
      ${a.instructions ? `<p class="d-note">${esc(a.instructions)}</p>` : ''}
      <p>${d.items} item${d.items === 1 ? '' : 's'} · ${money(d.total_cents)} · <strong>${d.paid ? 'Paid' : 'NOT PAID: collect payment'}</strong></p>
      <p><a class="d-btn" href="${maps}" rel="noopener">Directions</a></p>
      ${d.status === 'completed' ? '<p class="d-done">Delivered. Thank you!</p>' : '<p><button class="d-btn d-ok" id="d-ok">Delivered</button></p>'}
      <p class="d-small">Problem? Call ${esc(d.restaurant)} at <a href="tel:${esc(d.restaurant_phone)}">${esc(d.restaurant_phone)}</a>.</p>`;
    root.querySelector('#d-ok')?.addEventListener('click', async (e) => {
      if (e.target.dataset.sure !== '1') { e.target.dataset.sure = '1'; e.target.textContent = 'Tap again to confirm delivered'; return; }
      e.target.disabled = true;
      draw(await call('driver_done'));
    });
  }
  call('driver_view').then(draw);
})();
