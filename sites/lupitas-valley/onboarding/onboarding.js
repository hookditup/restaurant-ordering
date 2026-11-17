// Texting setup survey: saves answers for A2P 10DLC registration.
(() => {
  const cfg = window.RO || {};
  const form = document.getElementById('ob-form');
  const msg = document.getElementById('ob-msg');
  const done = document.getElementById('ob-done');
  const groups = { msg_types: 'Check at least one kind of text you want to send.', optin_methods: 'Check at least one way guests will sign up.' };

  const fail = (text, el) => {
    msg.textContent = text;
    if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
  };

  form.addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.textContent = '';
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const bad = [...form.querySelectorAll('input,select,textarea')].find((el) => !el.checkValidity());
    if (bad) {
      const name = (bad.closest('label')?.textContent || bad.closest('fieldset')?.querySelector('legend')?.textContent || 'This field').replace('*', '').trim();
      return fail(`Please check: ${name}.`, bad);
    }
    const fd = new FormData(form);
    if (fd.get('website_hp')) return;
    for (const [k, text] of Object.entries(groups)) if (!fd.getAll(k).length) return fail(text, form.querySelector(`[name=${k}]`));
    const type = fd.get('business_type');
    const ein = String(fd.get('ein') || '').replace(/\D/g, '');
    if (type !== 'Sole proprietor' && ein.length !== 9) return fail('Please enter your 9-digit EIN.', form.elements.ein);
    if (ein && ein.length !== 9) return fail('An EIN has 9 digits.', form.elements.ein);

    const data = {};
    for (const [k, v] of fd.entries()) {
      if (k === 'website_hp') continue;
      const val = String(v).trim().slice(0, 2000);
      if (k in groups || k === 'has_links' || k === 'has_phone') (data[k] ||= []).push(val); else data[k] = val;
    }
    data.ein = ein ? `${ein.slice(0, 2)}-${ein.slice(2)}` : '';
    data.page = location.pathname;
    data.submitted_at = new Date().toISOString();

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch(`${cfg.url}/rest/v1/onboarding_submissions`, {
        method: 'POST',
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ business_name: data.legal_name, data }),
      });
      if (!r.ok) throw new Error(String(r.status));
      form.hidden = true; done.hidden = false; done.focus();
    } catch {
      fail('That did not send. Please try again, or call Hook\'d IT Up.');
      btn.disabled = false; btn.textContent = 'Send answers';
    }
  });
})();
