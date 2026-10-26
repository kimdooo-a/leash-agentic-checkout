// After a human approved the order on PayPal's sandbox page: verify + capture, then (optionally)
// refund one line in plain English. Talks to a RUNNING Leash server (same one that created the order).
//   node scripts/sandbox-finish.mjs --order <ORDER_ID> [--base http://localhost:3070] [--refund "refund the parmesan"] [--no-refund]
// The browser redirect to /paypal/return does the capture by itself; this script repeats that call
// (it is idempotent: a COMPLETED order is returned as-is) and then drives the refund.
const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = (arg('--base', process.env.APP_BASE_URL ?? 'http://localhost:3070')).replace(/\/$/, '');
const orderId = arg('--order');
const refundMsg = process.argv.includes('--no-refund') ? null : arg('--refund', 'refund the parmesan');
if (!orderId) {
  console.error('usage: node scripts/sandbox-finish.mjs --order <ORDER_ID> [--base URL] [--refund "text"] [--no-refund]');
  process.exit(2);
}
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status}: ${j?.error ?? text.slice(0, 120)}`);
  return j ?? { status: r.status, location: r.headers.get('location') };
};
const find = async () => (await api('GET', '/api/state')).orders.find((o) => o.id === orderId);

try {
  let order = await find();
  if (!order) throw new Error(`order ${orderId} is not in this server's state — run this against the server that created it`);
  console.log(`before: ${order.id} ${order.status} ${usd(order.totalCents)}`);
  if (order.status !== 'COMPLETED' && order.status !== 'PARTIALLY_REFUNDED' && order.status !== 'REFUNDED') {
    await api('GET', `/paypal/return?token=${encodeURIComponent(orderId)}`);
    order = await find();
  }
  console.log(`capture: ${order.status}${order.captureId ? ` · capture ${order.captureId}` : ''}${order.problem ? ` · ${order.problem}` : ''}`);
  if (order.status !== 'COMPLETED') throw new Error('order is not captured — was it approved on the PayPal page? (status above)');

  if (refundMsg) {
    const rq = await api('POST', '/api/agent', { message: refundMsg });
    if (!rq.refund) throw new Error(`no refundable match for "${refundMsg}"`);
    console.log(`refund request: ${rq.refund.name} ${usd(rq.refund.cents)} from ${rq.refund.orderId}`);
    const done = await api('POST', `/api/orders/${rq.refund.orderId}/refund`, { sku: rq.refund.sku });
    console.log(`refund: ${done.status} · refunded ${usd(done.refundedCents)}`);
  }
  const st = await api('GET', '/api/state');
  console.log(`budget: spent ${usd(st.budget.spentCents)}, refunded ${usd(st.budget.refundedCents)}, remaining ${usd(st.budget.remainingCents)}`);
  for (const e of st.audit.filter((x) => x.kind === 'paypal_api').reverse()) {
    console.log(`  ${e.method} ${e.path} -> ${e.status} (${e.ms}ms)${e.debugId ? ` debug ${e.debugId}` : ''}`);
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
}
