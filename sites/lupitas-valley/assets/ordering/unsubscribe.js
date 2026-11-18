/* Email unsubscribe page: /unsubscribe/?t=<token>. One tap, with a way to undo. */
(function () {
  const cfg = window.RO, box = document.getElementById('ro-unsub');
  if (!cfg || !box) return;
  const t = new URLSearchParams(location.search).get('t') || '';
  const post = (resubscribe) => fetch(`${cfg.url}/functions/v1/ordering`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unsubscribe', restaurant: cfg.restaurant, token: t, resubscribe }) }).then((r) => r.json()).catch(() => ({ ok: false, error: 'Something went wrong. Please try again.' }));
  const show = (html) => { box.innerHTML = html; box.querySelector('h2')?.focus(); };
  if (!/^[a-f0-9]{16,64}$/.test(t)) { show('<h2 tabindex="-1">This link is incomplete</h2><p>Please use the unsubscribe link from your email.</p>'); return; }
  const off = () => post(false).then((r) => r.ok
    ? show('<h2 tabindex="-1">You\'re unsubscribed</h2><p>You won\'t get marketing emails from us anymore. You\'ll still get receipts and reservation emails.</p><button class="btn ghost" type="button" id="undo">Undo, keep me subscribed</button>')
    : show(`<h2 tabindex="-1">We couldn't do that</h2><p>${r.error ? r.error.replace(/[<>]/g, '') : ''}</p>`)).then(() => {
    box.querySelector('#undo')?.addEventListener('click', () => post(true).then((r) => show(r.ok ? '<h2 tabindex="-1">You\'re subscribed again</h2><p>Thanks for staying with us!</p>' : '<h2 tabindex="-1">We couldn\'t do that</h2>')));
  });
  box.innerHTML = '<h2 tabindex="-1">Unsubscribe from marketing emails?</h2><p>You\'ll still get receipts and reservation emails.</p><button class="btn" type="button" id="go">Unsubscribe</button>';
  box.querySelector('#go').addEventListener('click', off);
})();
