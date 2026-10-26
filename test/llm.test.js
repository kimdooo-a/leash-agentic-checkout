// The LLM path, against a fake OpenAI-compatible server. Proves: the model's intent is used,
// its picks are validated against catalog candidates, and a broken model falls back to rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp } from './helpers.js';

function fakeLLM(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    calls.push({ auth: req.headers.authorization, body });
    const content = handler(body, calls.length);
    if (content === null) {
      res.writeHead(500);
      return res.end('boom');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

test('LLM intent + validated picks (hallucinated sku rejected)', async (t) => {
  const llm = await fakeLLM((body, n) => {
    if (n === 1) return { intent: 'buy', budget: 20, items: [{ query: 'spaghetti', qty: 1 }, { query: 'pasta sauce', qty: 1 }], excludeCategories: [], refundTarget: null };
    return { choices: [{ slot: 0, sku: 'GL-PASTA-ORG', why: 'organic requested' }, { slot: 1, sku: 'FAKE-SKU-999', why: 'hallucinated' }] };
  });
  t.after(() => llm.server.close());
  const app = await startApp({ llmBaseUrl: llm.url, llmModel: 'test-model', llmApiKey: 'k' });
  t.after(app.close);

  const r = await app.call('POST', '/api/agent', { message: 'organic pasta night, keep it under 20 bucks' });
  assert.equal(r.json.parsedBy, 'llm');
  assert.equal(r.json.intent.budgetCents, 2000);
  assert.equal(r.json.lines[0].sku, 'GL-PASTA-ORG');
  assert.notEqual(r.json.lines[1].sku, 'FAKE-SKU-999');
  assert.equal(llm.calls[0].auth, 'Bearer k');
  assert.equal(llm.calls[0].body.model, 'test-model');
  // prices never come from the model
  assert.equal(r.json.lines[0].unitCents, 349);
});

test('LLM failure falls back to rules', async (t) => {
  const llm = await fakeLLM(() => null);
  t.after(() => llm.server.close());
  const app = await startApp({ llmBaseUrl: llm.url, llmModel: 'test-model' });
  t.after(app.close);
  const r = await app.call('POST', '/api/agent', { message: 'Breakfast for two' });
  assert.equal(r.json.parsedBy, 'rules');
  assert.equal(r.json.status, 'ready');
  assert.ok(r.json.trace[0].warn);
});
