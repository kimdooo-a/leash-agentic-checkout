// PayPal REST client (OAuth 2.0 client credentials + Orders v2 + Payments v2 refunds).
// The same client runs in both modes: PAYPAL_MODE=sandbox points it at api-m.sandbox.paypal.com,
// PAYPAL_MODE=mock points it at the local fake in mock-paypal.js.
//
// Endpoints used (developer.paypal.com):
//   POST /v1/oauth2/token                         https://developer.paypal.com/api/rest/authentication/
//   POST /v2/checkout/orders                      https://developer.paypal.com/api/orders/v2/orders-create
//   GET  /v2/checkout/orders/{id}                 https://developer.paypal.com/api/orders/v2/orders-get
//   POST /v2/checkout/orders/{id}/capture         https://developer.paypal.com/api/orders/v2/orders-capture
//   POST /v2/payments/captures/{id}/refund        https://developer.paypal.com/api/payments/v2/captures-refund
import { toPayPalValue } from './money.js';

export class PayPalError extends Error {
  constructor(status, body) {
    const issue = body?.details?.[0]?.issue;
    super(`PayPal ${status}${body?.name ? ` ${body.name}` : ''}${issue ? ` (${issue})` : ''}${body?.message ? `: ${body.message}` : ''}`);
    this.status = status;
    this.body = body;
    this.issue = issue;
    this.debugId = body?.debug_id;
  }
}

export class PayPalClient {
  constructor({ apiBase, clientId, clientSecret, fetchImpl = fetch, onCall = () => {} }) {
    this.apiBase = apiBase;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.onCall = onCall; // audit hook: receives {method, path, status, ms, debugId}
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const t0 = Date.now();
    const res = await this.fetch(`${this.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    this.onCall({ method: 'POST', path: '/v1/oauth2/token', status: res.status, ms: Date.now() - t0 });
    if (!res.ok) throw new PayPalError(res.status, body);
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + Number(body.expires_in ?? 300) * 1000;
    return this.token;
  }

  async call(method, path, { body, requestId } = {}) {
    for (let attempt = 1; ; attempt++) {
      const token = await this.accessToken();
      const t0 = Date.now();
      let res;
      try {
        res = await this.fetch(`${this.apiBase}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
            // Idempotency: retrying with the same id never creates a second order/capture/refund.
            ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt < 3) continue;
        throw e;
      }
      const json = await res.json().catch(() => ({}));
      this.onCall({ method, path, status: res.status, ms: Date.now() - t0, debugId: json?.debug_id ?? res.headers.get('paypal-debug-id') });
      if (res.status === 401 && attempt === 1) {
        this.token = null; // token expired or revoked: refresh once
        continue;
      }
      if (res.status >= 500 && attempt < 3 && requestId) continue; // safe to retry thanks to PayPal-Request-Id
      if (!res.ok) throw new PayPalError(res.status, json);
      return json;
    }
  }

  // lines: [{sku, name, unitCents, qty, category}] — amounts are computed here, from cents, never from the LLM.
  buildOrderBody({ lines, currency, referenceId, invoiceId, description, returnUrl, cancelUrl, brandName }) {
    const itemTotal = lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
    return {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: referenceId,
          custom_id: referenceId,
          invoice_id: invoiceId,
          description: description.slice(0, 127),
          amount: {
            currency_code: currency,
            value: toPayPalValue(itemTotal),
            breakdown: { item_total: { currency_code: currency, value: toPayPalValue(itemTotal) } },
          },
          items: lines.map((l) => ({
            name: l.name.slice(0, 127),
            sku: l.sku.slice(0, 127),
            quantity: String(l.qty),
            unit_amount: { currency_code: currency, value: toPayPalValue(l.unitCents) },
            category: 'PHYSICAL_GOODS',
          })),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: brandName,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    };
  }

  createOrder(body, requestId) {
    return this.call('POST', '/v2/checkout/orders', { body, requestId });
  }

  getOrder(id) {
    return this.call('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
  }

  captureOrder(id, requestId) {
    return this.call('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, { body: {}, requestId });
  }

  refundCapture(captureId, { cents, currency, note }, requestId) {
    const body = { note_to_payer: note?.slice(0, 255) };
    if (cents != null) body.amount = { currency_code: currency, value: toPayPalValue(cents) };
    return this.call('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, { body, requestId });
  }
}

// The link the buyer opens to approve: "payer-action" when payment_source.paypal.experience_context
// is sent (status PAYER_ACTION_REQUIRED), "approve" in the older flow.
export function approvalLink(order) {
  return order?.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;
}

export function firstCapture(order) {
  return order?.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}
