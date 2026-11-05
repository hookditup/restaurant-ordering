// Browser run of the forms, gift card, rewards and staff screens against a built site.
// Usage: STAFF_EMAIL=... STAFF_PASSWORD=... node test/e2e-programs-browser.cjs <site folder> <screenshot folder>
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const [root, shots] = process.argv.slice(2);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  let f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { r.writeHead(404); return r.end('nf'); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'text/plain' }); fs.createReadStream(f).pipe(r);
});
(async () => {
  await new Promise((s) => srv.listen(8131, s));
  const B = 'http://localhost:8131', br = await chromium.launch(), errors = [], out = {};
  const route = async (ctx) => {
    await ctx.route(/google\.com\/maps|fonts\.g/, (r) => r.abort());
    await ctx.route(/supabase\.co/, async (r) => {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      const res = await fetch(r.request().url(), { method: r.request().method(), headers: { ...(r.request().headers()), host: undefined }, body: r.request().postData() ?? undefined });
      r.fulfill({ status: res.status, body: await res.text(), headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    });
  };
  const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); };
  const m = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await route(m);
  const p = await m.newPage(); watch(p);
  const phone = `435556${String(Date.now()).slice(-4)}`;

  await p.goto(`${B}/rewards/`);
  await p.fill('[name=name]', 'Browser Member'); await p.fill('[data-form=rewards] [name=phone]', phone); await p.click('[data-form=rewards] button[type=submit]');
  await p.waitForSelector('.form-msg.ok'); out.rewards = await p.textContent('.form-msg.ok');
  const code = out.rewards.match(/code is (\w+)/)[1];
  await p.waitForSelector('#ro-points'); await p.fill('#ro-points [name=phone]', phone); await p.fill('#ro-points [name=code]', code); await p.click('#ro-points button');
  await p.waitForFunction(() => document.querySelector('#ro-points .ro-ok').textContent); out.points = await p.textContent('#ro-points .ro-ok');
  out.rules = await p.textContent('#ro-rewards h2 + p');
  await p.screenshot({ path: `${shots}/rewards.jpg`, type: 'jpeg', quality: 60, fullPage: true });

  await p.goto(`${B}/reservations/`);
  const d = new Date(Date.now() + 2 * 86400000); while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  await p.fill('[name=name]', 'Browser Booker'); await p.fill('[name=email]', 'test@example.com'); await p.fill('[name=phone]', phone);
  await p.fill('[name=date]', d.toISOString().slice(0, 10)); await p.dispatchEvent('[name=date]', 'change');
  await p.waitForFunction(() => document.querySelector('[name=time]').options.length > 1);
  await p.selectOption('[name=time]', { index: 2 }); await p.selectOption('[name=party_size]', '3-4');
  await p.click('[data-form=reservation] button[type=submit]'); await p.waitForSelector('.form-msg.ok'); out.reservation = await p.textContent('.form-msg.ok');

  await p.goto(`${B}/gift-cards/`);
  await p.waitForSelector('#ro-gift-buy');
  await p.click('[data-amount="2500"]'); await p.fill('[name=buyer_name]', 'Browser Buyer'); await p.fill('[name=buyer_email]', 'test@example.com');
  await p.click('#ro-gift-buy button[type=submit]'); await p.waitForURL(/g=/); await p.waitForSelector('.ro-code');
  const gift = (await p.textContent('.ro-code')).trim(); out.giftPage = (await p.textContent('.ro-box')).slice(0, 90);
  await p.screenshot({ path: `${shots}/gift.jpg`, type: 'jpeg', quality: 60, fullPage: true });
  await p.fill('#ro-gift-check [name=code]', gift); await p.click('#ro-gift-check button'); await p.waitForFunction(() => document.querySelector('#ro-gift-check .ro-ok').textContent); out.giftCheck = await p.textContent('#ro-gift-check .ro-ok');

  await p.goto(`${B}/menu/`); await p.waitForSelector('#ro-time');
  await p.click('.ro-item:has(strong:text-is("Guacamole"))'); await p.waitForSelector('.ro-dialog[open]'); await p.click('.ro-add');
  await p.click('#ro-open'); await p.waitForSelector('#ro-sum .ro-total');
  await p.fill('[name=first_name]', 'Browser'); await p.fill('[name=last_name]', 'Member'); await p.fill('[name=phone]', phone); await p.fill('[name=email]', 'test@example.com');
  await p.click('.ro-credits summary'); await p.fill('[name=gift_code]', gift); await p.click('#ro-apply');
  await p.waitForFunction(() => /Gift card/.test(document.querySelector('#ro-sum').textContent)); out.sum = await p.textContent('#ro-sum');
  await p.screenshot({ path: `${shots}/cart.jpg`, type: 'jpeg', quality: 60 });
  await p.click('#ro-pay .ro-add'); await p.waitForURL(/\/order\//); await p.waitForSelector('#ro-status h1:not(:empty)'); await p.waitForTimeout(800);
  out.status = (await p.textContent('.ro-sum')).slice(0, 120);

  const k = await br.newContext({ viewport: { width: 1180, height: 820 } }); await route(k);
  const q = await k.newPage(); watch(q);
  await q.goto(`${B}/kitchen/`);
  await q.fill('[name=email]', process.env.STAFF_EMAIL); await q.fill('[name=password]', process.env.STAFF_PASSWORD); await q.click('.k-login button');
  await q.waitForSelector('.k-card'); out.kitchenTabs = await q.$$eval('[data-tab]', (t) => t.length);
  await q.locator('.k-new [data-move=accept]').first().click(); await q.waitForSelector('.k-accepted'); await q.locator('.k-accepted [data-move=ready]').first().click(); await q.waitForSelector('.k-ready');
  await q.locator('.k-ready [data-move=complete]').first().click(); await q.waitForFunction(() => document.querySelectorAll('.k-ready').length === 0);
  await q.screenshot({ path: `${shots}/kitchen.jpg`, type: 'jpeg', quality: 60 });

  const a = await k.newPage(); watch(a);
  await a.goto(`${B}/admin/`); await a.waitForSelector('[data-tab=reservations]');
  await a.click('[data-tab=reservations]'); const booked = a.locator('.a-box', { hasText: 'Browser Booker' }); await booked.waitFor(); await booked.locator('[data-m=confirm]').click(); await a.waitForFunction(() => /Saved/.test(document.querySelector('#a-msg').textContent));
  await a.click('[data-tab=messages]'); await a.waitForSelector('#a-view .a-box, #a-view > p'); out.msgs = await a.$$eval('#a-view .a-box h2', (c) => c.map((x) => x.textContent));
  await a.click('[data-tab=rewards]'); await a.fill('#a-rw [name=phone]', phone); await a.click('#a-rw button'); await a.waitForSelector('#a-rw-add');
  await a.fill('#a-rw-add [name=points]', '100'); await a.click('#a-rw-add button'); await a.waitForFunction(() => /^1\d\d points/.test(document.querySelector('#a-rw-out p').textContent)); out.rw = (await a.textContent('#a-rw-out p')).slice(0, 12);
  await a.click('[data-tab=gift]'); await a.fill('#a-gc [name=code]', gift); await a.click('#a-gc button'); await a.waitForSelector('#a-gc-use'); out.gc = (await a.textContent('#a-gc-out p')).slice(0, 12);
  await a.fill('#a-gs [name=amount]', '40'); await a.click('#a-gs button'); await a.waitForSelector('#a-gs-out h2'); out.sold = (await a.textContent('#a-gs-out h2')).trim().slice(-6);
  out.ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(JSON.stringify({ ...out, errors }, null, 1));
  await br.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
