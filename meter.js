// agent-stable · meter — normalize usage/decision events, enrich with cost + funding class,
// dispatch to pluggable sinks. Pure logic: auth, clocks, and transports are injected.
//
//   const meter = createMeter({ sink, pricing, host });
//   await meter.usage({ module, model, input, output, costUsd?, latencyMs?, note? });
//   await meter.decision({ module, actor, decision, why?, parent?, taskRef?, costUsd? });
//
// Sink interface: { record(event) → Promise }. Events:
//   { type:'usage',    at, host, module, model, input, output, costUsd, fundingClass, latencyMs, note }
//   { type:'decision', at, host, module, actor, decision, why, parent, taskRef, costUsd }
// Numeric fields (input, output, costUsd, latencyMs) are a number or null when unknown — never
// ''. Text fields are strings ('' when absent). Sinks that need blanks (sheet rows) render null as ''.
// `pricing` = { priceOf(model) → {in,out}|null, costClass(model, module, atIso) → 'real'|'credit'|'included' }.
// If costUsd is absent on usage events it is computed from the price table; fundingClass is always stamped.

// round to `digits` decimal places (cost in USD is kept to the micro-dollar: roundTo(x, 6))
// unknown numeric field → null. '' is accepted on input for backward compatibility (callers
// historically passed costUsd: '' to mean "not known") but is never emitted.
const orNull = v => (v === undefined || v === null || v === '') ? null : v;
const roundTo = (x, digits) => { const f = 10 ** digits; return Math.round(x * f) / f; };

function createMeter({ sink, pricing, host = '', now = () => new Date() } = {}) {
  if (!sink || typeof sink.record !== 'function') throw new Error('meter needs a sink with record(event)');
  const p = pricing || {};
  const stamp = () => now().toISOString();

  async function usage(e = {}) {
    const at = e.at || stamp();
    let costUsd = orNull(e.costUsd);
    if (costUsd === null && p.priceOf) {
      const pr = p.priceOf(e.model);
      if (pr) costUsd = roundTo(((+e.input || 0) * pr.in + (+e.output || 0) * pr.out) / 1e6, 6); // prices are per 1M tokens
    }
    return sink.record({
      type: 'usage', at, host: e.host || host,
      module: e.module || '', model: e.model || '',
      input: orNull(e.input), output: orNull(e.output),
      costUsd, note: e.note || '',
      latencyMs: orNull(e.latencyMs),
      fundingClass: p.costClass ? p.costClass(e.model, e.module, at) : 'included',
    });
  }

  async function decision(e = {}) {
    return sink.record({
      type: 'decision', at: e.at || stamp(), host: e.host || host,
      module: e.module || '', actor: e.actor || '',
      decision: e.decision || '', why: e.why || '',
      parent: e.parent || '', taskRef: e.taskRef || '', costUsd: orNull(e.costUsd),
    });
  }

  // wrap an async provider call: meters tokens/latency around it via a caller-supplied extractor
  //   const out = await meter.wrap(() => callModel(...), { module, model, extract: r => ({input, output}) })
  async function wrap(fn, meta = {}) {
    const t0 = Date.now();
    const result = await fn();
    const ex = meta.extract ? (meta.extract(result) || {}) : {};
    usage({ ...meta, ...ex, latencyMs: Date.now() - t0 }).catch(() => {});
    return result;
  }

  return { usage, decision, wrap, record: (e) => sink.record(e) };
}

module.exports = { createMeter };
