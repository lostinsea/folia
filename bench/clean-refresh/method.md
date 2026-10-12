# One hosted-Windows clean-refresh comparison

This is one new measurement-environment unit, not a repeat on the local host.
The existing ordinary Node/Electron runner, unchanged worker
`315c486b82422dad0908a204ca00c9326537084dd1b0f3cb56422ab77d760b07`,
unchanged statistical protocol and functionally tested PowerShell capture are
transported to one standard `windows-latest` Actions job. Hosted hardware is
not promised to be quiet, exclusive at the hypervisor level, or stationary.
Dispatch the already-registered `ci.yml` on the candidate branch with
`clean_refresh=true`; its unchanged normal test and revert-audit jobs must
succeed before its comparison job runs at the same revision.
Direct dispatch of the new filename was rejected before execution because
GitHub requires that entry file on the default branch. No AA was started by
that rejected request. Existing CI validation has its existing 45/60-minute
job limits; the comparison's separate fixed job/phase budgets remain unchanged.
The comparison has a separate non-cancelling CI concurrency group; ordinary CI
cannot replace it. Only the registered CI entry contains the job, so there is
no separate direct-dispatch route that skips those normal jobs. Keeping the job
there also preserves the existing packaging oracle's remote-action-only,
immutable-SHA pin contract without weakening that oracle for a local workflow.
One dispatch is the authorized
operator bound, not automated cross-run replay prevention: the attempt guard
rejects reruns of the same run, not a separately requested new workflow run.

Before measurement, preparation records the exact dispatched commit, source
and tooling hashes, schedules and a fresh private physical OS-temp storage root.
Git's normal CRLF checkout policy is fixed in this job's process environment,
not the user's global configuration; preparation rejects changed worker bytes.
Each worker/arm/phase gets new fixture paths and empty profiles there; code and
results occupy a separate runner-temp root. Staging verifies physical paths and
root identity using the existing practical checks, not a whole-host guarantee.
No historical fixture/profile/result or old attempt is reused.

Baseline remains `790c1bc9267f4b794700a8eede506bb48e8be189`. The candidate
diff must contain exactly the original two product sources; dependency manifests
must remain equal. Both arms share the same runtime/assets on this one job.
The worker, fixture generation, stock writes, full innerText heading endpoint,
guards and all 21 changed plus 21 unchanged observations are unchanged.
There is no cold/outlier deletion, noise subtraction or renderer modification.

The unchanged protocol fixes eight fresh-worker pairs per original cell, four
AB and four BA, seeds AA `0x51c08001` and AB `0x51c08002`, original nine cells,
nearest-rank worker quantiles, conditional median material-margin intervals,
observed-pair/pooled vetoes and global intersection qualification. The original
strict material thresholds are unchanged. Its independent/stationary-pair
assumptions remain assumptions, not proved by hosted execution. Its estimand
is typical paired empirical quantiles, not population p95 or rare-regression
protection. The original absolute unchanged-p95 2 ms precision objective is
explicitly reported; it is not automatically achieved or silently waived.

One AA attempt, at most 144 workers, 90 minutes including staging, native
capture and ordinary cleanup/admission. Only complete globally qualified AA,
native/wrapper zero, successful capture, completed cleanup, matched caller
acknowledgment and exact raw/compact/decision checks admit one AB attempt with
the same fixed bound. Any error, missing observation, material veto, incomplete
certificate or deadline stops without replacement, extension or rerun.
Workflow attempts after attempt 1 are rejected before app execution. The
205-minute job ceiling includes ordinary setup plus both fixed phase budgets;
platform cancellation/nonreturn means incomplete evidence, never a pass.

The unchanged capture controls already exercised actual Node 0/7 and nested
worker/caller distinctions. New integration controls are explicitly DATA,
not additional app measurements or a native timing guarantee. A failed AA
step prevents the AB step; AB independently revalidates AA before any worker.
The final checker re-reads raw records and recomputes the protocol verdict.

Retain raw records/logs, partial results, declaration and native/caller outcomes
from this run even on failure. Historical failed/deferred outcomes are not
rewritten. GitHub discards the temporary filesystem after the job; retained raw
records are not a promise of permanent fixture/profile custody. A green normal CI/build or native runner exit is not performance
qualification. No merge/tag/release follows unless the real release scope and
remaining repository requirements are also resolved.
