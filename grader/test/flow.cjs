const { chromium } = require('playwright');
(async () => {
  const br = await chromium.launch(); const out = {}; const K = process.env.K;
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const ctx = await br.newContext({ viewport: { width: w, height: h }, bypassCSP: true }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await p.route(/fonts\.g/, (r) => r.abort());
    await p.goto('http://localhost:3399/'); await p.fill('#q', 'Tacos Test Heber'); await p.click('#search button');
    await p.waitForSelector('.pick'); await p.click('.pick'); await p.waitForSelector('#unlock', { timeout: 30000 });
    out['preview' + w] = (await p.textContent('.score-head')).replace(/\s+/g, ' ').trim();
    out['issues' + w] = await p.$$eval('.issues li', (l) => l.map((x) => x.textContent));
    if (w === 390) await p.screenshot({ path: K + '/grader-preview-390.png', fullPage: true });
    await p.click('#unlock button'); out['err' + w] = await p.textContent('#msg');
    await p.fill('[name=name]', 'Pat Lee'); await p.fill('[name=email]', 'pat@example.com'); await p.check('[name=sms]'); await p.click('#unlock button');
    await p.waitForSelector('.check'); out['url' + w] = p.url().replace('http://localhost:3399', ''); out['checks' + w] = await p.$$eval('.check', (c) => c.length);
    out['ov' + w] = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    await p.screenshot({ path: `${K}/grader-full-${w}.png`, fullPage: true });
    const saved = p.url(); const p2 = await ctx.newPage(); await p2.route(/fonts\.g/, (r) => r.abort()); await p2.goto(saved); await p2.waitForSelector('.check'); out['reopen' + w] = await p2.$$eval('.check', (c) => c.length);
    await p2.goto(saved.replace(/t=\w+/, 't=bad')); await p2.waitForFunction(() => document.querySelector('#msg').textContent); out['badToken' + w] = await p2.textContent('#msg');
    await p2.close(); out['errs' + w] = errs;
    if (w === 1280) { await p.addScriptTag({ path: require.resolve('axe-core', { paths: [K + '/axe'] }) }); out.axeFull = await p.evaluate(async () => (await axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] })).violations.map((v) => `${v.id}:${v.nodes.length}`)); await p.goto('http://localhost:3399/'); await p.addScriptTag({ path: require.resolve('axe-core', { paths: [K + '/axe'] }) }); out.axeHome = await p.evaluate(async () => (await axe.run({ runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] })).violations.map((v) => `${v.id}:${v.nodes.length}`)); }
    await p.close();
  }
  console.log(JSON.stringify(out, null, 1)); await br.close();
})().catch((e) => { console.error(e); process.exit(1); });
