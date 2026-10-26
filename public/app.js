// Leash UI — plain JS, talks to the server's JSON API.
const $ = (s) => document.querySelector(s);
const money = (c) => `$${(c / 100).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let state = null;
let current = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function refresh() {
  state = await api('/api/state');
  renderBadges();
  renderMandate();
  renderOrders();
  renderLog();
}

function renderBadges() {
  const c = state.config;
  $('#badges').innerHTML =
    `<span class="${c.paypalMode}">PayPal: ${c.paypalMode === 'mock' ? 'MOCK (simulated)' : 'sandbox'}</span>` +
    `<span>AI: ${esc(c.llm.model ? `${c.llm.provider} · ${c.llm.model}` : c.llm.provider)}</span>` +
    `<span>catalog: ${esc(c.catalog)}</span>`;
}

function renderMandate() {
  const m = state.mandate;
  const f = $('#mandate');
  for (const k of ['monthlyBudgetCents', 'perOrderCapCents', 'perItemCapCents']) f[k].value = m[k] / 100;
  f.maxQtyPerItem.value = m.maxQtyPerItem;
  f.priceDriftTolerancePct.value = m.priceDriftTolerancePct;
  f.querySelectorAll('input[name=blocked]').forEach((cb) => (cb.checked = m.blockedCategories.includes(cb.value)));
  const b = state.budget;
  const total = m.monthlyBudgetCents || 1;
  const net = Math.max(0, b.spentCents - b.refundedCents);
  $('#mSpent').style.width = `${Math.min(100, (net / total) * 100)}%`;
  $('#mHeld').style.width = `${Math.min(100, (b.heldCents / total) * 100)}%`;
  $('#meterText').textContent = `${b.period}: spent ${money(net)} (refunded ${money(b.refundedCents)}) · held ${money(b.heldCents)} · remaining ${money(b.remainingCents)} of ${money(m.monthlyBudgetCents)}`;
}

function renderTrace(p) {
  $('#traceCard').hidden = false;
  $('#trace').innerHTML = p.trace
    .map((t) => {
      const cls = t.warn ? 'warn' : t.step === 'guardrail' ? 'guard' : t.step;
      return `<li class="${cls}"><span class="step">${esc(t.step)}</span>${esc(t.detail ?? t.warn)}${t.by ? `<span class="by">${esc(t.by)}</span>` : ''}</li>`;
    })
    .join('');
}

function renderCart(p) {
  const card = $('#cartCard');
  card.hidden = false;
  $('#cartStatus').className = `pill ${p.status}`;
  $('#cartStatus').textContent = p.status.replace('_', ' ');
  const actions = $('#cartActions');
  actions.innerHTML = '';
  $('#violations').innerHTML = '';
  $('#cartHint').textContent = '';

  if (p.status === 'refund_request') {
    $('#lines').innerHTML = p.refund
      ? `<tr><td>${esc(p.refund.name)}</td><td>order <code>${esc(p.refund.orderId)}</code></td><td class="num">—</td><td class="num">−${money(p.refund.cents)}</td></tr>`
      : '<tr><td colspan="4">No matching captured order.</td></tr>';
    $('#limitText').textContent = '';
    $('#limitFill').style.width = '0';
    if (p.refund) {
      const btn = el('button', 'primary', `Confirm refund ${money(p.refund.cents)}`);
      btn.onclick = () => doRefund(p.refund.orderId, p.refund.sku, btn);
      actions.append(btn);
      $('#cartHint').textContent = 'Refunds go through PayPal Payments v2 (captures/{id}/refund) and credit your monthly budget.';
    }
    return;
  }

  $('#lines').innerHTML =
    p.lines.map((l) => `<tr><td>${esc(l.name)}</td><td>${esc(l.merchantName)}</td><td class="num">${l.qty}</td><td class="num">${money(l.unitCents * l.qty)}</td></tr>`).join('') +
    `<tr><td colspan="3"><b>Total</b></td><td class="num"><b>${money(p.totalCents ?? 0)}</b></td></tr>`;
  const pct = p.limitCents ? Math.min(100, ((p.totalCents ?? 0) / p.limitCents) * 100) : 100;
  $('#limitFill').style.width = `${pct}%`;
  $('#limitFill').className = `fill${(p.totalCents ?? 0) > p.limitCents ? ' over' : ''}`;
  $('#limitText').textContent = `${money(p.totalCents ?? 0)} of ${money(p.limitCents ?? 0)} allowed`;
  $('#violations').innerHTML = (p.violations ?? []).map((v) => `<li>${esc(v.message)}</li>`).join('');

  if (p.status === 'ready') {
    const btn = el('button', 'primary', `Confirm & pay ${money(p.totalCents)} with PayPal`);
    btn.id = 'confirmBtn';
    btn.onclick = () => doConfirm(p, btn);
    const no = el('button', 'secondary', 'Discard');
    no.onclick = () => ((card.hidden = true), ($('#traceCard').hidden = true));
    actions.append(btn, no);
    $('#cartHint').textContent = 'Confirming re-checks prices and the mandate, holds the amount, and creates a PayPal order. You then approve it on PayPal; the server captures only after verifying the approved amount.';
  } else if (p.status === 'blocked') {
    $('#cartHint').textContent = 'The agent will not check out a cart that breaks your mandate. Loosen the mandate or ask for less.';
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

async function doConfirm(p, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/api/proposals/${p.id}/confirm`, { method: 'POST' });
    if (!r.approveUrl) throw new Error('PayPal returned no approval link');
    location.href = r.approveUrl; // buyer approval on PayPal (or the simulated page in mock mode)
  } catch (e) {
    banner(`Checkout stopped: ${e.message}`, false);
    btn.disabled = false;
    refresh();
  }
}

async function doRefund(orderId, sku, btn) {
  if (btn) btn.disabled = true;
  try {
    const o = await api(`/api/orders/${orderId}/refund`, { method: 'POST', body: JSON.stringify({ sku }) });
    banner(`Refund completed — order ${o.id} is now ${o.status}. Budget credited.`, true);
  } catch (e) {
    banner(`Refund refused: ${e.message}`, false);
  }
  if (btn) btn.disabled = false;
  refresh();
}

function renderOrders() {
  const orders = state.orders;
  if (!orders.length) return;
  $('#orders').innerHTML = orders
    .map(
      (o) => `<div class="order"><div class="head"><span><code>${esc(o.id)}</code> <span class="pill ${o.status}">${esc(o.status)}</span></span><b>${money(o.totalCents)}${o.refundedCents ? ` <small>(−${money(o.refundedCents)})</small>` : ''}</b></div>
      ${o.captureId ? `<div class="hint">capture <code>${esc(o.captureId)}</code>${o.payer ? ` · payer ${esc(o.payer)}` : ''}</div>` : ''}
      ${o.problem ? `<div class="violations">${esc(o.problem)}</div>` : ''}
      <ul>${o.lines
        .map(
          (l) => `<li class="${l.refunded ? 'refunded' : ''}"><span>${l.qty}× ${esc(l.name)}</span><span>${money(l.unitCents * l.qty)} ${
            o.captureId && !l.refunded ? `<button class="danger" data-order="${esc(o.id)}" data-sku="${esc(l.sku)}">refund</button>` : ''
          }</span></li>`,
        )
        .join('')}</ul>
      ${o.status === 'PAYER_ACTION_REQUIRED' && o.approveUrl ? `<a href="${esc(o.approveUrl)}">Resume PayPal approval →</a>` : ''}</div>`,
    )
    .join('');
  $('#orders').querySelectorAll('button[data-order]').forEach((b) => (b.onclick = () => doRefund(b.dataset.order, b.dataset.sku, b)));
}

function renderLog() {
  $('#log').innerHTML = state.audit
    .slice(0, 60)
    .map((e) =>
      e.kind === 'paypal_api'
        ? `<li class="s${String(e.status)[0]}">${esc(e.at.slice(11, 19))} ${esc(e.method)} ${esc(e.path)} → ${e.status} · ${e.ms}ms${e.debugId ? ` · ${esc(e.debugId)}` : ''}</li>`
        : `<li class="ev">${esc(e.at.slice(11, 19))} ${esc(e.kind)}${e.rule ? ` · ${esc(e.rule)}` : ''}${e.orderId ? ` · ${esc(e.orderId)}` : ''}${e.cents != null ? ` · ${money(e.cents)}` : ''}</li>`,
    )
    .join('');
}

function banner(text, ok) {
  const b = $('#banner');
  b.hidden = false;
  b.className = `banner ${ok ? 'ok' : 'bad'}`;
  b.textContent = text;
}

$('#ask').onsubmit = async (ev) => {
  ev.preventDefault();
  const btn = $('#askBtn');
  btn.disabled = true;
  try {
    current = await api('/api/agent', { method: 'POST', body: JSON.stringify({ message: $('#message').value }) });
    renderTrace(current);
    if (current.status === 'not_understood') {
      $('#cartCard').hidden = true;
    } else renderCart(current);
  } catch (e) {
    banner(e.message, false);
  }
  btn.disabled = false;
  refresh();
};

$('#examples').onclick = (ev) => {
  if (ev.target.classList.contains('chip')) {
    $('#message').value = ev.target.textContent;
    $('#ask').requestSubmit();
  }
};

$('#mandate').onsubmit = async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = {
    monthlyBudgetCents: Math.round(Number(f.monthlyBudgetCents.value) * 100),
    perOrderCapCents: Math.round(Number(f.perOrderCapCents.value) * 100),
    perItemCapCents: Math.round(Number(f.perItemCapCents.value) * 100),
    maxQtyPerItem: Number(f.maxQtyPerItem.value),
    priceDriftTolerancePct: Number(f.priceDriftTolerancePct.value),
    blockedCategories: [...f.querySelectorAll('input[name=blocked]:checked')].map((c) => c.value),
  };
  try {
    state = await api('/api/mandate', { method: 'PUT', body: JSON.stringify(body) });
    banner('Mandate saved. The agent re-checks it on every proposal and again at checkout.', true);
  } catch (e) {
    banner(e.message, false);
  }
  refresh();
};

$('#reset').onclick = async () => {
  await api('/api/reset', { method: 'POST' });
  location.href = '/';
};

(async () => {
  await refresh();
  const id = new URLSearchParams(location.search).get('order');
  if (id) {
    const o = state.orders.find((x) => x.id === id);
    if (o?.status === 'COMPLETED') banner(`Paid. PayPal capture ${o.captureId} completed for ${money(o.totalCents)} — the agent stayed inside your mandate.`, true);
    else if (o) banner(`Order ${o.id} is ${o.status}${o.problem ? `: ${o.problem}` : ''}. No money was captured.`, false);
  }
})();
