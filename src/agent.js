// The shopping agent: request -> intent -> catalog search -> cart -> fit the cart inside the mandate.
// It returns a proposal plus a step-by-step trace; it never moves money. Checkout is a separate,
// human-confirmed step in server.js.
import { randomUUID } from 'node:crypto';
import { llmConfigured, llmParseIntent, llmChoose } from './llm.js';
import { rulesParseIntent } from './rules.js';
import { checkLine, evaluateCart, cartTotal } from './policy.js';
import { fmt } from './money.js';

function toLine(p, qty, slot) {
  return {
    slot,
    sku: p.sku,
    name: p.name,
    merchant: p.merchant,
    merchantName: p.merchantName,
    category: p.category,
    unitCents: p.priceCents,
    qty,
    source: p.source,
    url: p.url,
    tags: p.tags ?? [],
  };
}

export async function parseIntent(cfg, message, trace) {
  if (llmConfigured(cfg)) {
    try {
      const intent = await llmParseIntent(cfg, message);
      trace.push({ step: 'understand', by: `LLM (${cfg.llm.model})`, detail: summarizeIntent(intent) });
      return { intent, by: 'llm' };
    } catch (e) {
      trace.push({ step: 'understand', by: 'LLM', warn: `LLM unavailable (${e.message}); using rule-based parser` });
    }
  }
  const intent = rulesParseIntent(message);
  trace.push({ step: 'understand', by: 'rules', detail: summarizeIntent(intent) });
  return { intent, by: 'rules' };
}

function summarizeIntent(i) {
  if (i.intent === 'refund') return `refund request: "${i.refundTarget ?? ''}"`;
  const items = i.items.map((x) => `${x.qty}× ${x.query}${x.optional ? ' (optional)' : ''}`).join(', ');
  return `${i.intent}: ${items || '(no items)'}${i.budgetCents != null ? ` · stay under ${fmt(i.budgetCents)}` : ''}${
    i.excludeCategories.length ? ` · exclude ${i.excludeCategories.join(', ')}` : ''
  }`;
}

export async function planCart({ cfg, catalog, mandate, ledger, message, now = new Date() }) {
  const trace = [];
  const { intent, by } = await parseIntent(cfg, message, trace);
  const base = { id: randomUUID(), message, createdAt: now.toISOString(), intent, parsedBy: by, trace };
  if (intent.intent !== 'buy') return { ...base, status: intent.intent === 'refund' ? 'refund_request' : 'not_understood', lines: [] };

  const userExcluded = new Set(intent.excludeCategories);
  const effective = { ...mandate, blockedCategories: [...new Set([...mandate.blockedCategories, ...userExcluded])] };

  // 1. search
  const slots = [];
  for (const item of intent.items) {
    const candidates = await catalog.search(item.query, { limit: 5 });
    if (!candidates.length) {
      trace.push({ step: 'search', warn: `No product found for "${item.query}"` });
      continue;
    }
    slots.push({ ...item, candidates });
  }
  trace.push({ step: 'search', by: catalog.source, detail: `${slots.length}/${intent.items.length} items found in the ${catalog.source} catalog` });

  // 2. choose (LLM may pick among candidates; otherwise top-ranked)
  let picks = new Map();
  if (by === 'llm' && slots.length) {
    try {
      picks = await llmChoose(cfg, message, slots);
      trace.push({ step: 'choose', by: `LLM (${cfg.llm.model})`, detail: `${picks.size} picks validated against catalog candidates` });
    } catch (e) {
      trace.push({ step: 'choose', warn: `LLM pick failed (${e.message}); using top-ranked match` });
    }
  }
  let lines = slots.map((s, i) => {
    const sku = picks.get(i)?.sku;
    const p = s.candidates.find((c) => c.sku === sku) ?? s.candidates[0];
    return toLine(p, s.qty, i);
  });

  // 3. line-level guardrails: swap to an allowed alternative or drop
  const kept = [];
  for (const line of lines) {
    const slot = slots[line.slot];
    if (line.qty > effective.maxQtyPerItem) {
      trace.push({ step: 'guardrail', rule: 'qty_over_limit', detail: `${line.name}: quantity ${line.qty} → ${effective.maxQtyPerItem}` });
      line.qty = effective.maxQtyPerItem;
    }
    const v = checkLine(line, effective);
    if (!v.length) {
      kept.push(line);
      continue;
    }
    const alt = slot.candidates.map((c) => toLine(c, line.qty, line.slot)).find((l) => !checkLine(l, effective).length);
    const why = v.map((x) => (userExcluded.has(line.category) && x.rule === 'blocked_category' ? `${line.name}: you asked for no ${line.category}` : x.message)).join('; ');
    if (alt) {
      trace.push({ step: 'guardrail', rule: v[0].rule, detail: `${why} → swapped for ${alt.name}` });
      kept.push(alt);
    } else {
      trace.push({ step: 'guardrail', rule: v[0].rule, detail: `${why} → removed from cart` });
    }
  }
  lines = kept;

  // 4. fit the total under the tightest limit: cheaper swaps first, then drop optional extras
  const evalNow = () => evaluateCart(lines, effective, ledger, { statedBudgetCents: intent.budgetCents, now });
  let ev = evalNow();
  trace.push({ step: 'budget', detail: `cart ${fmt(ev.totalCents)} vs limit ${fmt(ev.limitCents)} (per-order cap ${fmt(effective.perOrderCapCents)}, monthly remaining ${fmt(ev.budget.remainingCents)}${intent.budgetCents != null ? `, your budget ${fmt(intent.budgetCents)}` : ''})` });
  let guard = 0;
  while (ev.totalCents > ev.limitCents && guard++ < 50) {
    let best = null;
    for (const [idx, line] of lines.entries()) {
      for (const c of slots[line.slot].candidates) {
        const alt = toLine(c, line.qty, line.slot);
        if (checkLine(alt, effective).length) continue;
        const saving = line.unitCents * line.qty - alt.unitCents * alt.qty;
        if (saving > 0 && (!best || saving > best.saving)) best = { idx, alt, saving };
      }
    }
    if (best) {
      trace.push({ step: 'fit', detail: `${lines[best.idx].name} → ${best.alt.name} (saves ${fmt(best.saving)})` });
      lines[best.idx] = best.alt;
    } else {
      const optional = lines
        .map((l, idx) => ({ l, idx }))
        .filter(({ l }) => slots[l.slot].optional)
        .sort((a, b) => b.l.unitCents * b.l.qty - a.l.unitCents * a.l.qty)[0];
      if (!optional) break;
      trace.push({ step: 'fit', detail: `dropped optional ${optional.l.name} (${fmt(optional.l.unitCents * optional.l.qty)})` });
      lines.splice(optional.idx, 1);
    }
    ev = evalNow();
  }

  const status = ev.ok ? 'ready' : 'blocked';
  trace.push(
    ev.ok
      ? { step: 'ready', detail: `${lines.length} items, ${fmt(ev.totalCents)} — inside your mandate. Waiting for your confirmation.` }
      : { step: 'blocked', detail: ev.violations.map((v) => v.message).join('; ') + ' — the agent will not check out.' },
  );
  return {
    ...base,
    status,
    lines,
    totalCents: cartTotal(lines),
    limitCents: ev.limitCents,
    violations: ev.violations,
    mandateSnapshot: effective,
  };
}
