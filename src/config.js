// Configuration comes only from the environment (optionally a local .env file).
// Secrets are never written to logs, the audit trail or API responses.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const env = process.env;

function num(name, fallback) {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function loadConfig(overrides = {}) {
  const port = overrides.port ?? num('PORT', 3070);
  const appBaseUrl = (overrides.appBaseUrl ?? env.APP_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const mode = (overrides.paypalMode ?? env.PAYPAL_MODE ?? 'mock').toLowerCase();
  if (!['mock', 'sandbox'].includes(mode)) throw new Error('PAYPAL_MODE must be "mock" or "sandbox"');

  const paypal =
    mode === 'sandbox'
      ? {
          mode,
          apiBase: (env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com').replace(/\/$/, ''),
          clientId: env.PAYPAL_CLIENT_ID || '',
          clientSecret: env.PAYPAL_CLIENT_SECRET || '',
        }
      : {
          mode,
          // Mock mode runs the very same HTTP client against a local fake of the PayPal REST API.
          apiBase: `${appBaseUrl}/mock-paypal`,
          clientId: 'mock-client-id',
          clientSecret: 'mock-client-secret',
        };
  if (mode === 'sandbox' && (!paypal.clientId || !paypal.clientSecret)) {
    throw new Error('PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
  }
  if (mode === 'sandbox' && !/sandbox\.paypal\.com/.test(paypal.apiBase)) {
    throw new Error('Leash only talks to the PayPal sandbox. PAYPAL_API_BASE must be a sandbox host.');
  }

  return {
    port,
    appBaseUrl,
    currency: env.CURRENCY || 'USD',
    brandName: env.BRAND_NAME || 'Leash Demo Store',
    paypal,
    llm: {
      baseUrl: (overrides.llmBaseUrl ?? env.LLM_BASE_URL ?? '').replace(/\/$/, ''),
      apiKey: overrides.llmApiKey ?? env.LLM_API_KEY ?? '',
      model: overrides.llmModel ?? env.LLM_MODEL ?? '',
      timeoutMs: num('LLM_TIMEOUT_MS', 20000),
    },
    catalog: {
      source: (env.CATALOG_SOURCE || 'local').toLowerCase(),
      channel3ApiKey: env.CHANNEL3_API_KEY || '',
    },
    dataDir: overrides.dataDir ?? env.LEASH_DATA_DIR ?? path.join(ROOT, 'runtime'),
  };
}

// What is safe to show in the UI / logs about the configuration.
export function publicConfig(cfg) {
  return {
    paypalMode: cfg.paypal.mode,
    paypalApiBase: cfg.paypal.apiBase,
    llm: cfg.llm.baseUrl && cfg.llm.model ? { provider: 'openai-compatible', model: cfg.llm.model } : { provider: 'rules (no LLM configured)' },
    catalog: cfg.catalog.source,
    currency: cfg.currency,
  };
}
