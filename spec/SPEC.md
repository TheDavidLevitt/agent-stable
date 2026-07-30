# agent-stable — Spec

> Regeneration pack: this folder contains enough context to rebuild the project
> from scratch without rediscovering its design or its lessons.
> SPEC = what & why · DESIGN = how · LESSONS = constraints learned the hard way.

## Problem

Operators running multiple LLM agents across providers accumulate three unanswered
questions: what the agents actually spent (and whether it was cash, an expiring credit
pool, or a flat-rate subscription); whether a newly shipped model is cheaper or better
than the incumbent for a given job; and who checks — continuously, not the night the
invoice lands. agent-stable is the metering + price-awareness + automated-procurement
layer that answers these, embeddable in any host app.

## The stable metaphor

Downstream agents never ask for model names — they ask for a **tier** and get back the
current model, its real price, whose money it is, and time-sensitive advisories:

- **workhorse** — cheapest adequate model: mechanical extraction, classification, bulk work.
- **steeldust** — the daily driver: orchestration, thesis-led summaries, judgment calls;
  escalation target from workhorse.
- **thoroughbred** — top-tier reasoning; hard analysis; escalation target from steeldust.

A bot runs cheap by default, calls `escalate()` when out of its depth, and is told exactly
what that will cost before committing.

## Core behaviors

1. **Pricing** — a per-1M-token price table with `priceOf()`, plus `costClass()`
   classifying every call's *source of funds*: `real` (out-of-pocket) · `credit` (finite
   pools) · `included` (subscription). A dollar of expiring credit is not a dollar of cash.
2. **Metering** — normalize usage and decision events, enrich with computed cost, funding
   class, and latency; `wrap()` meters any async provider call transparently.
3. **Sinks** — pluggable event stores: in-memory ring buffer, JSONL, Google Sheet
   (authenticated client injected; the module never holds credentials).
4. **Adapters** — one uniform `call()` across providers: a single OpenAI-compatible HTTP
   implementation covers eight providers (hosted + local keyless); bespoke providers are
   injected as functions. Keys and endpoints are always injected, never read.
5. **APA (Agent Procurement Agent)** — the decision engine: run a fixed eval suite on
   candidate vs incumbent, LLM-judge head-to-head, project savings from real usage
   history, and gate adoption on *runnable ∧ equal-or-better ∧ cheaper ∧ autoAdopt*.
   Every adoption is logged with rationale and projected saving, and is revertible.
6. **Board** — compile/parse prompts that build a live market board (models × cost ×
   benchmark scores per role) and a benchmark knowledge base; merge user thresholds
   over the engine's hypotheses.
7. **Tiers** — `resolve(tier)` / `escalate(tier)` resolution for downstream consumers.

## Zero dependencies as a design goal

The package has zero runtime dependencies on purpose: it is publishable, auditable in an
afternoon, and embeddable by copy or by npm without pulling a dependency tree into the
host. All I/O — filesystem, network, env, auth — is injected by the host. This is what
makes the same code runnable as an npm package and vendorable verbatim inside a private app.

## Non-goals

- No storage engine, scheduler, or notification system of its own — sinks, cron scans,
  and notify channels are host concerns (Store/Notify boundary).
- No web scraping or key management inside the modules; scan-prompt assembly stays
  host-side because it is context-gathering from host systems.
- No dashboard UI (a separate starter-dashboard package is planned); the board module
  emits data, the host renders it.
- No TCO accounting — the self-host cost line is a stated electricity-only estimate,
  never dressed up as per-model truth.
