import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { authorizenet, clover, square, PayError } from '../supabase/functions/ordering/payments.js';

// Fake processor: records calls, answers from a list of { match, status, body }.
function fake(answers) {
  const calls = [];
  const http = async (method, url, { headers, body } = {}) => {
    const b = body ? JSON.parse(body) : null;
    calls.push({ method, url, headers, body: b });
    const a = answers.find((x) => x.match(method, url, b));
    if (!a) throw new Error(`no fake answer for ${method} ${url}`);
    return { ok: (a.status ?? 200) < 300, status: a.status ?? 200, text: (a.bom ? '﻿' : '') + JSON.stringify(typeof a.body === 'function' ? a.body(b) : a.body) };
  };
  return { http, calls };
}
const page = { cents: 1234, name: "Lupita's order 1001", email: 'g@example.com', first_name: 'Ana', last_name: 'Diaz', ref: '0f8e2c4a-1b2c-4d5e-8f90-123456789abc', success_url: 'https://x.test/order/?t=abc', cancel_url: 'https://x.test/menu/?cancelled=1' };

// ---------- Authorize.net ----------
const anetCtx = (http, extra = {}) => ({ settings: { api_login_id: 'abc123LOGIN' }, env: 'sandbox', key: 'TXNKEY', hook_key: 'ABCDEF0123', http, ...extra });
const ok = { messages: { resultCode: 'Ok', message: [{ code: 'I00001', text: 'Successful.' }] } };

test('authorize.net: hosted page request shape, BOM-safe parse, form post', async () => {
  const f = fake([{ match: (m, u, b) => b.getHostedPaymentPageRequest, bom: true, body: { ...ok, token: 'FORMTOKEN' } }]);
  const out = await authorizenet.checkout(anetCtx(f.http), page);
  const req = f.calls[0];
  assert.equal(req.url, 'https://apitest.authorize.net/xml/v1/request.api');
  const g = req.body.getHostedPaymentPageRequest;
  assert.deepEqual(Object.keys(g), ['merchantAuthentication', 'transactionRequest', 'hostedPaymentSettings']);
  assert.deepEqual(Object.keys(g.transactionRequest), ['transactionType', 'amount', 'order', 'customer', 'billTo']);
  assert.equal(g.transactionRequest.amount, '12.34');
  assert.equal(g.transactionRequest.order.invoiceNumber, '0f8e2c4a1b2c4d5e8f90');
  assert.equal(g.transactionRequest.order.invoiceNumber.length, 20);
  const ret = JSON.parse(g.hostedPaymentSettings.setting.find((s) => s.settingName === 'hostedPaymentReturnOptions').settingValue);
  assert.equal(ret.showReceipt, false);
  assert.equal(ret.url, page.success_url);
  assert.deepEqual(out, { session: '0f8e2c4a1b2c4d5e8f90', post: { url: 'https://test.authorize.net/payment/payment', fields: { token: 'FORMTOKEN' } } });
});

test('authorize.net: bad keys give a plain message', async () => {
  const f = fake([{ match: () => true, body: { messages: { resultCode: 'Error', message: [{ code: 'E00007', text: 'User authentication failed due to invalid authentication values.' }] } } }]);
  await assert.rejects(authorizenet.test(anetCtx(f.http)), /did not accept the API Login ID/);
});

test('authorize.net: webhook signature and invoice lookup', async () => {
  const raw = JSON.stringify({ notificationId: 'n1', eventType: 'net.authorize.payment.authcapture.created', payload: { id: '60123', authAmount: 12.34, responseCode: 1 } });
  const sig = 'sha512=' + createHmac('sha512', 'ABCDEF0123').update(raw).digest('hex').toUpperCase();
  const f = fake([{ match: (m, u, b) => b.getTransactionDetailsRequest, body: { ...ok, transaction: { transId: '60123', transactionStatus: 'capturedPendingSettlement', authAmount: 12.34, order: { invoiceNumber: 'INV1' } } } }]);
  const ctx = anetCtx(f.http);
  assert.deepEqual(await authorizenet.hook(ctx, raw, { 'x-anet-signature': sig }), { session: 'INV1', txn: '60123' });
  assert.equal(await authorizenet.hook(ctx, raw, { 'x-anet-signature': 'sha512=00' }), null);
  assert.equal(await authorizenet.hook(ctx, raw + ' ', { 'x-anet-signature': sig }), null);
  assert.deepEqual(await authorizenet.confirm(ctx, { session: 'INV1', txn: '60123' }), { paid: true, cents: 1234, txn: '60123' });
  assert.deepEqual(await authorizenet.confirm(ctx, { session: 'OTHER', txn: '60123' }), { paid: false });
});

test('authorize.net: confirm without a webhook searches unsettled payments', async () => {
  const f = fake([{ match: (m, u, b) => b.getUnsettledTransactionListRequest, body: { ...ok, transactions: [
    { transId: '1', invoiceNumber: 'INV2', transactionStatus: 'declined', settleAmount: 5 },
    { transId: '2', invoiceNumber: 'INV2', transactionStatus: 'capturedPendingSettlement', settleAmount: 5 },
  ] } }]);
  assert.deepEqual(await authorizenet.confirm(anetCtx(f.http), { session: 'INV2', txn: null }), { paid: true, cents: 500, txn: '2' });
  assert.deepEqual(await authorizenet.confirm(anetCtx(f.http), { session: 'NOPE', txn: null }), { paid: false });
});

test('authorize.net: void before settlement, refund after', async () => {
  const details = (status) => ({ match: (m, u, b) => b.getTransactionDetailsRequest, body: { ...ok, transaction: { transId: '9', transactionStatus: status, payment: { creditCard: { cardNumber: 'XXXX1111', expirationDate: 'XXXX' } } } } });
  const done = { match: (m, u, b) => b.createTransactionRequest, body: (b) => ({ ...ok, transactionResponse: { responseCode: '1', transId: b.createTransactionRequest.transactionRequest.transactionType === 'voidTransaction' ? '9' : '77' } }) };
  let f = fake([details('capturedPendingSettlement'), done]);
  await assert.rejects(authorizenet.refund(anetCtx(f.http), { txn: '9', cents: 500, charged_cents: 1000, refunded_cents: 0 }), /full amount/);
  f = fake([details('capturedPendingSettlement'), done]);
  assert.deepEqual(await authorizenet.refund(anetCtx(f.http), { txn: '9', cents: 1000, charged_cents: 1000, refunded_cents: 0 }), { id: '9' });
  assert.equal(f.calls[1].body.createTransactionRequest.transactionRequest.transactionType, 'voidTransaction');
  f = fake([details('settledSuccessfully'), done]);
  assert.deepEqual(await authorizenet.refund(anetCtx(f.http), { txn: '9', cents: 500, charged_cents: 1000, refunded_cents: 0 }), { id: '77' });
  const tr = f.calls[1].body.createTransactionRequest.transactionRequest;
  assert.deepEqual(Object.keys(tr), ['transactionType', 'amount', 'payment', 'refTransId']);
  assert.deepEqual(tr.payment.creditCard, { cardNumber: '1111', expirationDate: 'XXXX' });
  assert.equal(tr.amount, '5.00');
});

// ---------- Clover ----------
const cloverCtx = (http) => ({ settings: { merchant_id: 'ABCDEFGHJK123' }, env: 'sandbox', key: 'PRIVKEY', hook_key: 'whsec', http });

test('clover: hosted checkout request and redirect', async () => {
  const f = fake([{ match: (m, u) => u.endsWith('/invoicingcheckoutservice/v1/checkouts'), body: { href: 'https://sandbox.dev.clover.com/checkout/abc', checkoutSessionId: 'sess-1', expirationTime: 1 } }]);
  assert.deepEqual(await clover.checkout(cloverCtx(f.http), page), { session: 'sess-1', redirect: 'https://sandbox.dev.clover.com/checkout/abc' });
  const c = f.calls[0];
  assert.equal(c.url, 'https://apisandbox.dev.clover.com/invoicingcheckoutservice/v1/checkouts');
  assert.equal(c.headers['X-Clover-Merchant-Id'], 'ABCDEFGHJK123');
  assert.equal(c.headers.Authorization, 'Bearer PRIVKEY');
  assert.deepEqual(c.body.shoppingCart.lineItems, [{ name: page.name, price: 1234, unitQty: 1 }]);
  assert.deepEqual(c.body.redirectUrls, { success: page.success_url, failure: page.cancel_url });
});

test('clover: webhook signature (t.body, HMAC-SHA256 hex)', async () => {
  const raw = JSON.stringify({ created: 1, message: 'Approved for 1234', status: 'APPROVED', type: 'PAYMENT', id: 'PAY1', merchantId: 'ABCDEFGHJK123', data: 'sess-1' });
  const t = '1642599079', v1 = createHmac('sha256', 'whsec').update(`${t}.${raw}`).digest('hex');
  const ctx = cloverCtx(null);
  assert.deepEqual(await clover.hook(ctx, raw, { 'clover-signature': `t=${t},v1=${v1}` }), { session: 'sess-1', txn: 'PAY1', approved: true });
  assert.equal(await clover.hook(ctx, raw, { 'clover-signature': `t=1642599080,v1=${v1}` }), null);
  const other = raw.replace('ABCDEFGHJK123', 'ZZZZZZZZZZZZZ'), v2 = createHmac('sha256', 'whsec').update(`${t}.${other}`).digest('hex');
  assert.equal(await clover.hook(ctx, other, { 'clover-signature': `t=${t},v1=${v2}` }), null, 'another merchant');
  const declined = raw.replace('APPROVED', 'DECLINED'), v3 = createHmac('sha256', 'whsec').update(`${t}.${declined}`).digest('hex');
  assert.equal((await clover.hook(ctx, declined, { 'clover-signature': `t=${t},v1=${v3}` })).approved, false);
});

// ---------- Square ----------
const sqCtx = (http) => ({ settings: { location_id: 'LOC123' }, env: 'production', key: 'SQTOKEN', hook_key: 'sqkey', hook_url: 'https://p.supabase.co/functions/v1/ordering/pay/square/r1', http });

test('square: payment link request', async () => {
  const f = fake([{ match: (m, u) => u.endsWith('/v2/online-checkout/payment-links'), body: { payment_link: { id: 'PL1', url: 'https://square.link/u/x', order_id: 'ORD1' } } }]);
  assert.deepEqual(await square.checkout(sqCtx(f.http), page), { session: 'ORD1', ref: 'PL1', redirect: 'https://square.link/u/x' });
  const b = f.calls[0].body;
  assert.equal(f.calls[0].url, 'https://connect.squareup.com/v2/online-checkout/payment-links');
  assert.deepEqual(b.quick_pay, { name: page.name, price_money: { amount: 1234, currency: 'USD' }, location_id: 'LOC123' });
  assert.equal(b.checkout_options.redirect_url, page.success_url);
  assert.equal(b.idempotency_key, page.ref);
});

test('square: webhook signature (url + body, base64) and confirm from the order', async () => {
  const ctx0 = sqCtx(null);
  const raw = JSON.stringify({ type: 'payment.updated', data: { object: { payment: { id: 'P1', order_id: 'ORD1', status: 'COMPLETED' } } } });
  const sig = createHmac('sha256', 'sqkey').update(ctx0.hook_url + raw).digest('base64');
  assert.deepEqual(await square.hook(ctx0, raw, { 'x-square-hmacsha256-signature': sig }), { session: 'ORD1', txn: 'P1' });
  assert.equal(await square.hook({ ...ctx0, hook_url: 'https://other' }, raw, { 'x-square-hmacsha256-signature': sig }), null);
  const f = fake([
    { match: (m, u) => u.endsWith('/v2/orders/ORD1'), body: { order: { id: 'ORD1', location_id: 'LOC123', tenders: [{ id: 'T1', payment_id: 'P1' }] } } },
    { match: (m, u) => u.endsWith('/v2/payments/P1'), body: { payment: { id: 'P1', status: 'COMPLETED', amount_money: { amount: 1234 } } } },
  ]);
  assert.deepEqual(await square.confirm(sqCtx(f.http), { session: 'ORD1' }), { paid: true, cents: 1234, txn: 'P1' });
  const g = fake([{ match: (m, u) => u.endsWith('/v2/orders/ORD1'), body: { order: { id: 'ORD1', location_id: 'LOC123' } } }]);
  assert.deepEqual(await square.confirm(sqCtx(g.http), { session: 'ORD1' }), { paid: false, cents: 0, txn: '' });
});

test('square: refund, expired link deleted, friendly errors', async () => {
  const f = fake([
    { match: (m, u) => u.endsWith('/v2/refunds'), body: { refund: { id: 'R1' } } },
    { match: (m, u) => m === 'DELETE', body: {} },
  ]);
  assert.deepEqual(await square.refund(sqCtx(f.http), { txn: 'P1', cents: 500, key: 'rf-0f8e2c4a-0-500', reason: 'Cold food' }), { id: 'R1' });
  assert.deepEqual(f.calls[0].body.amount_money, { amount: 500, currency: 'USD' });
  await square.cancel(sqCtx(f.http), { ref: 'PL1' });
  assert.equal(f.calls[1].url, 'https://connect.squareup.com/v2/online-checkout/payment-links/PL1');
  const bad = fake([{ match: () => true, status: 401, body: { errors: [{ code: 'UNAUTHORIZED' }] } }]);
  await assert.rejects(square.test(sqCtx(bad.http)), (e) => e instanceof PayError && /key was not accepted/.test(e.message));
  assert.throws(() => square.check({ location_id: '' }, 'k'), /Location ID/);
});
