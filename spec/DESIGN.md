# agent-stable — Design

## Stack

Plain Node (CommonJS), zero runtime dependencies, no build step. Every module is a pure
factory: data in, data out; `fetch`, `fs`, sheets clients, clocks, and keys are injected.
`node test.js` and `node demo.js` (no network) are the whole test/demo surface; CI runs both.

## Modules

```
index.js      public entry: re-exports everything below
pricing.js    MODEL_PRICES table · priceOf() · costClass() · selfHostPerMTok()
meter.js      createMeter({sink, pricing, host}) → usage() · decision() · wrap()
sinks/        memory (ring buffer + query) · jsonl (fs injected) · sheet (client injected)
adapters.js   createAdapters(cfg) → call({provider, model, prompt}) → {text, usage, latencyMs}
apa.js        createApa({adapters, priceOf, judge, usageHistory}) → evaluate ·
              projectSavings · adoptGate · considerFinding
board.js      createBoard({roles, prices, labs}) → compilePrompt/parseCompile ·
              benchPrompt/parseBench · thresholdFor · sameBench
tiers.js      createTiers({incumbent, priceOf, costClass, advisories}) → resolve · escalate
```

## Event schema

Sinks implement one method: `record(event) → Promise`. Two event types:

```
usage:    { type:'usage', at, host, module, model, input, output,
            costUsd, fundingClass, latencyMs, note }
decision: { type:'decision', at, host, module, actor, decision, why,
            parent, taskRef, costUsd }
```

`costUsd` is computed from the price table when absent; `fundingClass`
(`real|credit|included`) is always stamped. Numeric fields (`input`, `output`, `costUsd`,
`latencyMs`) are a number or `null` when unknown, never `''`; the sheet sink writes `null` as a
blank cell so existing tab readers see unchanged rows. `decision` events are the audit trail — every
APA outcome (adopt, propose, defer, tested-and-rejected) writes one.

## Host integration (the embedding pattern)

Hosts consume agent-stable one-way: the package never imports host code, reads env, or
touches disk/network. The reference host vendors the package verbatim as a directory and
supplies, via `considerFinding(finding, ctx)`:

- `ctx.store` — `recordPrice()`, `incumbent(role) → model id`, `adopt(role, id, note)`.
  The adopt WRITE is the host's act; the host makes it reversible (one-click revert).
- `ctx.notify` — `info()` / `propose()`: journal, Slack, console — host's choice.
- `ctx.log` — the decisions audit sink.
- A scan loop (host cron) that gathers findings (releases, price cuts, benchmark shifts)
  and feeds them in; a judge LLM call; the roles/thresholds config.

Swapping a Sheet+journal host for a JSON-file+Slack host changes nothing in the engine.

## Benchmark-driven role scoring

`board.compilePrompt()` asks a web-search LLM for ~20 model rows (exact API id, lab,
country, open-weight flag, role, prices, benchmark scores — omit anything unverifiable)
plus, per role, a *hypothesized minimum score* on that role's primary benchmark for
adequacy. `parseCompile()` normalizes strict-JSON output defensively. `thresholdFor()`
resolves the effective cutoff: a user-set minimum always wins over the hypothesis — the
engine fills gaps, humans own thresholds. Pricing basis is explicit: closed models at lab
list price; open-weight models at the cheapest major host's serverless price with the
host named; self-hosting as one editable `watts × tok/s × $/kWh` reference line.

## Adopt/revert safety model

Adoption requires all four, in one gate function (`adoptGate`):

1. **Runnable** — the candidate completed the full eval suite via a real adapter call;
   a model that can't be probed can never be adopted (unrunnable → recommend for review).
2. **Equal-or-better** — an LLM judge grades candidate vs incumbent on the same fixed
   task suite; ties go to quality-OK only if explicitly at-least-as-good.
3. **Cheaper** — combined in+out list price strictly below the incumbent's.
4. **autoAdopt on** — otherwise the result is a proposal, not a write.

Every adoption logs its rationale and the projected monthly saving (extrapolated from the
module's real trailing-30-day token usage), and the host's store keeps the previous
incumbent so revert is one click. Non-adoption paths also log — the trail is complete.
