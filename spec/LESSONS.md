# agent-stable — Lessons

> Constraints discovered during building. Format: constraint → consequence → directive.
> An agent rebuilding or extending this project should treat these as load-bearing.

1. **Automated adoption loops stomp manual overrides unless guarded.** The APA writes to
   the same role→model config a human edits; without a guard, the next scan cycle
   re-adopts over a deliberate manual choice. This bug recurred in the embedding host.
   → Store a last-human-edit timestamp (or provenance flag) per role; the engine must
   treat any human edit newer than its own last write as the winning intent and skip
   auto-adoption for that role until told otherwise.

2. **A vendored package forks unless sync is one-way.** The package lives both as a
   standalone repo and as a verbatim directory inside a host app; edits landing in both
   places independently diverge silently. → Declare one direction (source repo → vendored
   copy), copy verbatim after every source change, and run the host's own tests on the
   copy. Never edit the vendored copy directly.

3. **Aggregate benchmark indices beat single-task benchmarks for role assignment.**
   Single-task primaries (one benchmark per role) were tried and rejected: any single
   benchmark saturates, gets gamed, or measures a skill adjacent to the actual job.
   → Score roles against a small basket of benchmarks with an explicit "what this
   predicts / what it misleads on" knowledge base, and let user-set minimums override
   the engine's hypothesized cutoffs.

4. **Role proliferation is a smell.** A dedicated role per task type was tried twice and
   deleted twice — each new role needs its own benchmark basket, threshold, incumbent,
   and scan coverage, and most tasks fit an existing tier anyway. → Keep few, broad tiers
   (cheap-adequate / daily-driver / top-reasoning) plus escalation between them; add a
   named role only for a genuinely orthogonal capability (e.g. a provider-exclusive one).

5. **Cost basis changes rankings — make it a toggle, not a constant.** Self-host energy
   price vs hosted API price vs a lab's premium endpoint produce different "cheapest"
   answers for the same model. → Every price carries its stated basis (API list /
   cheapest-named-host serverless / editable self-host formula); comparisons must say
   which basis they used, and the self-host parameters are user-editable inputs.

6. **"How much" is the wrong question; "whose money" is the right one.** Summing costUsd
   treats expiring credit, subscription allowance, and cash as fungible — they are not,
   and procurement decisions differ per class. → Stamp a fundingClass on every event at
   record time; ship the classifier as a clearly labeled worked example the operator
   edits for their own billing reality.

7. **A model that cannot be probed must never be adopted.** Announcement-time model ids
   are often wrong, gated, or not yet live; adopting on paper specs bricks the role.
   → The eval suite doubles as a liveness probe: any suite failure returns "unrunnable",
   which routes to human review, never to adoption.

8. **LLM-emitted JSON is hostile input.** Judges and board compilers return fenced
   blocks, prose preambles, and truncated objects. → Parse defensively everywhere
   (strip fences, regex the outermost object, default to the safe verdict on failure —
   for the judge, "not better").

9. **Extracting a public package from a private codebase needs a fresh history and a
   pack whitelist.** Git history carries private paths and names; npm packs everything
   not excluded, so a git-excluded working file can still ship in the tarball.
   → Start the public repo with fresh history, sweep for private references before
   every push, and use an explicit `files` whitelist in package.json.

10. **Injected I/O is what makes zero-dep real.** The first slice that read env or disk
    would have forced config conventions and dependencies on every host. → No module
    reads env, disk, or network; adapters take keys, sinks take clients/fs, meters take
    clocks. The discipline is cheap at extraction time and impossible to retrofit.
