// The mandate: the leash the user puts on the agent. Pure functions only, so every rule is testable.
// The agent proposes; these functions decide. Money is integer cents.

export const DEFAULT_MANDATE = Object.freeze({
  monthlyBudgetCents: 15000, // $150 per month across all agent orders
  perOrderCapCents: 6000, // $60 per order
  perItemCapCents: 4000, // no single unit above $40
  maxQtyPerItem: 4,
  blockedCategories: ['alcohol', 'gift_card'],
  allowedMerchants: [], // empty = any merchant in the catalog
  priceDriftTolerancePct: 5, // re-quote at checkout; abort if the total moved more than this
});

export function normalizeMandate(input = {}) {
  const m = { ...DEFAULT_MANDATE, ...input };
  for (const k of ['monthlyBudgetCents', 'perOrderCapCents', 'perItemCapCents', 'maxQtyPerItem']) {
    if (!Number.isInteger(m[k]) || m[k] < 0) throw new Error(`mandate.${k} must be a non-negative integer`);
  }
  if (!Array.isArray(m.blockedCategories) || !Array.isArray(m.allowedMerchants)) {
    throw new Error('mandate.blockedCategories and mandate.allowedMerchants must be arrays');
  }
  m.blockedCategories = m.blockedCategories.map(String);
  m.allowedMerchants = m.allowedMerchants.map(String);
  m.priceDriftTolerancePct = Number(m.priceDriftTolerancePct);
  return m;
}

export function lineTotal(line) {
  return line.unitCents * line.qty;
}

export function cartTotal(lines) {
  return lines.reduce((s, l) => s + lineTotal(l), 0);
}

// Spend accounting for the current period: committed spend minus refunds, plus open holds.
export function budgetState(mandate, ledger, now = new Date()) {
  const period = periodKey(now);
  let spent = 0;
  let refunded = 0;
  let held = 0;
  for (const e of ledger) {
    if (e.period !== period) continue;
    if (e.type === 'capture') spent += e.cents;
    if (e.type === 'refund') refunded += e.cents;
    if (e.type === 'hold' && e.open) held += e.cents;
  }
  const used = spent - refunded + held;
  return { period, spentCents: spent, refundedCents: refunded, heldCents: held, remainingCents: Math.max(0, mandate.monthlyBudgetCents - used) };
}

export function periodKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Line-level rules. Returns a list of violations (empty = line is allowed).
export function checkLine(line, mandate) {
  const v = [];
  if (mandate.blockedCategories.includes(line.category)) {
    v.push({ rule: 'blocked_category', sku: line.sku, message: `${line.name}: category "${line.category}" is blocked by your mandate` });
  }
  if (mandate.allowedMerchants.length && !mandate.allowedMerchants.includes(line.merchant)) {
    v.push({ rule: 'merchant_not_allowed', sku: line.sku, message: `${line.name}: merchant ${line.merchantName} is not on your allow-list` });
  }
  if (line.unitCents > mandate.perItemCapCents) {
    v.push({ rule: 'item_over_cap', sku: line.sku, message: `${line.name}: unit price over your per-item cap` });
  }
  if (line.qty > mandate.maxQtyPerItem) {
    v.push({ rule: 'qty_over_limit', sku: line.sku, message: `${line.name}: quantity ${line.qty} exceeds limit ${mandate.maxQtyPerItem}` });
  }
  if (!Number.isInteger(line.qty) || line.qty < 1) {
    v.push({ rule: 'bad_quantity', sku: line.sku, message: `${line.name}: quantity must be a positive whole number` });
  }
  return v;
}

// Whole-cart evaluation. limitCents = the tightest of: per-order cap, remaining budget, user's stated budget.
export function evaluateCart(lines, mandate, ledger, { statedBudgetCents = null, now = new Date() } = {}) {
  const violations = [];
  if (!lines.length) violations.push({ rule: 'empty_cart', message: 'Nothing to buy' });
  for (const l of lines) violations.push(...checkLine(l, mandate));
  const total = cartTotal(lines);
  const budget = budgetState(mandate, ledger, now);
  const limits = [
    { rule: 'order_over_cap', cents: mandate.perOrderCapCents, label: 'per-order cap' },
    { rule: 'budget_exceeded', cents: budget.remainingCents, label: 'remaining monthly budget' },
  ];
  if (statedBudgetCents != null) limits.push({ rule: 'over_stated_budget', cents: statedBudgetCents, label: 'the budget you asked for' });
  for (const lim of limits) {
    if (total > lim.cents) violations.push({ rule: lim.rule, message: `Total is over ${lim.label}`, limitCents: lim.cents, totalCents: total });
  }
  const limitCents = Math.min(...limits.map((l) => l.cents));
  return { ok: violations.length === 0, violations, totalCents: total, limitCents, budget };
}

// Re-quote check at checkout: prices may have changed since the proposal.
export function checkDrift(quotedCents, currentCents, tolerancePct) {
  if (quotedCents === 0) return { ok: currentCents === 0, driftPct: currentCents ? Infinity : 0 };
  const driftPct = ((currentCents - quotedCents) / quotedCents) * 100;
  return { ok: Math.abs(driftPct) <= tolerancePct, driftPct: Math.round(driftPct * 100) / 100 };
}

export function refundAllowed(order, merchant, now = new Date()) {
  const days = merchant?.refundWindowDays ?? 0;
  if (!order.capturedAt) return { ok: false, reason: 'Order was never captured' };
  const ageDays = (now - new Date(order.capturedAt)) / 86400000;
  if (ageDays > days) return { ok: false, reason: `Refund window of ${days} days has passed` };
  return { ok: true };
}
