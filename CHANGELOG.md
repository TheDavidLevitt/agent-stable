# Changelog

All notable changes to agent-stable. Versions before 1.0 follow semver's 0.x convention:
a minor bump may break the API, a patch bump does not.

## 0.9.0

**Breaking**

- `meter`: unknown numeric event fields (`input`, `output`, `costUsd` on usage events;
  `costUsd` on decision events) are now `null`, not `''`, matching `latencyMs`. Memory and JSONL
  sink consumers see `null` where they saw `''`. The sheet sink still writes a blank cell, so
  Usage and Decisions rows are byte-identical. `''` is still accepted on input.
- `apa`: `evaluate()` now runs **10 prompts × 2 judge passes** by default (was 3 × 1). The second
  pass shows the candidate as answer B, and `qualityOK` needs a strict majority of passes.
  Expect roughly 6–7× the previous cost per evaluation. `judgePasses: 1` and a shorter
  `evalPrompts` restore the old behaviour. The README covers what the verdict can and cannot tell you.

**Added**

- `apa`: `judges: [fn, …]` for a panel of distinct judges. `judgePasses` sets how many passes a single
  `judge` gets. `evaluate()` also returns `quality` (share of passes agreeing) and `votes`.
- `pricing.priceFrom(table, id)` is the table-agnostic lookup behind `priceOf`.
- `VERSION` export, so a vendored copy can report which release it is. CHANGELOG.md ships in the
  package.

**Fixed**

- `pricing.priceOf` is order-independent. It tries the exact id first, then the id without its
  routing prefix, then the longest table key contained in the id at token boundaries. 0.8.0's
  prefix-only match returned `null` for routed ids such as `openrouter:claude-opus-5`.

**Changed**

- `meter`: the micro-dollar rounding is a named `roundTo` helper. No behaviour change.
- Tests pin `board.fromRows` role assignment (highest cleared bar wins, in either declaration
  order).

## 0.8.0

- `board`: `canonical()` / `sameModel()` slug families, so effort variants (`-xhigh`,
  `-thinking`) and token order (`claude-4-5-haiku` ≡ `claude-haiku-4-5`) resolve to one model.
  Tiering uses the effective threshold (user min ?? cutoff hypothesis). `winnerOnBoard` is
  family-aware. `paretoFrontier` / `bestReplacement` take `fundable`, `includeWinner` and
  `oneVariantPerBase`. New `recommend()`.
- `pricing`: current first-party price table, exact-then-longest-prefix `priceOf`.
  `costClass` treats unknown ids as paid and credit pools as expired past their date.
- Brings in the 0.5.0–0.7.0 work, which was developed in a vendored copy and never released
  from this repo:
  - **0.7.0**: usage-weighted cost (`usageMixOf`, `weightedCost`) and the Pareto value walk in
    `bestReplacement`. `apa` proposes, and never adopts, for delisted incumbents.
  - **0.5.0–0.6.0**: delisted-winner gate (`winnerOnBoard`, relaxed replacement search).
    `board.fromRows` assigns the highest cleared tier rather than the last one in iteration
    order.

## 0.4.1

- `pricing.costClass`: marketplace-routed ids (`provider/model`, `openrouter:…`) always
  classify as `real` spend.

## 0.4.0

- `board` consumes externally sourced benchmark rows (e.g. Artificial Analysis) via
  `fromRows`. **Breaking:** the LLM compile machinery (`compilePrompt` / `parseCompile`) is
  removed.

## 0.3.0

- `secretariat` tier: top long-horizon model, escalation from `thoroughbred`.

## 0.2.0

- Horse-themed tiers (`workhorse` / `steeldust` / `thoroughbred`) and `tiers.js`:
  `resolve()` / `escalate()` return the tier's model, real cost, funding class and advisories.

## 0.1.0

- Initial extraction from the reference deployment: `pricing`, `meter`, `sinks`
  (memory / JSONL / Google Sheet), `adapters`, `apa`, `board`. Zero runtime dependencies.
