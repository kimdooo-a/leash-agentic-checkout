// A local stand-in for the PayPal REST API so Leash runs end-to-end without credentials.
// It mirrors the request/response shapes and the checks that matter for this app:
// bearer auth, amount/item-total consistency, PayPal-Request-Id idempotency, the
// PAYER_ACTION_REQUIRED -> APPROVED -> COMPLETED state machine, and refund ceilings.
// It is NOT PayPal; the UI labels it "simulated" everywhere it appears.
import { randomBytes } from 'node:crypto';
import { toCents, toPayPalValue } from './money.js';

const id = (n = 17) => randomBytes(n).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, n).padEnd(n, '7');

export class MockPayPal {
  constructor(appBaseUrl) {
    this.appBaseUrl = appBaseUrl;
    this.tokens = new Set();
    this.orders = new Map();
    this.captures = new Map(); // captureId -> {orderId, cents, refundedCents}
    this.idem = new Map(); // `${path}|${requestId}` -> response body
  }

  async handle(req, res, url, rawBody) {
    const p = url.pathname.replace(/^\/mock-paypal/, '');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'paypal-debug-id': `mock-${id(8).toLowerCase()}` });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    const err = (status, name, issue, message) =>
      send(status, { name, message: message ?? issue, debug_id: `mock-${id(8).toLowerCase()}`, details: issue ? [{ issue, description: message ?? issue }] : [] });

    // --- buyer-facing approval page (stands in for the PayPal-hosted checkout) ---
    if (req.method === 'GET' && p === '/checkoutnow') return send(200, this.approvalPage(url.searchParams.get('token')), 'text/html; charset=utf-8');
    if (req.method === 'POST' && p === '/checkoutnow') {
      const form = new URLSearchParams(rawBody);
      const order = this.orders.get(form.get('token'));
      if (!order) return send(404, 'Unknown order', 'text/plain');
      const ctx = order._experience;
      if (form.get('action') === 'approve' && order.status === 'PAYER_ACTION_REQUIRED') {
        order.status = 'APPROVED';
        order.payer = { payer_id: 'MOCKBUYER01', email_address: 'buyer@example.test', name: { given_name: 'Sandbox', surname: 'Buyer' } };
        res.writeHead(303, { Location: `${ctx.return_url}?token=${order.id}&PayerID=MOCKBUYER01` });
      } else {
        res.writeHead(303, { Location: `${ctx.cancel_url}?token=${order.id}` });
      }
      return res.end();
    }

    // --- OAuth ---
    if (req.method === 'POST' && p === '/v1/oauth2/token') {
      const auth = req.headers.authorization ?? '';
      const [cid, secret] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':');
      if (!cid || !secret) return send(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      if (!/grant_type=client_credentials/.test(rawBody)) return send(400, { error: 'unsupported_grant_type' });
      const token = `MOCK-${id(32)}`;
      this.tokens.add(token);
      return send(200, { scope: 'mock', access_token: token, token_type: 'Bearer', app_id: 'APP-MOCK', expires_in: 32400, nonce: id(12) });
    }

    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!this.tokens.has(bearer)) return err(401, 'AUTHENTICATION_FAILURE', null, 'Authentication failed due to invalid authentication credentials or a missing Authorization header.');

    const reqId = req.headers['paypal-request-id'];
    const idemKey = reqId ? `${req.method} ${p}|${reqId}` : null;
    if (idemKey && this.idem.has(idemKey)) return send(200, this.idem.get(idemKey));
    const done = (status, body) => {
      if (idemKey) this.idem.set(idemKey, body);
      send(status, body);
    };
    const body = rawBody ? JSON.parse(rawBody) : {};

    if (req.method === 'POST' && p === '/v2/checkout/orders') {
      const pu = body.purchase_units?.[0];
      if (body.intent !== 'CAPTURE' && body.intent !== 'AUTHORIZE') return err(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER', 'intent');
      if (!pu?.amount?.value || !pu.amount.currency_code) return err(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER', 'purchase_units[0].amount');
      const itemSum = (pu.items ?? []).reduce((s, it) => s + toCents(it.unit_amount.value) * Number(it.quantity), 0);
      const declaredItemTotal = pu.amount.breakdown?.item_total ? toCents(pu.amount.breakdown.item_total.value) : null;
      if (declaredItemTotal != null && itemSum !== declaredItemTotal) return err(422, 'UNPROCESSABLE_ENTITY', 'ITEM_TOTAL_MISMATCH');
      if (declaredItemTotal != null && toCents(pu.amount.value) !== declaredItemTotal) return err(422, 'UNPROCESSABLE_ENTITY', 'AMOUNT_MISMATCH');
      const orderId = id(17);
      const ctx = body.payment_source?.paypal?.experience_context ?? {};
      const order = {
        id: orderId,
        intent: body.intent,
        status: 'PAYER_ACTION_REQUIRED',
        purchase_units: [{ ...pu, payee: { email_address: 'merchant@example.test', merchant_id: 'MOCKMERCHANT' } }],
        create_time: new Date().toISOString(),
        _experience: ctx,
      };
      this.orders.set(orderId, order);
      return done(200, this.view(order));
    }

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) {
      const order = this.orders.get(m[1]);
      if (!order) return err(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
      return send(200, this.view(order));
    }

    if (req.method === 'POST' && (m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) {
      const order = this.orders.get(m[1]);
      if (!order) return err(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
      if (order.status === 'COMPLETED') return err(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED');
      if (order.status !== 'APPROVED') return err(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment.');
      const cents = toCents(order.purchase_units[0].amount.value);
      const capId = id(17);
      const capture = {
        id: capId,
        status: 'COMPLETED',
        amount: { ...order.purchase_units[0].amount, breakdown: undefined },
        final_capture: true,
        custom_id: order.purchase_units[0].custom_id,
        invoice_id: order.purchase_units[0].invoice_id,
        create_time: new Date().toISOString(),
        links: [{ href: `${this.appBaseUrl}/mock-paypal/v2/payments/captures/${capId}/refund`, rel: 'refund', method: 'POST' }],
      };
      this.captures.set(capId, { orderId: order.id, cents, refundedCents: 0, currency: order.purchase_units[0].amount.currency_code });
      order.status = 'COMPLETED';
      order.purchase_units[0].payments = { captures: [capture] };
      return done(201, this.view(order));
    }

    if (req.method === 'POST' && (m = p.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/))) {
      const cap = this.captures.get(m[1]);
      if (!cap) return err(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
      const cents = body.amount ? toCents(body.amount.value) : cap.cents - cap.refundedCents;
      if (cents <= 0 || cap.refundedCents + cents > cap.cents) return err(422, 'UNPROCESSABLE_ENTITY', 'REFUND_AMOUNT_EXCEEDED', 'The refund amount must be less than or equal to the capture amount that has not yet been refunded.');
      cap.refundedCents += cents;
      return done(201, { id: id(17), status: 'COMPLETED', amount: { currency_code: cap.currency, value: toPayPalValue(cents) }, note_to_payer: body.note_to_payer, create_time: new Date().toISOString() });
    }

    return err(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', `mock has no route ${req.method} ${p}`);
  }

  view(order) {
    const { _experience, ...pub } = order;
    const links = [{ href: `${this.appBaseUrl}/mock-paypal/v2/checkout/orders/${order.id}`, rel: 'self', method: 'GET' }];
    if (order.status === 'PAYER_ACTION_REQUIRED') links.push({ href: `${this.appBaseUrl}/mock-paypal/checkoutnow?token=${order.id}`, rel: 'payer-action', method: 'GET' });
    if (order.status === 'APPROVED') links.push({ href: `${this.appBaseUrl}/mock-paypal/v2/checkout/orders/${order.id}/capture`, rel: 'capture', method: 'POST' });
    return { ...pub, payment_source: { paypal: order.payer ? { email_address: order.payer.email_address, account_id: order.payer.payer_id } : {} }, links };
  }

  approvalPage(token) {
    const order = this.orders.get(token);
    if (!order) return '<!doctype html><p>Unknown order.</p>';
    const pu = order.purchase_units[0];
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const rows = (pu.items ?? []).map((it) => `<tr><td>${esc(it.name)}</td><td>${esc(it.quantity)}</td><td>$${esc(it.unit_amount.value)}</td></tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated buyer approval</title>
<style>body{font:15px system-ui,sans-serif;background:#f3f4f6;color:#111;margin:0;padding:24px}main{max-width:460px;margin:auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #ddd}
.badge{display:inline-block;background:#fde68a;color:#7c2d12;font-weight:600;padding:2px 8px;border-radius:6px;font-size:12px}table{width:100%;border-collapse:collapse;margin:12px 0}td{padding:6px 0;border-bottom:1px solid #eee}
.total{font-size:20px;font-weight:700}button{font:inherit;padding:10px 16px;border-radius:8px;border:0;margin-right:8px;cursor:pointer}.ok{background:#111827;color:#fff}.no{background:#e5e7eb}</style></head>
<body><main><span class="badge">MOCK MODE · simulated payment page · no real money</span>
<h2>Approve payment to ${esc(order._experience.brand_name ?? 'merchant')}</h2>
<p>Order <code>${esc(order.id)}</code> · signed in as <b>buyer@example.test</b> (simulated)</p>
<table>${rows}</table><p class="total">Total $${esc(pu.amount.value)} ${esc(pu.amount.currency_code)}</p>
<form method="post" action="/mock-paypal/checkoutnow"><input type="hidden" name="token" value="${esc(order.id)}">
<button class="ok" name="action" value="approve" id="approve">Approve payment</button><button class="no" name="action" value="cancel" id="cancel">Cancel</button></form>
<p style="color:#666;font-size:13px">In sandbox mode this step is PayPal's real hosted approval page with a sandbox buyer account.</p></main></body></html>`;
  }
}
