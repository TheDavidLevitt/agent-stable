// agent-stable · board — benchmark-board logic over EXTERNALLY SOURCED rows.
// v0.4.0: the LLM web-search compile is gone. Benchmark data comes from a real source the
// host injects (the reference deployment uses Artificial Analysis' API) — deterministic,
// fresh, and no scraping machinery to maintain. The board keeps the judgment layers a data
// vendor can't provide: YOUR tier thresholds, role assignment, and fuzzy benchmark matching.
// v0.8.0: slug FAMILIES (canonical/sameModel) so effort variants and token order stop
// splitting one model into many; fromRows honours cutoff hypotheses; recommend().
//
//   canonical(slug)                                       // → { base, variant } family key + effort/mode variant
//   sameModel(a, b)                                       // → same family (equal base) across sources
//   const board = createBoard({ roles });                 // roles = apa-roles config object
//   const rows = board.fromRows(sourceRows, cutoffs);     // normalize + assign tiers (user min ?? hypothesis)
//   board.thresholdFor(roleKey, cutoffs)                  // → user min ?? hypothesis
//   board.sameBench(a, b)                                 // fuzzy benchmark-name equality
//   const bp = board.benchPrompt();                       // → knowledge-base prompt (optional)
//   const kb = board.parseBench(rawLlmText);              // → [{name, measures, ...}]
//   board.winnerOnBoard(rows, roleKey)                    // → {winner, present, score, variant, model} | null
//   board.paretoFrontier(rows, roleKey, { mix, fundable, includeWinner, oneVariantPerBase })
//   board.bestReplacement(rows, roleKey, {minScore, maxCost, …})  // relaxed delisted-gate search
//   board.recommend(rows, roleKey, { cutoffs, mix, fundable, valueBar })  // → what the role SHOULD run + why

// model-name equality across sources ("grok-4.3" vs AA's "grok-4-3"): case, dots, spaces → dashes
const normModel = s => String(s || '').toLowerCase().replace(/[\s.]+/g, '-').replace(/-+/g, '-');

// ---- slug families ----
// Sources disagree on ids in two ways. Reasoning-effort / mode VARIANTS ride as suffixes
// ("claude-opus-5-xhigh", "gpt-6-astra-non-reasoning", "claude-3-7-sonnet-thinking"), and token
// ORDER differs ("claude-4-5-haiku" on a benchmark board vs the API id "claude-haiku-4-5").
// canonical() strips ONE trailing variant token (longest match first, so 'non-reasoning' beats
// 'reasoning') and reduces the rest to an order-free family key: alphabetic tokens sorted,
// numeric tokens kept in sequence, words then digits. Two slugs name the same model iff their
// bases match; the variant says which effort/mode the row measured.
const VARIANT_ALIASES = { 'non-reasoning-low-effort': 'low' };
const VARIANTS = ['xhigh', 'high', 'medium', 'low', 'minimal', 'thinking', 'non-reasoning', 'reasoning', 'adaptive',
  'non-reasoning-low-effort', 'fast', 'instant', 'preview', 'exp', 'beta'].sort((a, b) => b.length - a.length);
function canonical(slug) {
  let s = normModel(slug).replace(/^-+|-+$/g, ''), variant = 'default';
  for (const v of VARIANTS) { // a bare variant word is a name, not a suffix — only strip when something remains
    if (s === v) break; // ('non-reasoning' alone must not fall through to the shorter '-reasoning')
    if (s.endsWith('-' + v)) { s = s.slice(0, -(v.length + 1)); variant = VARIANT_ALIASES[v] || v; break; }
  }
  const words = [], digits = [];
  for (const t of s.split('-')) if (t) (/^\d+$/.test(t) ? digits : words).push(t);
  return { base: [...words.sort(), ...digits].join('-'), variant };
}
const sameModel = (a, b) => { const x = canonical(a).base; return !!x && x === canonical(b).base; };

function createBoard({ roles = { roles: {}, all_benchmarks: [], track_non_us_os: 3 }, prices = {}, labs = {} } = {}) {
  const benchAll = () => [...new Set([...(roles.all_benchmarks || []), ...Object.values(roles.roles || {}).flatMap(r => r.benchmarks || [])])];
  const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').trim();
  const sameBench = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.startsWith(y) || y.startsWith(x)); };
  // a row's numeric score on a role's primary benchmark (fuzzy name), or null
  const primaryScore = (m, primary) => {
    const b = Object.entries(m.benchmarks || {}).find(([k, v]) => v != null && !isNaN(+v) && sameBench(k, primary));
    return b ? +b[1] : null;
  };

  // Normalize source rows ([{model, lab, os, priceIn, priceOut, benchmarks:{name:score}, …}])
  // and assign each model the HIGHEST configured tier whose EFFECTIVE threshold (user-set min,
  // else the compiler's cutoff hypothesis — thresholdFor) it clears on that tier's primary
  // benchmark ('' when it clears none or the tier has no threshold yet). Rows carry their
  // family key + variant and pass the source's extra columns through untouched.
  function fromRows(rows, cutoffs = {}) {
    const tiers = Object.entries(roles.roles || {});
    return (Array.isArray(rows) ? rows : []).filter(r => r && r.model).map(r => {
      let role = '', roleMin = -Infinity; // highest cleared bar wins, not iteration order —
      for (const [key, rc] of tiers) {    // else a low-bar tier added later claims every model
        const min = rc && rc.primary ? thresholdFor(key, cutoffs) : null;
        if (min == null) continue;
        const hit = Object.entries(r.benchmarks || {}).find(([b]) => sameBench(b, rc.primary));
        if (hit && +hit[1] >= +min && +min > roleMin) { role = key; roleMin = +min; }
      }
      const { base, variant } = canonical(r.model);
      return { model: String(r.model), base, variant, lab: r.lab || '', country: r.country || '', os: !!r.os,
        role, priceIn: r.priceIn ?? null, priceOut: r.priceOut ?? null, cacheIn: r.cacheIn ?? null,
        speed: r.speed ?? null, ttft: r.ttft ?? null, releaseDate: r.releaseDate ?? '', benchmarks: r.benchmarks || {} };
    });
  }

  function benchPrompt() {
    return `You maintain a benchmark knowledge base for a multi-model agent system. For EACH benchmark below, produce current, accurate entries (use web search to verify leaders/scores — real figures only, never fabricate):\n` +
      `BENCHMARKS: ${benchAll().join(', ')}\n` +
      `Fields per benchmark: measures (one dense line: what skill it actually tests and its failure modes), goodFor (which agent use cases it PREDICTS well: thoroughbred-reasoning / steeldust-daily / workhorse-mechanical / coding / agentic — and which it misleads on), cutoffs (suggested minimum scores for common tasks with the score scale), leader (current top model + score), notes (saturation status, gaming concerns, update cadence).\n` +
      `Return STRICT JSON only: {"benchmarks":[{"name","measures","goodFor","cutoffs","leader","notes"}]}`;
  }

  function parseBench(raw) {
    const block = (String(raw).replace(/```json?/gi, '').replace(/```/g, '').match(/\{[\s\S]*\}/) || [])[0];
    let items = []; try { items = JSON.parse(block).benchmarks || []; } catch (e) {}
    return items.filter(b => b && b.name);
  }

  // effective threshold: user-set min wins over the compiler's hypothesis
  function thresholdFor(roleKey, cutoffs = {}) {
    const rc = (roles.roles || {})[roleKey] || {};
    return rc.min ?? (cutoffs[roleKey] || {}).min ?? null;
  }

  // ---- delisted winners ----
  // A role winner absent from the source board has no live price or score, so a strict
  // "equal-or-better AND cheaper" gate can never replace it — the winner freezes forever.
  // The JUDGMENT for that case lives here: presence detection and the relaxed replacement
  // search (equal-or-better on the role's primary benchmark, at comparable-or-better price
  // vs the winner's last-known price — both bars supplied by the host, which keeps that
  // history). The host owns miss-counting, state, and proposal I/O — and never auto-swaps.
  // Presence is FAMILY-aware: any variant of the winner's base counts, and the score is the
  // best primary score among those variants (model/variant say which row carried it).
  function winnerOnBoard(rows, roleKey) {
    const rc = (roles.roles || {})[roleKey] || {};
    if (!rc.winner) return null;
    let best = null;
    for (const m of rows || []) {
      if (!m || !m.model || !sameModel(m.model, rc.winner)) continue;
      const score = primaryScore(m, rc.primary);
      if (!best || (score != null && (best.score == null || score > best.score))) best = { model: String(m.model), variant: canonical(m.model).variant, score };
    }
    if (!best) return { winner: rc.winner, present: false, score: null, variant: null, model: null };
    return { winner: rc.winner, present: true, score: best.score, variant: best.variant, model: best.model };
  }

  // Cost is USAGE-WEIGHTED (owner's {wIn,wOut} token mix; absent → 0.5/0.5 flat blend). The
  // search is a PARETO VALUE WALK, not a bare cheapest-adequate pick: a hard min-score bar is
  // somewhat arbitrary, and what the owner actually wants is the (cost, score) frontier and
  // the cheap jumps along it. Entry = cheapest frontier model clearing the bar; then upgrade
  // to any later frontier point while the jump is steep, measured in POINTS PER COST-DOUBLING
  // (Δscore / log2(costRatio) — the natural slope on a log-price axis). So +14 points for
  // 1.5× the price (+24 pts/dbl) is taken, +3 points for 14× (+0.8) is not — and the exact
  // placement of the min bar stops deciding the outcome. valueBar tunes greed (default 8
  // pts/dbl; Infinity ⇒ pure cheapest-adequate). maxCost still caps everything: arbitrage
  // never exceeds the incumbent's budget.
  const { weightedCost } = require('./pricing');
  const effCost = c => Math.max(0.01, c); // log math floor — free models plot/compare at 1¢
  const ptsPerDoubling = (a, b) => b.cost <= a.cost ? Infinity : (b.score - a.score) / Math.log2(effCost(b.cost) / effCost(a.cost));
  // fundable: optional host predicate (row → bool) — e.g. "has a key / credit pool for this lab".
  // includeWinner: keep the winner's family in (recommend needs it; replacement searches don't).
  // oneVariantPerBase: a family competes as its best-scoring variant (cheaper on ties), so
  // xhigh/high/low rows of one model never crowd the frontier as if they were three models.
  function paretoFrontier(rows, roleKey, { mix = null, fundable = null, includeWinner = false, oneVariantPerBase = true } = {}) {
    const rc = (roles.roles || {})[roleKey] || {};
    if (!rc.primary) return [];
    const pts = [];
    for (const m of rows || []) {
      if (!m || !m.model) continue;
      if (!includeWinner && rc.winner && sameModel(m.model, rc.winner)) continue;
      if (fundable && !fundable(m)) continue;
      const score = primaryScore(m, rc.primary);
      if (score == null) continue;
      const cost = weightedCost({ in: m.priceIn != null ? +m.priceIn : null, out: m.priceOut != null ? +m.priceOut : null }, mix);
      if (cost == null) continue;
      const { base, variant } = canonical(m.model);
      pts.push({ model: m.model, base, variant, lab: m.lab || '', score, priceIn: m.priceIn ?? null, priceOut: m.priceOut ?? null, cost });
    }
    let cands = pts;
    if (oneVariantPerBase) {
      const byBase = new Map();
      for (const p of pts) { const q = byBase.get(p.base); if (!q || p.score > q.score || (p.score === q.score && p.cost < q.cost)) byBase.set(p.base, p); }
      cands = [...byBase.values()];
    }
    cands.sort((a, b) => (a.cost - b.cost) || (b.score - a.score));
    const front = []; let best = -Infinity;
    for (const p of cands) if (p.score > best) { front.push(p); best = p.score; }
    return front; // cost-ascending AND score-ascending: the efficient set
  }
  // the value walk from frontier index i — jumps may skip weak intermediate points to reach a steep one
  function valueWalk(front, i, valueBar) {
    for (;;) {
      let bestJ = -1, bestV = valueBar;
      for (let j = i + 1; j < front.length; j++) {
        const v = ptsPerDoubling(front[i], front[j]);
        if (v >= bestV) { bestV = v; bestJ = j; }
      }
      if (bestJ < 0) return i;
      i = bestJ;
    }
  }
  function bestReplacement(rows, roleKey, { minScore = null, maxCost = null, mix = null, valueBar = 8, fundable = null, includeWinner = false, oneVariantPerBase = true } = {}) {
    const front = paretoFrontier(rows, roleKey, { mix, fundable, includeWinner, oneVariantPerBase }).filter(p => maxCost == null || p.cost <= maxCost);
    const i = front.findIndex(p => minScore == null || p.score >= +minScore);
    if (i < 0) return null;
    return { ...front[valueWalk(front, i, valueBar)] };
  }

  // ---- recommend: what this role SHOULD run ----
  // Same frontier + value walk, but framed as a standing recommendation rather than a
  // replacement search: the winner's family stays IN (so "keep what you have" is a possible
  // answer), the floor is the role's effective threshold (user min ?? hypothesis), and with no
  // floor at all the winner's live score becomes the bar — never downgrade. Returns null when
  // no fundable model clears the bar (or nothing defines one). `why` is one line the host can
  // show verbatim: the floor, the price, and the next frontier step it declined.
  function recommend(rows, roleKey, { cutoffs = {}, mix = null, fundable = null, valueBar = 8 } = {}) {
    const rc = (roles.roles || {})[roleKey] || {};
    if (!rc.primary) return null;
    let floor = thresholdFor(roleKey, cutoffs), floorSrc = '';
    if (floor == null) {
      const w = winnerOnBoard(rows, roleKey);
      if (!w || w.score == null) return null;
      floor = w.score; floorSrc = ` (no min set — ${w.model}'s live score)`;
    }
    const front = paretoFrontier(rows, roleKey, { mix, fundable, includeWinner: true, oneVariantPerBase: true });
    const e = front.findIndex(p => p.score >= +floor);
    if (e < 0) return null;
    const i = valueWalk(front, e, valueBar);
    const entry = front[e], pick = front[i], next = front[i + 1];
    const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
    const ratio = (a, b) => r1(effCost(b.cost) / effCost(a.cost));
    const price = p => `$${p.priceIn}/$${p.priceOut} blended $${r2(p.cost)}`;
    const isW = rc.winner && sameModel(pick.model, rc.winner) ? ' (current winner)' : '';
    let why = `cheapest ${fundable ? 'fundable ' : ''}model ≥ ${floor} on ${rc.primary}${floorSrc}`;
    why += i === e
      ? ` at ${price(pick)}${isW}`
      : ` is ${entry.model} (blended $${r2(entry.cost)}); stepped up to ${pick.model}${isW} at ${price(pick)}: +${r1(pick.score - entry.score)} pts for ${ratio(entry, pick)}× cost (${r1(ptsPerDoubling(entry, pick))} pts/doubling ≥ ${valueBar})`;
    why += next
      ? `; next step +${r1(next.score - pick.score)} pts for ${ratio(pick, next)}× cost not worth it`
      : `; top of the frontier`;
    return { model: pick.model, base: pick.base, variant: pick.variant, lab: pick.lab, score: pick.score, cost: pick.cost, priceIn: pick.priceIn, priceOut: pick.priceOut, why };
  }

  return { fromRows, thresholdFor, sameBench, benchPrompt, parseBench, winnerOnBoard, bestReplacement, paretoFrontier, ptsPerDoubling, recommend, canonical, sameModel };
}

module.exports = { createBoard, normModel, canonical, sameModel };
