# Leash — agentic checkout on a mandate

**An AI shopping agent that can only spend inside the rules you set.**
You say what you need in plain English. The agent builds a cart, fits it under your budget and
store policies, and asks you once. PayPal moves the money. The leash — budget, caps, blocked
categories, re-checks, refunds — is enforced in code, not by the model.

```
"Pasta dinner for 4 under $25"
  understand  2× spaghetti, 2× pasta sauce, parmesan, basil*, garlic bread*, salad*, red wine*   (*optional)
  guardrail   Red table wine: category "alcohol" is blocked by your mandate → removed
  budget      cart $25.62 vs limit $25.00
  fit         Aged parmesan → Grated hard cheese (saves $3.30)
  ready       6 items, $22.32 — inside your mandate. Waiting for your confirmation.
  ── you confirm ──> PayPal order (Orders v2) ──> you approve on PayPal ──> server verifies + captures
  "refund the parmesan" ──> PayPal refund (Payments v2) ──> budget credited
```

## Why

Agents that can *recommend* are easy; agents that can *pay* are scary. The problem with letting
an assistant shop for you is not finding products — it is trusting it with money. Leash is built
around that trust problem:

- **The model never touches money.** The LLM only turns your words into a shopping intent and
  picks among products the catalog already found. Every price comes from the catalog, every total
  is computed in integer cents, and every PayPal amount is built by code.
- **A mandate the agent cannot argue with.** Monthly budget, per-order cap, per-item cap, max
  quantity, blocked categories (alcohol and gift cards by default), merchant allow-list, price-drift
  tolerance. The agent repairs carts to fit (swap to cheaper, drop optional extras) and refuses to
  check out when it can't.
- **Two human gates.** You confirm the cart in Leash, then approve the payment on PayPal.
  The server captures only after it re-reads the PayPal order and checks status, amount and
  ownership.
- **Undo is a first-class action.** Refund one line or the whole order in plain English, through
  PayPal, inside each merchant's refund window — and the budget is credited.

## Run it (2 minutes, no accounts needed)

Requires **Node.js 22+**. No `npm install` — zero dependencies.

```bash
git clone https://github.com/kimdooo-a/leash-agentic-checkout leash && cd leash
npm start            # http://localhost:3070  (mock PayPal + rule-based AI)
```

Open http://localhost:3070, click **Pasta dinner for 4 under $25**, then **Confirm & pay**.
In mock mode the approval step is a clearly-labelled *simulated* page that stands in for PayPal.

```bash
npm test             # 13 tests: policy, parser, LLM path (fake model), full HTTP flow
npm run e2e          # starts the server and drives intent → cart → order → approve → capture → refund
```

## Run it against the real PayPal sandbox

1. Log in at https://developer.paypal.com/dashboard/ → **Apps & Credentials** → **Sandbox** →
   create (or open) an app and copy its **Client ID** and **Secret**.
2. Under **Testing Tools → Sandbox Accounts**, note a **Personal** (buyer) account email and
   password — that is who approves payments. (Or skip it: on the sandbox approval page choose
   **Pay with debit or credit card**, pick United States, and use a PayPal sandbox test card with
   "Save info & create account" switched off — that is how the demo video approves.)
3. `cp .env.example .env` and set:
   ```
   PAYPAL_MODE=sandbox
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   APP_BASE_URL=http://localhost:3070
   ```
4. `npm run check:paypal` — gets an OAuth token, creates a $1.00 sandbox order, reads it back.
5. `npm start`, ask the agent, **Confirm & pay**, log in on PayPal's sandbox page with the
   personal account and approve. PayPal redirects back to `/paypal/return`; Leash verifies and
   captures. The **PayPal API log** panel shows every call, status and `debug_id`.
6. Prefer the terminal? After the buyer has approved, `node scripts/sandbox-finish.mjs --order <ORDER_ID>`
   (against the same running server) confirms the capture and then refunds one line
   (`--refund "refund the parmesan"` by default, `--no-refund` to stop after the capture).
   Run it only after approving: an order that was not approved is rejected and its budget hold released.

Leash refuses to start with a non-sandbox `PAYPAL_API_BASE`. With `PAYPAL_MODE=sandbox` in your `.env`,
`npm run e2e` runs against the sandbox and stops at the approval link; run the offline version with
`PAYPAL_MODE=mock npm run e2e`. `npm test` always uses the built-in mock.

## Plug in a language model (optional)

Any OpenAI-compatible `/chat/completions` endpoint:

```
LLM_BASE_URL=https://api.meta.ai/v1       # what the demo uses: Meta Model API (Muse Spark)
LLM_API_KEY=...
LLM_MODEL=muse-spark-1.3
LLM_TIMEOUT_MS=60000
```

Any other OpenAI-compatible server works the same way (e.g. `https://api.openai.com/v1` with
`gpt-4o-mini`, or a local `http://localhost:11434/v1`).

With a model configured, it parses free-form requests ("something cozy for a rainy movie night,
nothing over 30 bucks, we don't drink") and chooses between candidates. Its output is validated:
unknown SKUs are rejected, quantities are clamped, and if the model errors or times out Leash falls
back to the rule-based parser and says so in the trace. Without a model, the rule parser handles
lists ("2 usb-c cables and a hdmi cable"), budgets ("under $25"), party sizes, exclusions
("no alcohol"), occasions (pasta dinner, breakfast, game night, cleaning) and refunds.

## Live product search (optional)

`CATALOG_SOURCE=channel3` + `CHANNEL3_API_KEY` swaps the bundled fictional catalog for live search
through the Channel3 API (`POST https://api.trychannel3.com/v1/search`). The mandate and checkout
are identical.

## PayPal APIs used

| Step | Endpoint |
|---|---|
| Auth | `POST /v1/oauth2/token` (client credentials) |
| Checkout | `POST /v2/checkout/orders` — `intent: CAPTURE`, itemized `purchase_units` with `item_total` breakdown, `payment_source.paypal.experience_context` (`return_url`, `cancel_url`, `user_action: PAY_NOW`), `PayPal-Request-Id` idempotency |
| Verify | `GET /v2/checkout/orders/{id}` — status `APPROVED`, amount and `custom_id` must match the confirmed cart |
| Capture | `POST /v2/checkout/orders/{id}/capture` (idempotent) |
| Refund | `POST /v2/payments/captures/{capture_id}/refund` — partial (one line) or full |

## How it is built

```
src/
  server.js       HTTP API + UI + PayPal return/cancel handlers (Node http, no framework)
  agent.js        intent → search → choose → guardrails → fit-to-budget, with a step trace
  policy.js       the mandate: pure, tested rules (caps, budget with holds, drift, refund window)
  paypal.js       PayPal REST client (OAuth, Orders v2, Payments v2 refunds, retries, idempotency)
  mock-paypal.js  local stand-in for the PayPal API used in mock mode (same HTTP client runs against it)
  llm.js          OpenAI-compatible client, validated intent + candidate choice
  rules.js        offline rule-based intent parser (fallback)
  catalog.js      bundled catalog or Channel3 live search
  store.js        JSON state + append-only audit log (runtime/)
public/           single-page UI (vanilla JS)
test/             node:test suites
scripts/          e2e driver, sandbox credential check, post-approval capture/refund helper
```

Budget accounting uses **holds**: confirming a cart reserves its amount, so two parallel orders
can't overspend; a cancelled or failed approval releases the hold; a capture converts it to spend;
a refund credits it back.

## Honest limits

- The bundled catalog is fictional and merchants are simulated; Leash acts as the single
  merchant-of-record in the PayPal sandbox.
- Mock mode imitates PayPal's request/response shapes and the checks this app relies on — it is
  not PayPal. Use sandbox mode to see the real thing.
- Single-user, single-process demo storage.

## License

MIT — see [LICENSE](LICENSE).
