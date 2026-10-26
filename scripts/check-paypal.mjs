// Sandbox credential check. Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the env (or .env),
// gets an OAuth token, creates a $1.00 sandbox order and reads it back. Prints no secrets.
//   node scripts/check-paypal.mjs                 -> token + create + get
//   node scripts/check-paypal.mjs --capture <id>  -> capture an order you approved in the browser
import { loadConfig } from '../src/config.js';
import { PayPalClient, approvalLink } from '../src/paypal.js';

process.env.PAYPAL_MODE = 'sandbox';
const cfg = loadConfig();
const calls = [];
const pp = new PayPalClient({ ...cfg.paypal, onCall: (c) => calls.push(c) });

try {
  await pp.accessToken();
  console.log(`OAuth OK against ${cfg.paypal.apiBase} (client id ...${cfg.paypal.clientId.slice(-4)})`);
  const capIdx = process.argv.indexOf('--capture');
  if (capIdx > 0) {
    const id = process.argv[capIdx + 1];
    const r = await pp.captureOrder(id, `check-capture-${id}`);
    console.log(`capture: ${r.status} · ${r.purchase_units?.[0]?.payments?.captures?.[0]?.id}`);
  } else {
    const body = pp.buildOrderBody({
      lines: [{ sku: 'CHECK-1', name: 'Leash credential check', unitCents: 100, qty: 1 }],
      currency: cfg.currency,
      referenceId: `check-${Date.now()}`,
      invoiceId: `LEASH-CHECK-${Date.now()}`,
      description: 'Leash sandbox credential check',
      returnUrl: `${cfg.appBaseUrl}/paypal/return`,
      cancelUrl: `${cfg.appBaseUrl}/paypal/cancel`,
      brandName: cfg.brandName,
    });
    const order = await pp.createOrder(body, `check-${Date.now()}`);
    console.log(`create order: ${order.id} status ${order.status}`);
    console.log(`approval link: ${approvalLink(order)}`);
    const got = await pp.getOrder(order.id);
    console.log(`get order: ${got.status} amount ${got.purchase_units?.[0]?.amount?.value} ${got.purchase_units?.[0]?.amount?.currency_code}`);
  }
} catch (e) {
  console.error(`FAILED: ${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ''}`);
  process.exitCode = 1;
} finally {
  for (const c of calls) console.log(`  ${c.method} ${c.path} -> ${c.status} (${c.ms}ms)${c.debugId ? ` debug ${c.debugId}` : ''}`);
}
