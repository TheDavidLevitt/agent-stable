// agent-stable · fleet — the tier ladder, worked out from the board instead of set by hand.
//
// A fleet is a set of models one budget can pay for. Each fleet gets the same five-tier ladder,
// best to cheapest:
//
//   secretariat > thoroughbred > steeldust > workhorse > glue
//
// Every tier sits at a point on the fleet's cost/quality Pareto frontier, quality being one
// index (the Artificial Analysis Intelligence Index by default). Nothing here names a model:
//
//   1. Cutoffs.  Each tier's bar is a SHARE of the best score in the fleet (secretariat 97%,
//      thoroughbred 90%, steeldust 80%, workhorse 50%). Shares survive the index being rescaled,
//      and a stronger release at the top lifts every bar with it, so the ladder never anchors
//      on a model that has since been retired.
//   2. Picks.  Bottom up, each tier takes the cheapest frontier model that clears its bar and
//      scores strictly above the tier below. Two tiers can only share a model when the fleet
//      has fewer frontier models than tiers (said in the tier's `note`).
//   3. Glue.  `glue: 'workhorse'` (a subscription with few models) copies the workhorse pick;
//      `glue: 'local'` takes the best local model the host lists (marginal cost ≈ 0), else
//      falls back to the workhorse.
//   4. Hysteresis.  A tier keeps its current model while that model still clears the bar,
//      stays above the tier below, and the new pick would save less than `minSaving` (10%)
//      and gain less than `minGain` (2 points). Score jitter between two near-equal models
//      therefore never flips a tier back and forth between compiles.
//
// Module → tier assignment (assignModules) is separate: each module has a declared tier and
// moves one step up when its own record shows it is failing at that tier (escalations or
// failures), and is proposed one step down when a long clean record suggests it is overpaying.
//
// Pure module: no I/O, no globals. The host passes board rows ({model, lab, priceIn, priceOut,
// benchmarks}), a `fundable(row)` predicate for the fleet, and optional incumbents.

const { canonical, sameModel } = require('./board');
const { weightedCost } = require('./pricing');

const LADDER = ['glue', 'workhorse', 'steeldust', 'thoroughbred', 'secretariat']; // cheapest → best
const DEFAULT_SHARES = { workhorse: 0.50, steeldust: 0.80, thoroughbred: 0.90, secretariat: 0.97 };
const DEFAULT_INDEX = 'AA Intelligence';

const normBench = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').trim();
const sameBench = (a, b) => { const x = normBench(a), y = normBench(b); return !!x && !!y && (x.startsWith(y) || y.startsWith(x)); };
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;

function scoreOf(row, index) {
  const b = Object.entries((row && row.benchmarks) || {}).find(([k, v]) => v != null && v !== '' && !isNaN(+v) && sameBench(k, index));
  return b ? +b[1] : null;
}

// One point per model family (its best-scoring variant, cheaper on ties), fundable only.
function familyPoints(rows, { index = DEFAULT_INDEX, fundable = null, mix = null } = {}) {
  const byBase = new Map();
  for (const m of rows || []) {
    if (!m || !m.model || (fundable && !fundable(m))) continue;
    const score = scoreOf(m, index); if (score == null) continue;
    const cost = weightedCost({ in: m.priceIn != null && m.priceIn !== '' ? +m.priceIn : null, out: m.priceOut != null && m.priceOut !== '' ? +m.priceOut : null }, mix);
    if (cost == null || isNaN(cost)) continue;
    const { base, variant } = canonical(m.model);
    const q = byBase.get(base);
    if (!q || score > q.score || (score === q.score && cost < q.cost)) byBase.set(base, { model: String(m.model), base, variant, lab: m.lab || '', score, cost, priceIn: +m.priceIn, priceOut: +m.priceOut });
  }
  return [...byBase.values()];
}

// The efficient set: cost ascending AND score strictly ascending.
function frontier(rows, opts = {}) {
  const pts = familyPoints(rows, opts).sort((a, b) => (a.cost - b.cost) || (b.score - a.score));
  const out = []; let best = -Infinity;
  for (const p of pts) if (p.score > best) { out.push(p); best = p.score; }
  return out;
}

// → { top, frontier, cutoffs: {tier: {min, share, top, why}}, tiers: {tier: {model, base, score, cost, …, why, note?, kept?}} }
function deriveLadder(rows, {
  index = DEFAULT_INDEX, fundable = null, mix = null, shares = DEFAULT_SHARES,
  glue = 'workhorse', localModels = [], incumbents = {}, minSaving = 0.10, minGain = 2, fleet = '',
} = {}) {
  const sh = { ...DEFAULT_SHARES, ...(shares || {}) };
  const front = frontier(rows, { index, fundable, mix });
  const all = familyPoints(rows, { index, fundable, mix });
  const out = { fleet, index, top: null, frontier: front, cutoffs: {}, tiers: {} };
  if (!front.length) { out.note = 'no fundable model with a score and a price is on the board'; return out; }
  const top = front[front.length - 1];
  out.top = { model: top.model, score: top.score };
  let below = null;
  for (const k of LADDER.slice(1)) {
    const min = r1(sh[k] * top.score);
    out.cutoffs[k] = { min, share: sh[k], top: top.score, topModel: top.model, why: `${Math.round(sh[k] * 100)}% of the best ${fleet ? fleet + ' ' : ''}score (${top.model}, ${top.score} on ${index})` };
    const floor = below ? below.score : -Infinity;
    let pick = front.find(p => p.score >= min && p.score > floor);
    let note = null;
    if (!pick) {
      pick = front.find(p => p.score > floor) || top;
      note = pick.score < min
        ? `no ${fleet || 'fundable'} model reaches ${min}; took the strongest above ${below ? below.tier : 'nothing'}`
        : null;
      if (below && sameModel(pick.model, below.model)) note = `shares ${below.model} with ${below.tier}: the ${fleet || 'fleet'} frontier has only ${front.length} models`;
    }
    let res = { ...pick, tier: k, why: `cheapest ${fleet ? fleet + ' ' : ''}model scoring ≥ ${min} on ${index}${below ? ` and above ${below.tier}` : ''}: ${pick.model} (${pick.score}, ~$${r2(pick.cost)}/1M blended)` };
    if (note) res.note = note;
    // hysteresis: keep the incumbent unless the new pick is clearly better or cheaper
    const incId = incumbents[k];
    if (incId && !sameModel(incId, pick.model)) {
      const inc = all.find(p => sameModel(p.model, incId));
      const ok = inc && inc.score >= min && inc.score > floor && !(below && sameModel(inc.model, below.model));
      if (ok && pick.cost > inc.cost * (1 - minSaving) && pick.score - inc.score < minGain) {
        res = { ...inc, tier: k, kept: true, why: `kept ${inc.model} (${inc.score}, ~$${r2(inc.cost)}/1M): it clears ${min}, and ${pick.model} would save under ${Math.round(minSaving * 100)}% and gain under ${minGain} points` };
      }
    }
    out.tiers[k] = res;
    below = res;
  }
  // glue: local model (off-subscription) or the workhorse (subscription)
  const wh = out.tiers.workhorse;
  if (glue === 'local') {
    const loc = (localModels || []).filter(l => l && l.id).sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
    out.tiers.glue = loc
      ? { model: loc.id, base: canonical(loc.id).base, score: loc.score ?? null, cost: loc.cost ?? 0, local: true, tier: 'glue', why: `local model ${loc.name || loc.id}${loc.score != null ? ` (${loc.score} on ${index})` : ''}: runs on the owner's machine, no API spend` }
      : { ...wh, tier: 'glue', note: 'no local model is listed, so glue runs the workhorse model', why: wh.why };
  } else {
    out.tiers.glue = { ...wh, tier: 'glue', why: `${fleet || 'this'} fleet has few models, so glue runs the workhorse model (${wh.model})` };
  }
  return out;
}

// ---- module → tier ----
// declared: { module: tier } (the single source of truth the host keeps)
// signals:  { module: { runs, escalations, failures } } over the host's window
// → { module: { tier, from, change: 'up'|'down-proposed'|null, why } }
// Up is automatic (a failing module is worse than a dearer one) but capped at `autoUpTo`;
// above that, and every step down, is a proposal for the owner.
function assignModules(declared, signals = {}, { minRuns = 10, upRate = 0.2, downRuns = 60, autoUpTo = 'steeldust' } = {}) {
  const out = {};
  const cap = LADDER.indexOf(autoUpTo);
  for (const [mod, tier] of Object.entries(declared || {})) {
    const i = LADDER.indexOf(tier);
    const s = signals[mod] || {};
    const runs = +s.runs || 0, bad = (+s.escalations || 0) + (+s.failures || 0);
    const res = { tier, from: tier, change: null, why: '' };
    if (i >= 0 && runs >= minRuns && bad / runs >= upRate && i < LADDER.length - 1) {
      const up = LADDER[i + 1];
      const why = `${bad} of ${runs} runs escalated or failed (${Math.round(bad / runs * 100)}% ≥ ${Math.round(upRate * 100)}%)`;
      if (i + 1 <= cap) Object.assign(res, { tier: up, change: 'up', why });
      else Object.assign(res, { change: 'up-proposed', proposed: up, why: `${why}; moves above ${autoUpTo} need the owner` });
    } else if (i > 1 && runs >= downRuns && bad === 0) {
      Object.assign(res, { change: 'down-proposed', proposed: LADDER[i - 1], why: `${runs} runs, none escalated or failed: worth a trial one tier down` });
    }
    out[mod] = res;
  }
  return out;
}

module.exports = { LADDER, DEFAULT_SHARES, DEFAULT_INDEX, frontier, familyPoints, deriveLadder, assignModules, scoreOf };
