// Starts the real server as a separate process (mock PayPal unless PAYPAL_MODE=sandbox is set
// in your env — in sandbox mode it stops at the approval link, because a human must approve on PayPal)
// and walks: intent -> cart -> confirm -> PayPal order -> buyer approval -> capture -> refund.
// Usage: node scripts/e2e.mjs [--out transcript.json]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.E2E_PORT ?? 3071);
const base = `http://localhost:${port}`;
const outIdx = process.argv.indexOf('--out');
const out = outIdx > 0 ? process.argv[outIdx + 1] : null;
const transcript = [];
const log = (step, data) => {
  transcript.push({ step, ...data });
  console.log(`\n▶ ${step}`);
  if (typeof data.summary === 'string') console.log(`  ${data.summary}`);
  for (const k of ['trace', 'calls']) if (data[k]) for (const x of data[k]) console.log(`    · ${x}`);
};

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), APP_BASE_URL: base, LEASH_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'leash-e2e-')) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${j.error}`);
  return j;
};
const usd = (c) => `$${(c / 100).toFixed(2)}`;

try {
  const health = await waitUp();
  log('server up', { summary: `PayPal mode=${health.paypalMode} · api=${health.paypalApiBase} · AI=${health.llm.provider}` });

  const message = process.env.E2E_MESSAGE ?? 'Pasta dinner for 4 under $25';
  const plan = await api('POST', '/api/agent', { message });
  log('agent plan', { summary: `"${message}" -> ${plan.status}, ${plan.lines.length} items, ${usd(plan.totalCents)} (limit ${usd(plan.limitCents)})`, trace: plan.trace.map((t) => `${t.step}: ${t.detail ?? t.warn}`) });
  if (plan.status !== 'ready') throw new Error('plan not ready');

  const conf = await api('POST', `/api/proposals/${plan.id}/confirm`);
  log('human confirmed -> PayPal order created', { summary: `order ${conf.order.id} status ${conf.order.status} · approve at ${conf.approveUrl}` });

  if (health.paypalMode === 'sandbox') {
    console.log(`\nSandbox mode: open the link above, log in with your sandbox *personal* account and approve.`);
    console.log(`PayPal then redirects to ${base}/paypal/return and the server captures. Leaving the server running for 10 minutes.`);
    await new Promise((r) => setTimeout(r, 600_000));
  } else {
    const token = new URL(conf.approveUrl).searchParams.get('token');
    const form = await fetch(`${base}/mock-paypal/checkoutnow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, action: 'approve' }),
      redirect: 'manual',
    });
    const ret = await fetch(form.headers.get('location'), { redirect: 'manual' });
    log('buyer approved (simulated) -> return_url -> server captured', { summary: `redirect ${ret.status} -> ${ret.headers.get('location')}` });

    let st = await api('GET', '/api/state');
    const order = st.orders.find((o) => o.id === conf.order.id);
    log('order', { summary: `${order.id} ${order.status} · capture ${order.captureId} · budget spent ${usd(st.budget.spentCents)}, remaining ${usd(st.budget.remainingCents)}` });

    const rq = await api('POST', '/api/agent', { message: 'refund the parmesan' });
    log('agent refund request', { summary: rq.refund ? `${rq.refund.name} ${usd(rq.refund.cents)} from ${rq.refund.orderId}` : 'no match' });
    const rf = await api('POST', `/api/orders/${rq.refund.orderId}/refund`, { sku: rq.refund.sku });
    st = await api('GET', '/api/state');
    log('refund via PayPal', { summary: `${rf.status} · refunded ${usd(rf.refundedCents)} · budget remaining ${usd(st.budget.remainingCents)}` });

    log('PayPal API calls', { calls: st.audit.filter((e) => e.kind === 'paypal_api').reverse().map((e) => `${e.method} ${e.path} -> ${e.status} (${e.ms}ms)`) });
    if (order.status !== 'COMPLETED' || rf.status !== 'PARTIALLY_REFUNDED') throw new Error('flow did not complete');
    console.log('\nE2E OK');
  }
  if (out) writeFileSync(out, JSON.stringify(transcript, null, 2));
} catch (e) {
  console.error(`\nE2E FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
