// Restaurant Grader front end.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const msg = $('#msg'), picks = $('#picks'), loading = $('#loading'), result = $('#result');
  const color = (p) => (p >= 80 ? 'var(--good)' : p >= 55 ? 'var(--ok)' : 'var(--bad)');
  const verdict = (s) => (s >= 80 ? 'Strong. A few fixes will keep you ahead.' : s >= 55 ? 'Room to grow. Guests may be choosing competitors.' : 'Needs work. You\'re likely losing guests and orders online.');

  async function api(path, data) {
    const r = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(d.error || 'Something went wrong. Please try again.');
    return d;
  }
  const fail = (e) => { msg.textContent = e.message; };

  function paint(el) {
    el.querySelectorAll('[data-p]').forEach((n) => { n.style.setProperty('--p', n.dataset.p); n.style.setProperty('--c', color(+n.dataset.p)); });
    el.querySelectorAll('.bar i').forEach((n) => { n.style.width = `${n.dataset.w}%`; n.style.setProperty('--c', color(+n.dataset.w)); });
  }

  const head = (r) => `<div class="score-head">
      <div class="ring" data-p="${r.score}"><div><strong>${r.score}</strong><small>out of 100</small></div></div>
      <div><h1>${esc(r.restaurant)}</h1><p>${esc(verdict(r.score))}</p>${r.address ? `<p class="muted">${esc(r.address)}</p>` : ''}</div>
    </div>
    <ul class="cats">${Object.values(r.categories).filter((c) => c.pct != null).map((c) => `<li class="cat"><h3>${esc(c.name)}</h3><div class="bar" role="img" aria-label="${c.pct} out of 100"><i data-w="${c.pct}"></i></div><p>${c.pct} / 100</p></li>`).join('')}</ul>`;

  function showPreview(r) {
    result.innerHTML = `${head(r)}
      ${r.topIssues.length ? `<div class="issues"><h3>Biggest opportunities</h3><ol>${r.topIssues.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>` : ''}
      <form class="unlock" id="unlock" novalidate>
        <h3>See all ${r.checkCount} checks and how to fix each one</h3>
        <p class="muted">We'll show the full report now and email you a copy, with your competitor comparison.</p>
        <div class="hp" aria-hidden="true"><label>Company <input name="company" tabindex="-1" autocomplete="off"></label></div>
        <div class="grid">
          <label>Your name <input name="name" required autocomplete="name"></label>
          <label>Email <input name="email" type="email" required autocomplete="email"></label>
          <label>Mobile phone (optional) <input name="phone" type="tel" autocomplete="tel"></label>
        </div>
        <label class="consent"><input type="checkbox" name="sms"> <span>Text me about my report and marketing tips from Hook'd IT Up. Up to 4 messages a month. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. Consent isn't required to get the report. See our <a href="https://hookditup.com/privacy-policy/">privacy policy</a> and <a href="https://hookditup.com/terms/">terms</a>.</span></label>
        <button type="submit">Show my full report</button>
      </form>`;
    paint(result);
    $('#unlock').addEventListener('submit', async (e) => {
      e.preventDefault(); msg.textContent = '';
      const f = e.target, btn = f.querySelector('button');
      const bad = [...f.querySelectorAll('input[required]')].find((i) => !i.checkValidity());
      if (bad) { bad.focus(); return fail(new Error(bad.name === 'email' ? 'Please enter a valid email.' : 'Please enter your name.')); }
      btn.disabled = true; btn.textContent = 'Loading your report…';
      try {
        const d = await api('/api/unlock', { id: r.id, name: f.name.value, email: f.email.value, phone: f.phone.value, smsConsent: f.sms.checked, company: f.company.value });
        history.replaceState(null, '', new URL(d.reportUrl).pathname + new URL(d.reportUrl).search);
        showFull(d.report);
      } catch (err) { fail(err); btn.disabled = false; btn.textContent = 'Show my full report'; }
    });
  }

  function showFull(r) {
    const cats = Object.entries(r.categories);
    const state = (c) => (c.points == null ? 'skip' : c.points === c.max ? 'pass' : c.points > 0 ? 'part' : 'fail');
    const sym = { pass: '✓', part: '!', fail: '✕', skip: '–' }, word = { pass: 'Passed', part: 'Partly passed', fail: 'Needs work', skip: 'Not measured' };
    result.innerHTML = `${head(r)}
      ${cats.map(([k, c]) => `<section class="group"><h3>${esc(c.name)}</h3>${r.checks.filter((x) => x.category === k).map((x) => {
        const s = state(x);
        return `<div class="check ${s}"><span class="icon" aria-hidden="true">${sym[s]}</span><div><h4>${esc(x.label)} <span class="sr-only">(${word[s]})</span></h4><p>${esc(x.detail)}</p>${x.fix && s !== 'pass' && s !== 'skip' ? `<p class="fix">Fix: ${esc(x.fix)}</p>` : ''}</div><span class="pts">${x.points == null ? word.skip : `${x.points} / ${x.max}`}</span></div>`;
      }).join('')}</section>`).join('')}
      ${r.competitors?.length ? `<section class="group"><h3>Top results for "${esc(r.localQuery)}"</h3><div class="tbl"><table><caption class="sr-only">Nearby competitors on Google Maps</caption><thead><tr><th scope="col">Rank</th><th scope="col">Restaurant</th><th scope="col">Rating</th><th scope="col">Reviews</th></tr></thead><tbody>${r.competitors.map((c) => `<tr${c.you ? ' class="you"' : ''}><td>#${c.rank}</td><td>${esc(c.name)}${c.you ? ' (you)' : ''}</td><td>${c.rating ?? '–'}</td><td>${(c.reviews || 0).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>${r.rank && r.rank > 5 ? `<p class="muted">You're #${r.rank} for this search.</p>` : ''}</section>` : ''}
      <div class="cta"><h3>Want help fixing these?</h3><p>Hook'd IT Up builds restaurant websites with commission-free online ordering, rewards, gift cards and texting, and helps you climb Google Maps.</p><a class="btn" href="https://hookditup.com/#contact">Book a free call</a></div>
      <button type="button" class="again" id="again">Grade another restaurant</button>`;
    paint(result);
    $('#again').addEventListener('click', () => { history.replaceState(null, '', '/'); result.hidden = true; $('#start').hidden = false; $('#q').focus(); });
    result.hidden = false; result.focus();
  }

  async function gradeIt(id, name) {
    msg.textContent = ''; picks.innerHTML = '';
    $('#start').hidden = true; result.hidden = true;
    $('#loading-name').textContent = name; loading.hidden = false; loading.focus();
    try {
      const d = await api('/api/grade', { placeId: id });
      loading.hidden = true; showPreview(d.report); result.hidden = false; result.focus();
    } catch (e) { loading.hidden = true; $('#start').hidden = false; fail(e); }
  }

  $('#search').addEventListener('submit', async (e) => {
    e.preventDefault(); msg.textContent = ''; picks.innerHTML = '';
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try {
      const { results } = await api('/api/search', { q: $('#q').value });
      picks.innerHTML = results.length
        ? `<p>Which one is yours?</p><ul>${results.map((p) => `<li><button type="button" class="pick" data-id="${esc(p.id)}" data-name="${esc(p.name)}">${esc(p.name)}<span>${esc(p.address)}</span></button></li>`).join('')}</ul>`
        : '<p>No restaurants found. Try adding the city.</p>';
      picks.querySelector('.pick')?.focus();
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  });
  picks.addEventListener('click', (e) => { const b = e.target.closest('.pick'); if (b) gradeIt(b.dataset.id, b.dataset.name); });

  // Saved report links: /r/<id>?t=<token>
  const m = location.pathname.match(/^\/r\/([a-f0-9]+)/);
  if (m) {
    $('#start').hidden = true;
    api(`/api/report/${m[1]}?t=${encodeURIComponent(new URLSearchParams(location.search).get('t') || '')}`)
      .then((d) => showFull(d.report))
      .catch((e) => { $('#start').hidden = false; fail(e); });
  }
})();
