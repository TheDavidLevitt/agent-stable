# The Form Guide — community model×task database (PROPOSAL)

> In horse racing, the *form guide* is the public record of how each horse ran on each
> course — the document bettors read to decide who can handle today's race. This is that,
> for models: a community-fed database answering **"which model (or what benchmark score)
> is enough for this task?"** — the community-scale version of agent-stable's private
> roles/cutoffs, feeding the same `resolve()` idiom.

Status: Phase 1 SHIPPING (2026-07-12) at **dashyng.com/agentstable** — read-only, inside
the existing reference-deployment service. Decisions at bottom.

**Hard rule — no abusable spend surface:** no request path in the Form Guide may reach
an LLM, ever, at any phase. Hypothesis fitting is pure math on stored reports; anything
LLM-assisted (seeding priors, merge suggestions) runs offline in the owner's pipeline,
never on a user-triggered route. Reads are anonymous, cached, and table-lookup only.

---

## 1. Task taxonomy

Three levels + qualifiers. L1/L2 are **curated** (small, stable, opinionated); L3 is
**community-proposed** (moderated into the tree, folksonomy tags until promoted). Every
node has a dot-slug used everywhere: `code.debug.race-conditions`.

**L1 domains (curated, ~10):**

| L1 | L2 examples (curated, ~5-10 each) |
|---|---|
| `code` | generate · debug · review · refactor · test-writing · architecture · completion |
| `agentic` | orchestration · tool-calling · multi-step-planning · browser-use · computer-use · long-horizon |
| `analysis` | quantitative · legal · scientific · financial · causal-reasoning |
| `writing` | technical · creative · editing · summarization · translation |
| `extraction` | classification · structured-output · entity-extraction · OCR-cleanup |
| `research` | web-research · literature-review · fact-checking · synthesis |
| `conversation` | support · tutoring · roleplay · therapy-adjacent (flagged) |
| `math` | proof · computation · word-problems · formalization |
| `vision` | understanding · chart-reading · document-parsing · spatial |
| `generation` | image · audio · video (scored on their own benchmark families) |

**L3+ (community):** the community subdivides freely below L2, to any depth —
`code.debug.race-conditions`, `extraction.structured-output.invoices.multi-currency`.
Proposed with a description; promoted when they accumulate ≥N reports; merged when
duplicates. The arbiter of whether a subdivision *deserves to exist* is empirical:
subdivisions whose fitted hypotheses don't diverge from the parent's get folded back
(§3 "split test"), so the tree deepens exactly where model capability actually differs.

**Qualifiers (structured, on the report, not the tree):** context size bucket
(<10k / 10-100k / >100k), language/framework, autonomy (assisted vs unattended),
stakes (throwaway vs production). Keeps the tree small while letting hypotheses
condition on the qualifier that actually moves the threshold.

## 2. Data model + posting site

Postgres (schema below); one small Node service; **GitHub OAuth only at launch** (dev
audience, cheap spam resistance) for posting, anonymous read. Site = one dense dark page
per task node + one per model, same design language as the public board at
dashyng.com/public/agentstable.

**Benchmark backbone: Artificial Analysis (decision 2026-07-14).** AA's data API already
provides standardized model scores (Intelligence / Coding / Agentic indices, per-benchmark
detail on paid tiers) and per-token pricing, refreshed as models ship — strictly better
than maintaining our own scraped board. The Form Guide therefore does NOT compete with AA:
`models`/`model_benchmarks` below become a *cached mirror* of AA data (free tier, 6h cache,
attribution on every surface), and the Form Guide's own contribution is exactly the layer
AA doesn't publish: the task taxonomy, real-world adequacy reports, fitted "what score is
enough for task X" thresholds, and the recommend API. (AA's coding-agents *harness*
comparisons are site-only today — not in their API; if that changes, harness becomes a
report qualifier.)

```sql
models            (id, slug, lab, family, os_flag, released_at, deprecated_at)
model_versions    (id, model_id, version_tag, effective_at)          -- reports pin versions
benchmarks        (id, slug, name, measures, scale_min, scale_max, source_url)
model_benchmarks  (model_version_id, benchmark_id, score, measured_at, source, provenance)
prices            (model_id, price_in, price_out, effective_at)      -- history, not latest-only
tasks             (id, parent_id, level, slug, label, description,
                   status ENUM(curated, proposed, merged), merged_into)
reports           (id, task_id, model_version_id, success SMALLINT CHECK (1..5),
                   evidence_url, evidence_text, qualifiers JSONB,
                   reporter_id, disclosure ENUM(none, affiliated), created_at,
                   UNIQUE (reporter_id, task_id, model_version_id))  -- one voice per pairing
votes             (report_id, voter_id, dir SMALLINT CHECK (-1, 1), PRIMARY KEY (report_id, voter_id))
hypotheses        (task_id, benchmark_id, min_score, p_adequate_at_min, auc, n_reports,
                   ci_low, ci_high, method, fitted_at)               -- §3 output, recomputed nightly
```

**Success rubric (shown at posting time, 1–5):**
1 failed/harmful · 2 partial, heavy rework · 3 usable with edits · 4 good, minor edits ·
5 expert-level, unedited.

**Consensus per (task, model):** shown as *adequate / inadequate / disputed / thin*.
- adequate: Wilson lower bound of P(success ≥ 4) ≥ 0.6 with n ≥ 5 (vote-weighted)
- inadequate: Wilson upper bound < 0.4 with n ≥ 5
- disputed: n ≥ 5 and neither — usually a qualifier split (surface the qualifier
  breakdown instead of averaging it away)
- thin: n < 5 — displayed, never fed to the API as settled

**Vote/anti-gaming mechanics:**
- Votes rank *usefulness* (evidence-linked reports float up); consensus math weights
  reports by reporter reputation, not raw votes (votes earn reputation slowly).
- New accounts: full posting rights, ~0.3 weight ramping to 1.0 over accepted history.
- Evidence-linked reports weigh ~2× unlinked.
- One report per (reporter, task, model_version); edits keep history.
- `disclosure=affiliated` required for lab/vendor employees (honor system + burst
  anomaly detection: many new accounts converging on one model/task = quarantine queue).
- Model releases reset nothing: model_versions keep old reports honest — a "gpt-6"
  report pins the version that was actually tested.

## 3. Hypothesis engine — "what score is enough?"

The core query: for task T and each benchmark B, take all reports on T, join each
model → its B score, giving points (score, adequate?). Fit a monotonic logistic curve;
the **hypothesis** is the score where P(adequate) crosses 0.8, with bootstrap CI.

- **Primary benchmark per task** = the B with the best separation (highest AUC) —
  this is the data-derived version of agent-stable's `roles[k].primary`.
- **Confidence gates:** no hypothesis published under n=8 reports spanning ≥4 models;
  wide-CI hypotheses are labeled "weak" and the API says so.
- **Split test (taxonomy feedback):** if a qualifier (e.g. context >100k) shifts the
  fitted threshold by more than the CI width, propose splitting the node — the taxonomy
  is *learned* where it matters, curated where it doesn't.
- **Cold start:** seed models/benchmarks/prices from the APA board compiler (already
  maintained daily), and seed hypotheses from the existing benchmark knowledge base's
  LLM-suggested cutoffs, labeled `method=prior` until community reports replace them
  (`method=fitted`).
- **Reference-deployment reporting:** the reference deployment posts its outcomes as the
  first reporter (disclosure: affiliated) at **category + success score granularity
  only** — task slug, model version, 1–5 — never evidence, prompts, or task content.
  Mechanically: a stage in its nightly CI workflow maps the day's metered
  module-outcomes to task slugs and POSTs them in batch. Privacy boundary is structural:
  the CI stage simply has no field to leak into (evidence columns forced null,
  qualifiers whitelist-only).

## 4. API

CORS-open reads (same conventions as /api/public/agentstable/tiers: 60s cache, no auth):

```
GET /api/v1/tasks                              → taxonomy tree
GET /api/v1/tasks/code.debug/hypothesis        → {benchmark, min_score, confidence, ci, n}
GET /api/v1/tasks/code.debug/board             → models × consensus × price for this task
GET /api/v1/models/claude-sonnet-5             → benchmarks, prices, consensus by task
GET /api/v1/recommend?task=code.debug          → THE endpoint:
    {task, model, priceIn, priceOut, fallbacks[],            ← cheapest adequate first
     benchmark, min_score, confidence, n_reports, basis: fitted|prior}
    ?strategy=cheapest-adequate (default) | best | fastest
    ?qualifiers=context:100k+ …
POST /api/v1/reports (OAuth)                   → submit a report
POST /api/v1/reports/:id/vote (OAuth)
```

**agent-stable integration:** `tiers.resolve('workhorse')` answers "what do *I* run for
this tier"; `recommend?task=` answers "what does the *world* run for this task". The
package grows a client so hosts can do `resolveTask('code.debug')` with the same return
shape as `resolve()`, and the APA gains a scan source: community consensus shifts become
findings ("SWE-bench 72 now judged adequate for code.debug — candidate for workhorse
eval"). dashyng.com's public board links each tier to its task-level form.

## Build shape

- **Phase 1 (read-only, SHIPPED):** lives INSIDE the existing dashboard service at
  dashyng.com/agentstable — no new infra, no database yet. Taxonomy v0 embedded;
  board seeded live from the APA compiler's sheet tabs; hypotheses are benchmark
  mappings only (`basis: prior`, **no fabricated thresholds** — until fitted from real
  reports, min_score is null and recommend() returns the cheapest of the top-3 on the
  task's benchmark). GET-only carve-outs, CORS-open, cached.
- **Phase 2 (when there's an audience):** Postgres + GitHub OAuth posting, votes,
  consensus, nightly logistic fits replacing priors. Only then does the reference
  deployment's CI start posting outcomes.
- **Phase 3:** agent-stable `resolveTask()` client + APA community-scan source +
  qualifier split tests.
- **Merge/curation tooling: deferred until real usage exists** (owner-decision
  2026-07-12). Until then, taxonomy-subdivision proposals just accumulate; rare merges
  are manual. No moderation UI, no LLM-assisted merge suggestions get built yet.

## Decisions (2026-07-11)

1. **Identity:** GitHub OAuth only at launch.
2. **Seeding:** the reference deployment auto-posts outcomes via its CI workflow —
   task category + model version + success 1–5 only, no evidence or task details,
   disclosure: affiliated.
3. **Taxonomy governance:** community subdivides freely below L2 (any depth); the
   split test folds back subdivisions whose hypotheses don't diverge.
4. **License:** open data — reports and hypotheses under **ODbL** (attribution +
   share-alike for the database), service code MIT like the rest of agent-stable.
5. **This spec is public** (lives in the agent-stable repo as the roadmap).

Still open: early-days L1/L2 curation flow (likely LLM-assisted merge suggestions with
one-click owner approval), and registering stableofagents.com.
