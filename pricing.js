// agent-stable · pricing — model price table, source-of-funds classification, and
// open-weight self-host cost estimation. Pure module: no I/O, no globals, no host deps.
// This is the first extracted slice of the agent-stable spinoff (see stable/README.md).

// API-list prices per 1M tokens. Update when prices change; runtime-scraped prices
// (APA board / findings) are layered on top by the host app, not written here.
const MODEL_PRICES = {
  // Anthropic first-party list prices (verified 2026-09-04).
  'claude-fable-5-1':   { in: 10, out: 50,  tier: 'fable' },
  'claude-fable-5':     { in: 10, out: 50,  tier: 'fable' },
  'claude-opus-5':      { in: 5,  out: 25,  tier: 'opus' },
  'claude-opus-4-8':    { in: 5,  out: 25,  tier: 'opus' },
  'claude-opus-4-7':    { in: 5,  out: 25,  tier: 'opus' },
  'claude-opus-4-6':    { in: 5,  out: 25,  tier: 'opus' },
  'claude-sonnet-5':    { in: 2,  out: 10,  tier: 'sonnet' },
  'claude-sonnet-4-6':  { in: 3,  out: 15,  tier: 'sonnet' },
  'claude-haiku-4-5':   { in: 1,  out: 5,   tier: 'haiku' },
  'gemini-2.5-flash':   { in: 0.30, out: 2.50, tier: 'gemini' },
  'gemini-2.5-pro':     { in: 1.25, out: 10, tier: 'gemini' },
  // grok is out-of-pocket (xAI paid API). One row PER model: a bare family row prices every
  // variant at the cheapest one's rate and lets a cost gate "prove" false savings.
  'grok-4.6':           { in: 2,    out: 6,    tier: 'grok', note: 'AA-scraped, refine from invoice' },
  'grok-4.3':           { in: 1.25, out: 2.50, tier: 'grok', note: 'AA-scraped, refine from invoice' },
};
// exact id first, then the LONGEST key the id starts with (after dropping a -YYYYMMDD
// snapshot suffix). The old `includes()` scan was order-dependent and would hit
// 'claude-sonnet-5' for a future 'claude-sonnet-5-1'.
function priceOf(model) {
  const m = String(model || '').toLowerCase().replace(/-20\d{6}$/, '').split('/').pop();
  if (MODEL_PRICES[m]) return MODEL_PRICES[m];
  const k = Object.keys(MODEL_PRICES).filter(p => m.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  return k ? MODEL_PRICES[k] : null;
}

// Source-of-funds classification — the distinctive idea of agent-stable: not just how much a
// call cost, but WHOSE money it was. 'real' = out-of-pocket (paid API keys); 'credit' = finite
// free credit pools (cloud credits, promo agent pools); 'included' = flat-rate subscription.
// NOTE: the rules below are the REFERENCE DEPLOYMENT'S policy (module names like 'claw', a
// subscription-terms change date) — shipped as a worked example. Edit costClass for your own
// billing reality; the rest of agent-stable only relies on the three class names.
const CREDIT_SPLIT_DAY = Date.UTC(2026, 5, 15);
const GCP_TRIAL_END = Date.UTC(2026, 6, 16);   // Vertex/Gemini credit pool expired 2026-07-16; spend after it is real
function costClass(model, module, atIso) {
  const m = String(model || '').toLowerCase();
  const mod = String(module || '');
  const at = atIso ? new Date(atIso).getTime() : Date.now();
  // Marketplace-routed ids (OpenRouter et al: "anthropic/claude-…", "openrouter:…") are ALWAYS
  // out-of-pocket — the underlying family's subscription/credit never applies to a reroute.
  if (m.includes('/') || m.startsWith('openrouter:')) return 'real';
  // metered surfaces: an external harness ('claw') runs on an API key by contract — its rows
  // are namespaced '<prefix>claw:<sub>', which an exact `module === 'claw'` test never matched
  if (/claw(:|$)/.test(mod) || (/opus/.test(m) && mod.includes('esc'))) return 'real';
  if (/grok/.test(m)) return 'real';   // xAI is a paid API — out-of-pocket, not a credit or subscription
  if (/-free$/.test(m)) return 'included'; // AI Studio free tier: $0, no pool to draw down
  if (/gemini|vertex|imagen/.test(m)) return at >= GCP_TRIAL_END ? 'real' : 'credit';
  if (/claude|sonnet|haiku|opus|fable/.test(m)) return at >= CREDIT_SPLIT_DAY ? 'credit' : 'included';
  // Unknown ids (glm, gpt, kimi, deepseek, qwen, …) are paid APIs: a fall-through of
  // 'included' would book every not-yet-listed model as free subscription usage.
  return 'real';
}

// Open-weight self-host cost estimate, $ per 1M OUTPUT tokens:
//   energy(kWh) = watts/1000 × (1e6 tokens ÷ tokPerSec ÷ 3600s)  →  cost = energy × $/kWh
// Defaults: one ~700W GPU rig sustaining ~40 tok/s on a large OS model. Deliberately simple
// and fully user-editable — the point is a stated, tweakable assumption, not a TCO study
// (no hardware amortization, cooling, or batch-throughput effects).
const SELF_HOST_DEFAULTS = { kwhPrice: 0.15, watts: 700, tokPerSec: 40 };
function selfHostPerMTok(a = {}) {
  const { kwhPrice, watts, tokPerSec } = { ...SELF_HOST_DEFAULTS, ...a };
  const kwh = (watts / 1000) * (1e6 / Math.max(1, tokPerSec) / 3600);
  return Math.round(kwh * kwhPrice * 100) / 100;
}

// ---- usage-weighted cost (2026-08-11) ----
// A flat in+out sum mis-ranks models on lopsided workloads: bulk-extraction traffic can be
// ~97% input tokens, where a model $0.25 pricier on input but $0.75 cheaper on output is a
// WORSE deal despite a lower sum. weightedCost prices a model against the owner's actual
// token mix: $/1M blended = in·wIn + out·wOut. usageMixOf derives {wIn,wOut} from usage
// rows; no rows → 0.5/0.5, which reproduces the old sum's ranking exactly (sum = 2×blend).
function usageMixOf(rows) {
  let inTok = 0, outTok = 0;
  for (const r of rows || []) { inTok += +r.input || 0; outTok += +r.output || 0; }
  const t = inTok + outTok;
  if (!t) return { wIn: 0.5, wOut: 0.5, inTok: 0, outTok: 0 };
  return { wIn: inTok / t, wOut: outTok / t, inTok, outTok };
}
function weightedCost(price, mix) {
  if (!price || price.in == null || price.out == null) return null;
  const wIn = mix && mix.wIn != null ? mix.wIn : 0.5, wOut = mix && mix.wOut != null ? mix.wOut : 0.5;
  return price.in * wIn + price.out * wOut;
}

module.exports = { MODEL_PRICES, priceOf, costClass, CREDIT_SPLIT_DAY, GCP_TRIAL_END, SELF_HOST_DEFAULTS, selfHostPerMTok, usageMixOf, weightedCost };
