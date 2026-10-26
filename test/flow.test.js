// End-to-end over HTTP against the mock PayPal API: intent -> cart -> order -> approval -> capture -> refund.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, approveAsBuyer } from './helpers.js';

test('full agentic checkout flow in mock mode', async (t) => {
  const app = await startApp();
  t.after(app.close);

  const plan = await app.call('POST', '/api/agent', { message: 'Pasta dinner for 4 under $35' });
  assert.equal(plan.status, 200);
  assert.equal(plan.json.status, 'ready');
  assert.ok(plan.json.trace.some((s) => s.step === 'guardrail' && /alcohol/.test(s.detail)), 'wine is removed by the mandate');
  assert.ok(plan.json.totalCents <= 3500);

  const conf = await app.call('POST', `/api/proposals/${plan.json.id}/confirm`);
  assert.equal(conf.status, 200, conf.text);
  assert.equal(conf.json.order.status, 'PAYER_ACTION_REQUIRED');
  assert.match(conf.json.approveUrl, /\/mock-paypal\/checkoutnow\?token=/);

  // double-confirm is idempotent: same order, no second hold
  const again = await app.call('POST', `/api/proposals/${plan.json.id}/confirm`);
  assert.equal(again.json.order.id, conf.json.order.id);
  let st = (await app.call('GET', '/api/state')).json;
  assert.equal(st.budget.heldCents, plan.json.totalCents);

  // capture before approval is refused by "PayPal"
  const early = await app.call('GET', `/paypal/return?token=${conf.json.order.id}`);
  assert.equal(early.status, 303);
  st = (await app.call('GET', '/api/state')).json;
  assert.equal(st.orders[0].status, 'REJECTED');
});

test('approve -> capture -> partial refund -> budget credited', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const plan = await app.call('POST', '/api/agent', { message: 'Breakfast for two' });
  const conf = await app.call('POST', `/api/proposals/${plan.json.id}/confirm`);
  const b = await approveAsBuyer(app, conf.json.approveUrl);
  assert.equal(b.status, 303);
  let st = (await app.call('GET', '/api/state')).json;
  const order = st.orders[0];
  assert.equal(order.status, 'COMPLETED');
  assert.ok(order.captureId);
  assert.equal(st.budget.spentCents, plan.json.totalCents);
  assert.equal(st.budget.heldCents, 0);

  // refund by natural language
  const rq = await app.call('POST', '/api/agent', { message: 'refund the eggs' });
  assert.equal(rq.json.status, 'refund_request');
  assert.equal(rq.json.refund.orderId, order.id);
  const rf = await app.call('POST', `/api/orders/${order.id}/refund`, { sku: rq.json.refund.sku });
  assert.equal(rf.status, 200, rf.text);
  assert.equal(rf.json.status, 'PARTIALLY_REFUNDED');
  st = (await app.call('GET', '/api/state')).json;
  assert.equal(st.budget.refundedCents, rq.json.refund.cents);

  // the same item cannot be refunded twice
  const twice = await app.call('POST', `/api/orders/${order.id}/refund`, { sku: rq.json.refund.sku });
  assert.equal(twice.status, 409);

  const paypalCalls = st.audit.filter((e) => e.kind === 'paypal_api').map((e) => `${e.method} ${e.path.replace(/[A-Z0-9]{17}/g, ':id')}`);
  for (const want of ['POST /v1/oauth2/token', 'POST /v2/checkout/orders', 'GET /v2/checkout/orders/:id', 'POST /v2/checkout/orders/:id/capture', 'POST /v2/payments/captures/:id/refund']) {
    assert.ok(paypalCalls.includes(want), `missing PayPal call ${want}`);
  }
});

test('buyer cancel releases the hold; blocked carts cannot check out; budget re-checked at checkout', async (t) => {
  const app = await startApp();
  t.after(app.close);

  const plan = await app.call('POST', '/api/agent', { message: 'Breakfast for two' });
  const conf = await app.call('POST', `/api/proposals/${plan.json.id}/confirm`);
  await approveAsBuyer(app, conf.json.approveUrl, 'cancel');
  let st = (await app.call('GET', '/api/state')).json;
  assert.equal(st.orders[0].status, 'CANCELLED');
  assert.equal(st.budget.heldCents, 0);

  const blocked = await app.call('POST', '/api/agent', { message: 'buy a 27-inch monitor' });
  assert.equal(blocked.json.status, 'blocked');
  assert.equal((await app.call('POST', `/api/proposals/${blocked.json.id}/confirm`)).status, 409);

  // proposal made under a $150 budget, then the user tightens the mandate before confirming
  const p2 = await app.call('POST', '/api/agent', { message: 'Breakfast for two' });
  await app.call('PUT', '/api/mandate', { monthlyBudgetCents: 1000 });
  const c2 = await app.call('POST', `/api/proposals/${p2.json.id}/confirm`);
  assert.equal(c2.status, 409);
  assert.match(c2.json.error, /budget/);
});

test('mock PayPal rejects inconsistent amounts like the real API', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const tok = await fetch(`${app.base}/mock-paypal/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  }).then((r) => r.json());
  const res = await fetch(`${app.base}/mock-paypal/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: '10.00', breakdown: { item_total: { currency_code: 'USD', value: '10.00' } } }, items: [{ name: 'x', quantity: '1', unit_amount: { currency_code: 'USD', value: '9.00' } }] }],
    }),
  });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).details[0].issue, 'ITEM_TOTAL_MISMATCH');
});
