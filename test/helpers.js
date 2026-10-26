import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

// Start a full Leash server (mock PayPal) on a free port with a throwaway data dir.
export async function startApp(overrides = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'leash-test-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const cfg = loadConfig({ port, appBaseUrl: `http://127.0.0.1:${port}`, paypalMode: 'mock', dataDir, llmBaseUrl: '', llmModel: '', ...overrides });
  const app = createApp(cfg);
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  const base = cfg.appBaseUrl;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, location: res.headers.get('location') };
  };
  const close = async () => {
    await new Promise((r) => app.server.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { ...app, base, call, close };
}

// Plays the buyer on the mock approval page: POST the form, follow the redirect to /paypal/return.
export async function approveAsBuyer(app, approveUrl, action = 'approve') {
  const token = new URL(approveUrl).searchParams.get('token');
  const page = await fetch(approveUrl);
  if (!page.ok) throw new Error(`approval page HTTP ${page.status}`);
  const res = await fetch(`${app.base}/mock-paypal/checkoutnow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, action }).toString(),
    redirect: 'manual',
  });
  const back = res.headers.get('location');
  const ret = await fetch(back, { redirect: 'manual' });
  return { token, returnUrl: back, finalLocation: ret.headers.get('location'), status: ret.status };
}
