// Product catalog. The agent never invents prices: every price the cart uses comes from here.
//  - "local": the bundled fictional catalog (data/catalog.json), works offline.
//  - "channel3": live product search through the Channel3 API (https://docs.trychannel3.com/api-reference/v1/search).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { toCents } from './money.js';

const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'some', 'with', 'to', 'me', 'my', 'get', 'buy', 'pack', 'x']);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

export class LocalCatalog {
  constructor(file = path.join(ROOT, 'data', 'catalog.json')) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    this.source = 'local';
    this.merchants = new Map(raw.merchants.map((m) => [m.id, m]));
    this.products = raw.products.map((p) => ({
      sku: p.sku,
      name: p.name,
      merchant: p.merchant,
      merchantName: this.merchants.get(p.merchant)?.name ?? p.merchant,
      category: p.category,
      priceCents: toCents(p.price),
      tags: p.tags,
      source: 'local',
    }));
    this.bySku = new Map(this.products.map((p) => [p.sku, p]));
  }

  merchant(id) {
    return this.merchants.get(id);
  }

  async get(sku) {
    return this.bySku.get(sku) ?? null;
  }

  // Score = matched query tokens against tags (weight 2) and name (weight 1).
  async search(query, { limit = 5 } = {}) {
    const q = tokenize(query);
    if (!q.length) return [];
    const scored = [];
    for (const p of this.products) {
      const tagTokens = new Set(p.tags.flatMap(tokenize));
      const nameTokens = new Set(tokenize(p.name));
      const phraseHit = p.tags.some((t) => t === String(query).toLowerCase().trim()) ? 3 : 0;
      let score = phraseHit;
      let matched = 0;
      for (const t of q) {
        const hit = (tagTokens.has(t) ? 2 : 0) + (nameTokens.has(t) ? 1 : 0);
        if (hit) matched++;
        score += hit;
      }
      if (matched === 0) continue;
      score += matched / q.length; // prefer products that cover the whole query
      scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score || a.p.priceCents - b.p.priceCents);
    return scored.slice(0, limit).map((s) => s.p);
  }
}

export class Channel3Catalog {
  constructor(apiKey, { fetchImpl = fetch } = {}) {
    if (!apiKey) throw new Error('CATALOG_SOURCE=channel3 needs CHANNEL3_API_KEY');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.source = 'channel3';
    this.cache = new Map();
  }

  merchant(id) {
    return { id, name: id, refundWindowDays: 30 };
  }

  async get(sku) {
    return this.cache.get(sku) ?? null;
  }

  async search(query, { limit = 5 } = {}) {
    const res = await this.fetch('https://api.trychannel3.com/v1/search', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) throw new Error(`Channel3 search failed: HTTP ${res.status}`);
    const body = await res.json();
    const out = [];
    for (const prod of body.products ?? []) {
      const offer = (prod.offers ?? []).find((o) => o?.price?.price != null && (o.price.currency ?? 'USD') === 'USD');
      if (!offer) continue;
      const p = {
        sku: `C3-${prod.id}`,
        name: prod.title,
        merchant: offer.domain ?? 'channel3',
        merchantName: offer.domain ?? 'Channel3 retailer',
        category: prod.category?.slug ?? 'general',
        priceCents: Math.round(Number(offer.price.price) * 100),
        tags: [prod.category?.title, ...(prod.brands ?? []).map((b) => b.name)].filter(Boolean),
        url: offer.url,
        image: prod.images?.[0]?.url ?? prod.images?.[0] ?? null,
        source: 'channel3',
      };
      this.cache.set(p.sku, p);
      out.push(p);
    }
    return out;
  }
}

export function createCatalog(cfg) {
  if (cfg.catalog.source === 'channel3') return new Channel3Catalog(cfg.catalog.channel3ApiKey);
  return new LocalCatalog();
}
