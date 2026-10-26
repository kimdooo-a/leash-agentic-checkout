import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MANDATE, evaluateCart, budgetState, checkDrift, checkLine, periodKey, refundAllowed } from '../src/policy.js';
import { toCents, toPayPalValue } from '../src/money.js';
import { rulesParseIntent, parseBudget } from '../src/rules.js';

const line = (o) => ({ sku: 'X', name: 'Thing', merchant: 'greenleaf', merchantName: 'Greenleaf', category: 'grocery', unitCents: 500, qty: 1, ...o });

test('money round-trips without float error', () => {
  assert.equal(toCents('19.99'), 1999);
  assert.equal(toCents('0.1'), 10);
  assert.equal(toPayPalValue(1999), '19.99');
  assert.equal(toPayPalValue(5), '0.05');
  assert.equal(toPayPalValue(toCents('100')), '100.00');
});

test('blocked category, merchant allow-list, item cap, qty limit', () => {
  const m = { ...DEFAULT_MANDATE, allowedMerchants: ['greenleaf'] };
  assert.deepEqual(checkLine(line(), m), []);
  assert.equal(checkLine(line({ category: 'alcohol' }), m)[0].rule, 'blocked_category');
  assert.equal(checkLine(line({ merchant: 'bytecorner' }), m)[0].rule, 'merchant_not_allowed');
  assert.equal(checkLine(line({ unitCents: 4001 }), m)[0].rule, 'item_over_cap');
  assert.equal(checkLine(line({ qty: 5 }), m)[0].rule, 'qty_over_limit');
});

test('cart limit is the tightest of per-order cap, remaining budget, stated budget', () => {
  const m = { ...DEFAULT_MANDATE, monthlyBudgetCents: 10000, perOrderCapCents: 6000 };
  const now = new Date('2026-11-05T00:00:00Z');
  const ledger = [{ type: 'capture', cents: 7000, period: periodKey(now) }];
  const ev = evaluateCart([line({ unitCents: 2000, qty: 2 })], m, ledger, { now });
  assert.equal(ev.limitCents, 3000);
  assert.equal(ev.ok, false);
  assert.ok(ev.violations.some((v) => v.rule === 'budget_exceeded'));
  const ev2 = evaluateCart([line({ unitCents: 1000 })], m, ledger, { statedBudgetCents: 900, now });
  assert.ok(ev2.violations.some((v) => v.rule === 'over_stated_budget'));
});

test('holds count against the budget; refunds give it back; other months do not count', () => {
  const now = new Date('2026-11-05T00:00:00Z');
  const p = periodKey(now);
  const b = budgetState({ ...DEFAULT_MANDATE, monthlyBudgetCents: 10000 }, [
    { type: 'capture', cents: 4000, period: p },
    { type: 'refund', cents: 1000, period: p },
    { type: 'hold', cents: 2000, period: p, open: true },
    { type: 'hold', cents: 9999, period: p, open: false },
    { type: 'capture', cents: 9999, period: '2026-10' },
  ], now);
  assert.equal(b.remainingCents, 10000 - 4000 + 1000 - 2000);
});

test('price drift check', () => {
  assert.equal(checkDrift(1000, 1040, 5).ok, true);
  assert.equal(checkDrift(1000, 1060, 5).ok, false);
});

test('refund window', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  assert.equal(refundAllowed({ capturedAt: '2026-11-10T00:00:00Z' }, { refundWindowDays: 14 }, now).ok, true);
  assert.equal(refundAllowed({ capturedAt: '2026-11-01T00:00:00Z' }, { refundWindowDays: 14 }, now).ok, false);
  assert.equal(refundAllowed({ capturedAt: '2026-11-19T00:00:00Z' }, { refundWindowDays: 0 }, now).ok, false);
});

test('rule parser: budgets, bundles, exclusions, refunds', () => {
  assert.equal(parseBudget('pasta dinner under $35'), 3500);
  assert.equal(parseBudget('budget of 20.50 please'), 2050);
  const pasta = rulesParseIntent('Pasta dinner for 4 under $35, no wine');
  assert.equal(pasta.intent, 'buy');
  assert.equal(pasta.budgetCents, 3500);
  assert.ok(pasta.excludeCategories.includes('alcohol'));
  assert.equal(pasta.items.find((i) => i.query === 'spaghetti').qty, 2);
  const list = rulesParseIntent('buy 2 usb-c cables and a hdmi cable');
  assert.deepEqual(list.items.map((i) => [i.query, i.qty]), [['usb-c cables', 2], ['hdmi cable', 1]]);
  const r = rulesParseIntent('Refund the parmesan');
  assert.equal(r.intent, 'refund');
  assert.equal(r.refundTarget, 'parmesan');
});
