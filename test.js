// agent-stable tests — plain-Node asserts, no framework, no network.  node test.js
const assert = require('assert');
const { createMeter, createAdapters, createApa, DEFAULT_EVAL_PROMPTS, createBoard, createTiers, pricing, sinks } = require('./index');

(async () => {
  assert(require('./index').VERSION === require('./package.json').version, 'VERSION export matches package.json');

  // pricing
  assert(pricing.priceOf('claude-sonnet-5').out === 10, 'priceOf');
  assert(pricing.priceOf('claude-opus-5-20260401').in === 5, 'priceOf strips a snapshot suffix');
  assert(pricing.priceOf('claude-sonnet-5-1').in === 2, 'an unlisted point release falls back to its family row');
  assert(pricing.priceOf('openrouter:claude-opus-5').in === 5 && pricing.priceOf('anthropic/claude-haiku-4-5').in === 1, 'routed ids are priced');
  assert(pricing.priceOf('nope-1') === null && pricing.priceOf('') === null, 'unknown ids → null');
  // order-independence: the old `find(includes)` scan returned the FIRST contained key, so with
  // the shorter family key listed first the newer model got the older model's price.
  const famFirst = { 'claude-fable-5': { in: 10 }, 'claude-fable-5-1': { in: 7 } };
  const famLast = { 'claude-fable-5-1': { in: 7 }, 'claude-fable-5': { in: 10 } };
  for (const t of [famFirst, famLast]) {
    assert(pricing.priceFrom(t, 'claude-fable-5-1').in === 7, 'exact id wins over a shorter contained key');
    assert(pricing.priceFrom(t, 'claude-fable-5-1-20260901').in === 7, 'snapshot suffix dropped, then exact');
    assert(pricing.priceFrom(t, 'openrouter:claude-fable-5-1').in === 7, 'routing prefix dropped, then exact');
    assert(pricing.priceFrom(t, 'us.anthropic.claude-fable-5-1-v1:0').in === 7, 'longest contained key wins');
    assert(pricing.priceFrom(t, 'claude-fable-5-thinking').in === 10, 'variant suffix falls back to the family row');
    assert(pricing.priceFrom(t, 'claude-fable-50') === null, 'no match across a token boundary');
  }
  assert(pricing.costClass('glm-5-3-flash', 'nightly') === 'real', 'unknown ids are paid APIs, not subscription');
  assert(pricing.costClass('claude-haiku-4-5', 'claw:main') === 'real', 'claw sub-modules are metered');
  assert(pricing.costClass('gemini-2.5-flash', 'summary', '2026-08-01T00:00:00Z') === 'real', 'vertex after the trial is real money');
  assert(pricing.costClass('grok-4', 'x') === 'real', 'grok is out-of-pocket');
  assert(pricing.costClass('anthropic/claude-sonnet-5') === 'real', 'marketplace-routed claude is out-of-pocket');
  assert(pricing.costClass('openrouter:claude-opus-5') === 'real', 'openrouter-prefixed is out-of-pocket');
  assert(pricing.selfHostPerMTok({ kwhPrice: 0.15, watts: 700, tokPerSec: 40 }) === 0.73, 'self-host estimate');

  // meter + memory sink: cost fill-in + funding class + query
  const mem = sinks.memorySink();
  const meter = createMeter({ sink: mem, pricing, host: 't' });
  await meter.usage({ module: 'm', model: 'claude-sonnet-5', input: 1e6, output: 1e5 });
  assert(mem.events[0].costUsd === 3, 'cost computed'); // 1M in @ $2 + 100k out @ $10
  assert(['credit', 'included'].includes(mem.events[0].fundingClass), 'funding class stamped');
  await meter.decision({ module: 'm', actor: 'apa', decision: 'd' });
  assert(mem.query({ type: 'decision' }).length === 1, 'query');

  // sheet sink row shapes (mock client)
  const calls = [];
  const sheet = sinks.sheetSink({ sheets: { spreadsheets: { values: { append: async o => calls.push(o) } } }, spreadsheetId: 'S' });
  const m2 = createMeter({ sink: sheet, pricing, host: 'h', now: () => new Date('2026-01-01T00:00:00Z') });
  await m2.usage({ module: 'mod', model: 'claude-haiku-4-5', input: 5, output: 6, note: 'n' });
  assert.deepStrictEqual(calls[0].requestBody.values[0], ['2026-01-01T00:00:00.000Z', 'h', 'mod', 'claude-haiku-4-5', 5, 6, 0.000035, 'n'], 'usage row shape');
  // unknown numbers: events carry null (one type per field), sheet rows keep the blank cell they always had
  await m2.usage({ module: 'mod', model: 'unpriced-model', note: 'n' });
  await m2.usage({ module: 'mod', model: 'unpriced-model', input: 0, output: 0, costUsd: '', note: 'legacy blank' });
  await m2.decision({ module: 'mod', actor: 'apa', decision: 'd' });
  assert.deepStrictEqual(calls[1].requestBody.values[0], ['2026-01-01T00:00:00.000Z', 'h', 'mod', 'unpriced-model', '', '', '', 'n'], 'unknown numbers render as blank cells');
  assert.deepStrictEqual(calls[2].requestBody.values[0], ['2026-01-01T00:00:00.000Z', 'h', 'mod', 'unpriced-model', 0, 0, '', 'legacy blank'], 'zero stays zero; legacy costUsd "" still blank');
  assert.deepStrictEqual(calls[3].requestBody.values[0], ['2026-01-01T00:00:00.000Z', 'h', 'mod', 'apa', 'd', '', '', '', ''], 'decision row shape');
  const mem2 = sinks.memorySink();
  const m3 = createMeter({ sink: mem2, pricing });
  await m3.usage({ module: 'mod', model: 'unpriced-model', costUsd: '' });
  await m3.decision({ module: 'mod' });
  const [u0, d0] = mem2.events;
  assert(u0.input === null && u0.output === null && u0.costUsd === null && u0.latencyMs === null, 'usage: unknown numbers are null, not ""');
  assert(d0.costUsd === null, 'decision: unknown costUsd is null');

  // adapters: openai-compat protocol via mock fetch; keyless local; unconfigured throws
  const seen = [];
  const mockFetch = async (url, opts) => { seen.push({ url, auth: opts.headers.Authorization }); return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 2 }, model: 'x' }) }; };
  const ad = createAdapters({ openrouter: { apiKey: 'k' }, ollama: {} }, { fetchImpl: mockFetch });
  const r1 = await ad.call({ provider: 'openrouter', model: 'm', prompt: 'p' });
  assert(r1.text === 'hi' && r1.usage.output === 2 && seen[0].auth === 'Bearer k', 'openai-compat');
  await ad.call({ provider: 'ollama', model: 'm', prompt: 'p' });
  assert(!seen[1].auth && seen[1].url.includes('localhost:11434'), 'keyless local');
  await assert.rejects(() => ad.call({ provider: 'together', model: 'm', prompt: 'p' }), /no adapter/, 'unconfigured throws');

  // apa engine: verdict, gate on/off, savings math, probe-guard
  // a fake judge that says "candidate ≥ incumbent" in whichever position the prompt asks about
  const agreeJudge = async p => /"b_better_or_equal"/.test(p) ? '{"b_better_or_equal": true, "note": "ok"}' : '{"a_better_or_equal": true, "note": "ok"}';
  const apa = createApa({
    adapters: { call: async ({ model }) => ({ text: 'answer from ' + model, usage: {} }) },
    priceOf: m => m === 'cand' ? { in: 1, out: 5 } : { in: 3, out: 15 },
    judge: agreeJudge,
    usageHistory: async () => [{ at: new Date().toISOString(), module: 's', input: 1e6, output: 1e5 }],
  });
  const ev = await apa.evaluate({ id: 'cand', provider: 'x' }, { id: 'inc', provider: 'x' });
  assert(ev.qualityOK && ev.cheaper, 'verdict');
  assert(apa.adoptGate(ev, { autoAdopt: true }).adopt === true, 'gate on');
  assert(apa.adoptGate(ev, { autoAdopt: false }).adopt === false, 'gate off');
  assert(apa.adoptGate(null).adopt === false, 'unrunnable never adopts');
  assert(await apa.projectSavings('s', 'inc', 'cand') === 3, 'savings math');

  // apa eval defaults: ≥10 prompts, 2 judge passes with the candidate's position alternated
  assert(DEFAULT_EVAL_PROMPTS.length >= 10, 'default suite has at least 10 prompts');
  const seenPrompts = [], calls2 = [];
  const fakeAd = { call: async ({ model, prompt }) => { calls2.push(model); return { text: 'out-' + model + '-' + prompt.length, usage: {} }; } };
  const apaP = createApa({ adapters: fakeAd, priceOf: () => ({ in: 1, out: 1 }), judge: async p => { seenPrompts.push(p); return agreeJudge(p); } });
  const evP = await apaP.evaluate({ id: 'cand', provider: 'x' }, { id: 'inc', provider: 'x' });
  assert(calls2.length === 2 * DEFAULT_EVAL_PROMPTS.length, 'every default prompt runs on both models');
  assert(seenPrompts.length === 2, 'a single judge runs two passes by default');
  assert(/A: out-cand/.test(seenPrompts[0]) && /"a_better_or_equal"/.test(seenPrompts[0]), 'pass 1: candidate shown as A');
  assert(/A: out-inc/.test(seenPrompts[1]) && /B: out-cand/.test(seenPrompts[1]) && /"b_better_or_equal"/.test(seenPrompts[1]), 'pass 2: candidate shown as B');
  assert(evP.qualityOK && evP.quality === 1 && evP.votes.length === 2, 'consistent judge → quality 1');
  // a position-biased judge (always prefers whichever answer is labelled A) used to decide alone
  const biased = async p => /"b_better_or_equal"/.test(p) ? '{"b_better_or_equal": false}' : '{"a_better_or_equal": true}';
  const evB = await createApa({ adapters: fakeAd, priceOf: () => ({ in: 1, out: 1 }), judge: biased }).evaluate({ id: 'c', provider: 'x' }, { id: 'i', provider: 'x' });
  assert(evB.quality === 0.5 && !evB.qualityOK, 'position-biased judge cannot carry the verdict');
  assert((await createApa({ adapters: fakeAd, priceOf: () => ({ in: 1, out: 1 }), judge: biased, judgePasses: 1 }).evaluate({ id: 'c', provider: 'x' }, { id: 'i', provider: 'x' })).qualityOK, 'judgePasses: 1 restores the single-pass behaviour');
  // a panel of distinct judges: strict majority; a throwing or garbled judge votes no
  const panelEval = js => createApa({ adapters: fakeAd, priceOf: () => ({ in: 1, out: 1 }), judges: js }).evaluate({ id: 'c', provider: 'x' }, { id: 'i', provider: 'x' });
  assert((await panelEval([agreeJudge, agreeJudge])).qualityOK, 'panel: both agree → ok');
  assert(!(await panelEval([agreeJudge, async () => { throw new Error('down'); }])).qualityOK, 'panel: a failing judge is a no vote');
  assert(!(await panelEval([agreeJudge, async () => 'not json'])).qualityOK, 'panel: unparseable verdict is a no vote');
  const ev3of = await panelEval([agreeJudge, agreeJudge, async () => '{}']);
  assert(ev3of.qualityOK && Math.abs(ev3of.quality - 2 / 3) < 1e-9, 'panel: 2 of 3 is a strict majority');
  assert.throws(() => createApa({ adapters: fakeAd, priceOf: () => null }), /judge/, 'a judge is required');

  // considerFinding: the Store/Notify boundary — all four outcomes via injected hooks
  const ev2 = { info: [], propose: [], adopt: [] };
  const ctx = {
    store: { recordPrice: () => {}, incumbent: () => 'inc', adopt: (m, id) => ev2.adopt.push(m + ':' + id) },
    notify: { info: l => ev2.info.push(l), propose: l => ev2.propose.push(l) },
    log: () => {}, usLabs: ['LabX'], crossProvider: true, autoAdopt: true,
    resolveId: m => m, providerFor: () => 'p', sameFamily: () => false,
  };
  const apa2 = createApa({
    adapters: { call: async ({ model }) => ({ text: 'a ' + model, usage: {} }) },
    priceOf: m => m === 'cand2' ? { in: 1, out: 5 } : { in: 3, out: 15 },
    judge: agreeJudge,
    usageHistory: async () => [],
  });
  assert(await apa2.considerFinding({ kind: 'price', lab: 'Other', model: 'x', headline: 'h', url: 'u' }, ctx) === 'arbitrage', 'proposal path');
  assert(await apa2.considerFinding({ kind: 'release', lab: 'LabX', model: 'cand2', headline: 'h', url: 'u' }, ctx) === 'adopted', 'adopt path');
  assert(ev2.adopt[0] === 'summary:cand2', 'adopt via store hook');
  assert(await apa2.considerFinding({ kind: 'release', lab: 'LabX', model: 'cand2', headline: 'h', url: 'u' }, { ...ctx, autoAdopt: false }) === 'tested', 'autoAdopt off');
  assert(await apa2.considerFinding({ kind: 'release', lab: 'LabX', model: 'cand2', headline: 'h', url: 'u' }, { ...ctx, crossProvider: false }) === 'test-recommend', 'crossProvider off');

  // board: fromRows normalization + tier assignment, threshold precedence, fuzzy bench names
  const bd = createBoard({ roles: { roles: { steeldust: { primary: 'AA Intelligence', min: 40 } }, all_benchmarks: ['AA Intelligence'], track_non_us_os: 2 }, prices: {}, labs: { us_labs: ['L'], hosting: ['H'] } });
  const rows = bd.fromRows([
    { model: 'm-good', lab: 'L', benchmarks: { 'AA Intelligence (index)': 55 }, priceIn: 1, priceOut: 5 },
    { model: 'm-weak', lab: 'L', benchmarks: { 'AA Intelligence': 12 } },
  ]);
  assert(rows.length === 2 && rows[0].role === 'steeldust' && rows[1].role === '', 'fromRows assigns tiers by threshold');
  assert(bd.thresholdFor('steeldust', {}) === 40, 'user threshold wins');
  assert(bd.sameBench('AA Intelligence (Artificial Analysis)', 'AA Intelligence'), 'fuzzy bench');
  // role assignment: the HIGHEST cleared bar wins regardless of declaration order. The old
  // loop let the last-declared cleared tier win, so a low-bar tier listed after a high-bar one
  // claimed every model that cleared both.
  const tierRow = [{ model: 'm-strong', benchmarks: { 'AA Intelligence': 70 } }, { model: 'm-mid', benchmarks: { 'AA Intelligence': 45 } }];
  const hiFirst = createBoard({ roles: { roles: { thoroughbred: { primary: 'AA Intelligence', min: 60 }, workhorse: { primary: 'AA Intelligence', min: 30 } } } });
  const loFirst = createBoard({ roles: { roles: { workhorse: { primary: 'AA Intelligence', min: 30 }, thoroughbred: { primary: 'AA Intelligence', min: 60 } } } });
  assert.deepStrictEqual(hiFirst.fromRows(tierRow).map(r => r.role), ['thoroughbred', 'workhorse'], 'highest cleared bar wins (high-bar tier declared first)');
  assert.deepStrictEqual(loFirst.fromRows(tierRow).map(r => r.role), ['thoroughbred', 'workhorse'], 'highest cleared bar wins (low-bar tier declared first)');

  // delisted winners: presence detection (name-normalized) + relaxed replacement search
  const bd2 = createBoard({ roles: { roles: { t: { primary: 'AA Intelligence', min: 50, winner: 'old-star.1' } } } });
  const board2 = [
    { model: 'new-good', lab: 'L', benchmarks: { 'AA Intelligence': 60 }, priceIn: 2, priceOut: 10 },
    { model: 'new-smarter-pricier', lab: 'L', benchmarks: { 'AA Intelligence': 70 }, priceIn: 9, priceOut: 40 },
    { model: 'new-weak', lab: 'L', benchmarks: { 'AA Intelligence': 30 }, priceIn: 0.1, priceOut: 0.5 },
  ];
  assert(bd2.winnerOnBoard(board2, 't').present === false, 'winner absent detected');
  assert(bd2.winnerOnBoard([{ model: 'Old.Star-1', benchmarks: { 'AA Intelligence (index)': 55 } }], 't').score === 55, 'presence is name-normalized, scored on primary');
  const rep = bd2.bestReplacement(board2, 't', { minScore: 50, maxCost: 7.5 });
  assert(rep && rep.model === 'new-good', 'relaxed search: cheapest adequate under the cap');
  assert(bd2.bestReplacement(board2, 't', { minScore: 50 }).model === 'new-good', 'no cap → still cheapest adequate, min does the quality judging');
  assert(bd2.bestReplacement(board2, 't', { minScore: 75, maxCost: 7.5 }) === null, 'nothing above bar → null');

  // usage-weighted cost: an input-heavy mix flips verdicts a flat in+out sum gets wrong
  const mixH = pricing.usageMixOf([{ input: 97e6, output: 3e6 }]);
  assert(Math.abs(mixH.wIn - 0.97) < 1e-9, 'mix derived from usage rows');
  assert(pricing.weightedCost({ in: 2, out: 10 }) === 6, 'no mix → 0.5/0.5 blend (old sum ranking)');
  const wbd = createBoard({ roles: { roles: { w: { primary: 'AA Intelligence', min: 40, winner: 'old-haiku' } } } });
  const wboard = [
    { model: 'muse-like', lab: 'M', benchmarks: { 'AA Intelligence': 56.8 }, priceIn: 1.25, priceOut: 4.25 }, // flat sum $5.5 < $6 but input-PRICIER
    { model: 'flash-like', lab: 'G', benchmarks: { 'AA Intelligence': 52 }, priceIn: 0.3, priceOut: 2.5 },
  ];
  const capH = pricing.weightedCost({ in: 1, out: 5 }, mixH); // incumbent's last-known on the real mix ≈ $1.12
  const pick = wbd.bestReplacement(wboard, 'w', { minScore: 40, maxCost: capH, mix: mixH });
  assert(pick && pick.model === 'flash-like', 'input-heavy mix rejects the input-pricier model, picks cheapest adequate');
  const evM = { qualityOK: true, cheaper: true, cp: { in: 1.25, out: 4.25 }, ip: { in: 1, out: 5 } };
  assert(apa.adoptGate(evM).adopt === true, 'flat blend: candidate adopts');
  assert(apa.adoptGate(evM, { mix: mixH }).adopt === false, 'usage-weighted: same candidate is pricier for this workload');

  // Pareto value walk: steep cheap jumps get captured; the min bar stops deciding the outcome
  const vb = createBoard({ roles: { roles: { v: { primary: 'AA Intelligence', min: 30, winner: 'old' } } } });
  const vboard = [
    { model: 'mimo-ish', benchmarks: { 'AA Intelligence': 38 }, priceIn: 0.14, priceOut: 0.28 },   // ~0.145 blended (mixH)
    { model: 'luna-ish', benchmarks: { 'AA Intelligence': 52.3 }, priceIn: 0.2, priceOut: 1.2 },   // ~0.216 — +14.3 pts for 1.5× = ~24 pts/dbl
    { model: 'opus-ish', benchmarks: { 'AA Intelligence': 62.5 }, priceIn: 5, priceOut: 25 },      // ~5.6 — +10 pts for 26× = ~2 pts/dbl
  ];
  const fr = vb.paretoFrontier(vboard, 'v', { mix: mixH });
  assert(fr.length === 3 && fr[0].model === 'mimo-ish' && fr[2].model === 'opus-ish', 'frontier is cost- and score-ascending');
  assert(vb.bestReplacement(vboard, 'v', { minScore: 30, mix: mixH }).model === 'luna-ish', 'entry below the jump: walk takes the steep upgrade');
  assert(vb.bestReplacement(vboard, 'v', { minScore: 40, mix: mixH }).model === 'luna-ish', 'entry above the jump: same outcome — bar placement no longer decides');
  assert(vb.bestReplacement(vboard, 'v', { minScore: 30, mix: mixH, valueBar: Infinity }).model === 'mimo-ish', 'valueBar Infinity ⇒ pure cheapest-adequate');
  assert(vb.bestReplacement(vboard, 'v', { minScore: 30, maxCost: 0.2, mix: mixH }).model === 'mimo-ish', 'budget cap still binds the walk');

  // adoptGate delisted relaxation: comparable price passes but only ever PROPOSES
  const evD = { qualityOK: true, cheaper: false, cp: { in: 3, out: 15 }, ip: { in: 3, out: 15 } };
  assert(apa.adoptGate(evD).adopt === false, 'strict gate: equal price is not cheaper');
  const gD = apa.adoptGate(evD, { delisted: true });
  assert(gD.adopt === false && gD.propose === true, 'delisted: comparable price proposes, never adopts');
  assert(!apa.adoptGate({ ...evD, cp: { in: 9, out: 40 } }, { delisted: true }).propose, 'delisted: pricier still fails');
  assert(!apa.adoptGate({ ...evD, qualityOK: false }, { delisted: true }).propose, 'delisted: quality bar still applies');

  // considerFinding: delisted incumbent → 'proposed' outcome via the propose hook, no adopt
  const ev3 = { info: [], propose: [], adopt: [] };
  const apa3 = createApa({
    adapters: { call: async ({ model }) => ({ text: 'a ' + model, usage: {} }) },
    priceOf: () => ({ in: 3, out: 15 }), // equal prices: strict gate would freeze forever
    judge: agreeJudge,
    usageHistory: async () => [],
  });
  const ctx3 = {
    store: { recordPrice: () => {}, incumbent: () => 'inc', adopt: (m, id) => ev3.adopt.push(id) },
    notify: { info: l => ev3.info.push(l), propose: l => ev3.propose.push(l) },
    log: () => {}, usLabs: ['LabX'], crossProvider: true, autoAdopt: true,
    resolveId: m => m, providerFor: () => 'p', sameFamily: () => false,
    incumbentDelisted: (module, incId) => incId === 'inc',
  };
  assert(await apa3.considerFinding({ kind: 'release', lab: 'LabX', model: 'cand3', headline: 'h', url: 'u' }, ctx3) === 'proposed', 'delisted incumbent → proposed');
  assert(ev3.adopt.length === 0 && ev3.propose.some(l => l.includes('incumbent delisted')), 'proposal via notify.propose, no store.adopt');

  // tiers: resolve/escalate with price, funding class, and time-sensitive advisories
  const tiers = createTiers({
    incumbent: t => ({ workhorse: 'claude-haiku-4-5', steeldust: 'claude-sonnet-5', thoroughbred: 'claude-opus-4-8', secretariat: 'claude-fable-5' })[t],
    priceOf: pricing.priceOf, costClass: m => pricing.costClass(m),
    advisories: (m, t) => t === 'workhorse' ? ['gcp credit pool expires 2026-07-16'] : [],
  });
  const wh = tiers.resolve('workhorse');
  assert(wh.model === 'claude-haiku-4-5' && wh.price.out === 5 && wh.advisories[0].includes('credit pool'), 'tier resolve');
  const esc = tiers.escalate('workhorse');
  assert(esc.tier === 'steeldust' && esc.model === 'claude-sonnet-5' && esc.price.out === 10 && Array.isArray(esc.advisories), 'escalation returns model + real cost + advisories');
  assert(tiers.escalate('thoroughbred').tier === 'secretariat', 'thoroughbred escalates to secretariat');
  assert(tiers.escalate('secretariat').advisories.some(a => a.includes('top tier')), 'top-tier escalation capped');
  assert(tiers.resolve('pony').error, 'unknown tier rejected');

  // ---- v0.8: slug families — variants stripped, token order irrelevant ----
  const { canonical, sameModel, normModel } = require('./board');
  assert.deepStrictEqual(canonical('claude-4-5-haiku'), { base: 'claude-haiku-4-5', variant: 'default' }, 'canonical: board order → family key');
  assert(canonical('claude-haiku-4-5').base === 'claude-haiku-4-5', 'canonical: API order → same key');
  assert.deepStrictEqual(canonical('claude-opus-5-xhigh'), { base: 'claude-opus-5', variant: 'xhigh' }, 'canonical: effort suffix → variant');
  assert(canonical('claude-opus-5-low').variant === 'low' && canonical('claude-opus-5-high').variant === 'high', 'canonical: high/low (xhigh not confused with high)');
  assert.deepStrictEqual(canonical('gpt-6-astra-xhigh'), { base: 'astra-gpt-6', variant: 'xhigh' }, 'canonical: words sorted, digits after');
  assert.deepStrictEqual(canonical('gpt-6-astra-non-reasoning'), { base: 'astra-gpt-6', variant: 'non-reasoning' }, 'canonical: longest suffix wins over "reasoning"');
  assert(canonical('gpt-6-astra-non-reasoning-low-effort').variant === 'low', 'canonical: non-reasoning-low-effort aliases to low');
  assert.deepStrictEqual(canonical('claude-3-7-sonnet-thinking'), { base: 'claude-sonnet-3-7', variant: 'thinking' }, 'canonical: thinking variant');
  assert.deepStrictEqual(canonical('grok-4.3'), { base: 'grok-4-3', variant: 'default' }, 'canonical: dots → dashes');
  assert(canonical('Claude Opus 5').base === 'claude-opus-5', 'canonical: case + spaces');
  assert(canonical('high').base === 'high' && canonical('high').variant === 'default', 'canonical: a bare variant word is a name, not a suffix');
  assert.deepStrictEqual(canonical('non-reasoning'), { base: 'non-reasoning', variant: 'default' }, 'canonical: a bare multi-token variant word does not fall through to a shorter suffix');
  assert(canonical('gemini-3-flash-preview-thinking').variant === 'thinking', 'canonical: only ONE trailing suffix is stripped');
  assert(sameModel('claude-4-5-haiku', 'claude-haiku-4-5') && sameModel('claude-opus-5-xhigh', 'claude-opus-5-low'), 'sameModel: order + variants');
  assert(!sameModel('claude-opus-5', 'claude-opus-4-8') && !sameModel('', ''), 'sameModel: different families / empty never match');
  assert(normModel('Grok 4.3') === 'grok-4-3', 'normModel unchanged');

  // winnerOnBoard is family-aware: the API id finds the board's reordered slug, scored on its best variant
  const bd3 = createBoard({ roles: { roles: { wh: { primary: 'AA Intelligence', winner: 'claude-haiku-4-5' } } } });
  const aaRows = [
    { model: 'claude-4-5-haiku', lab: 'Anthropic', benchmarks: { 'AA Intelligence': 40 }, priceIn: 1, priceOut: 5 },
    { model: 'claude-4-5-haiku-thinking', lab: 'Anthropic', benchmarks: { 'AA Intelligence': 48 }, priceIn: 1, priceOut: 5 },
    { model: 'claude-4-5-sonnet', lab: 'Anthropic', benchmarks: { 'AA Intelligence': 60 }, priceIn: 3, priceOut: 15 },
  ];
  const w3 = bd3.winnerOnBoard(aaRows, 'wh');
  assert(w3.present === true && w3.score === 48 && w3.variant === 'thinking' && w3.model === 'claude-4-5-haiku-thinking', 'winner present across token order; score = best variant, with which one');
  assert(bd3.winnerOnBoard([{ model: 'claude-4-5-haiku-thinking', benchmarks: {} }], 'wh').present === true, 'present even without a primary score');
  assert.deepStrictEqual(bd3.winnerOnBoard([aaRows[2]], 'wh'), { winner: 'claude-haiku-4-5', present: false, score: null, variant: null, model: null }, 'a sibling family is not the winner');

  // fromRows honours cutoff hypotheses (user min ?? cutoffs[key].min) and carries base/variant + extra AA columns
  const bd4 = createBoard({ roles: { roles: { sd: { primary: 'AA Intelligence' }, wh: { primary: 'AA Intelligence' } } } });
  const raw4 = [
    { model: 'claude-4-5-haiku', benchmarks: { 'AA Intelligence': 45 }, priceIn: 1, priceOut: 5, cacheIn: 0.1, speed: 120, ttft: 0.4, releaseDate: '2025-10-15' },
    { model: 'x-1', benchmarks: { 'AA Intelligence': 20 } },
  ];
  assert(bd4.fromRows(raw4)[0].role === '', 'no user min and no hypothesis → no tier');
  const r4 = bd4.fromRows(raw4, { sd: { min: 50 }, wh: { min: 40 } });
  assert(r4[0].role === 'wh' && r4[1].role === '', 'hypotheses assign tiers when the user has set no min');
  assert(bd4.fromRows(raw4, { sd: { min: 40 }, wh: { min: 30 } })[0].role === 'sd', 'highest cleared bar still wins under hypotheses');
  assert(createBoard({ roles: { roles: { sd: { primary: 'AA Intelligence', min: 60 } } } }).fromRows(raw4, { sd: { min: 40 } })[0].role === '', 'user min beats the hypothesis');
  assert(r4[0].base === 'claude-haiku-4-5' && r4[0].variant === 'default', 'rows carry base + variant');
  assert(r4[0].cacheIn === 0.1 && r4[0].speed === 120 && r4[0].ttft === 0.4 && r4[0].releaseDate === '2025-10-15', 'extra source columns pass through');
  assert(r4[1].cacheIn === null && r4[1].speed === null && r4[1].ttft === null && r4[1].releaseDate === '', 'absent extras → null (numbers) / "" (date)');

  // paretoFrontier: oneVariantPerBase collapses a family to its best variant; includeWinner keeps the winner in
  const vb2 = createBoard({ roles: { roles: { o: { primary: 'AA Intelligence' } } } });
  const vrows = [
    { model: 'foo-9-low', benchmarks: { 'AA Intelligence': 40 }, priceIn: 0.3, priceOut: 0.3 },
    { model: 'foo-9-high', benchmarks: { 'AA Intelligence': 50 }, priceIn: 1, priceOut: 1 },
    { model: 'bar-1', benchmarks: { 'AA Intelligence': 45 }, priceIn: 0.5, priceOut: 0.5 },
  ];
  const f1 = vb2.paretoFrontier(vrows, 'o');
  assert(f1.length === 2 && f1[0].model === 'bar-1' && f1[1].model === 'foo-9-high' && f1[1].base === 'foo-9' && f1[1].variant === 'high', 'oneVariantPerBase: only foo-9\'s best variant competes');
  const f2 = vb2.paretoFrontier(vrows, 'o', { oneVariantPerBase: false });
  assert(f2.length === 3 && f2[0].model === 'foo-9-low', 'variants compete separately when disabled');
  const vb3 = createBoard({ roles: { roles: { o: { primary: 'AA Intelligence', winner: 'foo-9' } } } });
  assert(vb3.paretoFrontier(vrows, 'o').every(p => p.base !== 'foo-9'), 'winner family excluded by default — every variant');
  assert(vb3.paretoFrontier(vrows, 'o', { includeWinner: true }).some(p => p.base === 'foo-9'), 'includeWinner keeps it');
  assert(vb3.paretoFrontier(vrows, 'o', { fundable: m => m.model !== 'bar-1' }).length === 0, 'fundable predicate filters rows');
  assert(vb3.bestReplacement(vrows, 'o', { minScore: 30, includeWinner: true, fundable: m => m.model !== 'bar-1' }).base === 'foo-9', 'bestReplacement passes fundable/includeWinner through');

  // recommend(): cheapest adequate (winner INCLUDED), then the value walk — +14 at 1.5× taken, +3 at 14× not
  const rb = createBoard({ roles: { roles: { r: { primary: 'AA Intelligence', winner: 'mid-model' } } } });
  const rrows = [
    { model: 'weak-model', lab: 'D', benchmarks: { 'AA Intelligence': 20 }, priceIn: 0.1, priceOut: 0.1 },
    { model: 'cheap-model', lab: 'A', benchmarks: { 'AA Intelligence': 38 }, priceIn: 0.5, priceOut: 0.5 },   // blended 0.5
    { model: 'mid-model', lab: 'B', benchmarks: { 'AA Intelligence': 52 }, priceIn: 0.75, priceOut: 0.75 },  // 1.5× → +14 pts (~24 pts/dbl): taken
    { model: 'top-model', lab: 'C', benchmarks: { 'AA Intelligence': 55 }, priceIn: 10.5, priceOut: 10.5 },  // 14× → +3 pts (~0.8 pts/dbl): not
  ];
  const rec = rb.recommend(rrows, 'r', { cutoffs: { r: { min: 30 } } });
  assert(rec && rec.model === 'mid-model' && rec.base === 'mid-model' && rec.variant === 'default' && rec.score === 52 && rec.cost === 0.75 && rec.priceIn === 0.75, 'entry cheap-model → walk takes the steep jump, stops before the flat one');
  assert(/≥ 30 on AA Intelligence/.test(rec.why) && /\+14 pts for 1\.5× cost/.test(rec.why) && /\+3 pts for 14× cost not worth it/.test(rec.why) && /current winner/.test(rec.why), 'why: floor, the step taken, the step declined');
  assert(rb.recommend(rrows, 'r', { cutoffs: { r: { min: 30 } }, valueBar: Infinity }).model === 'cheap-model', 'valueBar Infinity → pure cheapest adequate');
  const recTop = rb.recommend(rrows, 'r', { cutoffs: { r: { min: 53 } } });
  assert(recTop.model === 'top-model' && /top of the frontier/.test(recTop.why), 'floor above the winner → the only adequate model');
  assert(rb.recommend(rrows, 'r', { cutoffs: { r: { min: 60 } } }) === null, 'nothing clears the floor → null');
  assert(createBoard({ roles: { roles: { r: { primary: 'AA Intelligence', min: 53 } } } }).recommend(rrows, 'r', { cutoffs: { r: { min: 30 } } }).model === 'top-model', 'user min beats the cutoff hypothesis');
  // no floor anywhere: the winner's live score is the bar (never downgrade) — a cheaper equal wins, else keep
  const rrows2 = [...rrows, { model: 'equal-cheaper', lab: 'E', benchmarks: { 'AA Intelligence': 52 }, priceIn: 0.6, priceOut: 0.6 }];
  const rec2 = rb.recommend(rrows2, 'r');
  assert(rec2 && rec2.model === 'equal-cheaper' && /no min set/.test(rec2.why), 'no floor: cheapest model ≥ the winner\'s score');
  assert(rb.recommend(rrows, 'r').model === 'mid-model', 'no floor, nothing cheaper at the bar → keep the winner');
  assert(createBoard({ roles: { roles: { r: { primary: 'AA Intelligence' } } } }).recommend(rrows, 'r') === null, 'no floor and no winner → null');
  // fundable predicate honoured
  assert(rb.recommend(rrows, 'r', { cutoffs: { r: { min: 30 } }, fundable: m => m.lab !== 'B' }).model === 'cheap-model', 'winner unfundable: the jump to top is too flat, stay cheap');
  const recF = rb.recommend(rrows, 'r', { cutoffs: { r: { min: 30 } }, fundable: m => m.lab !== 'A' });
  assert(recF.model === 'mid-model' && /cheapest fundable model/.test(recF.why), 'cheapest adequate unfundable → next fundable');
  // variants of one family collapse before the walk: the winner's best variant is what gets recommended
  const rb2 = createBoard({ roles: { roles: { r: { primary: 'AA Intelligence', winner: 'claude-opus-5' } } } });
  const rec3 = rb2.recommend([
    { model: 'claude-opus-5-low', benchmarks: { 'AA Intelligence': 50 }, priceIn: 5, priceOut: 25 },
    { model: 'claude-opus-5-xhigh', benchmarks: { 'AA Intelligence': 62.6 }, priceIn: 5, priceOut: 25 },
    { model: 'cheap-model', benchmarks: { 'AA Intelligence': 20 }, priceIn: 0.5, priceOut: 0.5 },
  ], 'r', { cutoffs: { r: { min: 60 } } });
  assert(rec3.model === 'claude-opus-5-xhigh' && rec3.base === 'claude-opus-5' && rec3.variant === 'xhigh' && /\$5\/\$25 blended \$15/.test(rec3.why), 'family collapsed to its best variant; why quotes the price');

  console.log('all agent-stable tests passed');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
