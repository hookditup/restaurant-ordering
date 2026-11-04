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
  await q.waitForSelector('.k-card'); await q.waitForFunction(() => { const b = document.querySelector('[data-count=messages]'); return b && !b.hidden; });
  out.badge = await q.textContent('[data-count=reservations]');
  await q.click('[data-tab=reservations]'); await q.waitForSelector('.k-list .k-card');
  await q.waitForTimeout(500); await q.screenshot({ path: `${shots}/k-res.jpg`, type: 'jpeg', quality: 60 });
  const name = q.locator('.k-card', { hasText: 'Browser Booker' }); await name.locator('[data-m=confirm]').click(); await q.waitForFunction(() => /Confirmed/.test(document.querySelector('#k-view').textContent));
  await q.click('[data-tab=messages]'); await q.waitForSelector('.k-list .k-card'); out.msgs = await q.$$eval('.k-list .k-card', (c) => c.length);
  await q.click('[data-tab=rewards]'); await q.waitForSelector('#k-rw'); await q.fill('#k-rw [name=phone]', phone); await q.click('#k-rw button'); await q.waitForSelector('#k-rw-add');
  await q.fill('#k-rw-add [name=points]', '100'); await q.click('#k-rw-add button'); await q.waitForFunction(() => /100 points/.test(document.querySelector('#k-rw-out').textContent)); await q.click('[data-use]'); await q.waitForFunction(() => /\D0 points/.test(document.querySelector('#k-rw-out').textContent)); out.rw = (await q.textContent('#k-rw-out header')).trim();
  await q.screenshot({ path: `${shots}/k-rw.jpg`, type: 'jpeg', quality: 60 });
  await q.click('[data-tab=gift]'); await q.waitForSelector('#k-gc'); await q.fill('#k-gc [name=code]', gift); await q.click('#k-gc button'); await q.waitForSelector('#k-gc-use'); out.gc = (await q.textContent('#k-gc-out header')).trim();
  await q.fill('#k-gs [name=amount]', '40'); await q.click('#k-gs button'); await q.waitForSelector('#k-gs-out .k-card'); out.sold = (await q.textContent('#k-gs-out header')).trim().slice(-6);
  await q.waitForTimeout(9000); out.stillOnTab = await q.$('#k-gs') !== null;
  await q.click('[data-tab=orders]'); await q.waitForSelector('.k-cols'); out.ordersBack = await q.$$eval('.k-card', (c) => c.length);
  out.ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(JSON.stringify({ ...out, errors }, null, 1));
  await br.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
