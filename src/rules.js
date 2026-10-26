// Rule-based intent parser: the offline fallback when no LLM is configured (or the LLM fails).
// Same output shape as llm.validateIntent().

const BUNDLES = [
  {
    match: /\b(pasta|spaghetti|italian)\b.*\b(dinner|night|meal)\b|\b(dinner|meal)\b.*\b(pasta|italian)\b/,
    items: [
      { query: 'spaghetti', qty: 1 },
      { query: 'pasta sauce', qty: 1 },
      { query: 'parmesan', qty: 1 },
      { query: 'fresh basil', qty: 1, optional: true },
      { query: 'garlic bread', qty: 1, optional: true },
      { query: 'salad greens', qty: 1, optional: true },
      { query: 'red wine', qty: 1, optional: true },
    ],
    scaleWithPeople: ['spaghetti', 'pasta sauce'],
  },
  {
    match: /\bbreakfast\b/,
    items: [
      { query: 'eggs', qty: 1 },
      { query: 'milk', qty: 1 },
      { query: 'rolled oats', qty: 1 },
      { query: 'bananas', qty: 1 },
      { query: 'coffee beans', qty: 1, optional: true },
      { query: 'orange juice', qty: 1, optional: true },
    ],
    scaleWithPeople: ['eggs'],
  },
  {
    match: /\b(party|game night|movie night|get-together|bbq)\b/,
    items: [
      { query: 'chips', qty: 2 },
      { query: 'salsa', qty: 1 },
      { query: 'sparkling water', qty: 1 },
      { query: 'napkins', qty: 1 },
      { query: 'plates', qty: 1, optional: true },
      { query: 'beer', qty: 1, optional: true },
    ],
    scaleWithPeople: ['chips'],
  },
  {
    match: /\b(clean(ing)?|kitchen restock|restock the kitchen)\b/,
    items: [
      { query: 'dish soap', qty: 1 },
      { query: 'sponges', qty: 1 },
      { query: 'paper towels', qty: 1 },
      { query: 'trash bags', qty: 1, optional: true },
    ],
    scaleWithPeople: [],
  },
];

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };

const EXCLUDE_WORDS = [
  { re: /\b(no|without|skip|avoid)\s+(alcohol|booze|wine|beer|drinks with alcohol)\b|\b(alcohol|sober)[- ]free\b/, category: 'alcohol' },
  { re: /\b(no|without)\s+gift ?cards?\b/, category: 'gift_card' },
];

export function parseBudget(text) {
  const m =
    text.match(/\b(?:under|below|less than|max(?:imum)?|budget(?: of| is)?|up to|within|no more than|at most|cap(?:ped)? at)\s*(?:of\s*)?\$?\s*(\d+(?:\.\d{1,2})?)/) ||
    text.match(/\$\s*(\d+(?:\.\d{1,2})?)\s*(?:max|budget|or less|tops)/);
  return m ? Math.round(Number(m[1]) * 100) : null;
}

export function parsePeople(text) {
  const m = text.match(/\bfor\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:people|guests|of us|persons|friends)?\b/);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
}

function parseItemList(text) {
  const cleaned = text
    .replace(/^(please\s+)?(can you\s+)?(buy|get|order|grab|pick up|i need|we need|add)\s+(me\s+)?/, '')
    .replace(/\b(?:under|below|less than|max|budget|up to|within|no more than|at most)\b.*$/, '')
    .replace(/\b(no|without|skip|avoid)\s+\w+/g, '');
  return cleaned
    .split(/,|\band\b|\+|;/)
    .map((s) => s.trim().replace(/[.!?]+$/, ''))
    .filter((s) => s.length > 1)
    .map((chunk) => {
      const m = chunk.match(/^(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\s*(?:x\s*)?(?:packs? of |bottles? of |bags? of |boxes? of )?(.+)$/);
      if (m) return { query: m[2].trim(), qty: /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]], optional: false };
      return { query: chunk, qty: 1, optional: false };
    })
    .filter((i) => i.query && !/^(some|stuff|things)$/.test(i.query));
}

export function rulesParseIntent(message) {
  const text = String(message).toLowerCase();
  const budgetCents = parseBudget(text);
  const excludeCategories = EXCLUDE_WORDS.filter((e) => e.re.test(text)).map((e) => e.category);

  if (/\b(refund|return|send back|money back)\b/.test(text)) {
    const target = text.replace(/.*\b(refund|return|send back|money back)\b\s*(the|my|for)?\s*/, '').replace(/[.!?]+$/, '').trim();
    return { intent: 'refund', budgetCents: null, items: [], excludeCategories: [], refundTarget: target || null };
  }

  const bundle = BUNDLES.find((b) => b.match.test(text));
  let items;
  if (bundle) {
    const people = parsePeople(text) ?? 2;
    const factor = Math.max(1, Math.ceil(people / 2));
    items = bundle.items.map((i) => ({
      query: i.query,
      qty: bundle.scaleWithPeople.includes(i.query) ? i.qty * factor : i.qty,
      optional: Boolean(i.optional),
    }));
  } else {
    items = parseItemList(text);
  }
  return { intent: items.length ? 'buy' : 'other', budgetCents, items, excludeCategories, refundTarget: null };
}
