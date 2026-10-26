// Leash HTTP server: UI, agent API, checkout (PayPal Orders v2), capture on return, refunds.
// Zero dependencies — Node's http module only.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, publicConfig, ROOT } from './config.js';
import { createCatalog, tokenize } from './catalog.js';
import { PayPalClient, approvalLink, firstCapture, PayPalError } from './paypal.js';
import { MockPayPal } from './mock-paypal.js';
import { Store } from './store.js';
import { planCart } from './agent.js';
import { normalizeMandate, evaluateCart, checkDrift, budgetState, periodKey, refundAllowed, cartTotal } from './policy.js';
import { toCents, fmt } from './money.js';

const STATIC = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function createApp(cfg = loadConfig(), { catalog = createCatalog(cfg) } = {}) {
  const store = new Store(cfg.dataDir);
  const S = store.state;
  const mock = cfg.paypal.mode === 'mock' ? new MockPayPal(cfg.appBaseUrl) : null;
  const paypal = new PayPalClient({
    ...cfg.paypal,
    onCall: (c) => store.audit('paypal_api', c),
  });

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const redirect = (res, to) => {
    res.writeHead(303, { Location: to });
    res.end();
  };

  const effectiveMandate = (proposal) => ({
    ...S.mandate,
    blockedCategories: [...new Set([...S.mandate.blockedCategories, ...(proposal?.mandateSnapshot?.blockedCategories ?? [])])],
  });

  function releaseHold(order, why) {
    const hold = S.ledger.find((e) => e.id === order.holdId);
    if (hold?.open) {
      hold.open = false;
      hold.closedBecause = why;
    }
  }

  function stateView() {
    return {
      config: publicConfig(cfg),
      mandate: S.mandate,
      budget: budgetState(S.mandate, S.ledger),
      proposals: Object.values(S.proposals).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8),
      orders: Object.values(S.orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      audit: S.audit.slice(-120).reverse(),
    };
  }

  // ---- agent: plan a cart, or turn a refund request into a refund proposal ----
  async function agent(message) {
    if (typeof message !== 'string' || !message.trim()) throw new HttpError(400, 'message is required');
    if (message.length > 600) throw new HttpError(400, 'message too long');
    const proposal = await planCart({ cfg, catalog, mandate: S.mandate, ledger: S.ledger, message });
    if (proposal.status === 'refund_request') {
      const target = tokenize(proposal.intent.refundTarget ?? '');
      const captured = Object.values(S.orders).filter((o) => o.status === 'COMPLETED' || o.status === 'PARTIALLY_REFUNDED').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      let match = null;
      for (const o of captured) {
        if (target.some((t) => o.id.toLowerCase() === t)) {
          match = { order: o, line: null };
          break;
        }
        const line = o.lines.find((l) => !l.refunded && target.some((t) => [...tokenize(l.name), ...(l.tags ?? []).flatMap(tokenize)].includes(t)));
        if (line) {
          match = { order: o, line };
          break;
        }
      }
      if (!match && captured[0] && /\b(last|latest|whole|entire|everything)\b/.test(message.toLowerCase())) match = { order: captured[0], line: null };
      if (match) {
        const cents = match.line ? match.line.unitCents * match.line.qty : match.order.totalCents - match.order.refundedCents;
        proposal.refund = { orderId: match.order.id, sku: match.line?.sku ?? null, name: match.line?.name ?? 'entire order', cents };
        proposal.trace.push({ step: 'refund', detail: `Found ${proposal.refund.name} in order ${match.order.id} — ${fmt(cents)}. Confirm to refund through PayPal.` });
      } else {
        proposal.trace.push({ step: 'refund', warn: 'No captured order matches that refund request.' });
      }
    }
    S.proposals[proposal.id] = proposal;
    store.audit('agent_plan', { proposalId: proposal.id, status: proposal.status, parsedBy: proposal.parsedBy, totalCents: proposal.totalCents ?? null });
    store.save();
    return proposal;
  }

  // ---- checkout: human confirmed the cart -> re-check -> PayPal order -> buyer approval link ----
  async function confirm(proposalId) {
    const proposal = S.proposals[proposalId];
    if (!proposal) throw new HttpError(404, 'unknown proposal');
    const existing = Object.values(S.orders).find((o) => o.proposalId === proposalId);
    if (existing) return { order: existing, approveUrl: existing.approveUrl, reused: true };
    if (proposal.status !== 'ready') throw new HttpError(409, `proposal is ${proposal.status}; the agent will not check out`);

    // 1. re-quote every line from the catalog; the proposal's prices are not trusted
    const fresh = [];
    for (const l of proposal.lines) {
      const p = await catalog.get(l.sku);
      if (!p) throw new HttpError(409, `${l.name} is no longer available`);
      fresh.push({ ...l, unitCents: p.priceCents });
    }
    const drift = checkDrift(proposal.totalCents, cartTotal(fresh), S.mandate.priceDriftTolerancePct);
    if (!drift.ok) {
      store.audit('guardrail', { rule: 'price_drift', proposalId, driftPct: drift.driftPct });
      store.save();
      throw new HttpError(409, `Prices moved ${drift.driftPct}% since the proposal — ask the agent again`);
    }
    // 2. re-run the whole mandate with today's ledger (another order may have used the budget)
    const ev = evaluateCart(fresh, effectiveMandate(proposal), S.ledger, { statedBudgetCents: proposal.intent.budgetCents });
    if (!ev.ok) {
      store.audit('guardrail', { rule: 'recheck_failed', proposalId, violations: ev.violations.map((v) => v.rule) });
      store.save();
      throw new HttpError(409, ev.violations.map((v) => v.message).join('; '), { violations: ev.violations });
    }
    // 3. hold the budget, then create the PayPal order (idempotent on the proposal id)
    const hold = { id: randomUUID(), type: 'hold', cents: ev.totalCents, period: periodKey(), open: true, proposalId };
    S.ledger.push(hold);
    let ppOrder;
    try {
      ppOrder = await paypal.createOrder(
        paypal.buildOrderBody({
          lines: fresh,
          currency: cfg.currency,
          referenceId: proposalId,
          invoiceId: `LEASH-${proposalId.slice(0, 8)}-${Date.now()}`,
          description: `Leash agent order: ${proposal.message}`,
          returnUrl: `${cfg.appBaseUrl}/paypal/return`,
          cancelUrl: `${cfg.appBaseUrl}/paypal/cancel`,
          brandName: cfg.brandName,
        }),
        `order-${proposalId}`,
      );
    } catch (e) {
      hold.open = false;
      hold.closedBecause = 'create_order_failed';
      store.save();
      throw e;
    }
    const order = {
      id: ppOrder.id,
      proposalId,
      createdAt: new Date().toISOString(),
      status: ppOrder.status,
      lines: fresh,
      totalCents: ev.totalCents,
      refundedCents: 0,
      holdId: hold.id,
      approveUrl: approvalLink(ppOrder),
      mode: cfg.paypal.mode,
    };
    hold.orderId = order.id;
    S.orders[order.id] = order;
    proposal.status = 'checkout';
    store.audit('order_created', { orderId: order.id, totalCents: order.totalCents, paypalStatus: order.status });
    store.save();
    return { order, approveUrl: order.approveUrl };
  }

  // ---- buyer came back from PayPal approval: verify, then capture ----
  async function onReturn(token) {
    const order = S.orders[token];
    if (!order) throw new HttpError(404, 'unknown order');
    if (order.status === 'COMPLETED') return order;
    const pp = await paypal.getOrder(order.id);
    const pu = pp.purchase_units?.[0];
    const problems = [];
    if (pp.status !== 'APPROVED') problems.push(`status is ${pp.status}, expected APPROVED`);
    if (pu && toCents(pu.amount.value) !== order.totalCents) problems.push('amount on PayPal does not match the confirmed cart');
    if (pu?.custom_id && pu.custom_id !== order.proposalId) problems.push('order does not belong to this proposal');
    if (problems.length) {
      order.status = 'REJECTED';
      order.problem = problems.join('; ');
      releaseHold(order, 'verification_failed');
      store.audit('guardrail', { rule: 'capture_verification', orderId: order.id, problems });
      store.save();
      return order;
    }
    const captured = await paypal.captureOrder(order.id, `capture-${order.proposalId}`);
    const cap = firstCapture(captured);
    if (captured.status !== 'COMPLETED' || cap?.status !== 'COMPLETED') {
      order.status = captured.status;
      order.problem = `capture status ${cap?.status ?? 'missing'}`;
      store.save();
      return order;
    }
    order.status = 'COMPLETED';
    order.captureId = cap.id;
    order.capturedAt = new Date().toISOString();
    order.payer = captured.payer?.email_address ?? pp.payer?.email_address ?? null;
    releaseHold(order, 'captured');
    S.ledger.push({ id: randomUUID(), type: 'capture', cents: toCents(cap.amount.value), period: periodKey(), orderId: order.id, captureId: cap.id });
    store.audit('captured', { orderId: order.id, captureId: cap.id, cents: toCents(cap.amount.value) });
    store.save();
    return order;
  }

  function onCancel(token) {
    const order = S.orders[token];
    if (!order) throw new HttpError(404, 'unknown order');
    if (order.status !== 'COMPLETED') {
      order.status = 'CANCELLED';
      releaseHold(order, 'buyer_cancelled');
      store.audit('order_cancelled', { orderId: order.id });
      store.save();
    }
    return order;
  }

  async function refund(orderId, { sku = null, reason = '' } = {}) {
    const order = S.orders[orderId];
    if (!order) throw new HttpError(404, 'unknown order');
    if (!order.captureId) throw new HttpError(409, 'order has no capture to refund');
    const line = sku ? order.lines.find((l) => l.sku === sku) : null;
    if (sku && !line) throw new HttpError(404, 'that item is not in the order');
    if (line?.refunded) throw new HttpError(409, 'that item was already refunded');
    const merchants = (line ? [line] : order.lines).map((l) => catalog.merchant(l.merchant));
    for (const m of merchants) {
      const ok = refundAllowed(order, m);
      if (!ok.ok) throw new HttpError(409, `${m?.name ?? 'merchant'}: ${ok.reason}`);
    }
    const remaining = order.totalCents - order.refundedCents;
    const cents = line ? line.unitCents * line.qty : remaining;
    if (cents <= 0 || cents > remaining) throw new HttpError(409, 'nothing left to refund');
    const r = await paypal.refundCapture(
      order.captureId,
      { cents, currency: cfg.currency, note: reason || (line ? `Refund for ${line.name}` : 'Order refund') },
      `refund-${order.id}-${sku ?? 'all'}`,
    );
    if (r.status !== 'COMPLETED' && r.status !== 'PENDING') throw new HttpError(502, `refund status ${r.status}`);
    order.refundedCents += cents;
    if (line) line.refunded = true;
    else order.lines.forEach((l) => (l.refunded = true));
    order.status = order.refundedCents >= order.totalCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    order.refunds = [...(order.refunds ?? []), { id: r.id, status: r.status, cents, sku, at: new Date().toISOString() }];
    S.ledger.push({ id: randomUUID(), type: 'refund', cents, period: periodKey(), orderId: order.id, refundId: r.id });
    store.audit('refunded', { orderId: order.id, refundId: r.id, cents, sku });
    store.save();
    return order;
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) throw new HttpError(413, 'body too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, cfg.appBaseUrl);
    try {
      const raw = req.method === 'GET' ? '' : await readBody(req);
      if (mock && url.pathname.startsWith('/mock-paypal/')) return await mock.handle(req, res, url, raw);
      const body = () => {
        try {
          return raw ? JSON.parse(raw) : {};
        } catch {
          throw new HttpError(400, 'invalid JSON');
        }
      };

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const file = path.join(ROOT, 'public', STATIC[url.pathname]);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-store' });
        return res.end(await readFile(file));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, stateView());
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, ...publicConfig(cfg) });
      if (req.method === 'PUT' && url.pathname === '/api/mandate') {
        S.mandate = normalizeMandate({ ...S.mandate, ...body() });
        store.audit('mandate_updated', { mandate: S.mandate });
        store.save();
        return json(res, 200, stateView());
      }
      if (req.method === 'POST' && url.pathname === '/api/agent') return json(res, 200, await agent(body().message));
      let m;
      if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/proposals\/([\w-]+)\/confirm$/))) return json(res, 200, await confirm(m[1]));
      if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/orders\/([\w-]+)\/refund$/))) return json(res, 200, await refund(m[1], body()));
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        Object.assign(S, { ledger: [], proposals: {}, orders: {}, audit: [] });
        store.audit('reset', {});
        store.save();
        return json(res, 200, stateView());
      }
      if (req.method === 'GET' && url.pathname === '/paypal/return') {
        const order = await onReturn(url.searchParams.get('token') ?? '');
        return redirect(res, `/?order=${encodeURIComponent(order.id)}`);
      }
      if (req.method === 'GET' && url.pathname === '/paypal/cancel') {
        const order = onCancel(url.searchParams.get('token') ?? '');
        return redirect(res, `/?order=${encodeURIComponent(order.id)}`);
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof PayPalError ? 502 : 500;
      if (status >= 500) store.audit('error', { path: url.pathname, message: e.message, debugId: e.debugId });
      if (!res.headersSent) json(res, status, { error: e.message, ...(e.extra ?? {}), ...(e.debugId ? { paypalDebugId: e.debugId } : {}) });
      else res.end();
    }
  });

  return { server, store, cfg };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cfg = loadConfig();
  const { server } = createApp(cfg);
  server.listen(cfg.port, () => {
    const pc = publicConfig(cfg);
    console.log(`Leash listening on ${cfg.appBaseUrl}`);
    console.log(`  PayPal: ${pc.paypalMode} (${pc.paypalApiBase})`);
    console.log(`  LLM:    ${pc.llm.provider}${pc.llm.model ? ` · ${pc.llm.model}` : ''}`);
    console.log(`  Catalog: ${pc.catalog}`);
  });
}
