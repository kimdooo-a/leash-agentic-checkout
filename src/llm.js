// Pluggable language model. Any OpenAI-compatible /chat/completions endpoint works
// (LLM_BASE_URL + LLM_API_KEY + LLM_MODEL). With nothing configured, Leash uses its
// rule-based parser so the whole app still runs offline.
//
// The model is allowed to do two things only: read the request into a structured shopping
// intent, and pick among catalog candidates the code already found. It never sets a price,
// a total, or talks to PayPal. Everything it returns is validated before use.

export class LLMError extends Error {}

export function llmConfigured(cfg) {
  return Boolean(cfg.llm.baseUrl && cfg.llm.model);
}

export async function chatJSON(cfg, messages, { fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.llm.timeoutMs);
  try {
    const res = await fetchImpl(`${cfg.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.llm.apiKey ? { Authorization: `Bearer ${cfg.llm.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.llm.model, messages, temperature: 0, response_format: { type: 'json_object' } }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new LLMError(`LLM HTTP ${res.status}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new LLMError('LLM returned no message content');
    const json = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      return JSON.parse(json);
    } catch {
      throw new LLMError('LLM did not return valid JSON');
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new LLMError('LLM timed out');
    throw e instanceof LLMError ? e : new LLMError(e.message);
  } finally {
    clearTimeout(timer);
  }
}

const INTENT_SYSTEM = `You turn a shopper's message into JSON for a shopping agent. Reply with JSON only:
{"intent":"buy"|"refund"|"other",
 "budget":number|null,            // dollars the user explicitly asked to stay under, else null
 "items":[{"query":string,"qty":integer,"optional":boolean}],  // short product search phrases
 "excludeCategories":[string],    // e.g. "alcohol" when the user says no alcohol
 "refundTarget":string|null}      // for refunds: the product words or order id the user mentioned
Rules: expand a meal or occasion into concrete grocery/household items. qty is a whole number >= 1.
Mark nice-to-have extras as optional. Do not include prices.`;

export function validateIntent(raw) {
  if (!raw || typeof raw !== 'object') throw new LLMError('intent is not an object');
  const intent = ['buy', 'refund', 'other'].includes(raw.intent) ? raw.intent : 'other';
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter((i) => i && typeof i.query === 'string' && i.query.trim())
        .slice(0, 15)
        .map((i) => ({
          query: i.query.trim().slice(0, 80),
          qty: Math.min(20, Math.max(1, Math.round(Number(i.qty) || 1))),
          optional: Boolean(i.optional),
        }))
    : [];
  const budget = raw.budget == null || raw.budget === '' ? null : Number(raw.budget);
  return {
    intent,
    budgetCents: Number.isFinite(budget) && budget > 0 ? Math.round(budget * 100) : null,
    items,
    excludeCategories: Array.isArray(raw.excludeCategories) ? raw.excludeCategories.map(String).slice(0, 10) : [],
    refundTarget: typeof raw.refundTarget === 'string' ? raw.refundTarget.slice(0, 80) : null,
  };
}

export async function llmParseIntent(cfg, message, opts) {
  const raw = await chatJSON(cfg, [
    { role: 'system', content: INTENT_SYSTEM },
    { role: 'user', content: message },
  ], opts);
  return validateIntent(raw);
}

// slots: [{ query, candidates: [{sku, name, priceCents, category}] }]
// Returns sku choices; any sku not among that slot's candidates is rejected (falls back to rank 1).
export async function llmChoose(cfg, message, slots, opts) {
  const payload = slots.map((s, i) => ({
    slot: i,
    want: s.query,
    candidates: s.candidates.map((c) => ({ sku: c.sku, name: c.name, price: (c.priceCents / 100).toFixed(2), category: c.category })),
  }));
  const raw = await chatJSON(cfg, [
    {
      role: 'system',
      content:
        'Pick the best candidate for each slot for this shopper. Prefer matches to stated preferences (organic, vegan, cheap). ' +
        'Reply JSON only: {"choices":[{"slot":number,"sku":string,"why":string}]}',
    },
    { role: 'user', content: JSON.stringify({ request: message, slots: payload }) },
  ], opts);
  const out = new Map();
  for (const c of Array.isArray(raw?.choices) ? raw.choices : []) {
    const slot = slots[Number(c.slot)];
    if (slot && slot.candidates.some((x) => x.sku === c.sku)) out.set(Number(c.slot), { sku: c.sku, why: String(c.why ?? '').slice(0, 160) });
  }
  return out;
}
