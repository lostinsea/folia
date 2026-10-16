# Planned Work

The open work register for Folia. This file is the **durable** copy: the working
tracker lives in an agent session database that does not survive the session, so
anything only recorded there is lost the moment the session ends. If a **tracked
item** is not written down here, assume it does not exist.

That qualifier is deliberate. This register covers the *tracker's* open items. A
small amount of open work is recorded only in the audit documents and has never
been given a tracker ID — see *Open work tracked elsewhere* at the end. Those are
not omissions to be silently absorbed; they are listed so the boundary of this
file is visible.

It is deliberately a *register*, not a dump of the tracker. Each entry states
what the work is, why it is open, what proves it done, and what it waits on.

> **Discoverability — resolved 2026-09-02.** Two entry points now lead here, so a
> session that has lost its tracker can still find this file by following the
> repository's own documented starting points:
>
> - **`.github/copilot-instructions.md`** lists `docs/PLANNED-WORK.md` first among
>   the load-bearing documents and carries the rule *"Read `docs/PLANNED-WORK.md`
>   before selecting or starting any work"*, together with the single-writer and
>   update-at-every-transition protocol, and a summary of the mandatory
>   model-role assignment recorded below.
> - **`README.md`**'s *Planned next* now links here as the authoritative live
>   roadmap instead of restating a subset of it. It deliberately does not repeat
>   the inventory — a second copy would be stale within a wave.
>
> Keep both pointers alive. If this file is ever renamed or moved, those two
> references are what must be updated in the same commit; leaving them dangling
> reproduces, one level up, exactly the loss this register exists to prevent.

**Scope.** Everything below is work that has not landed on `main`. Finished work
is documented where it belongs — `docs/SECURITY-AUDIT.md`, `docs/PERF-AUDIT.md`,
`bench/BASELINE.md`, `docs/CUSTOMIZATIONS.md` — and only a short recent-history
section is kept here so the register has a visible edge.

## Current workset

- `reading-improvements` is published as v0.7.0. Its completed entry is below.
- `mermaid-dark-boundaries` has a reviewed user-directed width revision on
  the reading feature branch, not integrated into `main`.
- Astra source investigation and the viewed Electron PoC are complete.
  Sol/Luna reviews found no blocking issues in the earlier 2px/3px correction.
- Scope: darker-theme shape/container outlines and connecting lines, not text
  or fills. Ordinary borders and normal connectors use 1.5px; lifelines stay 2px.
  Faint neutral strokes gain contrast; stronger and authored styles stay intact.
- Handdrawn/authored visual settings remain author-owned. Fill-only chart data
  gains no invented borders. Unrelated layout/curve settings do not opt out.
- Native-render controls cover modern state compartments/concurrency and the
  unified class alias.
- Baseline controls reproduce the unavailable legacy state renderer and the TOC
  opening-animation assertion failure on both released and corrected source.
- Sol's native size-warning defect is fixed: optional metadata rejection logs a
  warning without discarding native output or valid neighbors. Its focused
  controls and mutation proof passed before the width revision. That source's
  reading checks passed 198/198 and packaging checks passed 414/414.
  Its proof results remain historical evidence, not new-width results.
- The muted `#74818f` color remains approved.
  The user explicitly selected "Use this subtler version" after viewing its
  preview. This approves the appearance only, not a release or installation.
- The user then requested "Can we make borders 1.5px? and 2px instead of 2 and 3?"
  This supersedes the earlier width choice. Combined native-render controls pass
  246/246, including dark/light/dark, high zoom, special participants and popout.
  R935/R936/R938/R942/R943 are individually proven on the revised source.
  Independent Sol/Luna reviews agree: no significant issues. Updated dark/light,
  high-zoom, special-participant and popout captures have been viewed.
- The user also requested 1.5px arrows and other connecting lines, including
  non-arrowed relationships. Lifelines remain a separate 2px default.
- The unconditional-metadata trial adds 31.4ms to the five-diagram render median.
  It is not accepted as noise. The implemented marker-free metadata fast path
  avoids that redundant parse using the actual native render type.
- Before the optimized measurement: fresh-render median/mean may add at most one
  16.7ms frame for five diagrams; settled-scroll p95 may add at most 1ms, callback
  p95 at most 0.1ms, with no geometry/scans or 50ms long tasks. Report added work.
- The earlier 2px/3px source's optimized matched run meets those budgets: render median 165.8ms to
  162.9ms, mean 173.1ms to 172.8ms; scroll median stays 16.6-16.7ms, callback
  p95 about 0.1ms, zero geometry/scans/long tasks. No speedup or free-work claim.
  Configured-source costs remain outside this bounded measurement.
  The current 1.5px/2px revision is not separately benchmarked.
- The private `0.7.1-local.1` portable and NSIS builds are ready from reviewed
  source `29df561ccbe2aee3d7881fbed37a94919342fa75`.
  Strict archive checks pass 414/414; packaged runtime checks pass 8/8 with
  production isolation, dark/light rerender and normal/high zoom.
  Shipped source hashes match, and the packaged captures have been viewed.
  Evidence remains in the session's `private-widths-*` receipts and
  `tmp/private-widths-packaged-r1/`.
  The installer is `dist/Folia-Setup-0.7.1-local.1.exe`; it is unsigned.
  Specific unsigned machine-wide installation consent and user save/close
  confirmation are received; the live process check confirms Folia is closed.
  The ordinary installer launch was refused with Windows error `0x800702E4`
  (elevation required). Nothing is installed yet. The user must open the verified
  installer and handle administrator/security prompts; no workaround is used.
  User diagrams have not been tested.
  No push, main integration, release, tag change or public updater delivery is authorized.
- Existing P2 and nonblocking follow-ups keep their recorded scope and status.

## Update protocol

Read this before editing the file; the value of the register is entirely in it
being current and stable.

1. **Update this file whenever an item starts, finishes, or splits.** Not at the
   end of a wave, not "when things settle" — at the transition. An item that
   changed state in the tracker but not here has already begun rotting.
2. **IDs are stable and are never reused.** `w2-sec08` means the same thing
   forever. If an item is dropped, mark it `DROPPED` with a one-line reason
   rather than deleting the row; a silently vanished ID is indistinguishable
   from a forgotten one.
3. **Splitting keeps the parent.** When an item is broken into subtasks, the
   parent ID stays and gains a nested list. New subtask IDs are namespaced under
   the parent in prose (`w2-f22` → `design-review`, `main-protocol`, …) so the
   totals stay honest — see *Counting* below.
4. **One item, one place.** An item lives in exactly one group. If it plausibly
   belongs to two, pick the one that owns its completion criteria and
   cross-reference from the other.
5. **Evidence, not assertion.** Any number in this file must cite where it was
   measured. This repository's standing rule is *measure; do not reason from the
   code* (`.github/copilot-instructions.md`), and it applies to the tracker too.
   If there is no measurement, say so explicitly rather than estimating.
6. **Completed items move to "Completed recently"** with their commit SHA, and
   are pruned from there once the detail has landed in a permanent document.
7. **Scope decisions are recorded, not just applied.** When the maintainer
   narrows, defers or splits an item, add a dated row to *Maintainer decisions on
   record* and state what the decision costs as well as what it saves. A scope
   change with no recorded reasoning gets re-litigated by the next reader.

## Status legend

**Current continuation model policy (explicit user correction).** Latest GPT
Sol with high reasoning implements; latest GPT Astra performs deep research;
two independent latest GPT Sol/high and GPT Luna/high contexts review.
This supersedes the historical Folia role table for this continuation only.
Substantive proof, performance, source-ownership and release rules remain.

**2026-10-12 release priority correction (explicit user decision).** The
identified Save-alias edge case, hosted shutdown failure and ordinary hosted
CI repair/full-green run are P2, deferred and nonblocking for this release.
This narrows the earlier all-Wave2 release contract only for those cases; it
does not mark their evidence passed or the historical register complete.
The native cross-check remains 501/506, separately from the retained alias
506/506 result. The unfinished alias implementation/tests/reverts are preserved
outside the shipping tree in the continuation's
`wave2-identity-p2-retained-20261012.patch`; its interrupted proof has no verdict.
The mutation was restored and the renderer again matches the committed Mermaid
source. Primary checkouts and failed/skipped hosted evidence are unchanged.

**Renderer isolation remains release-blocking, including responsiveness.**
The user explicitly retained isolation and required no visible performance
regression. The first production bridge consumer is implemented: existing
owned clean-tab disk read, fixed validated method, unchanged main authority and
synchronous no-read fast path. Focused real-Electron baseline is 26/26,
source packaging 360/0; R714-R718 and R735-R737 are individually exact PROVEN,
and the changed test-publication anchor's R675 retains its declared two failures
with product controls passing. Evidence: `owned-bridge-focused-r3-20261012.log`,
`owned-bridge-packaging-r2-20261012.log`,
`owned-bridge-exact-proofs-r2-20261012.log` in the continuation artifacts.
Fresh Sol/Luna reviews converge after Sol identified and the writer corrected
malformed/positive probe counter coupling. Main-window Node/isolation/sandbox
flags are not yet changed; remaining authority/browser/harness transitions and
final-source representative performance measurements are still pending.
Neither functional passes nor the skipped historical comparison certify final
isolation performance. Existing numerical contracts are unchanged.

**Second production bridge consumer — IMPLEMENTED / PROVEN.** One-use
main-issued multi-select extra-file grants now cross fixed `readDialogExtra`;
main's grant/session/sender and post-read checks remain authoritative.
The original batch/replay/stale-read scenarios are reused in a bounded focused
route, with malformed-envelope/response, fixed-field and subsequent ordinary
open controls. Baseline evidence is `dialog-bridge-focused-r1-20261012.log`
and the final split-stream run; R710-R712, R736 and R738-R740 are exact PROVEN
in `dialog-bridge-exact-proofs-r3-20261012.log`, with source restored.
Source packaging is 361/0. Final unmutated focused baseline is 59/59
(`dialog-bridge-focused-final-20261012.log`). Initial review disagreement:
Sol caught a virtual suite property typo that Luna missed; the writer corrected
it. Luna subsequently identified that the isolated probe's missing-batch
refusal did not prove live-grant sender isolation; that evidence claim is
corrected, and live-grant cross-sender coverage remains an isolation gate.
The first
mutation attempt exposed the already deferred lone shutdown diagnostic after
an empty-window teardown. The focused route now also verifies an ordinary
authenticated open after the refusals; no transcript rule was relaxed for it.
Main-window security flags and performance qualification are still pending.

**Document control-plane transition — IMPLEMENTED / PROVEN, unintegrated.**
Actual selection, watcher, quarantine, deletion-query and retirement consumers
now use fixed validated preload methods, including the dynamic tracking-intent
branch. Main authority and send/synchronous ordering are unchanged; this adds
no IPC, content read or digest. Both independent Sol/Luna design reviews
requested nullable query/retirement results, ordinary versus adopted selection,
background quarantine and live-state retirement controls; Sol additionally
identified the dynamic caller outside the original read ranges. Registration
is still provisional: this port tranche does not justify changing production
security flags or claiming qualified responsiveness. Focused boundary and
actual deletion/close evidence is 72/72, including main's live unacknowledged
retirement refusal and the actual reader-confirmed close. Source packaging is
364/0. R753-R755 and affected shared R736/R746/R747 are individually exact
PROVEN in `document-control-exact-proofs-r1-20261013.log`; source restored.
Fresh independent implementation reviews both found no blockers or
disagreement. Boundary spies and the temporary bridge observer remain
transitional Node-enabled test instrumentation, not final isolated-production
evidence. Next is main-issued admission and restore authority: moving these
calls alone does not authorize renderer-chosen paths. Legacy session
compatibility and the hot-path metadata IPC must be preserved and measured,
not renamed into an authority or performance certificate.

**Main-issued admission/restore authority — IN PROGRESS (2026-10-13).**
Independent Sol/Luna design feedback agrees that permission, a byte/version
snapshot and deletion retirement are separate facts. The implementation must
bind physical identity to the actual read, require admitted references at
every authority sink, retain history separately from retired Save ownership,
and make legacy import crash-safe and private before document processing.
The exact legacy session may be grandfathered once with explicit provenance;
that is compatibility, not a claim of historical main approval. No current
page-supplied path list or corrupt-manifest fallback may reopen import.
Restore ordering, unavailable entries and pending-Save settlement/queue tails
remain required. Production security flags and performance acceptance are
still open; the coding handoff is bounded and has a single product writer.

**Admission implementation review — CORRECTIONS ACTIVE, not qualified.**
The frozen real-Electron consumer run is 81/81, private startup/migration
47/47, and source packaging 364/0 in
`.context-viewport-evidence/admission-frozen-*`; these are pre-correction
results, not final acceptance. Both fresh Sol/Luna reviews found permanent
history quota exhaustion. Sol additionally identified superseded-reference
resurrection, a Save-tail ABA window, loss of the newest queued layout on
ordinary quit, executable-bit directory misclassification and an incomplete
alternate-spelling read observer. Luna identified retired historical IDs
accepted into live layout and synchronous Main persistence; Sol also requires
persistence coalescing and measurements, without claiming an observed slowdown.
The single writer is correcting lifecycle fences, live-layout authority and
durable asynchronous persistence in a bounded phase. Prior profiles/evidence
remain retained. The newly introduced quit/layout defect is in scope; it is
not the deferred hosted-shutdown campaign. Existing restore proofs need
equivalent new anchors and actual reproof, and the private session suite needs
normal test wiring. Provisional path routes, remaining privileged consumers,
production security flags and final responsiveness remain open.

**Admission R2 correction — frozen for targeted validation/review.** Both
independent reviewers found the invalid adopted-baseline cleanup and an
unawaited legacy-localStorage frozen-restore oracle. These are corrected without
weakening the preload validator or sentinel. Sol additionally found restored
entry protection surviving a close during held persistence; authenticated
live layout/retirement now consumes that protection before disk acknowledgement,
and successful obsolete writes do not reject merely because a submitted tab
closed. Luna additionally found packaged README incorrectly pointing inside
the excluded archive; both handlers now share the extra-resource/dev helper.
The focused race starts from actual Main restore snapshots, holds the rename
and closes the protected tab. Frozen restore uses approved saved IDs and awaits
the real consumer. Quit captures its final viewport before freezing later layout
submissions. Initial corrected focused evidence is 101/101
(`admission-correction-focused-r6.log`); subsequent README/viewport additions,
equivalent R647/R648 controls, new exact proofs and fresh independent reviews
are pending. Private migration now has a definitive controller aggregate footer.
This is not final isolation, performance qualification or release acceptance.

**Admission R3 correction — targeted baseline passed; proofs/review pending.**
Sol additionally found older provisional owners stranded by spelling-less
retirement-floor lookup, native alternate spellings bound to the wrong logical
tab, and quit acknowledging an old layout while restore was pending. Luna
found the ordinary-suite persistence fixtures still treating localStorage as
session authority. Both reviewers support authenticated spelling lookup,
separate exact logical tabs for differently spelled admitted opens, and
cancelling pending restore before submitting a fresh acknowledged quit layout.
The shared physical target and Save/deletion protections remain unchanged;
opening an alias does not rebind or overwrite a dirty existing tab.
The targeted real-Electron baseline is 122/122
(`admission-r3-correction-focused-r2.log`), private startup/migration is 47/47
(`admission-r3-private-r1.log`), and source packaging is 365/0
(`admission-r3-packaging-r1.log`). The first corrected run was 119/122: its
reopen wait was already true, its held-restore fixture reused historical
approval, and a fixture junction prevented cleanup. The corrected tests await
a new reference, use a genuinely new admitted file and unlink their owned
junction. Neither failure nor the previous interrupted audit is qualification.
Ordinary-suite Main-owned fixtures, exact new/affected reverts and fresh final
reviews remain pending. The Node-enabled transitional suite is not final
renderer isolation or responsiveness evidence.

**Admission R4 correction — behavioral baseline passed; not qualified.**
Fresh Sol found a persistent layout-write failure automatically reissuing quit,
and already-delivered unbound restore references revoked by a concurrent native
open. Luna found the native-ticket consumer silently ignoring a resolved-false
acceptance. Both support explicit refusal notification and delivered-reference
protection with bounded reclamation. Main now protects the successful returned
batch across epoch/same-path pruning, reclaims its unused references on the next
authenticated restore without dropping adoption-grant holders, and permits a
bounded transient reference only for readmission of an existing batch entry.
Binding clears the delivered marker; retired/dead-scope cleanup stays unconditional.
The race parks the native delivery after real admission, releases the successful
restore first, and executes actual restored-owner registration, Save and close.
The full-batch and repeated-unused-batch controls cover retention and capacity.
Persistence failure now enters the existing explicit Main fallback question,
with accurate layout-loss and unsaved-work warnings and Cancel as both default
and Escape. It does not automatically authorize exit, clear the import latch,
overwrite a corrupt manifest or reimport legacy page state. The explicit
fallback follows the existing document-session/continuation checks; it does
not claim a durable layout or a normal renderer phase-two success.
The healthy baseline is 134/134 (`admission-r4-correction-focused-r3.log`),
private startup/migration 47/47 (`admission-r4-private-r1.log`) and source
packaging 365/0 (`admission-r4-packaging-r1.log`). The earlier 41/42 run caught
a misplaced helper extraction at runtime; the subsequent 132/133 run caught
the test assuming closeTab returned a boolean. Both are retained failures,
not qualification. The ordinary generation-matrix reset fixture now begins
from a real native admission; its complete cross-check is pending.
Final independent reviews and exact new/affected mutations are still pending;
draft anchors resolving is not proof. Isolation flags, remaining ports and
representative final-source responsiveness remain open.

**Admission R5 correction — focused follow-up active.** The frozen focused run
passed 134/134 (`admission-r5-focused-r1.log`); the ordinary cross-check ended
346/351 (`admission-r5-ordinary-tabs-r1.log`), retaining the three deferred
navigation/shutdown failures and aborting at a legacy unadmitted restart fixture.
Sol found relative native arguments missing absolute logical tab matches, and
final quit saving fresh scroll alongside an obsolete heading anchor. Luna found
no significant issue; this is not unanimous approval of those defects.
Logical matching now normalizes absolute spellings without resolving aliases or
folding case. Final quit captures both position fields using the existing anchor
helper. Controls exercise an actual relative open/reopen and an overflowing
document restored after a real renderer restart. The affected ordinary terminal
fixtures now obtain a native admission before testing restart recovery. R779/R780
are drafted, not proven; R765/R770 anchors were updated with their mechanisms
preserved. The first follow-up passed 139/140; its setup used integer equality
against a scroll position quantized to 523.2 CSS pixels on this display. The
one-pixel setup tolerance matches the actual-restoration control; that control
and both corrected behaviors already passed. The failed log is retained.
The corrected focused run passed 140/140 (`admission-r6-focused-r2.log`).
Both the restored viewport and native refusal captures were actually viewed.
The latest anchor audit resolves; it is not proof. Fresh independent reviews,
the ordinary cross-check and exact proofs remain pending.

R6 Sol found no new product defect, but caught the ordinary fixture creating a
second provisional tab after its native admission (345/351, retained). Its two
producers now reuse the actually admitted active tab; the strict restart oracle
is unchanged. Luna found no significant issue. Sol also identified R250's
activation mutation colliding with the new restore supersession fence, and
R779's duplicate-layout error reaching the global sentinel. These draft-proof
defects need bounded empirical correction, not new product behavior or blanket
diagnostic suppression. The selected live-name audit passed for private session,
packaging and focused controls; it does not prove a mutation.
R250-R253 now reuse the existing focused batch journey rather than the deferred
ordinary shutdown campaign. R250 explicitly neutralizes its own activation's
restore supersession as a compound probe, retaining token/open-intent/freeze
checks and the complete-batch positive control. This mechanism and R779's exact
additional sentinel evidence are being checked empirically in a serialized
mutation phase. No draft or failed attempt is marked proven.

**Admission proof correction — serialized, product bytes restored.** The first
mutation window qualified R251/R252, but R250/R253/R765/R780 timed out and R779
was collateral; all product hashes were restored exactly. The batch-only
selector reuses the same existing batch tests without the unrelated quota and
admission journeys. Its actual window destruction now precedes the footer,
rather than weakening transcript-tail acceptance. R250/R251/R252 subsequently
qualified (`admission-r7-batch-proofs-r2.log`); R250 is explicitly compound.
R253 exposed two coupled oracles: ordering wrongly depended on active selection,
and unreadable-extra recovery combined retention with selection. Ordering and
retention now remain independent controls; selected-document preservation has
its own assertion. R779 constrains the observed duplicate-layout sentinel hit,
without any mute. The restart oracle now compares against the captured live
viewport, not mutated persisted scroll, after fonts and real paint frames settle;
it does not wait for the desired answer to become true. Corrected exact reruns
and independent test/proof reviews remain pending.

**Admission foundation — reviewed and proven on retained product bytes
(2026-10-13); remaining isolation sinks are still transitional.** Main-issued
native descriptors/tickets, private one-time legacy capture, approved-ID
restore and asynchronous coalesced layout persistence are implemented. R8
fixed a real synchronous bootstrap defect: assigning `event.returnValue`
at handler entry sent a refusal before the accepted branch could reply.
Every branch now sends exactly one verdict. The private test observes the
actual first preload request in Main, verifies the sender/frame/application
URL/nonce setup without exposing the nonce, and R760 fails exactly its declared
replay assertions when the one-use guard is removed. Final private startup
and migration is 54/54 (`admission-r11-private-r1.log`); source packaging is
365/0 (`admission-r11-packaging-r1.log`), not installed-artifact qualification.

The delivered-owner Save/close oracle now owns strict live-layout checks;
the independent same-path native-open control performs an actual owned read.
R761/R772 accurately name their coupled consequences. R769's dedup control
begins from its own real exact logical admission and requires an observed new
reference, not a discarded wait result. R8/R9 exact mutation logs qualify
the new/affected records, including R250-R253, R647/R648 and R756-R780.
R250 and R647/R648 remain explicitly compound probes. Failed setup, vacuous,
collateral and timed-out attempts stay retained; R733/R734 have no verdict.
Each completed proof window verified exact source restoration.

The final lifecycle-only baseline is 117/117 and R769/R102 are individually
exact PROVEN in `admission-r11-selected-proofs-r1.log`. This selector ends before
capacity stress and the subsequent final-quit viewport, persistence-failure and
packaged-README scenarios; those retain their earlier full-run/proof evidence,
not coverage from the final lifecycle run. Real ordinary-open, sentinel and
teardown controls remain. The full focused selector's
120s functional watchdog is unchanged: its R10 attempt timed out at quota
open 408 after 113 passing checks and is not a pass or performance result.
The earlier complete R9 baseline remains 143/143. All product hashes are
unchanged since the converged R8 review; only the later oracles/selectors changed.

The ordinary R9 cross-check was 514/525. Its concurrent-Save assertions sampled
while Main still reported two pending operations; both completions arrived
afterward. The test now proves two synchronous dispatches and awaits the
existing correlated settlement promise with a finite bound, never desired
content. The corrected ordinary R11 run is 524/527: all eight additional
Save/reload/late-edit assertions and installed-restart controls pass; only
the three explicitly deferred navigation cases fail. The intervening R10
early-switch abort remains retained, not attributed to the environment or
declared reproduced/fixed by the fresh passing diagnostic probes.
Fresh Sol/Luna feedback converges on the final oracle changes; Sol's ignored
reopen-wait finding was accepted and corrected, while Luna had not identified
it. Sol also caught an understated description of the lifecycle selector's
omitted scenarios; that evidence-scope wording is corrected. No outstanding
review disagreement remains on this tranche.

**Save/reload transport — IMPLEMENTED / PROVEN; review converged, unintegrated.**
The actual Save/reload/result-acknowledgement callers now use three fixed
validated preload methods. Save and reload retain same-stack dispatch; result
acknowledgement retains asynchronous rejection and exact boolean retry replies.
Metadata is copied and validated; document text is type-checked and passed
through verbatim, with no new IPC, read, digest or content scan.
Both fresh Sol/Luna design reviews support the bounded transition; Sol additionally
required restoring unsent reload bookkeeping and retaining its update prompt.
The actual caller now surfaces delivery errors and restores only its own sequence.
Boundary controls preserve full Unicode/CRLF/NUL document text and empty content;
real queue controls prove pending-before-dispatch, Main serialization, acknowledged
outcomes and rejected delivery without disk writes or lost edits. Independent
Sol/Luna implementation reviews found no product blockers. Sol's nonblocking
queue-byte/reentrant coverage gaps and Luna's underlying-send-throw gap are
corrected, with no outstanding disagreement.
The final owned baseline is 46/46 (`transport-owned-final-r3.log`); final queue-only
is 12/12 (`transport-queue-final-r4.log`). An earlier existing F22 focused
cross-check is 75/75
(`transport-queue-baseline-r3.log`); its filename does not make it the narrow
queue-only selector. R782 and R784-R788 are individually exact PROVEN in
`transport-exact-proofs-r2.log`. That combined attempt remains nonpassing:
R102 exposed the later refusal test reusing the conflicted queue tab.
The refusal test now uses a separate actual native-dialog-admitted editable
document, with explicit descriptor/DOM/editor setup and unconditional chooser
restoration. R102, R781 and R783 are individually exact PROVEN in
`transport-queue-exact-proofs-r4.log`; each completed window restored source
hashes exactly. The failed plain-path fixture attempt remains retained; it did
not supply Main approval and cannot prove admitted setup.
Both independent reviews also converge on the final decoupled native fixture
and its unconditional cleanup. This is not final isolation,
installed-artifact acceptance or a measurement of responsiveness.
Final source packaging is 365/0 (`transport-packaging-final-r1.log`), and the
final anchor dry run resolves (`transport-final-anchors-r2.log`); a dry run is
not a semantic proof.

Next: remaining fixed result/event and browser path consumers,
then production Node-off/context-isolation/sandbox and genuine live-grant
foreign-sender coverage. Provisional/raw compatibility paths still exist;
this foundation is not full path-authority closure. Representative final-source
responsiveness remains unqualified. The retained old hosted comparison did not
run and cannot certify these or future bytes. No performance contract changed.

**Document result/event transition — IMPLEMENTED / PROVEN; review converged,
unintegrated.**
Five fixed preload subscriptions now feed a browser-only local registry used by
the actual renderer/tab consumers. Tab-first takeover, duplicate/last-occurrence
removal, snapshot delivery, renderer delegation and frozen-operation replay
remain intact. One shallow mutable ingress copy is shared across listeners,
preserving Save's object-keyed memoization without deep copying document text.
No Electron event object, public emit or generic IPC capability is exposed.
Recognized fields are projected without coercing or dropping legitimate
uncorrelated refusals or repairing malformed echoed identities into absence.
Main event production and authority stay unchanged, with no new read or IPC.
Independent fresh Sol/Luna implementation reviews found no blockers and agreed
on projection, shared-object delivery and the bounded migration. Sol identified
nonblocking retained-field and synchronous-listener-error coverage gaps; Luna
did not identify those gaps independently. Both improvements were implemented
and both reviewers accepted the final controls, with no outstanding disagreement.
The final owned baseline is 58/58 (`document-events-owned-r3.log`); unchanged
product-byte queue and F22 focused evidence remains 12/12 and 75/75
(`document-events-queue-r1.log`, `document-events-f22-r1.log`). Source packaging
is 371/0 (`document-events-packaging-r1.log`), not installed-asar acceptance.
R789-R802 and affected R252 are individually exact PROVEN on final controls
(`document-events-exact-proofs-r2.log`); repaired equivalent R681/R684/R688/R703
script-order controls are exact PROVEN in `document-events-exact-proofs-r1.log`.
R254 now uses the existing real batch selector, which already executes its
original scenario and must-pass controls; its exact proof is retained in
`document-events-accepted-reopen-proof-r1.log`. Every completed mutation window
restored its source hashes exactly. No legacy full-suite failures were waived
or relabeled. R98's ordinary background-Save record has not been reproven in
this tranche; retain it for the final consumer/harness integration, rather than
infer qualification from the registry identity probe. Other command/quit/
clipboard/path consumers, production flags and final measured responsiveness
remain subsequent gates; these results do not qualify responsiveness or full
isolation.

**Fixed app UI requests — IMPLEMENTED / PROVEN, unintegrated.** The bounded browser-privilege
transition covers native file/image choosers, existing PDF request/ready/results,
Mermaid/table/image popups, update download/install and app-version lookup.
Use fixed request/subscription methods, preserving same-stack delivery and
the existing Main normalizers; do not add arbitrary path opens, generic IPC,
extra reads or payload scans. The permanent PDF theme hold and one-shot popup
result forwarding must retain ordering, independent unsubscription and
observable failure. Independent Sol/Luna design feedback agrees on this scope;
the owned boundary/actual BroadcastChannel controls are 66/66
(`ui-ports-owned-r3.log`), actual PDF theme/popup integration is 398/398
(`ui-ports-theme-r2.log`), and source packaging is 373/0
(`ui-ports-packaging-r2.log`), all in `.context-viewport-evidence`.
R803-R811 are individually exact PROVEN; affected R336/R346/R347/R360/
R377/R378/R381 are PROVEN under their existing declarations
(`ui-ports-exact-proofs-r2.log`), with source hashes restored exactly.
The earlier theme mutation transcripts remain UNUSABLE in the retained r1
log: their terminal footer preceded actual renderer destruction. The fixture
now observes owned destruction before reporting, using an unloaded sandboxed
keepalive to prevent automatic quit racing the observation. Its single-flight
finish reports teardown errors explicitly. No diagnostic is muted and no
transcript rule is weakened; this is not a product shutdown fix.
Fresh independent Sol/Luna implementation reviews converge without blockers.
Both accepted the teardown correction; Sol additionally required the
single-flight/fail-closed completion guard, which was implemented and reviewed.
There is no outstanding disagreement.
The existing PDF protocol has no result on dialog cancellation or request
correlation. Registering the popup waiter before dispatch does not fix canceled
or concurrent exports; the existing unpaired-refusal theme-hold limitation is
also retained, not falsely certified. Local dispatch failure now cleans only
its waiter and reports directly without synthesizing a shared PDF result.
Clipboard/path/physical-metadata/quit consumers, final Main admission gates and
production flags remain subsequent work; no responsiveness conclusion follows.

**Remaining shutdown/notice ports — IMPLEMENTED / PROVEN, unintegrated.**
Actual shutdown request/commit/verify/thaw consumers, their synchronous replies,
deletion acknowledgement/notices, native-open tickets, error/update notices and
newline diagnostics now use fixed production methods. Main's validators and
existing single startup generation invoke remain unchanged. Malformed/absent
refusal identities, null versus empty dirty-file snapshots, nested deletion
ownership, subscriber-before-readiness order and scalar errors are preserved.
No new filesystem work, document-string scan or authorization handshake is
introduced. Actual startup readiness and the extracted original same-id cache
scenario run in the final owned focused route, measured 76/76
(`remaining-control-owned-r8.log`); source packaging is 376/0
(`remaining-control-packaging-r2.log`). The corrected actual F22 route and the
pre-unit product archive both pass 75/75 (`remaining-control-f22-r3.log`,
`remaining-control-f22-pre-unit-r2.log`). This is a functional comparison,
not responsiveness evidence. Earlier 72/75 evidence remains red: two mixed-
newline Save timeouts are retained without an asserted cause, and stale
raw-listener introspection was corrected to select the unique preload wrapper.
The first archive attempt lacked generated vendor runtime and failed before
scenario setup; it is not comparison evidence.
Fresh independent Sol/Luna implementation feedback converges. Sol found a
test-created unhandled rejection in the async-response mutant; Luna initially
did not. The exact campaign confirmed the collateral failure. Its probe now
consumes the rejected Promise while still requiring a same-stack refusal,
without muting the sentinel or widening expected failures; both reviewers
accept the correction. R572 and R812-R818 are individually exact PROVEN in the grouped final campaign
(`remaining-control-exact-proofs-r3.log`), with source hashes restored exactly.
The later positive r6 run remains red (24/26): its tab switch timed out and
fixture cleanup reported EPERM. A bounded diagnostic run passed 76/76
(`remaining-control-owned-r7.log`); no cause or product fix is asserted for the
earlier timeout. Switch diagnostics now observe the actual Promise without
silencing a rejection. Both reviewers accept those diagnostics and the factual
evidence disposition; there is no outstanding review disagreement.
Clipboard and large-render confirmation are the next bounded browser
transition; folder/history/physical metadata, final authority gates and
production flags remain subsequent, with responsiveness still unqualified.

**Clipboard and large-render browser transition — IMPLEMENTED / PROVEN,
review converged; unintegrated.**
Independent Sol/Luna design feedback agrees on a shared browser-native
clipboard helper and a fixed synchronous confirmation method, without new
clipboard IPC or work on the ordinary nonlarge path. Capture exact strings
before menu state clears, preserve existing success feedback only after the
write resolves, and report failures. Main must validate sender/envelope before
the modal and reply once: cancellation stays `false`, transport refusal is
nonboolean and reaches the existing uncached tab fallback. Sol specifically
identified the immediate synchronous reply setter; no provisional reply is
assigned before the modal. Actual code-button/image/code/recent/tab commands
now use browser clipboard writes; exact snapshots, empty code, deferred
success and observable refusal run without changing the system clipboard.
The real owner/isolated-foreign confirmation boundary, scalar validation and
actual tab cancellation/refusal/retry/acceptance/silent paths pass 91/91
(`browser-ui-owned-r2.log`); source packaging is 378/0
(`browser-ui-packaging-r1.log`). R247 now shares its original scenario with
the focused route; R247 and R819-R825 are individually exact PROVEN in
`browser-ui-exact-proofs-r1.log`, with source hashes restored exactly.
Both fresh independent Sol/Luna implementation reviews found no significant
issues; no review disagreement remains. The later restored-source r3 run is
red (28/30): the existing Alpha tab switch timed out before the new consumer
scenarios, and cleanup reported EPERM. Its pending-Promise/readiness diagnostics
are retained in `browser-ui-owned-r3.log`; no cause, environment attribution
or product fix is asserted. Earlier passing and exact proof evidence is not
rewritten as a final green run. Retain the
earlier R247/R823 anchor failures as failures, not passing sweeps. Mocked
clipboard evidence is not actual final sandbox clipboard feasibility.
Folder/history/physical metadata, production flags and actual isolated
responsiveness remain subsequent gates.

**Browser primitive transition — IMPLEMENTED / PROVEN, unintegrated.** Removed
renderer Node crypto and Buffer dependencies using native Web Crypto/TextEncoder for the existing
attestation and an allocation-free shared UTF-8 byte counter for explicitly
enabled diagnostics. Independent Sol/Luna design feedback agrees on the bounded
plan and requested Unicode in the actual adopted-disk journey, not only in a
helper oracle. No additional IPC or default-path diagnostic scan is introduced;
actual final-source responsiveness and remaining main authority are still open.
The Node-free/CommonJS helper route is 9/9; the actual owned-read/dialog journey
is 59/59 with complete BMP/astral Unicode adoption; source packaging is 362/0
(`browser-primitives-loader-r1-20261012.log`,
`browser-primitives-tabs-r1-20261012.log`,
`browser-primitives-packaging-r1-20261012.log`). R743-R745 and the affected
R714-R718 are individually exact PROVEN in
`browser-primitives-exact-proofs-r1-20261012.log`; all source was restored.
Fresh independent Sol/Luna implementation reviews both found no blockers or
disagreement. Byte counting stays within opted-in diagnostics; no latency
neutrality for enabled diagnostics or final isolation is inferred.

**Next isolation transition — ACTIVE design/implementation.** Replace the
remaining browser privileged consumers and provisional path authority with
fixed main-owned operations, preserving restore/basic Save and unchanged-tab
fast paths. Node-off/context-isolation/sandbox and live-grant foreign-sender
controls follow the production ports, not a test-only Node facade.
Approved history/recent/native-fallback opens and tab/recent folder reveal are
**IMPLEMENTED / PROVEN, unintegrated**. They reuse Main's approved-entry/live-native
permission and its existing failure correlation; browser paths are selectors,
never new filesystem authority. Preserve same-stack transport, precise
case-preserving logical targets, existing unsaved guards and relative native
spellings. Actual first-time trusted link/drop capture already exists and is
not duplicated. Unapproved stale recents must be refused visibly and can be
opened through the native chooser, not imported as blanket new permission.
Independent Sol/Luna design feedback agrees on lexical exact-path lookup,
same-stack ports, existing channels and dispatch/correlation cleanup. Both
identified missing private provenance on admission-only reopens; Sol additionally
identified the asynchronous reissuance scope fence, and Luna the invalid
correlation/visible-error distinction. Those corrections are implementation
requirements, not expanded scope. Actual consumer implementation is frozen for
fresh independent implementation review and exact proofs. Focused consumers
pass 105/105 (`approved-request-owned-r3.log`); the actual reload scope fence
holds a successful old-page body read, obtains a genuinely bound new-page
admission, then proves the old read issues nothing into the replacement scope.
Private startup/migration passes 57/57 (`approved-request-private-r1.log`),
including native admission-only reopen and retirement with a corrupt manifest.
Both logs are in `.context-viewport-evidence`. The initial 71/72 failure came
from a legacy close fixture opening a never-approved path; it now uses the real
native chooser and refuses to proceed without a painted admitted document.
First-round Sol found an undelivered result admission retaining permission
after the native tab closed with corrupt history; Luna found no implementation
issue. Sol's finding was accepted. Both browser and native-chooser failed sends
now discard only their newly issued reference, retaining durable history and
the existing live tab. Private corrected evidence is 61/61
(`approved-request-private-r3.log`), including both real refused deliveries.
R827-R831 proved exactly on the first frozen bytes; R826 was UNUSABLE after
the retained earlier Alpha-switch timeout, before its scenario. All source
hashes restored. The same request actors now have a narrow existing-suite
selector, 21/21 (`approved-request-narrow-r2.log`); their full-route 105/105
evidence remains separate, not waived or replaced with a passing label.
R826-R832 are individually exact PROVEN on the final controls in
`approved-request-final-exact-proofs-r5.log`, with source restoration drift zero.
The post-cleanup scope oracle observes issuance as well as retained admissions,
without reading secret values; otherwise cleanup could hide temporary reissuance.
The earlier r2 campaign's R828 WRONG-GUARD is retained: a version-query reply
was not an event-delivery fence. The bounded wait now awaits the exact invalid
correlation error, not an unrelated notification count. Sol identified that
predicate distinction; Luna initially accepted the count-based wait.
Both fresh correction reviews accepted product bytes and the final exact-error
test predicate with no new blockers or remaining disagreement. Nonblocking dedicated post-modal
replacement and in-flight admission-revocation controls remain outside this
bounded actor set; no claim that those scenarios were individually proven.
The first anchor audit found R831's wrong line shape; packaging caught an
undefined source variable then a CRLF-specific census. Corrected source
packaging is 380/0 (`approved-request-packaging-r4.log`). The first narrow
launcher omitted the focused dispatch branch and reached the deferred updater
campaign (55/56); the corrected route preserves the original focused dispatch
and 90-second bound. Final narrow positive is 21/21
(`approved-request-narrow-final-r4.log`), private is 61/61, and source packaging
380/0 (`approved-request-packaging-final-r5.log`). All failed logs remain retained.
This does not close the
subsequent provisional document-owner or renderer physical-metadata routes.

**Native-reference authority closure — IMPLEMENTED / PROVEN, unintegrated (`f9ca5c0`).**
This is the prerequisite for exposing fresh physical metadata without granting
arbitrary filesystem probes. Production native/startup/restore opens already
issue Main references; remove the remaining missing-reference owner route,
bind manual reload to its actual admitted owner and retained read target,
and authorize adoption source paths before their existing filesystem checks.
Preserve current native Save/reload, deletion retirement and held-read
supersession. Browser recents/path strings and a fabricated same-page tuple
must not become read/write/metadata authority. Reuse the actual native chooser,
corrupt-manifest and isolated foreign-window controls; no Node test facade.
Main-owned physical/browser logical helpers follow this authority boundary,
then genuine production security flags and final measured responsiveness.
No new stat/read/IPC is authorized merely to make the boundary easier to test.
Owner normalization, closing identity and retained-owner/Save checks now require
a current Main reference rather than a provisional same-page tuple. Independent
adoption sources use the existing lexical native/history permission before
probes; grants retain and recheck permission/proposed/old-owner authority at the
read, commit, confirmation and completion boundaries. Nullable old owners and
native ticket settlement remain distinct from live-owner authority.
Manual reload carries its reference through the fixed request/event and actual
tab validators, uses the existing owned stable reader, and preserves background
settlement without changing the foreground watcher.

Final focused native controls are 43/43 (`native-authority-positive-final-r9.log`):
actual chooser/Save/reload/deleted-close, independently approved nullable
preparation, genuine foreign-reference refusal, and successful held adoption
and reload bodies revoked by actual same-page owner closure. Source packaging
is 380/0 (`native-authority-packaging-final-r3.log`); private startup/corrupt-manifest
compatibility is 61/61 (`native-authority-private-final-r4.log`), and approved
selectors remain 21/21 (`native-authority-approved-final-r3.log`). These are not
final isolation or responsiveness qualification.
Both design reviewers accepted the boundary; Luna initially over-constrained
background reload and accepted Sol's document-owned compatibility correction.
In implementation round one, Sol found a persistent retargeted link could be
read before the eventual refusal; Luna reported no significant issue. The
writer accepted Sol's finding and restored the existing owned-target check
before the body read, retaining missing-file deletion handling. The real
retargeted-link body observer passed on the preceding reader bytes.
In round two, Sol identified a retarget during asynchronous open, and Luna
identified missing-target deletion hidden by a still-existing file symlink.
Both findings are accepted: the reader now opens its retained case-preserving
physical target and attests descriptor/target identity before body I/O; refusal
checks the retained target, not the link itself. Actual queued-open retarget and
watcher-stopped dangling-file-link controls pass. The safety attestation adds
one pre-body target stat per owned read; its performance is not yet measured.
It adds no body read or metadata IPC and does not change the synchronous
unchanged-tab path. R651 and R833-R841 are exact in
`native-authority-reader-exact-proofs-r4.log`, with restoration, on those bytes.
Round three Sol found no significant issue; Luna found deletion could still be
hidden if the admitted target disappeared while its logical alias retargeted
after descriptor acquisition. The accepted correction classifies a refused
reload against a still-current retained target and checks that target on close,
not the replacement now occupying the logical alias. Actual watcher-stopped
queued deletion and retargeted-close controls pass in
`native-authority-positive-r8.log` (43/43). Fresh independent Sol/Luna correction
reviews and the evidence-only follow-up converge with no blockers or remaining
disagreement. Final R651, R714-R718 and R833-R843 are individually exact PROVEN
in `native-authority-final-exact-proofs-r7.log`, with zero restoration drift.
R841's preceding campaign was correctly COLLATERAL: its logical-open mutation
also bypassed a target-only fixture hook. The real descriptor-acquired actor now
recognizes both admitted spellings, preserving setup, and the compound reader
revert declares its exact queued-open and deleted-target failures. That failed
campaign remains retained. The final native rendered capture was opened and
viewed (`screenshots/tabs-native-authority-final.png`); it is not performance evidence.
R651 and R833-R839 were individually exact in
`native-authority-final-exact-proofs-r3.log` on the preceding reader bytes;
these historical results are superseded by the final-byte proof above.
R651's first
campaign was UNUSABLE after its later native setup failed; the foreign actor
now drains any mutation-created descriptor before proceeding. Updated compound
R651 and R839 are exact in `native-authority-corrected-exact-proofs-r2.log`.
R767/R768 are consumed historical IDs, not current proofs: their former
provisional-owner compatibility contract is intentionally removed, replaced
by the missing-reference refusal controls and R833/R834. Retained outcomes
are unchanged. The broader native scenario now checks mandatory-reference
refusal and the admitted layout instead of expecting provisional Save authority.
The initial native baseline also retained an invalid saved-preview expectation;
the actual Save oracle is disk write plus terminal settlement, followed by a
fresh manual-reload paint. The first foreign actor omitted its real selection
generation and failed transport validation. The first retarget fixture left
only a dangling junction after its target was swept; explicit owned-junction
cleanup fixes the current run, while that failed root/log remains retained.
The legacy owned-reader route now opens its initial fixtures through the actual
native chooser, rather than inventing unadmitted tabs. The former timeout
reported zero known owners; the native-backed core is 81/81
(`native-authority-owned-core-final-r5.log`), preserving unchanged-path, read authority,
held-currentness and atomic-replacement controls. R715's old fallback-only
mutation became vacuous because native binding independently refused it;
its current compound removes both binding protections. R717 now proves both
physical-stat fences using an actually admitted alternate logical spelling.
The existing broader confirmation fixture still creates provisional tabs;
its full route is not green. The narrow core selector keeps all reader controls
and the sentinel, and does not change or certify that broader fixture.
The attempted native-descriptor-only confirmation fixture did not bind a real
adoption and poisoned its later layout; that experiment was restored, not
integrated, and its 99/105 log is retained separately from the earlier 100/105.
The remaining isolated-production harness must replace such provisional
fixtures rather than restore provisional authority.

**Conditional clean-tab version gate — IMPLEMENTED / PROVEN, unintegrated.**
Both independent Sol/Luna design reviews accept one fixed conditional Main RPC:
metadata-only when the freshly inspected version is unchanged, otherwise the
existing owned stable body reader, without a metadata-plus-body round trip.
Both require explicit unavailable/refused outcomes, memory-only live-owner
authorization before probes, preserved ctime policy, and local mutation/ref/
generation witnesses spanning the entire new asynchronous window. The renderer
version/physical gate is removed, not replaced by cached physical success.
The unchanged branch now necessarily crosses IPC; no synchronous/zero-overhead
or responsiveness qualification is claimed. Remaining browser/adoption helpers,
real isolated harness, production flags and final measurements stay open.
Final restored controls are 99/99 native-backed core, 61/61 private document
session and 380/0 source packaging (`conditional-refresh-*-final-*` logs).
R714-R718, R735-R737 and R844-R851 are individually exact PROVEN in
`conditional-refresh-exact-proofs-r2.log`, with source restored; final anchors
resolve and the actual restored-Alpha capture was viewed.
Fresh independent Sol/Luna implementation reviews agree on no blockers.
Their distinct nonblocking findings were corrected: Sol's async switch-oracle
timing and changed-receipt descriptor forwarding; Luna's raw-receipt field-set
gap before preload filtering. Both correction reviews converge without blockers.
The earlier 79/81 inventory mismatch, 93/94 intentional refusal/sentinel mismatch
and failed freeze fixture remain retained, not passing evidence. That freeze
fixture had coupled its wait to an acknowledgement held by layout persistence;
the current hook identifies the actual named conditional metadata stat, and
the real phase-two freeze/thaw is independently observed.
The first exact campaign retains R716 COLLATERAL (four newly covered currentness
legs also failed) and R844 UNUSABLE (the unsafe probe mutant aborted a legitimate
missing-file case). Their corrected exact contracts, not a success-shaped rerun,
are what the final campaign proves. Broader provisional fixtures remain nongreen.

**Adoption post-approval metadata fence — IMPLEMENTED / PROVEN, unintegrated.**
This bounded browser migration removes only `verifyDiskAdoption`'s raw
physical/version probes. Its proposal uses an admitted descriptor; Main retains
fresh preparation/commit/completion checks, now including a version/physical
fence before either confirmation dialog. A fixed non-consuming committed-grant
check replaces the renderer's post-commit probe, while all local mutation,
selection, generation and freeze witnesses remain. Sol/Luna design feedback
agrees on capability-only transport and fail-closed metadata; Sol identified
the missing pre-dialog version fence, which is included rather than accepting
a stale prompt. Other raw selection/post-completion/path helpers, production
flags and final responsiveness remain open. The real native-backed core is
109/109 (`adoption-fence-core-final-r3.log`), including fresh/non-consuming grant
checks, authority refusal before probes, actual late disk changes and actual
deletion-consent positive/stale-before-dialog controls. The first 108/109 run
retains a probe observer that missed the event-emitter-qualified callback name;
the positive probe control exposed that vacuous observation. The first source
oracle also searched for a stripped comment; it now uses function boundaries.
Fresh independent Sol/Luna implementation reviews find no blockers or
disagreement. The first exact campaign retains R853 UNUSABLE (removing the
fresh probe also intentionally fails its observed-positive control) and R856
VACUOUS (the second call overwrote the first forwarding observation). R853 now
declares both exact failures; R856 preserves and checks both calls' actual
field sets. Their corrected exact-count inventory is maintained by the existing
harness self-check; its interim inventory mismatch correctly failed before any
mutations. R714-R718 and R852-R857 are individually exact PROVEN in
`adoption-fence-exact-proofs-r2.log`, with all product/test/proof bytes restored
and matching the immutable r2 review snapshot. Independent Sol/Luna oracle
correction feedback converges without blockers or disagreement.
Final private-session/native-authority/source-packaging controls are 61/61,
43/43 and 381/0 (`adoption-fence-*-final-*` logs). Final anchors resolve, which
is not proof. The restored Alpha/ALPHA_V2 capture was opened and viewed
(`screenshots/adoption-fence-final.png`). These are functional/source controls;
broader provisional fixtures, production flags and responsiveness remain open.

**Pending-Save reopen consumer — IMPLEMENTED / PROVEN, review converged, unintegrated.**
The next bounded migration refuses a missing/malformed native open ticket
after the actual Save wait, rather than reading the caller's path in the
renderer. The normal ticket-backed Main read and its queue/epoch/revision
checks are unchanged; no normal-path IPC or body read is added. Independent
Sol/Luna design feedback agrees on this scope and requires a genuinely held
Save/missing-admission refusal plus the actual returned native snapshot in the
positive control. Reader helpers temporarily remain for the existing explicit
R711 legacy-reader mutant, not a production fallback. The focused consumer
selector must preserve the default correction campaign while excluding its
separate deferred Save-alias edge cases only from this bounded route.
The bounded actual-native consumer route is 28/28 and source packaging 382/0
(`settled-reopen-focused-sealed.log`, `settled-reopen-packaging-final.log`).
R858-R860 are individually exact PROVEN (`settled-reopen-proof-*-sealed.log`),
with product/docs restored to their pre-proof normalized hashes. The legacy
fallback mutant actually performs its body/stat reads; the receipt oracle is
independently sensitive to incorrect returned metadata rather than saved RAM.
Both missing-document and missing-open-ticket deliveries originate in Main
while a real authenticated Save is held. Their exact post-settlement error is
forwarded and observed, not hidden by a silent sentinel. Default corrections
remain intact and their original baseline is restored before that campaign.
The first focused run retains issuance-ticket and forwarded-source oracle
failures; resolved descriptors legitimately omit the issuance ticket and an
empty forwarded console source is not evidence of a silent error. The first
R858 proof's post-footer shutdown tail was fixed by restoring an actual ordinary
authenticated final open, not relaxing transcript rules. The first R860 RAM
substitution also triggered Main's real attestation refusal; its narrower
receipt-metadata mutation isolates the intended oracle. The initial exact-count
inventory mismatch remains retained. Fresh independent Sol6.1/high and
Luna6/high implementation reviews both found no significant issues, with no
remaining disagreement. Parent verification reproduces 28/28 and source
packaging 382/0 on the sealed proof/review bytes; parent also viewed both
restored captures. The final anchor audit resolves, not proof. Broader metadata
helpers, Node-off production and responsiveness stay
open, without a performance qualification.

**Post-render owned metadata consumer — IMPLEMENTED / PROVEN, review converged, unintegrated.**
The accepted independent Sol/Luna design now has one fixed Main/preload
`checkOwnedTabDiskSnapshot` and its first `completeFileOpen` consumer. Main
authenticates the actual retained native owner and a distinct lexical source
permission before filesystem probes; both case-preserving bindings fence one
regular-target stat. Permission/owner currentness is rechecked between probes.
The receipt is strict match/refusal metadata, never a body, FD or new grant.
The consumer retains sequence/freeze, conflict/report/notification and scroll
ordering, with a further sequence/freeze fence after the synchronous port.
This replaces this phase's two renderer checks, not the remaining raw helpers.
Syntax checks pass. Initial anchors fail R844's now-ambiguous short owner-check
anchor; narrow it to its existing conditional handler and reprove, rather than
weakening its exact contract. Genuine native positive controls found that the
entry `event.returnValue` refusal replied before the checks; later assignment
could not replace it. The corrected handler replies once per terminal path.
Both reviewers agree this supersedes their initial no-blocker static result.
The corrected actual production metadata route is 37/37, authority route
22/22, owner-probe retirement route 24/24, and preserved native Save consumers
28/28 (`owned-metadata-runs-r1/green-r2-*.log`). Product/docs restore exactly to
the corrected r2 hashes and no owned Electron remains at this handoff.
R861-R877 and affected R844 are individually exact PROVEN, restored to the
complete review snapshot (`owned-metadata-runs-r1/final-evidence-r3.json` and
its referenced logs). R844's unmutated route reaches 109/109 and its individual
mutant has exactly its declared failure; the earlier tab-switch timeout and
popup-notification collateral stay retained without product popup changes or
baseline-only attribution. R872's accidental registry nesting was corrected
only in the registry; final anchors resolve, not proof.
Final metadata is 37/37; owner/source/stat-probe retirement routes are 24/24
each; source packaging is 383/0. Parent reproduces metadata 37/37, source-probe
24/24 and packaging 383/0 on byte-identical product/test/proof files and viewed
the approved-RAM captures. Fresh complete-unit Sol6.1/high and Luna6/high reviews
converged without blockers. Luna's initial canonical-preflight finding was
retracted after both traced the actual lexical closing-parser path rather than
the adjacent I/O reader; no preauthorization probe occurs on this endpoint.
This adds one small synchronous
RPC to this approved completion phase; latency and final responsiveness are
unqualified. No body read/serialization is added and the clean-tab unchanged
fast path does not take this port.

**Renderer adoption boundaries — IMPLEMENTED / PROVEN, review converged, unintegrated.**
Independent Sol6.1/high and Luna6/high agree that deferred local generations
do not supersede Main's old native owner before selection. Reuse the committed
capability check before selection, with authenticated owner/source spelling
association checks before alias seeding; use the actual retained selection
owner's metadata port afterward and at fallback reload boundaries. They
converged on preserving Main's already-selected sticky baseline aliases even
when later freshness fails: these are correlation, not permission or fresh
binding. Preselection refusal rolls back; a superseded completion must not
overwrite newer aliases. No new Main endpoint/framework is needed.
The preceding metadata unit is committed as `3e369e83`; its proof window is
closed. `beginFileOpen` now verifies the committed capability and lexical
owner/source association before alias seeding, then checks the actual retained
selection owner after Main spends the capability. Delegated reload uses that
same metadata port before display and after render, preserving native-selected
baseline aliases even on freshness refusal. Captured selection/sequence/path/
tab witnesses and freeze guards prevent stale visual completions from updating
newer aliases or conflicts. This replaces these consumer filesystem probes,
not the remaining raw helpers or Node-enabled production flags.
Performance is not qualified.
Native consumer controls reach 98/98; the earlier completion-focused route
reaches 51/51 with explicit begin/completion attribution and actual retained
owner/spent-capability witnesses. Parent reproduces 98/98 and source packaging
387/0 on restored checkpoint bytes and viewed approved-RAM conflict captures.
The initial 23/37 run remains retained: newly added postselection checks were
being counted as completion calls. Corrected assertions separate phases while
still requiring zero completion calls for frozen/superseded outcomes. Separate
source coverage changes only the shared helper input after genuine native
selection and has a real Main positive witness; it is not an independently
produced native reload-source delivery. Other failed fixture assumptions stay
retained.
R878-R891 and affected R871/R876/R877 are individually exact PROVEN; the R1
R878/R888 transcripts were initially UNUSABLE because teardown did not await
Main's actual `webContents destroyed` producer. Their corrected R3 reproofs
and fixture records R892-R894 are individually exact PROVEN. The freeze
fixture also used `__shutdown.reset`, clearing native baselines while leaving
authenticated owners; awaiting close did not prove removal. The source-only,
non-packaged exact-ID `abortCommit` now uses the existing decline/thaw path
without clearing document authority. Wrong/double abort, actual thaw,
preserved native refs/baselines and exact tab/ref retirement are witnessed.
The original restored combined 62/63 timeout remains unexplained; the
instrumented 98/98 pass despite contamination is diagnostic only. R3's sole
writer combined run failed 75/77 on an overstrict historical recognition-row
count; its correction checks the actual live identity and native ref, not
superseded recognition rows. Corrected open/reload selectors are 47/47 and
69/69; the earlier metadata route is 53/53. Parent's direct PowerShell GUI
launch lost stdout and is retained as UNUSABLE, not a passing suite. The
installed Electron CLI wrapper then retained the actual child's lifetime and
transcript: combined 119/119, source packaging 390/0, zero Electron, matching
sealed R3 product/test/proof hashes, syntax/encoding/diff checks and resolving
anchors (not proof). Parent viewed the approved-RAM/conflict captures.
Evidence is retained under `renderer-boundaries-execution-r1`,
`renderer-boundaries-fixture-execution-r2/r3` and
`renderer-boundaries-parent-final-r3`. Fresh independent complete-unit
Sol6.1/high and Luna6/high R3 reviews both found no significant issues or
remaining disagreement. Remaining tab/path consumers, Node-off production
and final measured responsiveness stay open.

**Tab authority consumers — IMPLEMENTED / PROVEN / REVIEW CONVERGED, unintegrated.**
Independent Sol/Luna agree on one coherent custom-tab migration: committed
capability before Main completion, actual retained owner afterward, composing
consecutive synchronous staging checks rather than adding RPC at each former
filesystem line. Post-render relevance precedes quarantine, and rollback
freshness is decided before abandonment. Restore/create must retain its old
stale-snapshot refusal even for background restored entries; successful Save
bookkeeping must retain moved-to-null without requiring the old owner to stay
retained. Both use the existing non-null ref-bound native query: reserve once
and reuse that reservation for restore creation; use the matched decision
identity for Save. Pure snapshot, null-tab and unconditional owned-check
suggestions were corrected after tracing the actual bridge copy shape and
admission lifetime. No new path-key gate or alias rebind is added to the old
nonapproval version gate. Save success/dirty behavior and unchanged refresh
remain untouched. This adds bounded metadata RPCs whose latency is still
unqualified, not a new endpoint or deferred Save-alias campaign.
The renderer boundary unit is committed/pushed as `a0966b46`. Its mutation
window is closed. This dependent custom-tab unit now has actual native
creation 55/55, reload/Save 120/120, background 20/20 and extras/restore 24/24
controls; the bounded terminal selector is 62/62. Parent independently
reproduces the four full selectors, with the definitive footer last, actual
child exit and zero Electron processes, on matching final product/test/proof
bytes. Source packaging is 390/0; syntax, CRLF/diff checks and resolving
anchors pass (resolution is not proof). Parent viewed its retained normal
captures. Fresh independent complete-unit Sol/Luna reviews converge with no
significant product findings. Both distinguish function from performance,
Node-off and repeated-run stability. Sol clears the closure-doc delta; Luna's
narrow wording/evidence corrections are applied: rejected continuations still
run local relevance checks, and historical runtime preparation is cited rather
than offered as runtime qualification. No remaining product disagreement.
Both independent product reviewers found the omitted-timestamp creation
regression; Sol also identified creation without a usable version. Actual
native controls reproduce both on the initial draft, with a complete-metadata
positive control. The correction carries the existing body-read version on
the copied admission descriptor and native-open event projection; a ticket
reread returns its own body version. Later mutable bookkeeping cannot
relabel an older body receipt; ordinary watcher checks do not themselves
assign the admission snapshot version. Null/omitted explicit creation versions may use this
attested fallback; malformed versions and finite timestamp mismatches refuse.
The derived timestamp still goes through the same ref-bound native freshness
query and reservation. Save retains its matched decision identity. This adds
bounded metadata to existing receipts, not a body read or endpoint.
Actual Save ACK acceptance releases delivery/correlation pins before the
matched native query; no physical owner-row deletion or capacity campaign is
claimed. Verified Save advances genuine bookkeeping while the earlier body
receipt remains historical. Rejected native renders after freeze/supersession
perform no late metadata/quarantine/visual work. Rollback checks a real live
capability before abandoning it, for both unchanged and disk-drift cases,
preserving earlier RAM and refusing spent replay.
R895-R903 and affected R860/R893/R899 are individually exact PROVEN. The
initial receipt/rollback fixture mistakes and unusable older-permutation
proof remain retained, not replaced by their corrected results.
The R3 teardown review exposed incomplete read-lifetime observation and a
missing post-yield recheck. Sol agreed with Luna's finding after adjudication.
R4 preserves and de-registers the private root and registered ancestors
before diagnostics, independent of observer counters; a genuine delayed
Main continuation after window destruction and closed observed handles
still resolves/reads its fixture. R900's exact revert removes that protection
and produces the intended preservation/ENOENT failures. Cleanup outside the
native process requires verified child/descendant termination. Both reviewers
converged on this correction. The original intermittent issuance delay remains
unexplained; these functional results are not repeated-run stability or timing
evidence. Parent's initial footer matcher expected the wrong grammar; its
correction validated the existing native creation transcript without retrying it.
Evidence is retained in `tab-authority-controls-r1`,
`tab-authority-full-review-r5` and `tab-authority-parent-final-r5`.
Remaining browser/path helpers, production Node-off/context isolation/sandbox
and measured responsiveness are still release gates.

**Browser identity / privileged fallback cleanup — IMPLEMENTED, qualification active.**
The independent Sol/Luna implementation reviews converge on product R2:
Main-issued descriptor spellings/keys seed correlation before incoming-tab
ownership, while the committed/retained checks remain the freshness authority.
Native absolute-path lexical normalization replaces page filesystem resolution,
without CWD/URL decoding or a general filesystem bridge. Remove unused raw
readers and link/drop fallbacks; preserve anchor handling and total cancellation
of synthetic/invalid links. Relative images require the admitted document base,
and fixed boolean visibility subscription replaces raw IPC. Production Node-off,
context isolation and sandbox are wired together. Earlier product review:
Sol initially finds no significant defect; Luna traces
relative native CLI paths reaching the browser unchanged while admissions are
absolute. Sol independently confirms and retracts that initial conclusion.
Main open ingress now resolves the case-preserving absolute logical spelling
once, without a browser CWD or filesystem bridge. The corrected actual
relative first-launch/event, genuine private link/drop and ordinary Save route
is 32/32; creation/background/receipts are 55/55, 20/20 and 24/24. The complete
reload/rollback/ordinary authenticated Save/ACK/drift route is 106/106,
terminal controls 48/48 and source packaging 398/0. Evidence:
`browser-isolation-controls-r1/handoff-r2-phase-complete-paused.json`.
Both fresh final-unit reviewers find no new significant product defect.
Current exact proofs protect the isolated flags, browser globals, lexical
paths, typed visibility and trusted gestures. R886/R887 remain UNUSABLE,
R891 is now individually exact PROVEN in
`browser-isolation-controls-r1/r2-r891-final-exact-proof.log`, with renderer
bytes restored. Corrected R914 is individually exact PROVEN in
`browser-isolation-controls-r1/r2-r914-final-exact-proof.log`, including its
three declared failures, constrained error evidence and passing controls;
Main bytes are restored and Native processes exited. Historical proof evidence
is not silently renewed. Source is restored and all owned Native processes
exited. The observed 12,986-ms open and later distinct proof timeouts remain
unclassified, not attributed to environment or waived.
Real historical and isolated native-action smokes complete with live error
sentinels; their before/after Mermaid captures were actually viewed.
The historical 100% fixture clips labels, while current labels wrap fully and
the centered diamond is compact at 100% and 150%. This does not assert the
representative source is the user's unavailable original.
Final action automation now checks the complete saved editor body, preserves
watchdog failures and pins the source set; R918-R920 are individually exact
PROVEN. Paired source/dependency-pinned responsiveness measurements, remaining
affected proofs, built-asar/installed qualification and integration remain open.

The original paired action phase stopped at its declared 45-minute ceiling:
73/84 launches completed exit 0, with the exact unexecuted set retained and no
automatic continuation. Complete small open/tab medians remain close, but the
partial large Save median is 814 ms current versus 371 ms historical, with
multi-second Main and renderer stalls on both sources. This is a responsiveness
blocker/diagnostic concern, not a no-visible-effect certificate or an isolation-
only attribution. The independently reviewed raw analysis explicitly leaves
historical FCP/load and conditional clean-tab gates unqualified by the new
endpoints. See `docs/PERF-AUDIT.md` and
`native-action-comparison-r1/phase-outcome.json`. At that paired-phase stop,
shipping source was restored/frozen, Electron had exited and separate bounded
CPU diagnostics were prepared; no automatic missing-job phase, packaging or
publication had begun.
The separate historical CPU diagnostic failed before readiness, with no action
samples; its actual reviewer executor and timestamps are retained in
`docs/PERF-AUDIT.md` and `stall-diagnostic-r1/reference`. Candidate diagnostic
did not run and no stall cause is inferred. The user now authorizes only this
stream owner to execute one current-only large-Save diagnostic, starting
profiles after actual did-finish-load and positive normal readiness. Existing
deadlines, frozen production and the no-visible-slowdown release gate remain.
Reviewers are explicitly read-only; they may not execute diagnostics.
The authorized owner-only current diagnostic now completes exit 0 with
complete disk equality, correlated accepted ACK, both post-readiness profiles
and no Electron survivors. Save is 152.57 ms in this one profiled observation;
it does not explain or supersede the earlier 814-ms partial paired median.
An 11-second control-tab setup stall precedes profiling and remains
unexplained. No justified new isolation root fix is established, and
responsiveness remains unqualified. See `docs/PERF-AUDIT.md` and
`native-action-comparison-r1/current-save-diagnostic-r1`. No automatic
profiling expansion or replacement comparison is authorized.
Independent read-only Sol/Luna review confirms the diagnostic's bounded timing
and correlation interpretation without performance qualification. Both source
reviews identified completion/cleanup issues in the private driver and these
were corrected before the sole app launch; their distinct startup/correlation,
missing-profile evidence and atomic-claim findings were also corrected.
Both missed the Boolean-literal pre-dispatch error, which the owner corrected
and retained honestly. The mutation screenshot for R914 was actually viewed.
Final anchors resolve; this is anchor health, not renewed proof of other units.
Windows packaging preparation now builds both portable and NSIS artifacts
without publication or version change. The first default-output build failed
at an extracted-runtime rename (`EPERM`); its log remains retained and no lock
cause is asserted. The separate fresh-output build completes, and its exact
artifacts are mirrored into the owned `dist` for the existing strict oracle.
Its observed completed tool handle records exit 0 in
`packaging-preparation-r1/build-exit-record.json`. `PACKAGING_STRICT=1` passes
398/0; every archived product source matches the
frozen final-source hashes. Artifacts are still unsigned preparation version
0.4.0, not a new release. Evidence: `packaging-preparation-r1` beneath the
continuation artifacts. Performance qualification, R886/R887 disposition,
viewed packaged/installed smoke, final version, integration and publication
remain open; no additional performance launch is authorized by this build.
The subsequent coordinator autonomy decision follows the actual unavailable-
user reply ("Work autonomously and make good decisions"), not a specific
user option or waiver. It authorizes only this owner for one separate
current-only tab diagnostic: normal startup/readiness, then both profilers
before the previously unprofiled setup-control-tab action, once through its
normal usable endpoint. Original inner guards and 300-second outer bound
remain; no historical retry, synthetic Long Task or replacement comparison.
Independent Sol/Luna source feedback is read-only. Isolation remains in the
release and no-visible-slowdown remains required.

The authorized tab diagnostic is complete, exactly once, owner
22:33:23.407-22:33:30.016 -07:00, exit 0/6.609 seconds and no native survivors.
Both profile starts precede the actual control-tab action. Its usable interval
is 342.306 ms, Long Task 245 ms and Main-loop maximum 20.283 ms; it did not
reproduce the earlier 11-second stall or identify a justified NEW isolation
root fix. Independent read-only Sol/Luna interpretation agrees, with no
disagreement. Source hashes are unchanged. The partial paired results remain
unqualified and unexplained; performance is still a release blocker and no
additional performance launch is dispatched.
The subsequent authorized correctness slot proves R887 exactly (its declared
three failures and positive controls), with byte-exact renderer restoration.
R886 remains UNUSABLE: its after-source setup never reaches the delegated
helper, emits reloadConflict and times out under the existing eight-second
guard. This is not proof, a pass, or a timeout waiver. Full transcript is
`browser-isolation-controls-r1/owner-r886-r887-final-exact-proofs.log`.
R886 specifically removes renderer.js's predisplay refusal branch after the
fixed native snapshot check. Its adversarial cases move the approved version,
owner binding or independently approved source binding before display; the
required outcome is refusal before RAM replacement/render, conflict reporting,
quarantine and retained aliases. The unusable run expires later, before the
after-source control receives a native delivery: no metadata/helper call or
adversarial mutation has occurred, and its target open is still pending.
The observer and authenticated watcher-setup source establish no justified
fixture correction; no speculative wait, guard or expected-failure change is
made. This is a dedicated mutation-sensitivity proof gap, not an established
product defect. Valid R887 explicitly requires the SAME predisplay
before-source exact native refusal as a passing control with that guard
intact; it supplies behavioral coverage, not R886's missing sensitivity proof.
The retained unmutated `r2-native-normal-complete.log` additionally records
PASS for all before-version, before-owner and before-source forwarding and
exact-refusal assertions (lines 49-50, 64-65 and 79-80), with native setup
witnesses and a completed 106/106 footer. Its renderer hash and saved test
source hash equal the current shipping renderer and current test; the later
R3 diagnostics-capability change does not alter the native metadata guard.
The unusable mutant summary does not retain its full assertion stdout:
the harness rejects unhealthy transcripts before enumerating expected
failures. Reaching the later after-source setup therefore does not establish
that every intended R886 failure occurred, nor that any were missing.
The coordinator accepts the scoped native behavior evidence and dispositions
R886 as an open proof-harness/sensitivity follow-up, not an independently
evidenced product/security defect or reason for further app launches now.
The record stays UNUSABLE; the historical proof register is not complete.
Publication remains held on actual user-visible performance acceptance.

Actual private packaged smoke R1 reached a normal native document with the
production Node-off/isolation/sandbox flags and separate userData, then its
harness incorrectly assumed Electron 43 exposed preferences.preload. It
failed before UI checks; its missing native exit remains null, not zero, and
no native process remains. Logs/result/tooling are retained, not replaced.
Its startup stderr independently exposed a real caller/registration mismatch:
the production preload queried a newline diagnostic endpoint that Main
intentionally registers only for development. The narrow R3 correction keeps
that production exclusion: Main advertises availability only in development
through existing native additionalArguments; preload explicitly returns false
without IPC when the capability is absent. No production diagnostic endpoint
is added. Source packaging is 402/0; R921's complete rollback is exact PROVEN
with its declared failures and positive controls, both product files restored.
The first packaging-oracle attempt selected the earlier popup argument array;
its failure is retained and extraction now scopes to the actual Main window.
The new exact record is also included in the harness's pinned self-check
inventory; the earlier self-check failure remains retained.
Changed Main/preload bytes are R3, not the earlier profiled/frozen R2.
Prior R2 performance evidence is not recertified or called final-source
acceptance. Distinct private rebuild and separately declared corrected
ordinary packaged smoke are authorized correctness preparation, not profiler
expansion, a replacement comparison or a performance waiver.
The private R3 rebuild completed exit 0 and matches every archived source;
strict actual-asar packaging is 402/0, artifacts remain unsigned 0.4.0.
Corrected ordinary smoke R2 verifies packaged source/capability/flags,
separate userData, no page Node or marked test control, disabled diagnostic
query and an actually live Electron 43 console observer. Its native-open
screenshot was viewed and is legible. It then fails before Save because its
setup oracle inspects immediate tab.hasUnsavedChanges, while the real input
handler updates renderer dirty state before the later tab fold. The stale
oracle is being corrected separately; no product change is justified by it.
Save/reload/Mermaid/menu/clipboard were not executed. Its own synthetic dirty
document did not close inside the cleanup guard; exact owned PID/creation
cleanup and actual 4294967295 exit are retained, not treated as a green smoke
or assigned to the deferred hosted-shutdown cause. All R1/R2 evidence and
tooling remain separate; no process or proof mutation remains.

Ordinary smoke R3 confirms the live dirty editor, complete exact native Save
body and settled clean baseline. Immediate Save/Exit then leaves the viewer
stale: its saved marker never appears under the original guard. Native exit is
0 with no forced cleanup or survivors; this is not a passed aggregate smoke.
Exact normalized source comparison with actual pre-isolation
`f87aa779b4d402c5c3b398880dd1c2adb313dd26` finds the complete clean-exit
cancellation/discard block and debounced input-preview block unchanged.
The clean exit cancels pending preview and renders only the discard branch.
This historical Save limitation is recorded under the coordinator's deferred
Save disposition, not fixed, hidden by a sleep, or attributed to isolation.
Remaining independent Mermaid/menu/clipboard checks use an explicitly recorded
normal reload precondition in a separate ordinary smoke; they cannot convert
the retained rapid-exit failure into a pass. Evidence and exact source
comparison are in `packaging-preparation-r1/smoke-r3` and
`packaging-preparation-r1/rapid-exit-source-comparison.json`.

Separate remaining-action smoke R4 completes normal native open, explicit
correlated reload, two fresh diagram-bearing manual reloads at higher zoom,
return to 100% without restart, the top-level toolbar menu and actual complete
code copy with the original-clipboard restoration API completing. Original
clipboard formats were not independently read back after restoration.
Both independent read-only
Sol/Luna reviews clear that bounded scope without disagreement. All five
captures were viewed: the representative decision and answer labels fit their
shapes at 100%; the higher-zoom decision is complete, but the answer extends
below that capture's viewport and is not fully visually certified there.
The menu capture verifies its top level, not every nested menu. Native exit is
0 without forced cleanup or survivors. Current packaged diagnostics startup
has no missing-handler error and the post-readiness live console sentinel
reports no other errors. This is private unsigned unpacked 0.4.0 preparation,
not installed verification, a passed rapid-exit case, or performance acceptance.
The actual result and viewed limitations are retained separately under
`packaging-preparation-r1/smoke-r4`. R886's sensitivity follow-up remains open;
unresolved comparative responsiveness continues to hold publication.

**2026-10-14 end-to-end resumption — measured Save fix implemented, revalidation ACTIVE.**

- The user explicitly authorized continued blocker repair, verification and
  eventual integration/release. No further generic Continue is required.
  No-visible-slowdown and isolation remain mandatory; the existing P2,
  F03/kbscroll and R886 dispositions are unchanged.
- Corrected R3 obtained one matched pair, then a real manifest-rename `EPERM`;
  no comparative acceptance follows. The bounded I/O diagnostic located
  multi-second pauses inside truncate-to-zero and stdout writes. Underlying
  OS causes and the earlier rename failure remain unresolved.
- The reviewed Save writer retains every final guard, no-yield boundary,
  descriptor/inode, UTF-8 bytes, fsync and verified readback. It avoids
  unnecessary truncation for equal-sized/growing documents and rejects
  zero-progress writes. Source controls are 414/0; R922 is individually exact
  PROVEN and Main restored. Independent latest Sol/high and Luna/high feedback
  converged after correcting one proof-control mismatch.
- Source-frozen R4 stopped on a harness fixture reset, not an app Save;
  R5 retained ten complete pairs before a hidden-document setup timeout.
  Both remain incomplete, with positive median Save deltas, not passed.
  The user resumed after PC restart; preserved source identities match.
  The bounded existing-tool diagnostic completed both normal journeys:
  current metadata callbacks reached 4.98 ms during open/reload/setup, with
  none in the measured Save windows. Neither its faster immediate singleton
  nor its absent long stall clears R5's positive paired medians. Retained
  post-ACK interval attribution continues; no guard or deadline was weakened.
  This is not selected-sample replacement or a performance certificate. The prior private
  407-check package is now older than Main. Final stable-source package/usability,
  performance acceptance and legitimate integration/publication remain open.
- Evidence and exact limitations: `docs/PERF-AUDIT.md`, section
  "2026-10-14 Save syscall diagnosis and guarded writer correction".

**2026-10-15 current-package verification — scoped visuals complete, performance still open**

- Shipping source is `d52fd0aa`; production bytes did not change in this
  phase. The current ordinary private 0.4.0 package matches those bytes,
  passes strict actual-asar checks 414/0 and excludes private evidence.
  It is unsigned, unpacked preparation, not installed or final-version evidence.
- The corrected packaged Save phase retained twelve complete pairs and
  144 exact Saves before reference 13's natural-draft timeout. Seventeen
  declared launches are unexecuted. Standard renderer medians are
  122.60 -> 122.65 ms settled and 247.80 -> 247.80 ms immediate.
  This does not qualify responsiveness or replace earlier failed phases.
- The separate successful reference witness does not explain the failed
  run. Hiding and continued visibility are both unestablished in that failure.
- All ten declared current-package scenes now have actually viewed accepted
  images: six schemes/table/list/code/inline styles, Search, TOC, short
  Insert Table, and complete 150% Mermaid labels. R2's two transition-time
  captures remain rejected; separate R3 recaptures only those scenes after
  natural animations settle. No product fix or repeated private build.
- Prior source-matched native correctness, toolbar/clipboard and unchanged
  surface evidence remain scoped to their actual results. R886 sensitivity,
  F03/kbscroll and P2/full-run exceptions keep their recorded dispositions.
  No full ordinary/proof chain, installed verification, final version,
  integration, tag or publication is invented.
- Method, exact source/archive identities, all timing endpoints and retained
  failures: `docs/PERF-AUDIT.md`, "2026-10-15 actual default-package Save
  comparison and viewed preparation". No-visible-slowdown remains required.
- The concrete enclosing-setup actor deadline gap is corrected, with actual
  callback controls, corpus 335/335 and exact R923 proof. Both authentic
  packages complete the repaired normal modes; product bytes are unchanged.
  This does not attribute or erase reference 13's timeout.
- The separate repaired R2 completed all 42 declared launches / 21 matched
  pairs / 252 exact Saves in 1,125.210 seconds, without failures, missing jobs,
  reporting errors or survivors. Earlier phases remain separate.
  Renderer medians are 123.3 -> 123.2 ms settled and 236.5 -> 238.2 ms immediate;
  sample p95 is 124.3 -> 124.2 / 295.8 -> 279.9 ms. Full-setup median increases
  of 58.489 / 21.056 ms and real subsecond outliers remain recorded.
  Independent Sol/Luna reviews agree this workload does not demonstrate a
  consistent noticeable Save median/p95 penalty, not practical equivalence
  or whole-app acceptance. Actual cold startup/first paint and cold Mermaid
  remain unqualified; no final release is claimed. Full endpoint definitions
  and distributions are in the complete-comparison subsection of the audit.
- A distinct actual-package cold/Mermaid comparison completed 42/42 launches
  and 21 pairs in 330.558 seconds. Contentful-paint intervals improve; no old
  multi-second Mermaid stall reproduced. Adverse results remain: return-100%
  reload median +29.9 ms / paired +30.0 ms, cold Mermaid paired +20.1 ms and
  multi-open paired +30.6 ms. This is not no-visible-slowdown acceptance.
  Source and a separate boundary witness expose an empty Prism idle callback
  keeping the loading overlay active. The narrow pending-work gate preserves
  all security checks and genuine deferred highlighting. Isolated native
  controls are 40/40; R924 is exact PROVEN/restored. Independent Sol/Luna
  final reviews converge after correcting the older idle test's plain-text
  fixture without changing its timeout outcome. Source-matched package
  revalidation remains before performance disposition.
  The old d52 package is not post-fix evidence. See the audit's cold-path section.

**2026-10-15 post-fix 0.5.0 preparation — measured and viewed**

- Product `676e274f`, version/lock `e2909a95`; ordinary build strict-asar
  414/0, source matched, private evidence excluded, local feed/digests verified.
  Portable/installer remain unsigned; no installed or published pass claimed.
- Separate unchanged-method post-fix comparison: 42/42 launches, 21 pairs,
  323.861 seconds, no failed/missing observations or survivors. Large open and
  cold/warm/return Mermaid improve in every pair. Multi-open retains +32.9 ms
  / +8.8% median, paired +16.8 ms; actor fixture-write outliers remain separate.
  Both independent Sol/Luna evaluations found no remaining observed noticeable
  penalty in these representative journeys. No waiver, global equivalence,
  environment attribution or deletion of earlier failed evidence follows.
- Final-package functional smoke completes six exact normal Saves and actual
  code/token/copy-button/overlay controls. Three fresh captures were viewed:
  code, settled TOC and short Insert Table. Unchanged prior wave views reused.
  Full ordinary/proof history and P2 exceptions are not relabelled as passes;
  R886 sensitivity, F03/kbscroll and feature dispositions remain unchanged.
- Coordinator delegated serialized main integration/publication ownership to
  this isolated child once readiness is real; primary checkout remains untouched.
  At this pre-install boundary, installed verification and final delivery
  remained. The installed follow-up below closes only the former. See the
  audit's post-fix subsection.
- Installed follow-up: user-approved machine-wide 0.5.0 installation, exact
  exe/asar match, same native six-Save/three-view smoke complete in 19.955 seconds.
  All three installed captures were viewed; no errors or surviving runtime.
  Private profile/copies preserve normal user state. This is not deferred
  updater/shutdown/association acceptance. Ready for serialized normal
  integration and tag-bound delivery, with the recorded P2/nonblocking
  dispositions unchanged; no published-release claim yet.

**2026-10-15 serialized main integration**

- Main fast-forwarded from `c61fb365` to `63ecad62` through the normal owner
  connection, without force, a protection bypass or primary-checkout writes.
  Live rules/check state was refreshed first; no concurrent main work diverged.
- Integrated shipping bytes are unchanged from the checked 0.5.0 package.
  Post-integration native controls pass 40/40 and strict actual-asar checks
  414/0. Tracked tree is clean; intentional private evidence remains untracked
  and excluded, not deleted to manufacture cleanliness.
- Mandatory implemented wave units are now on main. Recorded P2 exceptions,
  R886 sensitivity and F03/kbscroll dispositions remain as above. Tag-bound
  release execution and actual published artifact verification remain.

**2026-10-15 Wave 2 release published — v0.5.0**

- Published [Folia 0.5.0](https://github.com/lostinsea/folia/releases/tag/v0.5.0)
  from tag commit `f5b219818a9846a3ca2ddcc3ad7d79fe27c6d744`.
  Normal tag push triggered successful
  [release run 38676428597](https://github.com/lostinsea/folia/actions/runs/38676428597);
  no redundant dispatch, force push or v0.4.0 replacement.
- Windows portable/installer, Linux AppImage/deb, macOS arm64 DMG and all
  three updater feeds are published. All actual downloads match GitHub SHA256
  and sizes; feed SHA512/size checks pass. Each runtime artifact's provenance
  verifies against this exact tag/source digest and release workflow.
- The downloaded portable's complete decoded runtime matches the tested
  ordinary build byte-for-byte, including the installed executable and asar.
  Reuse the actual installed/unpacked functional and viewed evidence; do not
  invent another published-installer execution. The SFX tail warning remains
  in the extraction log; every decoded payload file was compared.
- Windows executables are unsigned; macOS signing/notarization is not supplied.
  GitHub attestations do not make either OS trust claim.
- In-scope implemented Wave 2 changes have shipped. Accepted P2 Save-alias,
  shutdown/full-run/hosted-CI exceptions, R886 sensitivity and nonblocking
  F03/kbscroll remain follow-ups, not passed tests or newly completed features.
  Private evidence/worktree/history are retained; primary checkout untouched.
- Published evidence:
  `.context-viewport-evidence/release-050-published-verification-r1/`,
  including final release/workflow records, downloads/feed checks, individual
  tag-bound attestations and complete runtime-identity comparison.

The capability-protocol unit is IMPLEMENTED / PROVEN, unintegrated: preparation, commit, completion and abandonment
of existing disk-adoption capabilities to four fixed preload methods. It
preserves async/sync ordering, nonce/digest/version/owner provenance and
historical-deletion resolution. Main handlers and their authority remain
unchanged, with no added read or IPC. Independent Sol/Luna design feedback
required preserving nullable initial identities, distinct prepare/commit
envelopes, historical replies and completion's advanced evidence revision;
implemented with focused malformed/positive controls. Final actual owned/dialog
journey is 63/63 (`adoption-bridge-focused-r2-20261012.log`); source packaging is
363/0. The initial 61/63 run retained an obsolete exact API inventory; its
correction now pins the six fixed production methods, not arbitrary IPC.
R746/R747 and affected shared-response R736 are exact PROVEN in
`adoption-context-exact-proofs-r1-20261012.log`. R748's compound rollback was
misdeclared under unsupported `edits`, so its earlier partial run does not prove
the stated full rollback; the corrected complete rollback is exact PROVEN in
`adoption-context-compound-proofs-r3-20261012.log`.
Independent fresh Sol/Luna
implementation reviews found no blockers or disagreement. Remaining metadata,
restore, event/command, main path-authority and test-harness migrations precede
the final security-flag and responsiveness gates.

| Status | Meaning |
|---|---|
| **ACTIVE** | Being implemented right now. **At most one ACTIVE item per delivery stream** (see *Parallel delivery without reducing quality*); the number of ACTIVE items equals the number of live streams. Today that is one. |
| **PENDING** | Accepted, specified well enough to start, not started. |
| **DEFERRED** | Accepted and specified, but deliberately scheduled *after* the current milestone by a recorded maintainer decision. Always PENDING as well, and always says which decision deferred it. Not the same as BLOCKED: nothing technical prevents it. |
| **BLOCKED** | Cannot start until a named dependency lands. The dependency is always named. |
| **GATE** | Cannot proceed without a decision from the maintainer. See *Decision gates*. |
| **DONE** | Landed on `main` with its tests and, where applicable, its revert proof. |
| **DROPPED** | Deliberately abandoned. Kept as a row with the reason. |

An item may be both PENDING and GATE: the work is understood, but the shape of
it is a decision that has not been made.

## Counting

The register holds **25 work items**: 1 active parent and 24 not-started — of
which 20 are PENDING (two of those additionally marked DEFERRED by recorded
maintainer decision) and 4 are BLOCKED on a named dependency. The active count
tracks the number of live delivery streams; it is one today because only Stream A
is editing source. `w2-f22` is
additionally broken into **6 subtasks**, which are *steps within* that item and
not separate work.

A naive row count of the underlying tracker therefore reports **31 open rows**
(1 parent + 6 subtasks + 24 not-started). Both numbers are correct; they answer
different questions. Quote "24 items" for scope and "30 rows" only when
reconciling against the tracker.

## Current active milestone

**Wave 2 — close the remaining audit findings, then release once.**

**Maintainer scope decision, 2026-10-12:** "Complete all of Wave2 before
releasing" supersedes the earlier clean-refresh-only scope: complete the
canonical Wave-2 release obligations, then merge and publish one usable
application release, with no interim release or performance-threshold waiver.
This records scope and authorization, not completion of any acceptance or
release gate; explicitly deferred and non-blocking register items retain
their recorded disposition. `w2-release` is the milestone's exit and is
blocked on the five open `w2-*` items **and on `fullrun`, `shots` and
`final-cleanup`** — eight blockers in total, listed under *Dependencies and
order*. `w2-f03` and `w2-kbscroll` are `w2-*` items that are deliberately **not**
release blockers — do not infer the dependency from the ID prefix.

Active integration work: **`w2-sec08`**; the identified Save/shutdown/ordinary
hosted-CI campaigns are deferred by the explicit priority decision above.
`w2-privacy` implementation/proof is closed; final integrated release checks
remain pending. SEC-08 is incomplete and has no new performance certificate.

**2026-10-12 hosted-CI history repair — implementation/proof reviewed.** The
failed frozen run could not read the theme oracle's historical CSS commit.
Both ordinary CI jobs now request full checkout history; the frozen golden
bytes and commit remain unchanged. The packaging oracle binds depth to each
job's own checkout, with bad-input controls; R725 and R726 individually prove
the corresponding shallow-checkout failure without losing the mate job or
action-pin controls. Source packaging passed 356/356; fresh independent Sol and
Luna reviews found no blockers or disagreements. This is source-config
evidence, not a successful hosted fetch: other observed ownership/setup and
shutdown failures remain open, and the old comparison run is not repeated.

**2026-10-12 logical/physical CI probe and filename corrections — reviewed.**
The owned-read case probe now varies the registered logical spelling, not
its physical realpath; the synchronous delivery witness independently resolves
its expected physical identity. A fresh private junction-alias correctness
run reached and passed the case probe; render-patch passed 198/198 through
that alias. Tabs reached 496/501, reproducing the separate deleted-owner Save
identity failure, cropped failure notification and companion scratch-accounting
failure. The latest R717 reproof refused COLLATERAL because the notification
failure accompanied its intended target; main source was restored. The
basename-first notification correction retains the bounded, sanitized filename,
with a deliberately long parent-path regression. Final native-root tabs passed
503/503; R717 and R727 each individually PROVEN with exactly their intended
failure, and both product sources restored. Source packaging passed 356/356.
Fresh independent Sol and Luna design/implementation reviews found no blockers
or disagreements. The earlier alias deleted-owner and companion failures,
and the hosted shutdown failure, stay open; this is not a green CI or performance
result.

**2026-10-12 user-added Mermaid release requirement — implementation/proof reviewed.**
Full labels and compact, normally padded boxes/decision shapes are in this
release; balanced multiline wrapping is preferred when it shrinks a decision
node. This does not absorb the remaining Mermaid backlog. Representative
captures were opened: at 150% app zoom, Mermaid confuses viewport-scaled HTML
measurements with SVG coordinates and clips labels; the same cold fixture fits
at 100%. The user's add/reload/reset journey is now also reproduced: add
diagrams to a plain document, reload successfully at 150%, repeat reloads, then
return to 100% without restarting. The opened capture still clips full text
against the invalid foreignObject geometry and shows a left-offset, oversized
decision diamond; a fresh reopening of the same source at 100% fits. This
connects the scaled-measurement defect to that transition, without claiming a
separate cache or font cause. Drawing now uses hidden, inert, unzoomed staging
with the original logical width and typography, generation/source/identity
checks and adopted-only caching. Actual SVG children move intact so native
bindings survive. Live zoom-cancellation prototypes were rejected for measured
theme-scroll displacement; they are not the implementation. The supported
160px flowchart wrapping budget keeps the decision balanced, with existing
font/padding and emergency wrapping for identifiers; longer prose and explicit
breaks can gain lines, without post-layout polygon shrinking.

The final targeted Mermaid baseline passed 139/139
(`mermaid-staging-final-independent-scroll-suite-20261012.log`). Complete roomy 100% and
constrained/130% captures were opened: full labels, centered multiline decision,
modest shape padding and connected, labeled edges are visible. Fresh Sol and
Luna feedback agreed on the staged native-output witness for rejected batches.
Sol also found a Gantt test selector that excluded legitimate outside-bar
labels; the corrected baseline verifies both task labels and matching native
dimensions. Sol identified those proof/test blockers where Luna's review did
not; both final focused correction reviews are clear.

R103, R104 and R110 are individually PROVEN with the staged producer witness
separate from live adoption. R728-R732 are individually exact PROVEN. The first
R728/R730 run refused COLLATERAL: incorrect zoom also displaced the reading
point, while an unwrapped identifier made the split-view scroll setup vacuous.
R728 now names exactly both coordinate-related behavioral failures; independent
ordinary paragraphs keep the scroll setup live regardless of identifier width,
and R730 retains its single intended failure with that setup required to pass.
The corrected records passed in
`mermaid-staging-r728-r730-corrected-20261012.log`; other records are in
`mermaid-staging-final-reverts-20261012.log`. Product bytes were restored.
Source packaging passed 356/356; anchors and CRLF audit are clean. Preserved,
opened final visual evidence is `mermaid-label-fit-final-roomy100.png` and
`mermaid-label-fit-final-constrained130.png`. This is isolated-stream closeout,
not completion of Wave 2, performance acceptance, integration or publication.

---

## A. Active

### `w2-f22` — protect unsaved tabs during shutdown · ACTIVE

Unsaved tab content must survive — or at least prompt on — every way the app can
go away: the native window close button, `Ctrl+Q`, an ordinary application quit,
and an update installation. Today those paths differ.

This is the fork's own subject matter. The tab model (`src/custom-tabs.js`) is
fork-owned and the reason Folia exists; a shutdown path that discards a dirty tab
is the same class of data loss as the stale-refresh bug the fork was created to
fix.

**Subtasks** (steps within `w2-f22`, not separate items):

| Subtask | What it covers |
|---|---|
| `design-review` | Independent review of the shutdown state machine *before* implementation — the states, the transitions, and which of them can be re-entered — by the three reviewers named in *Model roles and the delivery handoff*. |
| `main-protocol` | The main-process side: intercept close / quit / update-install, ask the renderer for approval, honour the answer. |
| `renderer-protocol` | The renderer side: snapshot the tabs, detect which are dirty, return an approval decision. |
| `tests` | Live Electron shutdown scenarios — every path above, exercised for real, not simulated. |
| `reverts` | Isolated revert proofs in `scripts/prove-table-fixes.js`, one per independently breakable behaviour. |
| `code-review` | Final independent review by GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna in three fresh contexts, and the corrections it produces — product fixes to Sol at high reasoning effort, test and automation fixes to Terra. See *Model roles and the delivery handoff*. |

**Completion criteria.** All four shutdown paths prompt (or preserve) for a
dirty tab and do not prompt for a clean one; every fix carries a revert with
`expect` *and* `mustPass` entries; `npm run test:tabs` and the affected suites
pass; `--anchors` resolves clean afterwards; **and the mandatory close-path
performance gate below is closed — that is, a final benchmark run evaluated
against a budget declared in advance, not the initial characterization alone.**

**Historical criteria status (2026-09-05): all of the above were met for the
then-current implementation.** Suites, revert proofs, anchors and the
performance gate are recorded below. The later file-lifecycle reconstruction
reopened the execution gates; this historical result must not be used to
approve the current working tree.

**Current extension (2026-09-29): still ACTIVE and not landed.** The expanded
active-editor shutdown gate first failed at raw p95 **90.654 ms (LF)** and
**117.275 ms (CRLF)** against the predeclared **16.7 ms** budget. After correcting
the tab fold, the product-source run passed all **42 observations**, with
**9.633 ms (LF)** and **12.0271 ms (CRLF)** active-editor p95; a further
product change to preserve the failed-Save guard on an ordinary tab switch was
re-attested at **10.9407 ms (LF)** and **12.0808 ms (CRLF)**; a subsequent
review-corrected background-disk-adoption path was re-attested at
**9.6951 ms (LF)** and **11.7335 ms (CRLF)**, each with all 42 observations
under budget. The expanded render-patch fixture passes **193/193**. Its
ordinary-switch failed-Save revert R654 and the separate accepted-disk-adoption
revert R656 are individually **PROVEN** on the current product and test bytes;
the transcript reader now accepts only the exact normal shutdown teardown
after the suite footer and keeps unexpected output fatal. The added regression
proves a renderer-only failed Save survives an unchanged-disk switch, while
accepted external disk adoption clears the stale failure. Earlier independent
Sol and Luna reviews disagreed: Sol found no product defect, while Luna found
this missing disk-adoption case;
Sol subsequently validated Luna's finding. A fresh full review is pending. The
earlier `test:tabs` run to reach the companion checks recorded **317/326**
assertions on the disposable integration tree; it was not a pass. A
before/after query proved that the
**test-only** `__shutdown.reset()` cleared a restored physical tab's
authoritative deletion baseline after its renderer had registered: the same
owner changed from `known:true` to `known:false` while the retained-owner
count stayed unchanged. Reloading to a new renderer generation after the reset
restores a known owner with no unresolved deletion, and the installed
scenarios' first ordinary tab cleanup now passes without bypassing
`closeTab()`. The phase-two exact-positive fixture had withheld the real
renderer commit before forging its reply; delivering the held commit now
proves the renderer froze. Its subsequent clean-close and duplicate-replay
controls also pass after moving their test-only reset before the next renderer
reload and proving the restored physical-tab setup. Another exact-owner
diagnostic found the first gap tab was unfrozen with deletion `known:true`
before a test reset and `known:false` afterward; its close refused, leaving
the older same-path tab behind to contaminate later tests. Closing it through
the existing public path *before* that reset now passes, as does the
post-edit cleanup, without weakening the owner guard. A shared
fail-loud cleanup check exposed a separate test teardown that tried to close
a still-frozen tab after an approved absorbed-user close. A test-only restart
now requires an exact clean or explicitly user-approved terminal response,
matching commit and freeze, and restores every physical owner in a new
renderer before public cleanup and reset; all four absorbed window-close
replay rows pass. A successful final updater quit also passes a distinct
two-approval and positive-launch gate before the same owner restoration.
The absorbed app-quit rows now pass a reason-specific terminal gate as well.
The final absorbed close is drained before the installed suite resets, so
the following semantic cleanup now leaves no restored tabs. The semantic
fixture's cooked renderer script now parses, and its dirty/undo CRLF oracles
match the product's deliberate cache spelling. Deferred-continuation fixtures
now deliver a real renderer verification before injecting loss; the isolated
teardown continuation companion passed **7/7**. The latest full
`test:tabs` run on those fixture bytes reached **333/335**: the installed
updater-error seam, semantic cleanup and ordinary continuation checks passed,
but the dangling-symlink Save button timed out and a missing-file save-race
fixture could not select an authoritative physical tab. That run stopped
before the isolated companions and is **not** a suite pass. Later focused
checks passed save-path races, pending-save/close, edit-mode CRLF and
mixed-newline cases. The initial pending-save conflict was test-induced:
`__shutdown.reset()` cleared an already registered owner baseline; moving it
before registration and re-adopting the same live owner after a later
necessary reset preserved the product's fail-closed guard. A fresh control
tab, exact deletion warning and scoped replacement approval let the deletion
classifier check pass; the focused harness reached **27/27** before timing out
at later inactive/stale-selection fixtures. That is a timeout, **not** a
passing suite. The maintainer chose to retain fail-closed selection of
deleted tabs and not add a new-document/Save As workflow. Opus and Luna agree
deleted-A replay is unreachable; Opus proposed a direct reassertion for the
stale-selection retry, but Luna found that it would test a seam rather than a
user-reachable workflow. The conservative fixture correction will retain the
first owner-inactive refusal and drop both unsupported replay claims; it will
not claim to prove the unreachable `wx+` creation branch. That test-only
correction removes a later forbidden re-selection of frozen deleted A. The
subsequent focused run advances through frozen thaw to the lost-ACK fixture
before timing out after **27/27** checks; the deferred deletion assertions
have not yet run. Scoped diagnostics measured a retry at **4.636 s** and a
consumed ACK at **8.667 s**, then isolated the stall to the test's unbounded
`observeNoFurtherDeliveries` renderer evaluation; no unexpected synchronous
main dialog fired. The observer must fail loudly rather than hanging before
its saved-result oracle can run. After bounding that observer, a later focused
run reached the same lost-ACK case but stalled in the shared
`waitForDeletionAckQuiescence` helper, whose renderer-count evaluation is
also unbounded. Both evaluators are now bounded, but another focused run
reached the **90 s global harness watchdog** before either could return a
pre-watchdog failure: it reported a destroyed window only *after* teardown.
The 90 s focused budget must be measured against the mandatory retry and
quiescence intervals before treating these runs as modal hangs.
A provisional longer focused-only watchdog yielded a definitive **35/47**
run in **111.437 s**; the F22-only watchdog is now **150 s** from that
measurement, while other watchdogs are unchanged. Its first cluster of
deletion assertion failures shared `deletedAOwner: null`: the test observer
recorded asynchronous `ipc.send` owner announcements but missed the
production `select-file-tracking` accepted through `ipc.sendSync`. Capturing
only the real accepted synchronous decision, with exact IPC descriptor
restoration, yielded a definitive **37/47** focused run under the new
watchdog. Its first failure is now the owner-path-moved ACK fixture: it sends
eight intentionally forged ACKs before delivering the real one, but selects
the first forwarded ACK by event ID and reason, which is a forged one that
main correctly rejects. The exact production ACK needs a full-envelope
correlation rather than that partial lookup. The later stale-save-order
fixture still throws `FOLIA_PENDING_SAVE`: its snapshot invokes the shutdown
dirty-list oracle while intentionally holding an earlier Save reply, although
that oracle correctly refuses a pending Save. A test-only correction must
witness the exact refusal while pending and read the dirty list only after
settlement. That exact pending-save witness is now in the disposable fixture,
but the next **37/47** focused run exposed a separate renderer-evaluation
`SyntaxError: Identifier 'tab' has already been declared`. Scoping those
renderer scripts and correlating the owner-path-moved ACK against every
field of the real envelope yielded **38/53** focused assertions. Main now
accepts and retires that exact ACK, but the test's 4.25-second quiescence
window still observes a change in that event's delivery/ACK counts; that
change must be diagnosed, not waived. The later
ordered-save fixture fabricates `tab.content` while its live editor still
contains the base bytes; its B Save consequently fails disk conflict rather
than proving newer-success ordering. A fresh-file disk version also needs
settling before adoption. After those assertions, another fixture refers
to `closeFile` outside its lexical scope; it needs a separately owned reload
tab. None of these runs or partial prefixes is a suite pass.
The next focused run produced five real ordered-save opens, including B's
successful main-process write and the three controlled failures; the first
ordered-save production assertion and pending-save refusal passed. Its stale
A and duplicate C assertions still apply a *global* reload-conflict-empty
condition even though earlier scenarios left unrelated conflict keys, and
the stale-A no-control condition includes B's delayed watcher-resume IPC.
The dedicated foreground reload tab then passed its stale-result and
single-toast check. A later background-reload toast check failed, and the
run reached the close/reopen tab-generation fixture but exceeded the
focused watchdog before any final footer. The owned Electron process tree
was stopped; this is an incomplete run, not an updated pass count.
An exact, one-shot, restored deleted-file confirmation let the subsequent
same-path close/reopen generation fixture pass for both old success and
old failure replies. The background failure-owner check also passed. The
run then reached the separate closed-failure-reply case and timed out at
**43/55 checks** under the 150-second watchdog: this second deleted-file
close uses the same synchronous warning without a scoped test answer.
That established the need for a shared exact close-warning fixture;
**43/55 is a timed-out prefix, not a suite result**.
The shared exact one-shot responder cleared that second hang. The focused
run reached a definitive **45/58**, including passing same-path generation,
closed-success/closed-failure reply, and background-failure-owner checks.
Its next independent phase-two composite fails: a synthesized `file-opened`
payload with no authoritative disk metadata is deferred while frozen but
does not become the active tab after thaw; the fixture also compares a
`replayedOperations` counter that the production shutdown snapshot does
not expose. Opus and Luna independently agree that a real main-produced
`open-file-path` request during this *renderer-only* freeze is the honest
producer and must be observed in the frozen queue before thaw. Three absent
counter comparisons can never pass, and a fourth (`undefined === undefined`)
is vacuously true. Replace them with queue drain, unique tab/owner adoption
and exact content/notification effects; a real main shutdown commit instead
blocks file-open ingress, so this fixture must not claim that boundary.
The other outstanding deletion, ordered-save
and background-toast assertions remain red; **45/58 is not a pass**.
The next focused attempt stopped earlier at **37/47** because a new
ordered-B setup witness incorrectly required the global file-tracking-active
flag, which edit mode keeps false even for a selected owner. That test-only
condition now requires B-correlated `set-active-file` and
`resume-file-watching` controls plus a real selected-owner witness instead.
The next **37/47** attempt proved the selected B owner but exposed a
deadlock in that test requirement: A's reply is deliberately held, so
the pending-save gate correctly emits only B's `pause-file-watching` until
A settles. The `set-active-file` and `resume-file-watching` controls belong
*after* A retires, with a new selection generation; the fixture must prove
that exact transition and no extra controls on duplicate delivery. The
stale-A/C conflict checks are scoped to this document's path key; the
failed-reload toast check
accounts separately for the deletion watcher notification. Those final
edits have **not yet been exercised** by another run, so the 37/47 prefix
must not be read as a regression of the prior 45/58 fixture bytes.
The newest complete focused run is **48/58**: B's selected owner and
pending-save watcher transition, stale-A and duplicate-C invariants,
background reload notifications and closed-reply cases now pass. The real
main-produced `file-opened` event queues once during the renderer-only
freeze, produces one authoritative tab/owner after thaw, and stays
one-shot on a second thaw. The phase-two composite remains red for an
additional test-oracle mistake: its `getActiveDocumentIdentity()` result
has no `selectionGeneration`, and `tabSnapshot()` calls the baseline
`originalContent`, not `original`. Its actual success/failure content,
queue drain, toasts, and second-thaw idempotence match the intended
behavior; the selection check must use a real accepted tracking owner
instead of removing that requirement. Nine deletion assertions remain
red as separate fixture work. No integrated `test:tabs` pass or product
change follows from this focused result.
The accepted-owner witness and corrected `originalContent` checks now
pass in a complete **49/58** focused run, including the full phase-two
renderer-only freeze and thaw composite. All nine remaining failures
are in the deletion-protocol fixture; its first is owner-path-moved ACK
quiescence after an exact main-accepted ACK. This is **not** a full
`test:tabs` pass or a wave-2 release approval.
The deleted-A fixture has since been restructured to keep tombstoned A
active through its Save conflict and explicit reload, rather than switch
to B and make unreachable reselection claims. The first run witnessed
the real main `SaveConflictError` but stalled at main's synchronous
replacement-consent dialog: the exact test responder had been restored
immediately after the asynchronous reload request, before main raised
the dialog. Its lifetime now covers the adoption wait; that revised
fixture has **no complete runtime verdict yet**. Product fail-closed
selection and Save guards remain unchanged.
The final A bytes then passed in a complete **54/58** focused run. The
real A Save conflict, cached tombstone, single watcher across deletion
and recreation, guarded replacement bytes and explicit reload adoption
all passed without allowing deleted-tab reselection. Exactly four ACK
fixture assertions remain red: owner-path-moved no-retry quiescence,
terminal owner-close/replacement-owner delivery observation, inactive
watcher-owner observation, and frozen refusal timing. Main accepted and
retired the exact owner-path-moved ACK, but that event's delivery/ACK
counts changed during the mandatory 4.25-second quiescence window;
the source of the change must be distinguished before changing its
oracle. The complete focused result is not an integrated `test:tabs`
pass or release gate.
Failure-only diagnostics on the next **54/58** focused run found the
exact change: after the accepted terminal attempt 1, main sent the
*same* event ID and watcher generation as attempt 2; the renderer
forwarded one `consumed:true` ACK for that second attempt. The test
restores the owner's path before observing quiescence, so independent
review is checking whether a still-missing file legitimately reactivates
the retained tombstone after that restoration. The diagnostic alone
does not establish either a scheduled-retry product bug or a passing
no-retry oracle; the measured window remains 4.25 seconds.
Opus and Luna independently classify the second delivery as a
post-terminal reactivation of retained deletion evidence, not an
in-flight or timer-driven retry. They differ on the proposed quiet
window: Opus suggests holding the renderer owner path moved until after
quiescence; Luna points out that main's missing-file poll can re-report
the tombstone while the path is still moved. The no-*scheduled-retry*
oracle must therefore distinguish the poll producer from the retry
timer without disabling either the poll or the measured window.
Opus verified Luna's poll counterexample and withdrew the quiet-window
proposal. An honest 4.25-second oracle must positively observe that no
retry timer arms and pair any additional send with re-insertion of the
durable record into the active-delivery map; a count-only zero-traffic
check cannot distinguish the two mechanisms.
Separately, terminal owner-close/replacement-owner ACK checks are being
split from the live owner-keyed acceptance oracle: close retires both
records *before* the held ACK, whereas replacement must positively
witness whether its id-keyed tombstone survives adoption before its
ACK is released. No status has been promoted on that correction.
A later **54/58** focused run witnessed both terminal paths' real
before/after map state and inert late ACKs. Complete disk adoption
synchronously removes the replacement-owner tombstone and delivery,
just as close does for its own owner; no asynchronous adoption message
is emitted. The fixture's last remaining expectation of one such
message was corrected to zero **after** that run; three other ACK
fixtures remained independently red.
The terminal correction and a main-boundary synchronous selection
witness for inactive B now pass in a complete **56/58** focused run,
independently repeated on the same test bytes. Main's accepted B owner
has a distinct tab/path/selection generation and no scheduled retry;
the probe no longer infers main ownership from renderer-only messages.
Only owner-path-moved activation-versus-retry and frozen-delivery timing
remain red. The focused run exits nonzero and does not approve landing.
The owner-path-moved test-only oracle now records ordered same-record
active-map insertions and positive unarmed retry-timeout state, while
retaining the entire 4.25-second observation and exactly matching any
later delivery/ACK to an insertion. Its static checks and R655 anchor
resolve passed; **no Electron verdict on these changed bytes yet**.
Opus and Luna agree the frozen test must hold an authentic main
watcher-produced envelope *before* freezing, release it well inside the
four-second ACK deadline, then witness the renderer's exact `frozen`
refusal and main's parked live record before thaw. Their initial
disagreement about post-thaw delivery was resolved by tracing the
thaw-time owner reassertion; neither proposal licenses a forbidden
ordinary reselection of deleted A.
Luna traced `thawDocument()` to the renderer's accepted tracking
reassertion, which increments selection generation and reaches main's
replay path without a `switchToTab` call. Opus independently traced the
generation guard again and **withdrew** the parked-without-replay
reading: after a genuine frozen ACK, thaw reoffers the same event with
attempt 2 and a later selection generation, then the unfrozen renderer
consumes it. The old run changed the owner's generation but had no
frozen ACK, so it cannot prove this post-thaw replay. The fixture must
prove `frozen` and parked/no-retry before thaw, then that exact
same-event reoffer, consumed ACK and retired record after thaw, without
an ordinary reselection of deleted A.
The first exclusive focused run of both changed test-only oracles exited
nonzero at **55/58** (`f22-frozen-replay-focused-integration-tabs.log`);
owner-path-moved, frozen ACK and a newly red lost-ACK assertion failed.
The main-record `Map.set` snapshots the *prior* attempt before the
subsequent send increments it, so the new activation probe found zero
although the later delivery had attempt 2. Freezing calls
`assertFileTrackingOwnership(..., false)`, which reoffers the missing
owner's event before the held attempt 1 is released: the observed
frozen ACK was attempt 2 and the delayed first delivery was refused as
`stale-selection`; thaw then consumed attempt 3. The lost-ACK main
probe saw `inFlight:true` and a simultaneously armed retry timeout on
its last attempt, so its strict accepted-attempt check failed even
though main retired the record. These are **diagnoses, not approved
oracle relaxations or product changes**; distinguish the timer's source
and review the freeze sequence before correction. An earlier command
accidentally ran the root checkout's 18/18 tabs instead of the
integration worktree and is not F22 evidence.
Opus's read-only freeze review confirms the freeze itself sends
attempt 2 at the newer generation and its exact `frozen` ACK parks the
record with retry unarmed; the test's later hand-delivery of held
attempt 1 is refused as stale, without un-parking, and thaw consumes
attempt 3. The current index-1 post-thaw assumption cannot hold.
Terra owns the bounded test-only correction on the disposable
integration fixture; owner-path and lost-ACK diagnoses remain separate.
Luna's independent owner-path review agrees this is a test-probe
timing defect: `Map.set` snapshots the retained record *before*
`deliverDeletionReport` increments its attempt, so the insertion
appears as attempt 1 although the causally subsequent production
delivery is attempt 2. Preserve the 4.25-second interval and correlate
the insertion to the later delivery rather than demanding attempt 2
on the insertion snapshot. Luna separately found a genuine product
timer invariant violation in the lost-ACK observation: a repeated
producer reoffered a live record with its retry timeout still armed,
so the new attempt was simultaneously `inFlight` with
`retryTimeoutActive:true`. The strict test probe correctly rejects
that state. Main's retry callback clears the timer before sending,
and explicit selection replay clears it before sending; repeated
producer reactivation must likewise not send while a retry remains
armed. Product correction and fresh performance/behavior gates are
pending, not yet approved.
Opus's independent timer trace agrees with Luna on the product
violation: the retry callback, new-record producer and explicit
selection replay enter the sender with retry unarmed, but the
existing-tombstone producer can enter with it armed. Guarding the
sender on the retry handle defers that redundant report until its
bounded backoff expires; clearing the entire attempt in the
producer would instead double-send a genuinely in-flight report.
That latency trade must be documented at the guard and proved in
the focused suite without relaxing the ACK-state oracle.
Sol made the narrow product edit to `deliverDeletionReport` in the
disposable integration worktree: refuse a send while its retry
timeout remains armed. Syntax, CRLF and diff checks passed; the global
`--anchors` run still identifies the **38 inherited** rotted setups
and none names this guard. Terra's revised frozen fixture now keys
the freeze/release/thaw sequence to attempts 2/1/3, respectively,
and statically passes. Neither change has a new runtime verdict;
Terra is correcting the remaining owner-path insertion-to-send
correlation before the next exclusive focused run. Since product
bytes changed, reattest the 16.7 ms active-editor gate rather than
reusing the unchanged-product 42/42 measurement.
The first focused run on the product retry guard plus the corrected
owner-path/frozen attempts reached **56/58**; the lost-ACK case now
passes with its strict unarmed-retry assertion intact. In
owner-path-moved, the independent activation/accepted-ACK witness is
valid but a global ACK-list slice uses the count of *this event's*
ACKs, pulling old forged ACKs into the one-to-one comparison and
terminating quiescence after 2059 ms. In frozen, attempts 2/1/3,
frozen/stale/consumed ACKs, parked state and final main retirement
all occur; whole-snapshot equality across the freeze incorrectly
rejects the intended `isFileTrackingActive:true` to `false`
transition. The test-only comparisons are being corrected while
retaining exact state/ACK and 4250 ms gates. No 58/58 verdict yet.
The guarded product was remeasured in the exclusive process-isolated
F22 shutdown gate: **42/42 observations**, 0 failures, budget **16.7
ms**, worst-case active-editor raw p95 **8.987 ms LF** and **12.1789 ms
CRLF** at 2 MB × 25 tabs; the persistent local result is
`f22-retry-guard-attestation.json`. The next focused run reached
**57/58**: frozen and lost-ACK checks both pass, while owner-path
quiescence still ended after 2059 ms despite a valid same-record
reactivation/accepted-ACK witness. The adapter projected incomplete
delivery/ACK objects and passed `undefined` delivery properties to
the strict one-to-one comparator; it must carry canonical envelopes
and the activation's complete `.identity`, without relaxing the
comparator or the 4250 ms window.
The owner-path adapter now forwards the complete canonical
delivery/ACK envelopes to the strict matchers. The exclusive focused
integration run exited **0, 58/58** with owner-path, frozen and
lost-ACK assertions all passing (`f22-complete-focused-integration-tabs.log`).
Its owner-path assertion requires `observedMs >= 4250`, the exact
post-terminal activation-to-send/ACK provenance, and the forged-ACK
rejections; the frozen assertion retains the pre-thaw parked/no-retry
proof and three exact lifecycle attempts. The **complete non-focused**
`test:tabs` and fresh independent Sol/Terra/Luna reviews are in
progress; neither the focused nor the benchmark pass closes the
remaining integration, individual-revert or release gates.
Fresh independent Terra review found the new retry-timer guard has
**no deterministic break-code witness yet**: the lost-ACK fixture
allows at least three deliveries and does not force a real production
re-entry while `retryTimeout` is armed. Mutating away the guard could
leave 58/58 green. Before landing, add a bounded producer-re-entry
scenario at the live timer boundary with a positive setup witness,
assert no early attempt/send, and individually prove the guard's
revert fails that exact assertion while unrelated legs pass.
The fresh independent **Sol/Terra/Luna** round agrees the active
retry guard cannot be approved from the 58/58 focused result alone:
Terra and Luna both independently require a deterministic duplicate
production attempt while the retry timer is armed. Sol also found
two distinct owner-path oracle gaps: `every()` makes an empty
reactivation list appear valid, and one active-map insertion followed
by a synchronous send failure and a later timer-driven retry could
masquerade as a direct watcher reoffer because the probe only checks
retry handles at insertion and ACK, not during delivery. Terra/Luna
did not report those two additional gaps; no reviewer found a
product stranding path in the retry guard. Preserve the recorded
agreements *and* Sol's additional findings for correction and a
fresh round after changed bytes. The full non-focused tabs run was
already running on the pre-review bytes and must finish before its
test file is edited.
The complete non-focused `test:tabs` run on those bytes has since
finished **426/428, exit 1** (`f22-full-integration-tabs.log`).
All focused ACK cases pass; its two independent failures are the
suite-wide sentinel collecting 11 console errors from intentional
F22 negative cases that ran outside a scoped mute, and the later
renderer-dies-mid-commit fixture reaching neither a pending commit
nor the crash (`crashedDuringCommit:0`, `commitPendingAtCrash:null`,
`settleWhy:fallback-unresponsive`). Neither may be waved away as
focused-only or declared a full-suite pass. Opus is tracing the
commit setup; Luna is checking that any sentinel muting remains
strictly audited rather than hiding unrelated errors.
Luna independently rejects a long F22-wide sentinel mute: generic
`[object Object]` errors cannot be attributed to their intentional
fixture merely by matching their family/source. Use narrow negative
case mutes with awaited failure witnesses, exact suppressed-entry
checks, `unmute()` in `finally` and the existing sentinel liveness
and final no-hits gates.
The mid-commit fixture's no-answer behavior has a source-backed
candidate cause: the F22 frozen test injected renderer-only shutdown
request ID **97001**; `custom-tabs.js` retains that as its highest
request ID for the page. Main's later real request ID **157** is
lower and could be dropped as stale, explaining the absent commit
and `fallback-unresponsive`. The renderer replay-cache seam can
positively confirm the high-water mark; Opus is checking page
navigation between those fixtures before changing test setup.
Opus confirmed the renderer's shutdown-request high-water ID is
module-scoped and only rises until an actual page navigation; it
withdrew its earlier speculative save-latch and preflight theories.
The F22 injected ID 97001 can therefore starve main's later
request 157. Prefer a test-owned synthetic ID derived from the live
renderer cursor and a positive check that main's next real ID still
exceeds it in the full chain; a page reload would rehydrate persisted
tabs and risks a blocking large-render dialog. Any new isolated
fixture must also work under the fresh focused-harness ID range.
The first focused run of the deterministic retry-guard fixture
stopped **28/29** on its *diagnostic*, not a product assertion:
`deletionDetail()` was called before initialization. It also only
compared renderer counts where it promised to prove the main attempt
unchanged. Terra is moving both new assertions below the diagnostic
declaration and adding a before/after main-record witness before
another exclusive verdict; the result is not a retry-guard proof yet.
The corrected deterministic fixture now passes **60/60** in an
exclusive focused run: a live missing-file poll sees the retained
record while a genuine captured retry callback is parked, cannot
advance the main attempt or send an early envelope, and releasing
that callback delivers/ACKs attempt 2. This is **not yet an
individual revert proof**. The first R657 attempt exited
`UNUSABLE` although it restored the product bytes: `test:tabs`
enforces a tagged companion transcript, while the externally
selected focused harness has no companions. Terra is wiring a
harness-owned virtual focused suite, following the existing F22
newline-evidence pattern, so R657 can prove the exact guard without
weakening transcript certification.
The virtual-suite R657 mutation reached the intended assertion but
returned **COLLATERAL**, not PROVEN: automatic missing-file polling
raced the dedicated fixture's parked-retry setup under the reverted
guard and advanced its main attempt before the controlled poll;
the existing lost-ACK assertion also failed from the same removed
guard and is not a valid `mustPass` for this revert. Product bytes
were restored. A test-only suspension of *automatic* polling for
the dedicated path, retaining the captured real poll callback for
the controlled re-entry, and independent surviving setup controls
are required before re-running R657. Do not count either unusable
or collateral attempt as proof.
The dedicated fixture then passed **60/60** after suspending only
automatic 2-second polling on its exact missing-file path while
retaining and invoking the captured real poll callback. R657's
harness-owned virtual suite individually returned **PROVEN, exit
0** (`f22-r657-controlled-proof.log`): with only the retry guard
removed, its positive armed-timer/real-poll setup stayed green and
the exact no-early-send assertion failed. The mutation additionally
broke the older lost-ACK assertion, an unlisted but printed genuine
consequence, not a required independent must-pass. The product
source hash matched before and after the proof; the earlier
`UNUSABLE` and `COLLATERAL` runs remain historical failures, not
proofs.
The first focused run of the bounded synthetic freeze ID stopped
**28/29 before freeze** with a precise setup witness: focused main
and renderer cursors were already **1**, so its asserted zero
baseline/id 1 was false. Terra is correcting the focused-only
premise to allow its actual cursor while preserving the strict
full-chain requirement that main's next real ID exceed the
synthetic ID. No new full-suite verdict on these bytes yet.
Terra's focused/full-chain split now passes the exclusive focused
tabs run **60/60, exit 0** on fixture SHA-256
`300BF6FDF0F2F33F62FEEF9E4DC676D81D3964E6A7253901A60F569BD44BE4D2`.
Focused setup accepts a pre-existing real request while preserving
the full-chain main-cursor inequality. The complete non-focused
mid-commit and suite-wide error-sentinel verdicts remain pending.
The first complete non-focused run on the corrected focused bytes
stopped **353/354, exit 1** before the frozen fixture: main and
renderer cursors were both **156**, and the proposed synthetic
ID **157** would equal main's next real ID, not precede it. The
strict safety gate correctly rejected the injection; this is
neither a frozen-ACK nor a mid-commit verdict. The fixture now
needs a way to freeze without poisoning the later main request,
not another relaxation of the full-chain inequality.
Terra's read-only source trace found that the frozen-deletion case
can drive the real renderer commit listener with the latest
**already-issued** main/renderer request ID and current revision,
without emitting a new phase-one request. It will require equal
positive cursors and assert both remain unchanged after the
commit; the next real main ID then necessarily outranks the
freeze's ID. This tests frozen deletion, not fresh phase-one
consent. Terra is making this bounded test-only correction;
the full suite and sentinel still require a new verdict.
The first complete suite with real-cursor commit-only freeze got
past the frozen fixture (**frozen-ACK and retry-guard cases pass**)
but ended **427/430, exit 1**. Its suite-wide sentinel still caught
intentional errors; the later renderer-dies-mid-commit case still
recorded no intercepted commit, and the isolated portable updater
companion ended **12/13** with `harness threw`. These are three
separate failures, not a passing full suite. The commit-only freeze
removed the demonstrated 157/156 cursor collision; the later
failure now needs its own actual route/fixture-state diagnosis.
The later mid-commit failure is not evidence that the first
commit-only correction failed: a **second** F22 replay fixture
still emitted renderer-only shutdown IDs **910001–910004** after
that case, without advancing main's cursor. Main's subsequent
real request **157** was again discarded by the renderer's
monotonic stale-ID guard. Terra is applying the same bounded
commit-only, existing-real-ID treatment to that replay fixture;
the full suite must be rerun afterward. Source audit found no
other renderer-only `quit-approval-request` emissions in the
tab fixture.
After converting all four late replay freezes to commit-only
real-ID reuse, the exclusive full tabs run reached **428/430,
exit 1**. The renderer-dies-mid-commit case now **passes with an
intercepted real commit**; both frozen-ACK and phase-two replay
fixtures pass. Remaining failures are the suite-wide intentional
console-error sentinel and the portable updater companion's
**12/13 `harness threw`** result. The sentinel still requires
per-operation attribution and bounded suppression; the
companion is a separate blocking fixture failure.
The portable companion's renderer exception was a fixture-state
failure: later cases dereferenced an active tab after successful
hand-off freeze, child-error retry or dead-child reload had left
no such tab. Terra restored and positively witnessed a real
selected fixture tab at each boundary; the exclusive standalone
portable companion now passes **47/47**. Its test-only bytes need
the complete non-focused suite to establish that the parent
companion also passes. Remaining sentinel errors include
pre-F22 file-open/owner-selection scenarios (visible in the
captured screenshots), so attribution must cover the full
suite rather than only F22.
The complete suite on the repaired portable fixture still exits
**428/430**: the child companion is now green **47/47, exit 0**,
and mid-commit still passes, but the parent transcript oracle
still expects the pre-repair **44** checks and correctly rejects
the extra three setup witnesses. Terra is updating that exact
expected inventory. The other failure is the suite-wide
intentional-error sentinel; **no** full-suite green is claimed.
Terra updated the parent portable companion's exact expected
footer to **47/47**, preserving its child-exit and no-fail-line
checks; the complete run on those bytes remains pending. A
read-only attribution pass proves only **three** of the eleven
unmuted console hits by unique F22 save error/path
(appeared-file, deleted-owner, ordered EACCES). Five other
source families account for eight hits but have no reliable
operation label in the aggregate transcript; screenshots
support possible contexts, not proof. Terra is scoping exact
suppression to those three witnessed negative saves first;
the others remain visible until independently attributed.
The first complete run with those three bounded save mutes ended
**431/433, exit 1**. The portable parent companion and the
deleted-owner and ordered-EACCES exact mute assertions passed,
but the appeared-file mute captured **zero** errors even though
its expected `Save failed: The file changed while the save was
starting` remains unmuted in the final sentinel. This disproves
the assumed emit window; Terra is locating the actual producer
before changing its scope. The sentinel retains nine hits:
the escaped changed-file error plus eight unattributed adoption,
tracking, and invalid-save errors. No empty mute is acceptable.
Opening/viewing the escaped error's actual `tabs-error-6.png`
shows the active dirty tab **`f22-producer-save-race.md`**, not
the earlier proposed `f22-save-appeared.md`. Generic changed-file
error text did not uniquely identify its producer: the
appeared-file attribution above is disproven, and the producer
race remains a candidate pending a matched operation/result
witness. Do not count this as a third proven mute yet.
Source/visual tracing then established the changed-while-starting
renderer error comes from the *producer-save-race* (`saveMarkdownFile`)
rather than the appeared-file raw IPC helper; the corrected narrow
mute passed in its first full run. That run nonetheless stopped
**371/376, exit 1** before the suite-wide sentinel: edit-mode CRLF,
mixed-newline and spelling Saves received unexpected on-disk
conflicts, and ordered B did not refresh its settled tracking
owner. The earlier complete run on the old mute bytes passed
these cases. Whether this is timing from the new drain or
independent fixture instability is unproven; do not relax
file-version assertions or claim the scoped-mute patch complete.
An exact-byte complete-suite repeat reproduced mixed-newline
and ordered-B conflicts (**372/376**). More decisively, the
exclusive F22-focused run on the same test bytes, with **no
sentinel or mute active**, failed CRLF/mixed/spelling/ordered-B
version witnesses (**44/49**). That rules out sentinel draining
as a necessary cause. Initial diagnostics indicate a later
metadata-only `ctimeMs` change while other version components
remain equal, but the first transition and its ownership
baseline are not yet located. Terra is instrumenting the
seed→selection→pre-Save path for a discriminating fixture
verdict; do not change disk-version comparison on speculation.
The focused diagnostic now reproduces **44/49** with
post-selection `ctimeMs` moving while dev/ino/size/mtimeMs
remain equal in CRLF, mixed-newline and ordered-B. Mixed and
ordered-B retain the old accepted owner baseline and refuse
unchanged disk bytes; CRLF receives a later reselection and
succeeds. Opus's source trace confirms main's shared version
predicate includes `ctimeMs` and stores **no selection-time
digest**. Simply dropping `ctimeMs` would avoid false conflicts
but lose detection of same-size content changes with restored
mtime, a data-integrity trade-off. The next product investigation
will preserve that protection while addressing ctime-only
drift, with fresh performance attestation required for any
source change. Diagnostic instrumentation is currently gated
behind `F22_CTIME_DIAGNOSTIC=1`.
The role handoff is active: GPT-6 Sol (high) owns the bounded
product correction, preserving metadata-change detection and
the save/path security boundary; Terra owns a separate read-only
test design until product bytes settle. Its proposed controls
are exact ctime-only/same-byte acceptance, same-size changed
bytes with restored mtime rejection, denied-read and unknown
baseline failure, an unchanged fast path, and an individual
revert that breaks acceptance without breaking those
refusals. No new product perf or focused-suite pass exists yet.
Sol's first product iteration retains an owner raw-byte
witness and confines ctime-only acceptance to a checked Save
boundary, keeping the global version predicate strict. The
first exclusive focused run on those bytes stopped **8/9**
before Save: `createActiveTab` could not establish the
producer-race file's physical identity (`identity:null`,
selection generation 1). This is a new product/selection
regression until disproven, not a ctime fix verdict. Sol is
diagnosing within the bounded product assignment; tests,
performance gate and security-negative controls remain
unproven on these bytes.
Moving the witness read until *after* physical selection
removed the first failure, but the next focused run stopped
**17/18**: reselecting `f22-edit-mode-crlf.md` left the other tab
active with no owner. A read that advances ctime can still
poison a subsequent strict selection. This refutes a Save-only
patch as sufficient for these measured bytes; Sol is tracing
the shared selection/owner boundary rather than relaxing
the fixture or assuming a later Save attestation fixes it.
Sol stopped the bounded product experiment and byte-restored
`src/main.js` to its pre-assignment Git blob
`d36976a443a9590a0ad2a94b8ce12c1da01` (including the
earlier retry guard). The version predicate and tab
re-selection/adoption paths also judge ctime, so adding a
baseline read in main can itself advance metadata and cause
the next owner selection to fail. A reliable content-based
exception requires an end-to-end raw-byte witness from the
original read/adoption through main owner authority and
through watcher/reselection, with tamper and performance
controls. Changing only Save or ignoring ctime would be an
unverified scope/security trade-off. This is a genuine
maintainer design gate before another implementation attempt.
**Maintainer decision, 2026-10-01:** ignore ctime-only
differences now, document the loss of same-size changed-byte
protection when mtime is restored, and track a stronger
content-witness design under `ctime-byte-witness` after wave 2.
This resolves the design gate, not the execution gates:
the ctime policy still needs code, exact fixtures and revert
proofs, a focused/full suite, independent reviews and fresh
performance measurement before `w2-f22` can close.
Sol applied the chosen policy at the three shared equality
surfaces in main, tabs and renderer, leaving the version
payload, validity checks, deletion and path-identity guards
unchanged. On those exact product bytes an exclusive F22
focused run returned **60/60, exit 0**, including CRLF,
mixed-newline, spelling and ordered Saves that had failed on
the strict ctime comparison. This is a first behavioral
check, not proof of a controlled ctime-only setup, the
retained non-ctime guards, complete-suite health or perf.
Terra now owns the explicit two-drift selection/Save fixture
and individual per-surface revert records.
Terra's controlled policy fixture now passes in an exclusive
focused run **62/62, exit 0**. On a fresh file it uses a
reversible Windows read-only attribute transition, positively
witnesses ctime-only drift with identical raw bytes and
unchanged dev/ino/size/mtime, then independently proves
real tab re-selection and real correlated Save after a
second drift. Ordinary reads were empirically not a
deterministic trigger; no skip or fixed wait substitutes
for the observed version shape. Individual main/tab/renderer
reverts, complete-suite health and fresh perf remain
pending on the current product bytes.
The process-isolated F22 gate then ran on the same ctime-policy
product bytes and passed **all 42/42 observations with zero
failures** against the predeclared **16.7 ms raw-p95** budget.
At 2 MiB x 25 tabs, worst-case active-editor raw p95 was
**10.1539 ms LF / 13.4979 ms CRLF** (20 samples each);
the exact raw samples and per-point verdicts are in
`f22-ctime-policy-attestation.json` with transcript
`f22-ctime-policy-benchmark.log` in the current session files.
This closes the measured ctime-policy performance gate only
while its product bytes remain unchanged; it does not close
the failing complete-suite/revert/review gates.
The first complete non-focused run on the controlled fixture
ended **420/435, exit 1**. Both new ctime selection and Save
assertions pass and the portable companion passes. Eleven
phase-two malformed-revision cases began with **no held
request** instead of their required clean-commit setup; this
intermittent full-chain fixture problem was known before
the ctime policy and needs its own positive-control diagnosis.
Three narrow intentional-Save mute assertions captured the
right error but failed solely because their expected literal
`renderer.js:4893` source line shifted to **4894** with the
product edit. Those source locations must be asserted by
file/path and valid line shape, not a brittle fixed number;
the final sentinel still reports seven other unattributed
errors. No full-suite pass is claimed.
Terra then added a stronger clean-live setup before each
phase-two malformed-revision case and corrected the three
mute checks to require the exact renderer source file with
a valid numeric line rather than a brittle fixed number.
The first complete run on those test bytes stopped
**213/214** in the renderer setup before any malformed case,
with Electron's generic `Script failed to execute` and no
underlying JS exception detail. This does **not** prove the
phase-two setup is repaired. Terra is surfacing the actual
exception before changing setup logic; product/performance
bytes remain unchanged.
The exception was test-only: the new witness called nonexistent
`getActiveTabId()` instead of reading the exported active
tab's `id`. After correction, the exclusive complete suite
reached **434/435, exit 1**: all phase-two malformed replies,
both controlled ctime policy legs, all three exact
intentional-Save mutes, the mid-commit crash, and the portable
companion pass. **Only the suite-wide sentinel remains red,**
with seven unmuted adoption/tracking/invalid-identity errors
whose operation provenance is not established by the aggregate
log. No broad mute or full-suite green is claimed.
The ctime-policy product bytes now have a fresh independent
Sol/Terra/Luna review round in progress; the Sol author of
the change and the Terra author of the test are not counted
as those reviewers. In parallel, Terra is collecting a
non-suppressing, per-operation sidecar for the seven
remaining console errors. The existing sentinel remains
fully live and red until each event is causally classified;
review and diagnosis do not advance `w2-f22` by themselves.
Fresh independent ctime-policy review round: Sol and Terra
reported no actionable production findings; Luna agreed
the three product comparators are consistent but alone
identified a **cross-platform test blocker**. The new
controlled ctime fixture calls Windows `attrib`
unconditionally, so Linux/macOS `test:tabs` would abort
before either ctime assertion. Terra must supply a
positively witnessed POSIX metadata-only trigger or
report an unsupported environment explicitly; no silent
skip or green cross-platform claim. The reviewers agree
on the product boundary and disagree only in the
test-coverage finding (found by Luna, missed by the other
two). A material test correction requires another
fresh review round.
Terra repaired the cross-platform fixture: Windows still
uses proven reversible `attrib`, while POSIX reversibly
toggles only owner-execute via `chmod`, with the same
byte/version/write-access setup oracles and no skip. The
POSIX path is static-checked but has no runtime verdict yet.
A diagnostic-only full tabs run on the preceding test bytes
again reached **434/435**, with all five hypothesized narrow
console-error windows recording **zero** events. The seven
remaining sentinel hits across five error/source signatures
(with repeats in the raw stream) were *unscoped*: the candidate quit-alpha/beta
clean open, ctime Save, replacement-owner adoption/stale
delivery, and frozen thaw did not emit them within their
drained boundaries. Terra is adding arrival-time
assertion adjacency rather than treating screenshots or
family names as sufficient provenance.
The first arrival-time diagnostic run did **not** reach the
sentinel verdict: it stopped at **212/214** when the phase-two
clean-live setup refused to mutate the document; that initial
error alone did not prove a standing freeze. A second exclusive
diagnostic run stopped at **213/214** and discriminated the state:
freeze clear, zero deferred operations, writable editor, but
**no active tab** after the invalid-revision reload sequence.
Terra added a conditional normal open of the established
quit-beta fixture and an awaited active-tab/path witness;
the next exclusive complete run passed every phase-two case
and returned **434/435, exit 1**, with only the suite-wide
console sentinel red. Immediate
event records placed
one disk-adoption refusal after the negative shutdown-revision
case and before its next assertion, but the other error
families remain unattributed; an attestation refusal during
failed-run cleanup is not evidence about a test operation.
That complete run retained **six** deduplicated sentinel hits
across disk-adoption, tracking-selection/reassertion and
invalid-identity-Save signatures; its diagnostic sidecar
recorded **24** raw console arrivals, including expected
negative cases already scoped by existing mutes. One Save
identity refusal is positively tied to the dangling-symlink
negative case; adoption errors cluster across invalid-revision
reloads, while tracking errors also occurred after unreadable
approval and during deletion-owner exercises. Timing alone
does not establish their decision payloads or justify suppression.
No console errors have been muted on the basis of assertion
adjacency alone.
Independent Opus/Luna sentinel feedback agrees that the
dangling-symlink Save is a controlled negative and that a
suite-wide mute would hide failures. They disagree on the
other families: Opus considers all reload/selection refusals
intentional and proposes exact scoped mutes; Luna finds the
adoption reasons unproven and the tracking/reassertion
failures potentially actionable until owner recovery is
witnessed. The complete transcript supports Luna's caution:
the committed-navigation cluster includes two main-process
`Refusing watcher selection without a valid disk version`
logs, so treating every selection refusal as a deliberately
rejected deleted-file owner would be unsound. The symlink
oracle proves no old-target write and a refused Save, but its
current lexical link-key witness does not exclusively prove
which renderer identity guard triggered; refine its cause
before attributing a new mute to that guard. Terra will
diagnose the navigation owner/version boundary before
changing the sentinel.
The first attempt to capture that navigation witness stopped
earlier at **213/214**: after the invalid-revision reloads,
the clean-live helper's reopen of `quit-beta.md` sent a real
`open-file-path`; main logged a successful read and send,
but the renderer logged both adoption-commit and attestation
refusals and remained without an active document for the
five-second wait. This is not proof of a standing freeze or
a timeout that should simply be lengthened. Terra is
capturing the structured refusal reasons without suppressing
errors before changing the setup again. No navigation-owner
verdict is claimed from this failed run.
The next exclusive run reproduced the early **213/214** stop.
A scoped, non-suppressing renderer diagnostic captured
`capability-target-mismatch` from main's adoption commit,
then `invalid-adoption-identity` (`known:false`, no
capability) on attestation of the reused `quit-beta.md`
path; `currentFilePath` and the selection cursor remained
unset. Both are fail-closed product replies, not proof that
a five-second wait is too short. The fixture repeatedly
resets main's owner baselines while reloading the renderer
and trying to reopen a previously registered path. Terra
must establish a fresh, real owner and a positive selected
document witness without masking either rejection before
the navigation diagnosis can continue.
Terra's fresh physical phase-two fixture then passed every
malformed-revision and commit case with a selected owner
whose physical version, canonical key, tab and page session
were positively matched. The exclusive complete suite
reached **434/435, exit 1**; the only failure was the console
sentinel (**seven** deduplicated hits, **24** raw arrivals).
The navigation witness reached both generation boundaries:
the first had no subsequent tracking refusal; the second
sent two `invalid-selection-disk-version` replies when the
fixture created and switched to a synthetic relative
`f22-navigation-edit.md` tab with **no physical file**.
This does not establish watcher loss for a stable file, nor
justify muting a refusal. Terra is replacing that synthetic
stand-in with a real disk-backed tab and proving its accepted
owner before drawing a sentinel verdict.
The first exclusive run on the disk-backed navigation
fixture passed phase two and the first generation case,
then stopped at **238/239** because a diagnostic referenced
`replacementTracking` outside its block. Terra corrected
that test-only scope error without a second Electron run.
Before repeating it, the positive owner oracle also needs
to respect main's two distinct success reply shapes:
an ordinary accepted `select-file-tracking` reply carries
`accepted`/`trackingActive`, whereas a disk-adoption reply
additionally carries `approvedOwner`; requiring
`approvedOwner` for every normal tab can create another
vacuous timeout. No navigation or sentinel verdict is
claimed from the interrupted run.
After the oracle correction, a fresh exclusive complete
suite reached **434/435, exit 1**. The navigation witness
proved no active file/selection at the first intentionally
empty boundary; the second used the real physical
`f22-navigation-edit.md` owner with a finite disk version
and a main `select-file-tracking` decision of
`accepted:true, trackingActive:true`. Its subsequent
close-state selection was accepted with tracking inactive.
The original dirty-close assertion passed. The remaining
sentinel retained **eight** deduplicated hits from **25**
raw arrivals, including the still-unresolved
invalid-revision-reload adoption cluster, prior-owner
tracking/reassertion clusters and the dangling-symlink
Save refusal. The diagnostic console wrapper contributes
one alternate `?:56` source signature; it is not a separate
product error. No mute has been added.
An attempted normal tab-close cleanup before the malformed
revision reloads failed its own setup at **207/209**:
two fixture-owned tabs remained open despite `frozen:false`,
no deferred operations and no renderer exception. This
was rolled back, not treated as a successful empty-page
setup. `closeTab` also requires an authenticated document
identity and deletion-state answer, which test-only
`__shutdown.reset()` can invalidate while retaining the
renderer tabs. The earlier strategy of closing those tabs
at that boundary cannot be assumed to work. The next
candidate is to clear only the fixture's persisted-tab
state immediately before each *deliberate* renderer reload
and verify the replacement starts empty; no product
refusal will be suppressed.
The first persisted-tab-clear attempt stopped at **207/209**
on an overbroad setup oracle. It positively observed storage
clear from three keys to zero and the replacement renderer
with **zero tabs, no active tab, no current path**, but
then failed because the new page held one localStorage key.
`custom-tabs.js` persists tabs specifically under `openTabs`
and `activeTabPath`; the renderer and theme code also persist
unrelated UI settings. The generic `localStorage.length === 0`
test therefore cannot prove tab restoration and rejects a
valid empty page. That unproven helper was rolled back.
The next verdict must test the two tab keys' *contents* and
the actual renderer tab/active state, not all storage keys.
With that exact oracle, the next exclusive suite passed
**446/447, exit 1**. Both cancel/confirm replacement pages
in all six malformed-revision cases proved zero restored
tabs, no active/current path, and empty-or-absent
`openTabs`/`activeTabPath`; phase two and the physical
navigation owner still passed. The adoption-*commit*
refusal family vanished without a mute. One adoption
*attestation* refusal remains after a separate valid
phase-two commit's deliberate reload. The sentinel retained
**six** hits from **14** raw arrivals, including paired
tracking/refusal errors after the unreadable-response and
deletion-owner scenarios, and the dangling-symlink Save.
Do not claim the remaining events have the same cause
as the eliminated malformed-revision contamination.
The next exclusive complete run again reached **446/447**,
with **five** deduplicated sentinel hits from **13** raw
arrivals; the intermittent valid-commit-reload adoption
attestation did not occur on those bytes. A scoped,
non-suppressing diagnostic around the unreadable-response
operation and real-handler restoration saw **zero**
tracking errors and the same active physical
`phase-two-reopen-1.md`, finite version and owner identity
before/after. Two selection refusals and a failed
prior-owner reassertion appeared 5–6 ms *after* that
scope ended, before the next staleness PASS. The next
fixture operation resets test-only main state and creates
a `quit-alpha.md` tab with synthetic `cached-answer` bytes
unrelated to the disk. Terra is testing whether that
unnecessary tab creation, rather than the unreadable
response, generates the three errors. No mute is justified
by the earlier assertion adjacency.
After removing that artificial tab creation, an exclusive
run passed the physical same-ID cache, fresh/stale and
duplicate-response assertions, and reached **447/448,
exit 1**, sentinel-only. The unreadable-response tracking
cluster disappeared without a mute; the remaining
**three** deduplicated sentinel hits came from the
dangling-symlink Save and a selection/refusal pair after
the inactive-deleted-owner scenario. In the latter,
main's exact log names `f22-deleted-inactive-a.md` as
`ENOENT` while verifying a watcher selection. The fixture
then calls a shared `clearTabs()` that closes all tabs
concurrently; if B closes while missing A remains, ordinary
selection can try A and fail. Terra must prove the ordering
and close missing A before B with positive live-owner and
no-reselection witnesses, or report the actual different
cause; no broad deletion mute is justified.
The first sequential-cleanup run stopped at **370/372**
on a test-probe cardinality assumption, not a watcher
refusal: main's `recordSnapshot()` projected the same
owner-keyed deletion record twice (`count:2`, one
ID tombstone) before close, then zero records/tombstones
afterward. It observed the exact deletion warning for
A, A removed, B still active with its real owner, and
**zero** missing-A watcher selections during that
interval. Terra changed the oracle to require matching
identity/state for every projection and complete retirement
rather than one projection only; this correction has not
had an exclusive complete-suite verdict yet. The
three-hit sentinel state above still applies only to
the earlier fully completed run.
The corrected sequential cleanup then passed in an
exclusive complete suite, **449/450, exit 1**:
the exact deletion warning retired missing A and its
owner-keyed record while B remained selected, B closed
only afterward, and all downstream frozen/replay checks
passed. **Zero** tracking-selection or prior-owner
reassertion refusals remained. The sentinel's **one**
retained hit is now the dangling-symlink Save's
`Refusing save with invalid document identity` at
`renderer.js:4462`; the sidecar recorded eight raw
events including already-scoped intentional negatives
and its self-proved liveness probe. Do not call the
complete suite green or mute this final hit until the
exact Save guard cause and selected symlink owner are
positively witnessed; the current test's lexical
link-key comparison is weaker than renderer's actual
alias-aware document state key.
An exclusive focused symlink diagnostic then passed
**65/65** and established the exact missing cause:
the Save button returned in the renderer before sending
any main Save IPC; its alert was exactly `Failed to save
file: Document identity is unavailable.` The actual
`canonicalReloadPath(currentFilePath)` resolved to the
dangling link spelling, while the selected identity still
named its removed old target. The mismatch triggers
renderer.js's invalid-identity guard *before* its
selection-generation checks; the public identity does
not expose `selectionGeneration`, so no unproved
generation claim is needed. Terra is tightening that
actual-key witness and adding one awaited, exact-source
sentinel expectation limited to this Save. The alternate
main refusal branch remains valid only if it raises no
renderer diagnostic. A focused pass does not itself
close the complete-suite sentinel gate.
Sol rechecked the owner-path reviewer finding: requiring at least
one activation and exact accepted attempt = the activation's
pre-send attempt + 1 closes both its empty-replay and synchronous
send-failure/timer-retry counterexamples for the current product;
returning a missing ACK must be null-safe and fail the oracle, not
throw. Sol qualifies that this arithmetic alone would not rule out
a hypothetical future timer armed before the first send, so the
unarmed-at-insertion and ACK-state controls still matter.
Independent Opus/Luna fixture reviews agree that the test's unawaited
deleted-A to B to A switches leave B active, so a subsequent Save and
explicit reload cannot prove anything about A. A must remain active until
its tombstone Save refusal and explicit reload have been witnessed; the
forbidden ordinary reselection claim must go. Both reviewers also require
the inactive-owner probe to observe main's actual accepted watcher owner,
and the frozen-ACK case to witness a still-standing freeze at delivery.
Opus initially proposed using an id-keyed tombstone for both terminal ACK
reasons; Luna noted that owner close retires that tombstone too, and Opus
confirmed the correction. The owner-closed late ACK must be proved inert
after its records have been retired at close; the replacement-owner case
needs a separate positive pre-delivery record-presence witness rather
than the shared owner-keyed acceptance assumption.
An earlier full run also saw phase-two negative cases unexpectedly enter a
user dialog instead of the expected clean commit, so that intermittent fixture setup
still needs a discriminating witness; other full runs passed those cases on
the same product bytes.
`test:packaging` passes **271 checks**
with one expected built-asar skip. The global `--anchors` audit identified
**38** older records whose mutations need repair and individual reproving.
Final independent reviews, remaining suites, permanent measurement records
and serial integration are also pending.

**F22 fixture update (2026-10-01, isolated integration worktree).** The
phase-two, navigation, same-ID cache and inactive-deletion fixtures now use
physical selected owners and ordered cleanup rather than silencing watcher
refusals. A misplaced symlink-test `finally` initially made the portable
companion fail to parse; it was removed before any further Electron run.
After a focused **65/65** pass, full runs exposed two intermittent
reload/reset races: main's test reset could clear an owner baseline before
the reloaded physical tab's tracking selection completed. The valid-revision,
valid-dirty and sender-gate paths now each prove the new renderer's exact
restored owner and accepted tracking decision before reset. The symlink
Save fixture captures the actual prepared identity, requires its selection
generation and owner fields to match, and distinguishes the exact
renderer-refusal and main-failure diagnostics without a broad mute. Its
raw console observer does not wrap `console.error`, which would change
Electron's source to `?:111`; both focused and full runs now require the
exact native console error before a bounded boundary completes. Both
named symlink fixtures are cleaned up on every outcome. The latest
machine-exclusive focused and complete tabs runs passed **67/67** and
**460/460** respectively, with **zero full-suite sentinel hits**, on test
SHA-256 `610851160F8F6C0A3565EC7FE49619BF1DCA73AC28A847C29166D160F99CB1DE`;
the complete record is `files/f22-final-oracle-correction-full-tabs.log` in
the current session. These are suite verdicts, not revert or release verdicts.
The subsequent R658 isolated mutation removed only renderer's pre-IPC
path-key guard. Its focused run failed the precise renderer-refusal assertion
while the valid-target symlink Save remained green; the record returned
**PROVEN** and restored the renderer source hash exactly. The clean focused
suite on those newer test bytes passed **67/67**. The **460/460** full-suite
verdict above predates R658's tightened branch oracle; it must be repeated
on final bytes. The older rotted anchors and the remaining independent
revert proofs are still open.
R659 individually returned **PROVEN** with the unchanged owner assertion
rejecting a controlled early wait that had seen a tracking selection but
had not captured a restored physical owner. The three nonempty persisted
physical-path setup controls remained green; valid-dirty and sender-gate
selection assertions also failed as expected collateral. The harness
restored the test source hash exactly. Neither R658 nor R659 resolves the
older rotted anchors or substitutes for a complete post-proof tabs run.
The final-byte R657 retry-guard proof returned **PROVEN** again. R661
(CustomTabs' ctime equality) and R662 (renderer comparator's directly
observed ctime-only equality, with non-ctime and invalid-input controls)
also returned **PROVEN** individually, with product bytes restored. R660
(main's ctime equality) was initially **UNPROVEN**: an isolated proof-only
checkpoint reached its controlled assertion and collateral controls, but
the harness correctly rejected the mutation transcript because delayed
unprefixed Save diagnostics followed the terminal suite footer. Waiting
for the main Save queue to drain did not resolve that transcript failure;
that unsuccessful probe was removed. Do not treat a checkpoint or an
anchor dry-run as an R660 revert proof. The complete tabs suite on the
current test bytes passed **464/464** with no sentinel hits or stalls
(`files/f22-ctime-sentinel-confirm-complete-tabs.log`); one prior green
run reported a sentinel stall, so only the later clean-instrument run
supports this current verdict.
The next proof-only checkpoint before the intentional path-race Saves
eliminated those delayed Save diagnostics, but R660 still returned
**UNUSABLE**: the terminal transcript was followed by an exact Electron
`console-message` deprecation warning alongside the ordinary destroyed-
renderer shutdown diagnostic. Product source was restored. At that point R660
was time-boxed as a transcript-protocol blocker; do not widen the global
post-footer allowlist merely to produce a green proof. On the present
test bytes, R662 and R657 each re-proved **PROVEN** with source hashes
restored, and a repeat full tabs run passed **464/464** with zero sentinel
hits and zero stalls (`files/f22-ctime-sentinel-confirm-complete-tabs.log`).
The subsequent bounded correction converted the two tab-suite
`console-message` listeners to Electron's modern event object, eliminating
the deprecation warning. The R660 proof-only record, not the global
transcript rule, now permits only the observed single exact shutdown line;
synthetic checks reject that line on ordinary runs and reject added or
fatal output. The renderer-side observer captures the actual synchronous
tracking reply, since the main event's `returnValue` could not be read back.
The checkpoint requires a byte-identical ctime-only transition, one
correlated selection, unchanged cached version, and the exact
`disk-or-deletion-moved-before-selection` rejection when the target
assertion fails. It fails closed on missing setup or unrelated failures.
**R660 is now individually PROVEN** on the final test bytes: both the
reselection and its dependent Save fail under the mutation, with the
independent controls passing and the main source restored byte-for-byte
(`files/f22-r660-guarded-final-proof.log`). The unmutated focused path
passed **18/18**; the complete tabs run passed **464/464** with zero
sentinel hits or stalls (`files/f22-r660-guarded-complete-tabs.log`).
An earlier complete run on intermediate test bytes passed **462/464**:
one false failure came from the unreadable main-side reply and was
corrected; an updater-commit timing failure did not recur in the next
complete run and is not claimed fixed. Fresh independent Sol, Terra and
Luna reviews of the corrected proof gate found no blocking defects.
Sol notes that the main rejection reason also covers other disk or
deletion changes; the controlled metadata-only transition and correlated
reply constrain, but cannot make that reason uniquely ctime-specific.
R621's unresponsive-commit revert now anchors the production fallback-cause
argument. Its individual break/restore proof is **PROVEN** with exactly the
commit-refusal and frozen-document assertions failing, the independent
question controls surviving, and the main source restored byte-for-byte
(`files/f22-r621-complete-expect-proof.log`). Fresh independent Sol, Terra
and Luna reviews found no blocker. R552 is **not proved**: moving its older
silent-approval mutation to the current fallback entry caused a repeated
commit/refusal loop, filled the harness output buffer and left a test child
running. The exact child process tree was identified and stopped by PID;
the production source hash was restored. That unsafe record change was
reverted, leaving R552 `SETUP-FAILED` until a bounded, finite mutation can
be designed and individually proved. The current `--anchors` audit still
fails on older records (`files/f22-r621-final-anchor-audit.log`); it does
not substitute for any individual proof.
R63's scroller implementation had moved from main to CustomTabs. Merely
updating its file target initially yielded a misleading **PROVEN** result:
both failing assertions tested whether the *mutated* helper could find a
scrollable pane, while the actual reading-position assertion stayed green
at zero scroll. The 5c2 test now parks and reads the physical scroller
through the unmutated renderer helper; that setup must stay green under
the paired tab-helper/CSS mutation. R63 then individually **PROVEN** the
reading-position regression, with the zoomed scenario's setup failure
reported as an expected consequence rather than as restoration evidence
(`files/f22-r63-physical-clean-proof.log`). The complete unmutated tabs
suite passed **464/464** (`files/f22-r63-physical-complete-tabs.log`).
An earlier mutation run also encountered an unrelated updater-boundary
timing failure; the clean individual reproof did not. Fresh independent
Sol, Terra and Luna reviews found no blocking issue in the corrected
R63 proof. The older anchor audit remains a release blocker; derive its
live failure inventory from `--anchors`, not from the status prose.
R570's first restored anchor was **VACUOUS**: its forged wrong-generation
READY omitted `pageSession`, so the later session guard still rejected
the request after the generation guard was removed. The fixture now
supplies the current valid session and separately proves an open request
and a distinct safe generation. Two mutation runs reached the intended
assertion but also failed unrelated updater checks; those are not clean
proofs. R570 alone now opts into exact-failure accounting and requires
both of its `mustPass` controls to appear as actual PASS records.
Its subsequent individual break/restore run is **PROVEN** with only the
target assertion failing (`files/f22-r570-observed-controls-proof.log`),
and the unmutated complete tabs run passed **465/465** with zero sentinel
hits or stalls (`files/f22-modern-sentinel-clean-tabs.log`). Sol identified
the absent-PASS gap in the first review round; after its correction,
fresh independent Sol, Terra and Luna reviews found no blocker.
R454 now anchors only the unique `will-download` registration, preserving
the expanded listener body and the independent policy predicate. It is
**UNPROVEN**: its popup mutation transcript remained `UNUSABLE` because
native popup-navigation diagnostics followed the terminal footer
(`files/f22-r454-modern-sentinel-proof.log`). The shared test sentinel
now uses Electron's modern single-event console signature; that removed
the separate deprecation warning but did not cure those late diagnostics.
The ordinary popup suite passed **93/93**, render-security **192/192**,
and the latest complete tabs suite **465/465**. Do not accept arbitrary
post-footer popup output to turn R454 green. Independent Sol, Terra and
Luna reviews found no bug in the changed R570/R454 fixtures or sentinel;
Terra raised the generic harness's permissive unlisted-failure policy,
which was addressed with an R570-only opt-in rather than changing other
records' deliberate semantics. The older anchor audit still fails
(`files/f22-r570-r454-anchor-audit.log`).
A bounded R454 handoff to Terra is checking whether the three exact
known after-footer popup diagnostics in the mutation transcript can
be accounted for by a mutation-only tail contract, as R660 does for
its separate diagnostic. The control popup run put the two deliberate
blocked-navigation messages **before** its footer. No generic
acceptance of arbitrary late output or claim of R454 proof follows
from this handoff; the independent policy-predicate PASS control,
exact wiring failure, product restoration and fresh reviews are
still required.
Terra found the two blocked-navigation messages were in a separate
diagnostic stream, not the parent stdout tail. A mutation-only R454
contract now admits **only** the exact terminal parent line
`Shutdown approval renderer unusable: webContents destroyed`; synthetic
controls reject reordered, added and fatal late lines, and prevent a
clean run from using the allowance. The popup baseline passed
**93/93**; R454's individual mutation failed just the wiring check
while the independent policy-predicate check was an observed PASS,
and product bytes were restored (`files/r454-tail-proof-20261003.log`).
Terra is adding R454-only exact-failure enforcement and reproving it
before this provisional result is promoted to reviewed evidence.
R454-only `requireExactFailures` is now in place. Its individual
break/restore rerun is **PROVEN** with exactly the one named wiring
failure, the independent policy predicate observed PASS, a resolved
anchor and byte-restored `src/main.js`. Fresh independent Sol, Terra
and Luna reviews of the final scoped verifier change are in flight;
the popup run and this proof do not stand in for the complete harness.
A subsequent full read-only `--anchors` audit resolved every record
(`files/f22-r454-full-anchor-audit-20261003.log`); it did **not**
execute or prove any other revert.
Fresh independent Sol and Luna reviews found no blocking issue in
R454's scoped verifier change. Terra agreed the tail contract rejects
extra/reordered/fatal stdout and fatal stderr, but flagged a duplicate
copy of the *same* expected failure name as a possible false proof:
exact matching is name-set, not occurrence-count based. That
hypothetical is not an R454-specific blocking path: the popup suite
calls its wiring `check()` at one site once per run, and the recorded
mutation has exactly one such failure with a correctly accounted
footer. Adding a per-record duplicate counter to certify an
unreachable second check would expand the general harness for a
low-ROI edge case. The disagreement is retained here rather than
misreported as three unanimous approvals; the R454 individual
break/restore result is accepted within its single-run scope.
R569's shutdown snapshot revert now uniquely anchors the all-tab scan
rather than another active-tab snapshot call. Its active-view setup must
appear as an observed PASS; the individual break/restore run was
**PROVEN** with only the reading-anchor assertion failing and product
bytes restored (`files/f22-r569-observed-setup-proof.log`). Fresh
independent Sol, Terra and Luna reviews found no blocker. A subsequent
full `--anchors` audit confirmed R569's anchor resolves but still found
older `SETUP-FAILED` records (`files/f22-r569-final-anchor-audit.log`);
this dry-run does not prove those records.
R209 and R526 now anchor the current shared renderer guards rather than
their former call-site shapes. Their individual break/restore runs are
**PROVEN**: R209 names exactly the four failed-save guard assertions
that fail under its mutation, and R526 names both navigation-prompt
failures. Both records require their independent `mustPass` controls
to appear as actual PASS records; R209 also rejects any unlisted
failure. The unmutated patch suite passed **193/193** and the renderer
source was restored byte-for-byte
(`files/f22-r209-observed-controls-proof.log`,
`files/f22-r526-observed-controls-proof.log`). Initial independent
Sol and Luna reviews accepted the causal, visible R209 consequences,
while Terra required them to be inventoried and both records' controls
to be observed. After that correction, fresh independent Sol, Terra
and Luna reviews found no blocker. R209 proves the combined
unsaved-work guard is load-bearing, not every clause independently;
R526 proves the prompt/send boundary, not completion of the file open.
The refreshed full anchor dry-run still reports older `SETUP-FAILED`
records (`files/f22-r209-r526-final-anchor-audit.log`).
R210's failed-write mutation now targets the unique current
`failedSaves.add(stateKey)` operation, leaving the separate dirty-state
applier intact. The patch fixture waits for the observed held Save to
settle through its pending-save lifecycle rather than waiting on the
failed-save record that this revert removes. Its individual
break/restore run is **PROVEN** with exactly the recorded failed-save
and dependent cross-tab assertions failing; the injected-failure
console control must appear as a PASS, no unlisted failure is accepted,
and renderer bytes were restored. The unmutated patch suite passed
**193/193** (`files/f22-r210-bounded-proof.log`). Fresh independent
Terra and Luna reviews found no blocker. Sol's first review mistakenly
examined the untouched root checkout; that finding did not apply to
the integration worktree, and a new Sol review verified the correct
worktree and found no blocker. The full anchor audit still finds older
`SETUP-FAILED` records (`files/f22-r210-final-anchor-audit.log`);
R210's dry-run anchor resolution is not its proof.
R212 now anchors the current per-document success cleanup. Its
individual mutation changes the path-scoped failure and conflict
deletions back to global clears and is **PROVEN**: saving document B
loses A's failed-save record, the independently checked pre-switch
failure state is absent, and returning to A finds its guard disarmed.
All declared controls appeared as PASS under the mutation, no
unlisted failure was accepted, renderer bytes were restored, and
the ordinary patch suite passed **193/193**
(`files/f22-r212-bounded-proof.log`). Fresh independent Sol, Terra
and Luna reviews found no blocker. This fixture directly proves
failed-save scoping, not conflict scoping: it does not create a
reload conflict even though the mutation also clears conflict state.
The latest full anchor audit still finds older `SETUP-FAILED`
records (`files/f22-r212-final-anchor-audit.log`).
R213 now targets the current failed-save insertion, conditionally
omitting it when an outstanding Save fails after the user enters edit
mode. Its individual break/restore run is **PROVEN** with only the
late-failure recording assertion failing; observed controls establish
the held write, dirty pending document and injected console error.
The restored patch suite passed **193/193**, and the renderer source
was byte-restored (`files/f22-r213-bounded-proof.log`). Fresh
independent Sol, Terra and Luna reviews found no blocker. The full
anchor dry-run still fails on older records
(`files/f22-r213-final-anchor-audit.log`); it is not a complete
revert-harness pass.
R208 now reverts the current edit-mode dirty-state setter, preserving
its notification route while unconditionally clearing dirtiness. Its
individual break/restore run is **PROVEN**: both the failed-write and
still-pending-write transitions lose the unsaved state, and the late
failure remains recorded but cannot restore that lost dirty flag.
The failure inventory is exact, the independent failed-open and
console controls appeared as PASS, and product source was restored
(`files/f22-r208-bounded-proof.log`). Fresh independent Sol, Terra and
Luna reviews found no blocker; this does not separately prove the
reload-conflict branch of the original condition. The full anchor
audit still fails on older records
(`files/f22-r208-final-anchor-audit.log`).
R545 now has a unique shutdown-snapshot anchor, but remains **UNPROVEN**.
The first individual run could not wipe a held Electron test profile;
after the identified child processes were stopped by PID, a clean retry
aborted before its live-only-edit assertions because installed-updater
fixture cleanup attempted to close a still-frozen tab. Both transcripts
were `UNUSABLE`, not mutation detections
(`files/f22-r545-bounded-proof.log`,
`files/f22-r545-clean-retry-proof.log`). A subsequent unmutated,
machine-exclusive tabs suite passed **465/465**
(`files/f22-r545-unmutated-baseline-tabs.log`); that does not prove
R545. Fresh independent Sol, Terra and Luna reviews agreed that the
source mutation is scoped to the shutdown snapshot and the evidence
does not prove it. Luna identified a plausible already-true thaw wait
in the installed fixture; whether the mutation contributes to the
earlier freeze remains unestablished. Do not weaken the frozen-document
guard or accept the fatal cleanup as an expected failure.
R234's large-tab guard revert now calls the real confirmation but
ignores a declined answer, rather than bypassing the confirmation
entirely. A separate restored-tab probe establishes a visible ordinary
document before the click, then checks both the active tab and visible
document after refusal. Its corrected individual break/restore run is
**PROVEN** with the declined-create and restored-click failures
accounted for exactly, the independent setup and passive-restore
controls observed passing, and product bytes restored
(`files/f22-r234-decline-proof.log`). The first corrected run had
misclassified two state-dependent assertions as must-pass; it was
`UNUSABLE`, not proof. The unmutated tabs suite passed **465/465**.
The independent review initially disagreed about trying this mutation:
Sol advised stopping with the old record, while Terra and Luna favored
the ask-then-ignore correction with a self-contained visible-document
probe. Fresh independent Sol, Terra and Luna reviews of the final
record found no blocker; the later main-fixture assertions still
cascade from an initial forced activation, while the restored click is
the independent refusal witness. The latest full anchor audit still
finds older `SETUP-FAILED` records
(`files/f22-r234-r545-final-anchor-audit.log`).
R254 now anchors the current already-open-file acceptance memo. Its
individual mutation omits only the renderer's `largeConfirmed` entry
after an authenticated re-open. It is **PROVEN** with exactly the
duplicate renderer confirmation assertion failing: the re-open
completed on the existing tab, while the separate main-confirmation
and multi-select controls appeared as PASS
(`files/f22-r254-bounded-proof.log`). Product source was restored,
the ordinary tabs suite passed **465/465**, and fresh independent
Sol, Terra and Luna reviews found no blocker. This proves the
renderer does not ask again for a document main already approved;
it is not a substitute for the remaining old anchor proofs.
The latest full anchor dry-run still fails on older records
(`files/f22-r254-final-anchor-audit.log`).
R251 now uniquely removes only `silent: true` from the active-tab
restore switch, leaving document-identity adoption and error handling
intact. Its individual break/restore run is **PROVEN**: an expensive
active document raises the confirmation, is declined, and consequently
does not render or announce itself passively. Ordinary-restoration and
large-sample setup controls appeared as PASS, failures were accounted
for exactly, and product bytes were restored
(`files/f22-r251-bounded-proof.log`). Fresh independent Sol, Terra
and Luna reviews found no blocker; the later revisit assertion is a
dependent consequence, since a declined restore leaves no active tab
to revisit. The first unmutated tabs run after the proof was
**464/465**: a later updater commit was refused as unresponsive.
One separate, machine-exclusive repeat passed **465/465**
(`files/f22-r251-independent-baseline-tabs.log`); the intermittent
updater failure has not been diagnosed or fixed. The full anchor
audit still fails on older records
(`files/f22-r251-final-anchor-audit.log`).
R252 now reverts only the `confirmed` bit on the authenticated new-tab
creation, preserving activation, disk version and adoption identity.
Its individual break/restore run is **PROVEN**: main's large-document
confirmation remains an observed passing control while the renderer
asks a second time on the selected file; the batch still opens and
renders only the selected document, and product source is restored
(`files/f22-r252-bounded-proof.log`). Fresh independent Sol, Terra
and Luna reviews found no blocker. The subsequent unmutated tabs run
was **464/465**, failing a distinct pre-install updater assertion
after a commit was refused as unresponsive. This is not attributed
to R252 or claimed fixed; the ordinary-suite gate remains open.
The full anchor audit still fails on older records
(`files/f22-r252-final-anchor-audit.log`).
R549 now mutates only the lower-request-id rejection predicate, leaving
the same-id response cache and equal-id pending-retry condition intact.
The earlier whole-guard mutation returned `COLLATERAL` and is not proof.
The narrowed individual break/restore run is **PROVEN**: exactly the
fresh/stale request and cancelled-request replay assertions fail, each
with an observed response to a lower ID; the selected physical-owner,
same-id replay and clean native-close controls are required to have
emitted PASS, and unlisted failures are rejected
(`files/f22-r549-lower-only-proof.log`). Product source was restored
byte-for-byte, and the following unmutated tabs suite passed **465/465**.
Fresh independent Sol, Terra and Luna reviews found no blocker. The
retained mutation log reports only failures, not each control's PASS
line; the record-local harness policy supplies that guarantee. It
also does not separately prove the upstream updater assertion emitted
PASS, nor do these results diagnose the earlier intermittent updater
`unresponsive` events. The refreshed full `--anchors` audit confirms
R549 resolves but still reports older `SETUP-FAILED` records
(`files/f22-r549-final-anchor-audit.log`).
R250 now anchors the current restore call and reverts only
`activate: false` to `true`, retaining its stable disk snapshot and
version metadata. Its individual break/restore run is **PROVEN**:
restoring four tabs raises three unwanted questions and renders five
times instead of one, with five named restore/guard assertions failing
and the expensive-sample, restored-tab and live-sentinel controls
observed passing (`files/f22-r250-sentinel-presence-proof.log`).
Forced activation sometimes also produces a disk-adoption console
error. The record accepts that suite-wide sentinel failure only with
the two known, distinct error signatures; if no error is reported, the
sentinel must instead have emitted PASS. A missing, repeated or mixed
sentinel outcome, or an unrelated reported error, cannot prove R250.
The sentinel deduplicates identical raw errors, so this is a check of
distinct reported hits, not a count of raw repetitions. Fresh
independent Sol, Terra and Luna reviews found no blocker after this
correction; product source was byte-restored. An unmutated tabs run
was **464/465**, failing a later updater assertion when an in-flight
commit was refused as unresponsive
(`files/f22-r250-unmutated-tabs.log`); this does not invalidate R250's
scoped proof or establish the cause of the intermittent ordinary-suite
failure. The full anchor audit still has older `SETUP-FAILED` records.
R253 now reverts only `activate: false` on trailing multi-select tabs
in the current verified background-adoption path, preserving the disk
snapshot, version, approval and reserved identity. Its individual
break/restore run is **PROVEN**: two extra renderer questions, three
renders and the wrong active tab fail the two batch assertions exactly;
main confirmation and independent session-restore controls must have
emitted PASS (`files/f22-r253-bounded-proof.log`). The earlier
`COLLATERAL` run in that log is not the proof. Fresh independent Sol,
Terra and Luna reviews found no blocker. Sol noted that R253's
failure of the assertion named for an already-confirmed file shows
unwanted *batch* prompts, not a second prompt for the same file;
R252 separately proves the latter. Product source was byte-restored.
The ordinary tabs suite has not been rerun since the R253 harness-only
change; its latest run remains **464/465** on the updater refusal above.
R544 now anchors the current all-tab shutdown scan and substitutes
only the active tab as its input, retaining the snapshot and the
existing dirty/deletion predicate. The first individually retained
attempt was `COLLATERAL` because an unrelated updater assertion also
failed; the next machine-exclusive break/restore run is **PROVEN**
with exactly seven named background-dirty and dependent failures,
while the active-edit and clean-close controls must have emitted PASS
(`files/f22-r544-independent-proof.log`,
`files/f22-r544-final-bounded-proof.log`). The maintained-state and
renderer-recovery failures are downstream witnesses of the same
omitted background tab, not seven independent defects. Fresh
independent Sol, Terra and Luna reviews found no blocker; product
source was byte-restored. This proof does not resolve R545's separate
live-edit snapshot blocker or the intermittent updater failure.
R568 now uniquely anchors the current tab-content setter, removing
only its maintained-dirty assignment while retaining the content
write, revision bump and freeze guard. It is **UNPROVEN**: two bounded
break/restore attempts ended `UNUSABLE` before their target or control
assertions ran because installed-updater fixture cleanup attempted to
close a still-frozen tab (`files/f22-r568-bounded-proof.log`). The
freeze guard correctly refused both the content setter and tab close;
the cleanup failure is not mutation detection. Source bytes were
restored. Fresh independent Sol, Terra and Luna reviews found no
blocker in the scoped anchor and agreed no proof can be claimed.
The follow-up, test-only diagnostic found that the abort was at a
*later* cleanup, not the initially instrumented thaw/close pair:
main had no pending question or commit, but still had an installed
attempt in `awaiting-updater-boundary`, and the renderer retained its
freeze (`files/f22-r568-state-capture-proof.log`). That observation
does not establish whether the failed installed transition is
mutation-induced or a fixture ordering problem. Temporary diagnostic
instrumentation was removed after capture; do not weaken the
retained-tab assertion or the production freeze guard. R545 remains
separately unproven on this same boundary.
A bounded read-only follow-up confirmed the existing installed-fixture
thaw wait stores a false timeout but calls the shared `clearDocuments()`
anyway. The latter tries to close a frozen tab, throws before the thaw
assertion can report the actual failure, and the installed attempt is
still `awaiting-updater-boundary` with no open question. Forcing a
renderer thaw in shared cleanup would hide the unresolved
preceding transition and make the unfrozen-before-cleanup witness
vacuous. Keep R545/R568 unproven; first determine why the installed
attempt never advances, rather than adding an unsafe cleanup reset.
A narrower follow-up corrected the *location* of that problem: the
fatal `clearDocuments()` runs in the next installed scenario's
**preamble**, before its own reset and `install-update` send. The
`awaiting-updater-boundary` attempt and frozen renderer were inherited
from the preceding scenario; `pendingId` and `commitPendingId` were
both zero. It is **not established** that the next installed attempt
stalled, nor that main has an open question. The unmutated suite
cleared the same preamble, but one healthy run does not establish
whether the inherited freeze is mutation-induced or intermittent.
Do not change production thaw/adoption semantics on that inference;
the prior scenario's transition needs a directly correlated witness
before either R545 or R568 can be scored.
R214's first repaired anchor was **VACUOUS**: the existing two-save
fixture makes the first result stale by sequence, so it never enters
the newer view-mode mismatch branch. A new single-save fixture holds
one real disk write, moves the document with `commitViewModeEdit`,
observes a switch to a control tab and back to the physical owner,
then checks that the first authorized result *applied* without
clearing the later local edit. The first review found that merely
recording an authorized decision did not prove application and that
the tab-switch calls lacked selection witnesses. After correction,
the ordinary patch suite passed **197/197**, and the individual R214
break/restore run is **PROVEN** with only the intended dirty-state
assertion failing; the three independent setup/application controls
must have emitted PASS and product bytes were restored
(`files/f22-r214-first-application-proof.log`,
`files/f22-r214-first-application-baseline.log`). A repeated delivery
of the same immutable decision returns false by design; the fixture
retains the first, mutating application result rather than allowing
the duplicate to overwrite its witness. Fresh independent Sol and
Terra reviews found no blocker. Luna's final objection was that the
Electron executable named another worktree in `process.argv[0]`;
this worktree's `node_modules` junction points there, but the test
script and its `require("../src/main.js")` resolve within the
integration worktree. The executable location is not the tested
source location. R211 now separately reverts *content preservation*
at that same latest-save mismatch, assigning the older saved bytes
while leaving the dirty-state call intact. Its individual
break/restore run is **PROVEN** with only the newer-content assertion
failing and the one-request, actual-application and physical-owner
controls passing (`files/f22-r211-bounded-proof.log`). R214 was
reproved after the fixture split: its dirty-state mutation fails only
the dirty assertion while the new content-preservation assertion
must PASS (`files/f22-r214-after-r211-proof.log`). The updated
unmutated patch suite passed **198/198**
(`files/f22-r211-r214-patch-baseline.log`); product bytes were restored
after both individual proofs. Fresh independent Sol, Terra and Luna
reviews found no blocker. The earlier **197/197** and R214 proof
above are historical, not the final executed fixture state. The
full anchor audit remains blocked on other records.
R604's maintained-dirty shutdown-scan anchor was repaired after
`saveFailure` joined the production return. The first rerun exposed
five scan-cost failures, not just the two named by its old record;
its `PROVEN` footer alone did not establish exact failure accounting
or positive controls. Initial independent Sol and Luna reviews then
caught a more important proof defect: replacing the whole return
also dropped `reloadConflict` and `saveFailure`, silently changing
shutdown protection. The final revert preserves both flags and the
unknown-tab fallback, replacing only the maintained `state.dirty`
read with a document comparison. Its bounded break/restore run is
**PROVEN** with exactly five named scan-cost failures (including a
33,554,432-byte bulk scan), both required controls observed as PASS,
a complete suite transcript and restored product bytes
(`files/f22-r604-guarded-proof.log`). Fresh independent Sol, Terra
and Luna reviews found no remaining blocker; these five observations
are linked consequences of one recomputation, not five defects.
R604's individual proof does not close the still-failing full
anchor audit or the intermittent unmutated updater test.
R555's denied-navigation anchor now changes only the event boundary,
leaving all newer shutdown-state resets intact. Initial independent
reviews rejected the old "unclosable" claim: under the mutation the
fixture actually observed a main-process fallback question. They also
required this exact navigation's cancellation to be witnessed. The
corrected fixture records the main-frame start and `will-navigate`
for the same URL, observes `defaultPrevented` *after* the production
guard and confirms the original file URL survives. R555's individual
break/restore is **PROVEN**: the only failed assertion observes
renderer `"loading"` and one needless fallback; the setup and three
controls must actually PASS, extra failures are rejected, and
`src/main.js` bytes were restored
(`files/f22-r555-cancellation-proof.log`). The preceding run was
**COLLATERAL** on an unrelated updater-commit failure and was not
counted as proof (`files/f22-r555-witness-proof.log`). Fresh
independent Sol, Terra and Luna reviews found no remaining blocker;
this proves the narrower fallback regression, not an unclosable
window. The sporadic updater failure remains unresolved.
The post-fixture unmutated tabs run passed **465/466**, including
both new denied-navigation assertions; its sole failure was the
separate missing-paired-updater-quit expiry scenario, again following
`unresponsive-during-commit`
(`files/f22-r555-postfixture-clean-tabs.log`). The fresh full
read-only anchor audit finds **13 SETUP-FAILED** records, including
R552 and R645 (`files/f22-r555-current-anchor-audit.log`). Neither
result is a clean integrated gate.
R645's old anchor was stale and its old expected assertion was
**WRONG-GUARD**: it did not exercise the snapshot comparison. The
replacement mutates only `sameDocument(currentSnapshot,
request.snapshot)` and requires a newer live edit on the same physical
owner. Initial reviewers rejected a first green-looking run because
the fixture sampled the tab immediately after dispatching an async
reply; it did not prove an overwrite. The corrected fixture waits for
the held reply's rejection or acceptance, then checks the edit. Under
the mutation, the early `document-moved-after-request` classification
is lost, but a *later* `tracking-selection-refused` guard rejects the
reply and the newer note survives. The record's claim is accordingly
**only** early conflict classification, not data loss. Its bounded
break/restore is **PROVEN** on that narrowed claim with two exact
expected failures, passing live-edit and retained-note controls, a
complete transcript and restored `src/custom-tabs.js` bytes
(`files/f22-r645-early-guard-proof.log`). Fresh independent Sol,
Terra and Luna reviews found no blocker; the global rejection counter
is attributed to that held reply by fixture ordering, not by a
request-tagged diagnostic. The old overwrite claim is **not proven**.
The post-R645 unmutated tabs run passed **468/469**, including the
new settled-reply checks; the only failure was a different updater
assertion, "an updater error leaves an ordinary commit active with its
exact commit identity"
(`files/f22-r645-postfixture-clean-tabs.log`). This is further
evidence that updater failures are intermittent across assertions,
not a clean gate. The subsequent full read-only anchor audit still
finds **12 SETUP-FAILED** records; R645 now resolves
(`files/f22-r645-current-anchor-audit.log`).
R102's stale save-queue anchor was narrowed to the current
`prior.then(execute, execute)` scheduling boundary. Its individual
run is **UNUSABLE, not proven**: the mutated two-write case emitted a
real write-boundary Save refusal but then stopped before the parent
suite footer, likely on a modal; after more than twelve idle minutes
the verified test Electron PID was stopped, allowing the harness to
restore `src/main.js` byte-for-byte
(`files/f22-r102-bounded-proof.log`). Neither the Save refusal nor
the interrupted transcript is evidence that the intended overlap
assertion failed. Do not rerun this mutation unchanged until the
blocking dialog/fixture boundary is isolated.
Fresh independent Sol, Terra and Luna reviews agree the repaired
R102 scheduling mutation removes same-path serialization without
damaging the queue's diagnostics, but that the interrupted run
proves nothing. Luna identified the fixture's unstubbed `alert()`
on the Save-failure path as a plausible cause of the stall, **not**
an established diagnosis. The full read-only anchor audit now
reports **11 SETUP-FAILED** records
(`files/f22-r102-current-anchor-audit.log`); R102 resolves but is
still an open behavioral proof.
Following the later R552 watchdog diagnosis, R102's old interrupted
run is likewise not evidence of a hung modal: it was externally
stopped without the tab suite's own timeout footer. A single
machine-exclusive, unchanged R102 mutation is being allowed to
reach that internal watchdog or a complete suite footer, with
product restoration and PID-scoped cleanup. This diagnostic does
not promote R102 until exact failures and positive controls are
accounted for; no global alert interception is justified.
That one unchanged R102 run reached the **suite's own 1,820-second
watchdog**, and the complete parent transcript ended
`=== TIMED OUT after 88/88 checks ===`
(`files/r102-proof-20261003-0619.log`). The watchdog's generic
"blocking dialog is most likely" is **not** a diagnosis, and no
R102 target or control assertion was reached. The harness
restored all product source bytes without external killing or a
surviving Electron process. R102 is still **UNUSABLE / UNPROVEN**.
Opus is mapping the last completed check and next awaited
operation read-only; no second unchanged R102 mutation is
justified until the stalled boundary is identified.
Opus's read-only trace localized the unresolved wait **between**
R102's second positive control and its queue-serialization check:
scenario 9d's `await exec(...)` runs two Save clicks with only
`window.confirm` stubbed, leaving a real renderer `window.alert`
on Save-refusal paths. The earlier write-boundary refusal supports
that hypothesis, but no transcript proves an alert actually fired.
The supervising process probe matched zero test Electron processes
throughout and is therefore not a valid no-modal witness. Terra
has a bounded fixture-only handoff to capture alerts **inside
scenario 9d**, first prove the stub sees its own sentinel, report
any Save refusal as an explicit failed assertion, and restore both
dialog hooks. Only after a healthy unmutated suite should another
R102 mutation run be interpreted; no broad mute or production
change is justified.
The scoped scenario-9d alert fixture proved its own sentinel,
restored both dialog hooks, and passed the unmutated tabs suite
**478/478**. One R102 mutation then completed naturally, not after
a watchdog: same-path active writes overlapped **1 → 2** and the
renderer captured an explicit write-boundary Save refusal instead
of blocking on its alert. The queue assertion failed as intended,
but six additional assertions failed, including retained disk
bytes, dependent scenario 9e checks and the visible-error
sentinel (`files/r102-s9d-proof-20261003-0706.log`).
The harness printed `PROVEN` under R102's older non-exact policy;
**do not accept that verdict yet**. Opus is classifying every
extra failure before requiring exact membership, and product
source bytes were restored. The generated screenshot was opened
and viewed, showing raw `S9D_SECOND` beside rendered `S9D_FIRST`;
the temporary PNG was then removed.
Opus's read-only audit separated the six additional failures:
the Save-refusal alert, retained first-write disk bytes, dirty
store/disk mismatch and global visible-error sentinel follow
directly from two same-path writes overlapping. The other **two**
are inherited scenario-9e failures: it assumes 9d left a clean
disk/session, so its reload never acquired a different document
under the R102 mutation, making an R101-related discard check
degenerate. Do not list those two as R102 detections or accept the
non-exact harness verdict. Scenario 9e needs its own disk-backed
reload setup before R102 can require exact failures; a focused
read-only trace is checking whether a small reset is sound when
9d left a refused, dirty Save.
The follow-up found no cheap disk-marker reset: under R102 the disk
already differs from 9e's stale text, yet the reload is not adopted.
The dirty edit itself does not block reload; ownership/selection and
main-process Save authority remain unsettled. A sound independent 9e
fixture needs a correlated clean-owner reload and is a substantive
change, so do not invent a passing 9e setup or count its two inherited
failures as R102 detections. A narrower, explicitly reported 9e skip
when 9d's witnessed precondition fails is under read-only evaluation;
R102 remains UNPROVEN pending a sound exact-failure run.
Opus confirmed the existing harness records `SKIP  <name> - <reason>`
as live but **unobserved**, not PASS or FAIL. Terra now owns the narrow
R102 fixture and revert-record handoff: skip exactly the two dependent
9e assertions with an explicit blocked reason only if 9d's existing
clean-Save setup fails; keep 9e fully exercised and zero-skipped on a
healthy run and under R101's separate mutation. R102 must require the
five causal failures exactly, independent observed PASS controls and
the global visible-error sentinel; the deferred independent 9e rebase
is not silently claimed by this narrower proof.
Terra's conditional 9e skip preserved the unmutated **478/478**
with **zero skips** and made the two inherited checks explicitly
unobserved under R102; the R102 mutation again reached same-path
overlap, Save refusal, retained first-write bytes and the visible-error
sentinel. Exact accounting now correctly reports **COLLATERAL**:
six additional downstream F22 checks fail (active-document restore,
three held-reload/ownership checks, late-edit commit and editable
refusal), so the five-name record remains **UNPROVEN**. R101 was
not rerun; source was byte-restored and an R102 anchor dry-run
resolved. Fresh independent Sol, Terra and Luna reviews of the narrow
fixture and evidence are pending. Do not broaden `expect` to claim
the six downstream failures or claim that 9e's reload adopted bytes.
The fresh independent Sol, Terra and Luna reviews agree: keep the
explicit 9e skip as an interim fixture boundary and keep exact
accounting, but R102's five-name `expect` is not a valid final proof:
disk order, renderer refusal and store outcome can vary with the
unqueued write schedule, while the direct queue-overlap diagnostic
does not have its own independent two-write setup witness. The six
downstream failures must not be absorbed. Sol additionally found that
the printed skips are not counted in the suite footer (although the
revert catalogue does recognize them as live/unobserved); Terra
flagged malformed `SKIP` lines accepted by the existing catalogue
parser; Luna highlighted the missing two-save positive control.
These observations differ in emphasis, not in the verdict: R102
requires a bounded, isolated deterministic queue fixture before
promotion. Do not extend the current whole-suite mutation to chase
downstream collateral on an already invalid schedule-dependent
record.
To check that the interim 9e skip did not weaken the distinct R101
proof, R101 was rerun individually after the fixture change. Its
own reload setup saw a different document, its baseline-discard
assertion alone failed, the source bytes were restored, and the
harness reported **PROVEN**
(`files/r101-after-r102-skip-proof-20261003.log`).
The maintainer chose **bounded F22 proof work** rather than
documenting the remaining gaps and moving to another wave-2 stream.
The next handoff is a single read-only Opus design pass for an
isolated deterministic R102 queue observation; any implementation
remains capped to one reviewable fixture unit, with no whole-suite
revert rerun to chase incidental disk order or downstream state.
R545/R568 will get a separate bounded attempt at the preceding
freeze transition after R102's disposition. No release gate is
waived by this prioritization.
In parallel, a read-only Opus check found that both R545's live-only
dirty checks and R568's semantic setter checks (including their
independent PASS controls) live in `runShutdownScenarios()` and
`runSameDocumentShutdownScenarios()`. The freeze-producing
generation/installed-updater scenarios own **none** of those named
checks. A single focused, self-proving virtual suite invoking just
the two relevant scenario functions is a bounded alternative to
force-thaw or broad cleanup; it still needs live error-sentinel,
both-function reach and complete-footer evidence before either
record can be rerun. This is only a design, not proof. It must wait
until Terra releases the focused test-dispatch region after R102.
With R102's focused unit reviewed, Terra now owns **one capped shared
R545/R568 fixture attempt**. It must first prove a clean standalone
shutdown+semantic mode actually reaches both target functions with
their independent controls and live error sentinel, then run the two
mutations separately with source restoration. If either function
depends on broader fixture state or a mutation again leaves an
unresolved freeze, stop rather than adding a forced thaw or widening
the expected failure set. No previously reported `UNUSABLE` run has
been reclassified by this handoff.
The shared focused baseline showed why the two functions cannot
simply be composed: it reached a complete parent footer but passed
**117/121**, with four failures in the *semantic* fixture. The
preceding shutdown scenarios left `phase-two-reopen-1.md` live; the
semantic fixture could not close it. R545's two targets and both
controls, as well as R568's two protocol controls, each appeared
once as PASS; R568's semantic targets did not run. Its console and
DOM sentinels proved live, but a clean baseline is required before
mutation. Terra removed the temporary shared focused dispatch and
suite registration; **neither R545 nor R568 was mutated**, product
bytes were unchanged and the full anchor dry-run resolved
(`files/f22-shutdown-semantic-focused-baseline-20261003.log`).
The next bounded handoff is R545-only, using the demonstrated
shutdown scenario without the contaminating semantic extension.
R568 must have its own independent clean semantic fixture; no
force-thaw or broad cleanup reset is justified by this result.
The R545-only focused baseline then passed **115/115** with its two
targets, live-only/background controls and sentinel each observed
PASS. One R545 mutation completed with a restored product source and
failed both intended checks, but **six further lifecycle assertions**
also failed (late-edit commit, editable refusal, retry-safe thaw,
Cancel default and clean cancellation). The exact record correctly
reported **COLLATERAL**, not proof
(`files/f22-r545-focused-proof-20261003.log`). No extra failures
will be listed as R545 targets merely to turn the run green. Terra is
removing the temporary focused route while keeping the R545
exact-failure guard, so future contaminated mutation runs cannot
promote themselves under the older permissive policy. R568 has not
yet been mutated in this focused attempt.
The R545-focused route was removed after that rejected run; R545
returned to `test:tabs`, keeping only the new fail-closed
`requireExactFailures` setting. The full anchor dry-run still
resolved (`files/f22-r545-cleanup-anchor-audit-20261003.log`).
The final bounded proof attempt is **R568 only**: a fresh,
semantic-only focused mode may be tried if it proves its own clean
setup, both R568 target checks, at least two genuinely independent
PASS controls that survive the setter mutation, sentinel liveness and
a complete footer. Otherwise the temporary mode is removed and R568
remains unproven. This attempt will not replay the prior inherited
installed freeze or weaken its guard.
The R568 semantic-only focused baseline passed **27/27** with
both target checks, independent editor-mode/pool-closure controls,
live two-channel error sentinel and host-file cleanup. Its one
mutation run emitted a **17/27** suite footer followed by
`Shutdown approval renderer unusable: webContents destroyed` on
parent stdout. The harness correctly marked the transcript
**UNUSABLE** before scoring the ten failed assertions, and restored
`src/custom-tabs.js` byte-for-byte
(`files/f22-r568-focused-proof-20261003.log`). No tail allowance,
reclassification of unseen failures, forced thaw or second mutation
was attempted. The temporary unproved focused mode is being removed;
R568 remains individually **UNPROVEN**. The full anchor dry-run
resolved after the attempt.
The semantic-only temporary route and its changed R568 control
selection were removed; R568 is back on `test:tabs` with its
original `mustPass`, `requireMustPassAssertions` and
`requireExactFailures`. A final full read-only anchor audit again
resolved every setup
(`files/f22-r568-cleanup-anchor-audit-20261003.log`).
Fresh independent Sol, Terra and Luna are reviewing the only
lasting R545 revert-record change (`requireExactFailures`) and this
bounded evidence disposition. F22 remains active, not integrated;
these two unresolved proofs are not release approvals.
The fresh independent Sol, Terra and Luna reviews found **no
blocker** in that R545 fail-closed guard or the R545/R568 evidence
disposition. They agree the guard rejects collateral, not that R545
or R568 is proved. A normal, unmutated tabs regression run after the
retained focused R102 fixture is the next verification step; it is
not a clean-tree milestone run.
That normal, machine-exclusive tabs run completed **478/478** with
zero failures after the focused-proof changes
(`files/f22-postfocused-integrated-tabs-20261003.log`). This is an
unmutated affected-suite check on the still-uncommitted F22 worktree,
not the mandatory clean-tree full suite, full revert harness,
strict built-asar packaging or viewed release screenshots.
The two pre-agreed bounded R545/R568 proof attempts are exhausted:
R545 has a clean standalone setup but six additional downstream
failures under its mutation; R568 has a clean standalone semantic
setup but an unusable post-footer mutation transcript. Neither
should be called a proof or rerun unchanged. Any further isolation
requires a fresh scoped decision; documenting these explanations
alone does not make the complete revert harness pass or release
F22 from its mandatory gates.
The maintainer authorized **one more bounded target-only isolation
round**, one record at a time, rather than switching workstreams.
Opus is tracing whether R545 can end its existing shutdown scenario
immediately after both target and independent control assertions,
before the six later lifecycle checks, without a forced thaw, broad
reset or incomplete footer. Terra will edit only if the design is
small and self-contained. R568 follows R545's verdict, not in
parallel. No prior collateral or unusable run has been promoted and
no release gate is waived.
Opus's read-only R545 target-only trace found a **structural stop**.
Returning after the second target would still execute a `finally`
assertion about update-borrow IDs whose witnesses are populated only
by later updater scenarios; even an unmutated focused run would fail.
The caller also enters several state-dependent later scenarios.
Relocating that assertion and gating the callers would exceed the
agreed small-fixture bound and change unrelated test ownership.
There was no new R545 edit or mutation. Keep its exact-failure guard
and **UNPROVEN** status; evaluate R568 separately under the same
bounded target-only criterion.
The read-only R568 target-only trace also reached a **structural
stop**. Its semantic function emits the maintained-dirty checks
among many dirty-dependent sibling assertions in one monolithic
result; omitting the siblings would suppress real failures. The
earlier focused log's **27/27** raw footer had the same late
`Shutdown approval renderer unusable: webContents destroyed` line as
the mutation, so even the clean focused transcript would fail the
strict parent-tail rule; an R568-only mutation-tail exception would
not certify a healthy baseline. The mutation footer's **17/27**
already implies more failures than R568's two named targets, but
their exact names were not retained by the unusable proof log and
must not be guessed. Another mutation solely to chase those names
would exceed this bounded round. No R568 code, source or fixture was
changed in this second design pass. Both R545 and R568 remain
individually **UNPROVEN** and continue to block the F22 execution
gates; completing them now needs a broader reviewed test redesign
or an explicit reprioritization, not another identical mutation.
The maintainer subsequently chose that explicit reprioritization:
**defer R545 and R568's individual proofs, switch to independent wave-2
work, and do not let these two deferred proofs alone block release.**
This supersedes the preceding blocking disposition, not its evidence.
R545 remains COLLATERAL/UNPROVEN and R568 UNUSABLE/UNPROVEN; neither
becomes PROVEN or a behaviorally withdrawn `skip`. The release harness
must account for exactly these two explicit exceptions separately
from proofs and fail closed on all other records. F22 is still
unmerged, and all other individual, integration and release gates
remain in force. In particular, no release was authorized.
Opus found the existing focused F22 virtual-suite pattern can run a
clean, standalone two-Save queue observation without carrying 9e or
later F22 state. Terra now owns a capped fixture/revert-record
implementation and one individual proof. The record must require an
observed two-enqueued/two-completed setup and live alert-capture
control as PASS, and only same-path queue overlap as the deterministic
FAIL. One detail of the read-only proposal was corrected before
handoff: a no-refusal `mustPass` would be invalid, because the earlier
R102 mutant *did* trigger a legitimate write-boundary refusal. Neither
disk ordering nor Save refusal may be required as deterministic
mutation evidence; no global sentinel may be claimed unless the
focused runner actually installs and proves one.
Terra implemented the standalone queue-only virtual suite in a
bounded pass. Its clean focused run passed **6/6**; under the R102
mutation both Save requests were enqueued, started and completed,
the alert-capture sentinel was proved live, and same-path queue
max-active rose **1 → 2** with one overlap. The sole failed name was
the direct queue-serialization check, with both setup controls
observed PASS; product bytes were restored and the full read-only
anchor audit resolved. This individual R102 proof is **provisional**
until fresh independent Sol, Terra and Luna reviews of the focused
fixture complete (`files/r102-queue-focused-proof-20261003.log`).
It does not claim that disk bytes were overwritten, that 9e adopted a
reload under the mutant, or that a global error sentinel ran in this
focused mode. The ordinary tabs suite's earlier **478/478** healthy
run and R101's individual proof are separate evidence, not part of
the focused R102 mutation verdict.
In the fresh independent R102-focused review, Sol found no blocker.
Terra noted that the queue's `completed` counter also counts failed
Save operations: two enqueued/completed requests do not by themselves
prove two successful physical disk writes. Luna noted that the
focused runner does not exercise the full console/DOM error sentinel.
Both are valid *scope* concerns; a global zero-error `mustPass` or a
no-refusal requirement would incorrectly reject the observed
write-boundary failure under this mutant. Terra owns a bounded
correction/claim-disposition for these findings before R102 is
accepted. Do not claim disk overwrite, successful dual writes, or
global visible-error absence from this focused transcript.
Terra corrected both review points without requiring an impossible
no-refusal control. The fixture and R102 record now claim two
same-path Save **operations settled in main**, not two successful
physical writes. A deliberate `ErrorEvent` proves the focused
`window.__e2eErrors` listener live; the focused suite then checks for
no uncaught JavaScript errors. It still does **not** claim that the
normal suite's console/DOM sentinel ran, and the expected
write-boundary refusal remains diagnostic-only. The corrected clean
focused run passed **8/8**; the individual R102 mutation again failed
only the queue overlap check with all four controls PASS and
byte-restored source
(`files/r102-queue-listener-proof-20261003.log`). The full anchor
dry-run resolved. Fresh independent Sol, Terra and Luna review of
this material correction is in progress.
The fresh second round by independent Sol, Terra and Luna found no
remaining blocker. **R102 is individually PROVEN for the narrow,
deterministic same-path queue-serialization invariant**: the
mutation makes overlapping Save operations observable while the
two-operation setup and focused uncaught-JS-error listener remain
live. There is no overwrite/data-loss, dual-successful-write, 9e
reload or global console/DOM-cleanliness claim. The interim full-tabs
9e skip remains conditional; R101 separately remains PROVEN. This
closes R102's individual revert gate, **not** F22's full-suite or
release gates.
R94's old tab-switch rebaseline anchor was repaired to the current
indentation, but its individual run is **WRONG-GUARD**: the expected
second-tab undo assertion did not fail; an unrelated updater
commit/error assertion did. Product bytes were restored
(`files/f22-r94-bounded-proof.log`). Do not infer this hook remains
load-bearing from the historical record or rerun the same mutation
unchanged; isolate whether another path now captures the baseline.
The isolation found that normal switches use `beginFileOpen`, which
captures the arriving tab's edit baseline; the old hook runs only on
the legacy fallback. R94 now reverts this *active* capture, and the
fixture positively checks that physical tab B was selected and edited.
Its bounded break/restore is **PROVEN** with exactly the intended
second-tab undo resurrection failure, passing setup and A-tab
round-trip controls, and restored renderer bytes
(`files/f22-r94-active-path-proof.log`). Fresh independent Sol, Terra
and Luna reviews found no blocker. The earlier WRONG-GUARD run is
historical, not proof of the active hook.
The post-R94 unmutated tabs suite passed **469/469**, including the
second-tab setup and undo assertions
(`files/f22-r94-postfixture-clean-tabs.log`). This clean repeat does
not resolve the preceding intermittent updater failures. The full
read-only anchor audit now reports **10 SETUP-FAILED** records
(`files/f22-r94-current-anchor-audit.log`).
R100's old order-swap anchor also targeted the legacy fallback,
not the active `beginFileOpen` capture. Its repaired revert captures
the arriving tab's baseline *before* its dirty state is restored;
the original later capture then no-ops for a preserved baseline. The
fixture now witnesses tab A dirty and tab B selected and clean before
editing B. The first individual run was **COLLATERAL**: R100's
intended dirty-state failure occurred, but two later F22 Save controls
failed on ctime-only metadata drift despite successful saves and
matching disk bytes (`files/f22-r100-active-order-proof.log`). A
bounded retry with unchanged exact-failure policy was **PROVEN**:
only the intended "clean B inherits dirty A" assertion failed;
required setup and content controls passed and product bytes were
restored (`files/f22-r100-bounded-retry-proof.log`). R94 was separately
reproved after the shared setup witness changed, with only its
second-tab undo failure (`files/f22-r94-after-r100-setup-proof.log`).
Fresh independent Sol, Terra and Luna reviews found no blocker;
Luna corrected its initial reading of the Save-control version
evidence: mtime was unchanged, only ctime moved. The cause of that
metadata-only drift is not established by this proof.
The post-R100 unmutated tabs suite passed **470/470**, including
both dirty-to-clean arrival controls
(`files/f22-r100-postfixture-clean-tabs.log`). The full read-only
anchor audit now has **9 SETUP-FAILED** records
(`files/f22-r100-current-anchor-audit.log`); neither this clean
repeat nor the anchor count resolves the intermittent updater issue.
R92's discard anchor was retargeted to the current
`setDocumentDirtyState` path without removing history or dirty-state
restoration. Its first run had a linked but unlisted replay failure;
the corrected, strictly accounted individual break/restore is
**PROVEN** with two exact failures: the discarded text remains on
screen, then is replayed from the tab record. The round-trip setup
must PASS and renderer bytes were restored
(`files/f22-r92-exact-proof.log`). Fresh independent Sol, Terra and
Luna reviews found no blocker; these are two observations of one
baseline-restoration defect, not separate fixes.
R101's reload-baseline anchor was retargeted to the current forced
capture. Its bounded individual break/restore is **PROVEN** with only
the named discard failure: after a witnessed different-content
reload, removing the capture restores stale pre-reload text instead.
The different-content setup must PASS; renderer bytes were restored
(`files/f22-r101-bounded-proof.log`). Fresh independent Sol, Terra
and Luna reviews found no blocker.
R98's retargeted background-save mutation is **VACUOUS**: the
ordinary suite stayed green after dropping replies for an inactive
tab (`files/f22-r98-bounded-proof.log`). Independent Sol, Terra and
Luna reviews agree that the existing fixture proves disk write but
does not witness the *first* reply arriving and settling while the
other tab is active; a main-process ACK retry after returning can
mask the drop. Terra owns a bounded test-only first-delivery witness
and individual reproof in the integration worktree; no result is
claimed before that handoff returns. R98 is still open.
Terra's first delivered fixture produced two named failures and a
**471/471** unmutated tabs run
(`files/f22-r98-first-delivery-proof.log`,
`files/f22-r98-tabs-baseline.log`), but the fresh independent Sol,
Terra and Luna review **did not accept it yet**. The fixture holds
attempt one only; main may retry the same unacknowledged result after
four seconds, before release or after returning to the saved tab,
making a valid mutation appear green. Luna also identified that the
fixed-sleep elapsed assertion does not measure async Exit completion.
Terra has the bounded correction handoff. R98 remains **UNPROVEN**
until that feedback is resolved and reproved without a retry race.
Terra's bounded follow-up held every correlated retry, released
attempt one on the background tab, retained retries through return
and Exit, then released and settled them in cleanup. It replaced the
fixed-sleep claim with an observable Exit transition and six-second
deadline. The individual R98 mutation now reports the same two
named failures with held and released attempts `[1, 2]`, no extra
failures, and an unmutated **470/470** tabs baseline
(`files/f22-r98-retry-bounded-proof.log`,
`files/f22-r98-retry-bounded-tabs-baseline.log`); product source hashes
were restored. Fresh independent Sol, Terra and Luna reviews of
these corrected bytes are underway. Do not count R98 as accepted
until those verdicts are adjudicated.
Those three independent reviews all **blocked acceptance** of the
retry-bounded fixture. Sol and Terra agreed that renderer pending-save
settlement precedes the asynchronous main-process ACK: the fixture
could remove its interceptor while main still owns a delivery and
retry timer. Luna additionally found that a retry arriving before
the stage returns can escape while the first request ID has not been
assigned, and that zero captured retries bypasses the cleanup check.
The observed `[1, 2]` proof remains useful evidence, but does not
make those paths deterministic. Terra has the narrowly scoped
follow-up to capture the request ID on the first intercepted send,
and to await both renderer settlement and main delivery/correlation
quiescence before removing interception. R98 is still **UNPROVEN**.
That follow-up's individual run ended **UNUSABLE**: while enforcing
main delivery/correlation and renderer pending-count baselines, the
held attempts did not settle those counts, so the fixture threw before
a complete parent-suite footer
(`files/f22-r98-main-correlation-proof.log`). Product bytes restored.
Do not treat the earlier green R98 mutation as accepted. Stop
expanding this timing fixture; restore its last tested ordinary-suite
version and leave the R98 proof open for a separate bounded design.
That prior fixture has been restored without the unproven ACK hooks.
One unmutated machine-exclusive tabs run passed **470/470**
(`files/f22-r98-restored-fixture-tabs-baseline.log`); product source
hashes matched before and after, and no test processes remained.
This confirms an ordinary baseline, **not** an R98 proof; R98 stays
open.
Opus's later read-only retry trace established a key constraint
for a bounded reproof: main ACKs only the **current** attempt
number; holding every retry indefinitely cannot settle its
delivery, and a one-time `finally` snapshot can miss a later
attempt. The failed main-quiescence log is consistent with that
shape but cannot exclude a try-body error masked by teardown.
A safer candidate is to intercept only attempt one, restore
ordinary delivery **before** releasing it, enforce a measured
release inside the four-second ACK deadline, and witness main's
delivery/correlation counters returning to baseline before a
stronger Exit claim. This is a design hypothesis, **not** a proof;
the mutant must also clean up without an unacknowledged retry
leaking into later tests.
Opus's follow-up excluded the tempting `__shutdown.reset()` cleanup:
main explicitly forbids resetting before the Save result and ACK,
and renderer has no reset for its pending-save map. There is a
production-path candidate instead. R98 drops results only while
the saved tab is **not** active; after witnessing that attempt one
was dropped on the background tab, switch back and let a later
natural retry pass the guard, settle renderer pending Save and ACK
main. This may make the older Exit/discard symptom pass under
the mutation, so a bounded revised record must honestly require
only the initial background-delivery failure and prove both
renderer and main cleanup before later suite cases. The post-switch
ACK leg is not yet witnessed, so this remains **UNPROVEN**.
Terra has since produced a bounded first-delivery candidate:
attempt one is held for under three seconds, main's send hook is
restored before release, and both renderer pending count and main
delivery/correlation counters must return to baseline. On the
mutant, returning to the saved tab allows the *production retry*
to settle, rather than using a test-only reset. The individual
R98 run reports exactly one first-background-delivery failure;
the old Exit/discard and disk/tab controls remain required PASS,
and the restored ordinary tabs run passed **475/475**
(`files/f22-r98-bounded-*.log`). This proves at most the
**immediate delivery** boundary, not inevitable data loss or
Exit failure. Fresh independent Sol, Terra and Luna reviews are
underway before counting this proof.
Fresh independent Sol, Terra and Luna reviews all **accepted** the
bounded R98 proof with no blocking disagreement. A timed attempt-one
delivery settles while the other physical tab is active on healthy
bytes; under the mutation it does not, but the saved tab's later
natural retry settles after return. Renderer pending Save and both
main delivery/correlation counts return to baseline in either case,
with the old Exit/return behavior retained as PASS controls.
R98 is **PROVEN for prompt first-background-delivery only**;
it does not demonstrate that removing this guard inevitably loses
data or that Exit must fail despite retries.
The current read-only full `--anchors` audit reports exactly six
unresolved records: R86, R87, R96, R97, R99 and R552
(`files/f22-current-full-anchor-audit.log`); R102's anchor resolves
but its individual stalled proof remains unusable.
R86's old source anchor has since been retargeted to the active
`prepared.content` save path, changing only the view-mode source to
the stale textarea while preserving edit-mode saves. Its individual
run detected the named stale-disk-write failure but also six
collateral failures (including later F22 Save controls and CRLF view
saves), so the exact-failure policy correctly rejected it as
**COLLATERAL / UNPROVEN**
(`files/f22-r86-individual-proof.log`). The anchor resolves and
product bytes restored; no new ordinary-suite run was claimed.
Recount unresolved anchors on current bytes rather than reusing the
pre-R86 inventory. Do not narrow this mutation to a fixture-specific
special case merely to make the proof green.
R87 has also been retargeted to the successful view-mode Save-result
adoption, without changing edit-mode or failure handling. The
in-memory-document assertion failed as intended, but two F22
pending-save/close assertions also failed. Their relation to the
mutation has not been established; the exact proof verdict is
**COLLATERAL / UNPROVEN** (`files/r87-individual-proof.log`).
Product bytes restored, the anchor resolves, and no post-mutation
ordinary-suite result is claimed.
R96 has been retargeted to the active successful edit-mode
Save-result assignment while retaining the saved-byte dirty
comparison. The individual run reached an unrelated fixture
precondition in subsequent scenario 9c and threw before a complete
suite footer: scenario 9b's mutation left its store different from
disk, and 9c requires a clean disk baseline. It is **UNUSABLE /
UNPROVEN**, not a detection
(`files/r96-retarget-proof.log`; see the retained `r96-retarget-*`
transcripts). The source anchor resolves, product bytes restored, and
no healthy result is inferred from the interrupted mutation.
R97's narrow edit-mode dirty-state revert also stopped on the
**same** scenario-9c clean-baseline precondition and is
**UNUSABLE / UNPROVEN** (`files/f22-r97-bounded-proof.log`).
Both R96 and R97 mutate scenario 9b state intentionally; scenario
9c assumes that earlier scenario left a pristine store. This is now
a shared fixture-isolation problem, not a reason to add new
failure names or widen either revert. Terra has a bounded handoff to
restore scenario 9c's independently checked disk baseline after
recording 9b's assertions, then reprove R97 before reconsidering R96.
The bounded isolation attempt still hit 9c's clean-baseline fatal,
so it was **not kept**. The fixture was byte-restored to the last
tested version, then one unmutated machine-exclusive tabs run
passed **470/470** with product bytes unchanged and no test
Electron left running
(`files/f22-r97-fixture-isolation-proof.log`,
`files/f22-r97-restored-fixture-tabs-baseline.log`).
R96 and R97 both remain **UNPROVEN**; repeating their unchanged
mutations would only reproduce a fatal, not supply evidence.
Opus's read-only follow-up located the precise shared obstacle:
scenario 9c's clean-baseline check still asserts scenario 9b's
**pre-reset** dirty and saved-store values. R96 changes the
pre-reset store and prevents the old reset gate; R97 changes the
pre-reset dirty flag, so the bounded post-test reset could not
make either assertion true. A 9c-only physical-disk fixture with
its own post-reload owner/content checks is the narrow structural
alternative; its design is not yet implemented or proven. Do not
weaken 9b's own saved-store/dirty assertions to make this pass.
Terra has now separated 9c's physical-byte setup from 9b's
pre-reset renderer state while retaining the real reload and
post-reload identity/disk/version checks. Its first R97 mutation
reached a complete suite footer: exactly the renderer dirty assertion
failed; the tab remained dirty independently, so the old record's
second expected failure was a **WRONG-GUARD**, not a second detected
bug (`files/f22-r97-independent-9c-baseline-proof.log`).
The R97 record is being corrected to require that tab assertion
as a passing control, then reproved with an unmutated baseline.
Neither the new fixture nor R97 is accepted yet.
The corrected individual R97 run reports **exactly the one
renderer-dirty failure** with the tab still dirty, the saved-store,
disk/race setup and other-tab controls passing. Its restored
unmutated tabs run passed **470/470**, product bytes were restored,
and no test Electron remained
(`files/f22-r97-corrected-proof.log`,
`files/f22-r97-corrected-tabs-baseline.log`). Fresh independent Sol,
Terra and Luna reviews of the fixture and proof are in progress;
R97 is provisionally proven, **not yet accepted**.
Fresh independent Sol, Terra and Luna reviews all **accepted** the
independent 9c fixture and R97's narrow proof. They found no
blocking disagreement: 9c still requires an accepted real reload
and independent disk/owner/version witnesses; R97 alone breaks
the renderer dirty answer while the tab baseline and other controls
remain intact. R97 is **PROVEN** for that renderer-level behavior.
The same fixture can now be tested against R96 separately; R96 is
not promoted by R97's result.
R96's separate individual mutation has now reached a complete
footer: exactly the named saved-store failure occurred while the
disk still held `S9B_SENT`, later editor text remained dirty,
the tab baseline and other tab remained correct, and the positive
controls passed. The restored ordinary tabs run passed
**470/470** (`files/r96-followup-*.log`); product bytes restored.
Fresh independent Sol, Terra and Luna review is underway before
accepting R96, and its result does not change R98's status.
All three fresh reviews **accepted** R96's independent saved-store
proof with no blocking disagreement. The R96 mutation alone copies
later keystrokes into the document store while disk and the tab
baseline remain on the written bytes; R97's separate dirty-state
mutation leaves that store intact. R96 is **PROVEN** for this
saved-byte boundary.
Opus's read-only R86/R87 collateral trace found that the later F22
failures use their **own** file content, not scenario 6's `V_EDITED`
fixture bytes. The reverted code is a global view-mode save path;
its wrong textarea source/re-adoption remains active in later F22
tests. Ctime-only drift is not evidenced in either transcript.
Do not use a scenario-6 cleanup to hide those real downstream
effects. The bounded next step is to enumerate and independently
reprove all causally linked failures in each record under the
existing exact-failure policy, retaining independent passing
controls; R86/R87 remain **UNPROVEN** until then.
R86's revised record now names the scenario-6 disk failure and
all six measured downstream view-mode save-source failures without
loosening exactness. Its individual run reports exactly those seven
failures and passing divergent-store, in-memory and unaffected
edit-mode CRLF controls; restored ordinary tabs passed **470/470**
(`files/f22-r86-corrected-individual-proof.log`,
`files/f22-r86-corrected-tabs-baseline.log`). Fresh independent Sol,
Terra and Luna reviews must still verify that each added failure
really follows from the same wrong source before R86 is accepted.
R87 remains unproven.
The R86 reviews did **not** converge. Sol and Luna blocked counting
scenario 7's discard assertion as an R86 failure: scenario 6's bad
view-mode save leaves the renderer dirty, scenario 7 fails to
establish a clean initial dirty baseline, and its discard correctly
restores the inherited value. Terra regarded this as a downstream
consequence. Sol also requested local stale-textarea witnesses for
the later F22 view-mode Save fixtures; Terra considered their
captured wrong request bytes sufficient. The exact seven-failure
transcript remains evidence, **not accepted proof**. A bounded
test-ownership correction will make scenario 7's baseline clean
and witnessed, make those later Save fixtures locally demonstrate
their divergent sources, and then remeasure R86's exact failure
set without weakening the harness.
That first correction repaired and witnessed scenario 7's clean
baseline, but the next R86 mutation was **UNUSABLE**: all four new
producer-race/pending-close stale-textarea setup assertions failed
to appear as required `PASS`
(`files/f22-r86-hygiene-individual-proof.log`). No exact R86
verdict or post-change healthy result can be inferred. An
unmutated baseline is being run before deciding whether to repair
or roll back the new fixture; do not run another mutation until its
own setup is demonstrably alive.
The unmutated tabs run made this a measured fixture bug, not an
R86 effect: **471/475 passed**; precisely the four new witnesses
failed. Their captured active path/tab, target content and distinct
stale textarea were sound, but they required a
`selectionGeneration` field that `getActiveDocumentIdentity()` does
not return (`files/f22-r86-hygiene-unmutated-tabs-baseline.log`).
Terra has the bounded correction to witness the renderer's separate
active-selection generation instead. R86 remains **UNPROVEN** until
an unmutated green setup, exact individual proof and restored green
run establish it.
The corrected shared setup witness now reads the renderer's
active-selection generation separately from its tab owner. On these
fixture bytes the unmutated tabs suite passed **475/475** before
mutation, R86 failed exactly **six** locally supported view-mode
save-source assertions while scenario 7's discard remained PASS,
and the restored suite passed **475/475** afterward. Product bytes
matched before/after (`files/f22-r86-selection-generation-*.log`).
Fresh independent Sol, Terra and Luna reviews of this material
fixture correction are underway. R86 remains provisionally proven,
not accepted until they adjudicate the prior blockers.
The fresh independent Sol, Terra and Luna reviews **all accepted**
the corrected R86 proof. Sol and Luna explicitly confirmed their
earlier blockers are gone: scenario 7 has its own witnessed clean
baseline, and each later F22 view-mode Save witnesses its own
selected owner and divergent textarea before dispatch. The six
exact failures, required PASS controls and pre/post **475/475**
baselines now establish R86 as **PROVEN** for the global view-mode
save-source boundary. R87 remains a separate, unproven
view-mode Save-*result* boundary.
R87's separate mutation now reports exactly the scenario-6
in-memory overwrite and two F22 pending-save/close failures, with
locally witnessed divergent textarea setups, correct disk bytes
and edit-mode controls all passing. Renderer bytes were restored
and the ordinary tabs run passed **475/475**
(`files/r87-followup-proof.log`,
`files/r87-followup-tabs-baseline.log`).
Fresh independent Sol, Terra and Luna review of those linked
failures is underway before accepting R87; this does not promote
any other open revert.
Fresh independent Sol, Terra and Luna reviews all **accepted R87's
narrow stale-adoption proof**. They agree the later F22 assertions
fail because the view-mode Save result overwrites the correct
in-memory document with an independently witnessed stale textarea,
despite correct saved disk bytes and correlated results. These
downstream failures do **not** demonstrate broken pending-save
deferral or close sequencing themselves: both still waited for
results. R87 is **PROVEN** for the in-memory Save-result boundary,
not for an unrelated sequencing claim.
R99 has been retargeted to the renderer's live current-owner guard.
Its one individual run reported exactly the named foreground
contamination failure while the disk-write, first-delivery and
saved-tab controls passed; the restored ordinary tabs run passed
**470/470**, with renderer bytes restored
(`files/r99-*.log`). Fresh independent Sol, Terra and Luna review is
underway before this proof can be accepted. On the current bytes a
full read-only anchor audit now finds **only R552**
`SETUP-FAILED` (`files/f22-post-r99-full-anchor-audit.log`);
anchor resolution is not a proof, and R552's previously unsafe
silent-approval mutation is not to be run unchanged. Opus is tracing
a safe execution boundary read-only.
The fresh independent Sol, Terra and Luna reviews **all accepted
R99's narrow foreground-contamination proof**: the identity guard
alone is removed, exactly one named assertion fails, and the disk,
delivery, saved-tab and restored-suite controls hold. They differed
on the shared 9c fixture's retry qualification: Sol and Luna retain
the unresolved ACK/quiescence caveat, while Terra judged it excluded
by the observed first delivery. This does **not** promote R98's
first-attempt settlement or cleanup claim; R98 stays **UNPROVEN**.
Opus's read-only R552 trace located the moved fallback guard and
proposed mutating it to a fail-safe *decline* rather than an
auto-approval, avoiding the destructive updater/close continuation.
This is a candidate design, **not proof**; it must be exercised and
reviewed independently before accepting R552.
R552's unsafe auto-approval revert has now been replaced with that
fail-closed, post-latch decline candidate. It is deliberately
**UNPROVEN**: suppressing shared fallback dialogs in the full tabs
suite could cause collateral timeouts, so no mutation or ordinary
suite run was claimed. A fresh full read-only `--anchors` audit on
current bytes reports **all anchors resolving**
(`files/f22-post-r552-full-anchor-audit.log`). This closes the stale
anchor inventory only; it does **not** close R552, R98, R86/R87,
R96/R97, R102, R545/R568 or the complete-harness release gate.
One later machine-exclusive **fail-closed** R552 run was allowed,
but it exceeded a six-minute watchdog with no completed parent
suite footer. Only its verified test Electron PID was stopped; the
harness then restored `main.js` byte-for-byte and classified the
run **UNUSABLE** (`files/r552-individual-proof.log`). A deleted-file
Save conflict appeared in the tail, but its cause is not proven.
Do not mistake the truncated run or resolved anchors for a revert
proof. R552 remains **UNPROVEN**.
Opus's read-only comparison of R552 and R102 showed the six-minute
stop was an **external limit**, not the tabs suite's own watchdog:
the parent watchdog starts at 420 seconds **plus** companion and
teardown budgets, over 900 seconds. The deleted-file
`SaveConflictError` in R552 is a main-process console error, and
that scenario already has a scoped renderer-alert stub; the R102
tail is a different renderer failure. Neither transcript proves a
shared hanging modal or even that the suite had stopped making
progress. A single machine-exclusive R552 run allowed to reach
the suite's own watchdog or complete normally is a justified
diagnostic, without altering or globally swallowing alerts.
The justified full-watchdog R552 run **completed naturally in
555.9 seconds**, well before its computed **1,820-second** internal
watchdog (`files/r552-rerun-*.log`). The four declared fallback
questions failed as intended and all existing `mustPass` controls
held; another sixteen assertions failed outside the exact
`expect` set. The harness correctly called this **COLLATERAL**,
not proof. Product bytes restored and no test processes survived.
No re-raise storm or hanging modal is established. Opus is
independently classifying the extra failures before any decision to
enumerate them; R552 remains **UNPROVEN**.
Opus found the additional failures all route through the **same
shared fallback-question funnel**; the fail-closed mutation
suppresses every caller, including invalid-revision and installed
commit cases. Widening the record to all twenty names would make a
very broad proof of the funnel, not a discriminating proof of
R552's original intent. A narrower call-site mutation is being
traced read-only before making another code or test change; the
current run remains **COLLATERAL / UNPROVEN** despite a complete
suite footer.
Opus's narrower trace corrected its earlier call-site count to
eleven and showed that R552's four declared assertions arrive by
**different** routes. The bare page with no tab overlay reaches
the unique trailing `dispatchShutdownRequest` fallback after the
loading branch; unreadable-answer and crashed-renderer cases take
other branches. Terra has a bounded R552 retarget to that single
call site, replacing only its question with a fail-closed decline,
retaining adjacent loading controls and requiring the bare-page
failure exactly. The broader four-route claim is withdrawn for
this record; other routes need their own evidence rather than
being implied by its result.
The narrowed R552 run completed naturally in **385.7 seconds**.
The intended bare-page fallback assertion failed, all three
required controls passed, and product bytes restored; however two
other assertions failed, so the exact harness verdict is
**COLLATERAL / UNPROVEN** (`files/r552-narrow-*.log`).
The deferred-commit failure recorded the mutation's decline
reason, but the synchronous overlay-probe failure recorded
`settleWhy: null`; it is not yet attributable to the same call
site. Opus is tracing these two routes read-only before any
expectation is widened or another run is attempted.
Opus traced the two extras to the same narrowed call site. The
deferred-commit case carries the mutation's unique decline reason.
The probe-throw case snapshots `settleWhy` **before** emitting
`close`, so its `null` does not refute the route; the actual close
finds an unusable but live renderer and reaches that trailing
dispatch branch. That latter link still lacks a post-close runtime
witness. Terra has a bounded handoff to capture it, positively
prove the fresh close and live-unusable owner, and require exactly
the three linked failures with independent passing controls.
No R552 proof is accepted yet.
The bounded correction added a **post-close** runtime witness to
the probe-throw case: request ID advanced, the renderer was
unusable, its webContents remained live/non-crashed, and the
mutation's decline reason was observed. The narrowed R552 run
finished naturally with exactly the bare-page, probe-throw and
deferred-commit failures, all four required controls passing,
`main.js` restored, and healthy tabs **476/476 both before and
after** (`files/r552-live-unusable-*.log`,
`files/r552-witness-*.log`). Fresh independent Sol, Terra and Luna
reviews are underway before this scoped live-unusable dispatch
proof is accepted; the old broad fallback-funnel claim remains
unproven.
Fresh independent Sol, Terra and Luna reviews all **accepted the
narrow R552 proof**. The mutation can only decline the live-unusable
renderer at the trailing dispatch call; it cannot approve an
updater or close action. The bare-page, probe-throw and
deferred-commit-loss cases each reach that exact branch, with
post-close evidence for the non-obvious probe route and zero
destructive continuations. The individual run failed exactly
those three assertions, required four independent PASS controls,
and restored `main.js`; pre/post tabs runs passed **476/476**.
R552 is **PROVEN for this dispatch fallback only**. The former
whole-funnel claim is not accepted by this scoped proof.
Remove diagnostic sidecars, finish the remaining individual proofs,
repair and reprove the older rotted
anchors, obtain fresh independent final reviews, and complete strict
built-asar packaging, clean-tree suites, viewed wave screenshots,
performance gates and serialized integration before promoting F22.

**Mandatory close-path measurement — CLOSED (2026-09-05).** This item adds an IPC
round trip on shutdown and a renderer-side scan of every open tab, so it falls
squarely inside the *Performance acceptance gates* below: IPC and DOM traversal
are both named there, and the gate applies whether or not the change looks cheap.
Predicting the cost instead of measuring it is exactly what this repository's
*measure; do not reason from the code* rule forbids.

**The budget was declared before the run that was judged by it: raw p95 <=
16.7 ms**, one frame at 60 Hz, applied to every observation including the
worst-case dirty ones. The permanent record — full method, all three runs, the
durability limitation of the second, and what the gate deliberately does not
measure — is `bench/BASELINE.md`, *The F22 shutdown-approval gate*; the defect
the gate found and the fix it drove are `docs/PERF-AUDIT.md`, PERF-10.

**Three runs, each executed exactly once. None is an average or a best-of.**

| Run | Runtime | Cold worst | Warm worst | Single CRLF | All-dirty LF | All-dirty CRLF | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 — pre-optimization | 352112 ms | 2.538 | 0.993 | 1.048 | **22.4936** | **98.1947** | **FAIL** |
| 2 — optimized | 351318 ms | 2.5598 | 1.0094 | 0.4962 | 0.9079 | 1.1272 | pass, 0 failures |
| 3 — attestation | 354850 ms | 2.5902 | 1.0375 | 0.7076 | 1.002 | 1.2792 | pass, 0 failures |

All figures are **raw** p95 in milliseconds, nearest-rank, at 2 MB × 25 tabs for
the dirty rows and worst-of-nine-points for cold and warm. The lifecycle control
reached real application termination on runs 2 and 3.

**Run 1 is a result, not a discarded outlier.** It is the measurement that found
the defect — the close path recomputed every open document's dirtiness, so a
shutdown after editing every tab re-read and re-normalised 50 MB — and it is what
drove the maintained-dirty-state architecture. Recording only the passing runs
would hide the reason the passing runs exist.

**Evidence durability, stated rather than glossed.** Run 2's raw samples were
**not persisted**: the durable-output path did not exist when it was taken, so
its figures are the reported statistics and nothing else — there is no sample
array behind them to re-derive. Run 3 carries the exact raw arrays, each
observation's point and mode, its raw and rounded statistics, the budget and the
per-observation verdict, and the all-dirty filename oracles, in
`f22-final-benchmark-attestation.json` with its console transcript alongside.
**It does not carry** the fixture byte counts and SHA-256 digests, the envelope
token, or the setup and lifecycle validation records: those checks ran and a
failure in any of them fails the run, but they were performed transiently during
`validateResult()` and execution, and only their consequence — **0 failures** —
survives in the file. Re-deriving them means re-running the gate. The artifacts
are **machine-local closure artifacts, not repository files**, and are
deliberately not committed; a later run reproduces the shape via
`F22_RESULT_FILE` (`docs/BUILD.md`).

**Suites, both before and after the revert harness ran:** `test:tabs` **205/205**
plus the isolated portable companion **25/25**; `test:security` **189/189**;
`test:packaging` **265 passed / 0 failed / 1 expected skip**.

**Proofs.** `--expects` audited **545 records across 11 suites** with **3
excused** and **no orphaned regexes**, over **1,697 assertions**. `--anchors`
resolved **545/545 before and after**. Every one of the **58 F22 records
R543–R604** was proven **individually** (R575, R576, R581 and R587 do not exist),
with the tree byte-restored after each. No leftover processes, markers, locks or
temp residue; the diff check came back clean.

**No screenshot evidence is claimed for this item, and none exists.** F22 is
interaction, state-machine and performance work; its visual surface is the
platform's own modal dialog. The *Wave-2 exit criteria*' `shots` requirement is a
separate item covering the theme surfaces.

---

**Historical — the withdrawn first characterization (2026-09-02/03).** Kept
because the reasoning that rejected it is the reason the gate above is
trustworthy, and because the numbers themselves were never in dispute. It is
**superseded** by the three runs above.

**Method.** `bench/bench-f22-shutdown.js`, Electron **43.4.1** / Node
**24.18.1**, **two full runs**. Renderer snapshot + all-tab dirty scan: **n=200**
after **20 warmups**. Clean native-close approval-to-continuation: **n=40**.
Fixture: the repository `README.md`, **25,762 characters per tab**. The modal
count was asserted **zero** on every clean run — the prompt-free path raises no
dialog, which is what makes these numbers the *clean* shutdown cost.

Ranges below span the two runs; where a single figure is given, both runs agreed.

| Measurement | Tabs | p50 (ms) | p95 (ms) |
|---|---|---|---|
| Renderer `snapshotActiveTab` + all-tabs `isDirty` | 1 | 0.3 | 0.4–0.5 |
| Renderer `snapshotActiveTab` + all-tabs `isDirty` | 10 | 0.8–0.9 | 1.1–1.4 |
| Renderer `snapshotActiveTab` + all-tabs `isDirty` | 25 | 1.9–2.0 | 2.2 |
| Clean native-close approval → continuation | 1 | 1.15–1.26 | 1.42–1.61 |
| Clean native-close approval → continuation | 10 | 1.67–1.75 | 1.88–2.87 |
| Clean native-close approval → continuation | 25 | 2.64–2.73 | 2.97–3.09 |
| Bare IPC round trip (reference floor) | — | 0.165–0.177 | 0.21–0.30 |

Worst single sample observed across both runs: **3.78 ms**, at 25 tabs.

**On the absence of a "before" number.** There is no pre-F22 baseline for the
approval path, because that path did not exist — the protocol is what this item
introduces. The figures above are therefore not a delta against a measured prior
state; they are the cost of the new path as measured. That is a real limitation
of this evidence, not a technicality: with no before-number there is nothing to
regress against, which is precisely why the gate has to be closed against a
budget instead. The bare IPC row is included as the floor the protocol cannot go
below, so the protocol's own share is visible. **This limitation still stands**;
it is why the closed gate above is judged against a predeclared budget rather
than against a delta.

**Why that was characterization and not a passed gate — and how each defect was
closed.** Three defects, none of them in the numbers themselves:

1. **One fixture.** Every figure in the historical table uses the repository
   `README.md` at 25,762 characters per tab. The *Performance acceptance gates*
   call for representative content sizes, and this is a single point.
   **Closed:** the gate now runs 50 KB / 500 KB / 2 MB across 1 / 10 / 25 tabs,
   plus all-dirty worst cases at 2 MB × 25 tabs in both LF and CRLF.
2. **No before-path and no prior figure** to compare against, as set out above.
   **Not closed, and it cannot be** — the path did not previously exist. This is
   why a predeclared budget carries the verdict.
3. **No budget was declared before the measurement was taken.** Reading a
   threshold off an observed result and then declaring the result acceptable is
   post-hoc acceptance, which the gate policy exists to prevent. The earlier
   framing of these numbers as a pass did exactly that and is withdrawn.
   **Closed:** 16.7 ms was fixed before the judged runs, and run 1 failing
   against it is the evidence that the budget was real rather than decorative.

**What closing the gate required — all met.**

- **An objective UX budget recorded before the next run** — met: raw p95 <=
  16.7 ms, one frame at 60 Hz, declared ahead of the runs it judged.
- **A fixture matrix beyond the single README** — met: **50 KB / 500 KB / 2 MB**
  across **1 / 10 / 25 tabs**, plus the all-dirty LF and CRLF worst cases.
- **The final run after the review gate's product fixes are in the working tree**
  — met: runs 2 and 3 were taken after those fixes.
- **The budget is not chosen in this document** — respected: it was proposed and
  accepted before the runs, and appears here only as a record of what was
  applied.

**Do not overgeneralise this result.** The gate covers **up to 25 tabs** and
documents **up to 2 MB** each. Nothing here measures 100 tabs, or documents
larger than the matrix. The all-dirty observations are the worst case *within*
those bounds, not beyond them. Any change that raises either bound re-opens this
measurement.

**Status.** The implementation, the executed suites, the proven reverts and the
closed performance gate all exist in the **uncommitted working tree**; they have
**not landed on `main`**, and nothing here is merged. `w2-f22` remains
**ACTIVE**. What is complete: implementation, tests, revert records, the
execution gates (suites, anchors, `--expects`, individual proofs) and the
performance gate. What remains: the final three-reviewer round over the executed
state, and serialised integration. The permanent record required before landing
is now written — `bench/BASELINE.md` (method and runs) and `docs/PERF-AUDIT.md`
(PERF-10, the defect and the fix) — so an uncommitted bench file is no longer the
only place the evidence lives.

**Review round — corrections applied, nothing re-run (2026-09-04).** A sealed
three-reviewer round returned ten findings against the working tree. All ten
were validated against the current source and fixed; one carried a mistaken
mechanism, corrected below, and two implementation decisions taken while fixing
them are recorded in *Maintainer decisions on record*. The corrections, all
uncommitted:

- **Product** (`src/main.js`, `src/custom-tabs.js`) — the portable updater now
  confirms **twice against the live document**: once at the child's `spawn`
  event, before the release gate is written, so a decline still stops an
  installer that has not started; and again at the **acknowledgement**, before
  the quit, because everything between those two points — spawning, polling,
  `start`, the write-back — is time in which the reader can type. Both are
  silent on a clean document. It quits only on an acknowledgement written by
  the batch *after* it has started the installer, carrying a per-hand-off
  secret, with a fail-closed timeout. Every failure and cancel path now removes
  the private temp directory. The shutdown state machine gained an `onDeclined`
  channel so an asynchronous hand-off is told when its intent will never run.
  The renderer's shutdown snapshot now compares the live document against the
  **cached** copy rather than the on-disk one — undoing a view-mode edit used to
  leave the abandoned text in the tab — and its replay cache is bounded to the
  one answer that can still be replayed.
- **Benchmark** (`bench/`) — budgets are compared against **raw** p95 samples,
  with rounding confined to presentation; the worker parent settles exactly once
  on error/close/timeout, so a failed spawn can no longer crash it and leak the
  exclusive lock; and two **worst-case all-dirty observations** (2MB × 25 tabs,
  LF and CRLF) were added, gated against the same budget, each proved
  non-vacuous by an exact filename oracle.
- **Verification** — `.github/workflows/ci.yml` gained a second, read-only job
  running `prove-table-fixes.js --expects`, the audit that catches a renamed
  assertion; `test/test-packaging.js` asserts both audits run and that no
  workflow runs the tree-rewriting mode. Thirteen revert records were added
  (R590–R602), six repaired against moved anchors, and **R560 was replaced** —
  its previous mutation was behaviourally inert and could not fail anything.

**A second review round found seven more defects, all fixed here.** Two
independent read-only reviews (Claude Opus 5 and GPT-5.6 Luna) were run over the
corrections above before they were reported. Both found real defects, and one of
them was introduced by this round:

- **HIGH, introduced by the snapshot fix** — five test fixtures assigned
  `tab.content` on the ACTIVE tab and only then called `switchToTab`, leaving
  `window.originalMarkdown` holding the pristine text. The corrected fold does
  exactly what it should with that and folds the edit away, so four existing
  assertions would have measured a clean tab they believed was dirty. The
  fixtures now move the live copy first; the product change is unchanged.
- **HIGH** — an acknowledged portable hand-off quit on consent that could by
  then describe a different document. It now re-asks when a question is already
  open or the document session has changed.
- **MEDIUM** — a hand-off that timed out *after* its gate was open cleared the
  retry latch, so a second Install press could launch a second installer over
  the first. Only a pre-release cancel or the batch's own failure report — both
  of which prove nothing started — clear it now.
- **MEDIUM** — `attachShutdownGuards()` and the `__shutdown.reset()` seam
  dropped pending and queued intents without declining them, stranding a parked
  hand-off.
- **MEDIUM** — the benchmark's `listener` control sent no renderer generation,
  so every one of its 40 samples timed the handler's stale-request early return
  rather than the scan. It now passes the generation and refuses to report
  unless all 50 calls were answered.
- **MEDIUM** — the benchmark's exclusive lock survived a Ctrl+C or an uncaught
  exception, making the gate unrunnable until the file was found by hand.
- **LOW** — a duplicate-replay assertion could no longer distinguish a cache hit
  from a recompute; the portable `error` handler lacked the terminal-state guard
  every other path has.

Two of Luna's findings were **rejected**, with reasons recorded in *Maintainer
decisions on record*: the ack token being readable by another same-user process,
and `%`-expansion in batch-interpolated paths.

**A third round found one more, and it is the sharpest of them (2026-09-04).**
Luna, reviewing the post-fix snapshot, blocked on the acknowledgement boundary:
it quit outright whenever the document *generation* was unchanged and no other
question was open. That test cannot see the case it most needs to. An edit typed
after the gate opened and before the acknowledgement came back involves no
navigation and raises no question, so the generation is unchanged and the edit
was discarded by a quit that believed it had consent — the same defect `w2-f22`
exists to remove, moved one boundary later. The acknowledgement now always takes
a fresh renderer approval, silent on a clean document, with a **quit-only**
continuation: it never re-enters the installer path, never re-releases the gate,
and a decline leaves the app running, unauthorized and still latched, because an
installer that is already running must not be joined by a second one. Covered by
two new assertions (decline and approve) and by the rewritten **R601**.

**Round 4 — Terra's final execution FAILED, and the correction is architectural
(2026-09-05).** `npm run test:tabs` returned 200/204 (portable companion 25/25),
revert record **R567** returned WRONG-GUARD, and the benchmark failed honestly:
all-dirty 25 × 2MB raw **p95 22.49 ms (LF)** and **98.19 ms (CRLF)** against the
16.7 ms budget. Cold max 2.538 ms, warm max 0.993 ms, single-dirty CRLF
1.048 ms. Three root causes, none of them in the numbers:

1. **The fold could not tell which side moved.** Comparing the live document
   against the *cached* copy fixed the resurrection defect but broke its mirror
   image: a value written straight into `tab.content` — a reload takeover, a
   completed background save, a test seam — is *newer* than the live copy, and
   the fold reverted it, after which the tab read clean and was clobbered by the
   next disk refresh. Both situations present the identical state, so no pair of
   values can separate them. The tab now records the live document its fold last
   observed and adopts only when that witness has moved. All three failing
   product assertions are this one defect.
2. **The measurement window did not contain the work.** The `sameDocument`
   assertions wrapped their scan counters around the *shutdown handler*, but the
   comparison had already been made — and memoised — by the snapshot inside
   `switchToTab`, so they counted zero whatever `sameDocument` did. That is why
   "finds a one-character edit" failed, and why **R567** could delete the
   CR-free fast path without breaking the assertion that names it. The counters
   now wrap the **assignment**, which is where the comparison happens.
3. **Dirtiness was recomputed on the close path.** The memo was keyed on the
   *values*, so its own validity check was itself a full document comparison —
   25 × 2MB of scanning and, for CRLF, of re-normalisation, on every shutdown.
   The answer belongs to the edit, not to the close: `content` and
   `originalContent` are now accessors that settle dirtiness once, at the moment
   the text changes, and shutdown reads one boolean per tab plus at most one
   active-tab reconciliation. Accessors deliberately, not a convention — this
   file, `renderer.js`, the suites and the benchmark all assign those properties
   directly, so a rule that had to be called by hand would be one refactor from
   a stale flag, and a stale flag here reads as "nothing unsaved".
   `setCleanDocument()` states the clean case atomically instead of comparing
   twice on the way to an answer that is already known. **The budget, the
   fixtures, the tab counts, the CRLF observation and the exact filename oracle
   are unchanged; nothing was trimmed, filtered, or moved out of the timed
   window.**

**Durable evidence — Terra could not save the raw samples.** The run deleted its
working directory and printed only rounded figures. Every run now prints one
greppable `F22-RESULT-JSON` line carrying the **raw** p95 of every observation,
and `F22_RESULT_FILE` writes the full record — every raw sample, both
statistics, the budget verdict and the oracle — atomically to a caller-chosen
path, before the lock is released, so a Ctrl+C still leaves its numbers behind.
Nothing is written by default and no artefact lands in the repository. Both
halves are asserted by `test:packaging`.

**One finding's stated mechanism was wrong; its conclusion was not.** The
benchmark finding attributed the free dirty scan to the cold/warm *fixtures*
being reference-identical. They are separate files, read separately. What
actually makes the scan free is `createTab()` storing **one string reference in
both `content` and `originalContent`** (`src/custom-tabs.js`), so `sameDocument`
returns on its identity check before reading a byte. The observation stands and
the worst-case observations were added; the reason recorded here is the measured
one.

**These corrections have not been executed.** No suite, benchmark, revert
harness or build was run in the session that made them; static syntax and anchor
checks only. Treat every claim above as *written*, not *verified*, until Terra
re-runs the affected suites, `--anchors`, `--expects` and `npm run bench:f22`.

**Two consequences that need a decision when it is re-run.**

1. The all-dirty observations apply the **clean-path** budget to a path that
   ends in a modal dialog. They may well exceed it; that is a real number to
   act on, not a defect in the harness, but whether a dirty close is bound by a
   frame budget at all is the maintainer's call and is still open.
2. `--expects` has never run in CI. Its first run audits all 500-odd records,
   not just this item's, so it may surface pre-existing orphaned regexes
   elsewhere in the register.

**Trap to respect.** A modal dialog raised in the **main** process cannot be
dismissed by any test — the process that would run the rescue is the process
that is blocked (`.github/copilot-instructions.md`, "Traps in this repository").
Any approval prompt this item introduces must be designed around that, or the
suites hang instead of failing.

**2026-10-04 full-harness exception handoff.** The F22 worktree now has a
reviewed no-argument release path that first rejects a dirty tree, audits every
anchor and live assertion name, and then reports only fingerprinted R545/R568
as **DEFERRED/UNPROVEN** without applying those individual mutations. Explicit
ID runs still attempt the ordinary proofs; a skipped-only deferred assertion,
orphaned name, unusable baseline, failed non-deferred proof or un-restored edit
cannot produce a release-success result. The initial design that matched
R568's incomplete mutant-failure signature was rejected by all three
independent reviewers; the corrected design received a fresh Sol/Terra/Luna
round with no blocker. A focused clean tabs name audit found both records'
`expect` and `mustPass` names live, and the full read-only anchor audit resolved.
The dirty-tree negative control exited before any suite. These are **not**
a clean-tree complete revert run, full integration, strict built-asar packaging,
or authorization to release. The no-Electron and machine-exclusivity
preconditions remain operator checks immediately before the eventual full run.
The first **full** live-name audit then **failed closed**
(`files/f22-full-name-audit-20261004.log`): several clean suite transcripts
end with a shutdown-destruction line after their footer, R135's built-asar
assertions were not observable without a build, and R543 still names an old
navigation assertion. A direct clean startup and popup run confirmed the
single shutdown line after passing footers; this is not permission to ignore
arbitrary or fatal output. Terra owns a bounded test/harness correction;
neither the complete name audit nor the release preflight was green at that
point. Terra's correction now admits only that exact lone line on clean
passing baselines, emits R135's two unavailable built-asar assertions as
**named SKIPs**, and retargets R543 to the current denied-navigation
assertion. The first complete audit on those bytes still exited 2 when its
clean tabs suite returned 477/478; it correctly left that suite's catalogue
UNAUDITED, but did not retain the failing assertion name. A separate clean
tabs run passed **478/478**, and one machine-exclusive complete `--expects`
retry exited **0** (`files/f22-full-name-audit-retry-20261004.log`):
no orphaned names or unusable suites. R135's two built-asar names are live
but **SKIPPED/unobserved without a build**, not execution or proof. The
independent Sol/Terra/Luna repair reviews agreed on the named-SKIP and
current R543 behavior; Sol found no blocker. Terra raised the existing
release-workflow gap (the tag workflow does not itself run the manual full
suite/revert gates), and Luna raised the existing generic exact two-line
mutation teardown allowance and lockfile-only asar freshness check. None
was introduced by this narrow repair; keep the manual wave-2 exit gates
mandatory and run strict packaging against the actual new build. This
audit pass does **not** close the complete revert, clean integrated suite,
strict built-asar packaging or viewed-screenshot gates.
On the reviewed F22 bytes, the complete `npm test` chain exited **0**
(`files/f22-full-suite-20261004.log`); its packaging leg still reported
the same two absent built-asar SKIPs, so this is not strict packaging.
A fresh independent Sol/Terra/Luna round over the current F22 lifecycle,
owner and test/revert evidence found no additional blocker; all three kept
the explicit R545/R568 deferrals and remaining wave exit gates visible.
The F22 stream was then committed as `ade3073` on
`feat/w2-f22-reviewed-20261004`, leaving that worktree clean. This is a
stream commit. With explicit maintainer approval, the integration
checkout's earlier one-line removal of the `dirtyTabNames()` active-tab
snapshot was restored before fast-forwarding F22 through `ade3073`.
The combined anchor audit resolved. The post-landing `npm test` run
finished **nonzero**, with theme at **355/363** (PDF-ready, theme-menu
and OS-colour-scheme setup failures); its other legs, including tabs
**478/478**, passed (`files/f22-integrated-full-suite-20261004.log`).
One separate quiet theme run then passed **363/363**
(`files/f22-integrated-theme-repro-20261005.log`). The failed aggregate
is retained, not reclassified as a green full suite. No clean-tree
combined suite, full release revert inventory, strict fresh built-asar
verification or visual release inspection has yet been claimed.

---

## B. Security and wave-2 hardening

### `w2-sec08` — context-isolated renderer · ACTIVE

Turn off `nodeIntegration` in the main window, turn on `contextIsolation`, and
put a minimal validated `contextBridge` preload in front of it. The four popup
windows are already done; the main window is the deliberate, documented
remainder (`docs/SECURITY-AUDIT.md`, SEC-08).

This is the largest single item in the register and it is not a flag flip. The
audit records the measured size of it: **40** distinct IPC channels to re-expose,
**70** `ipcRenderer` call sites, **18** synchronous `fs`/`path`/`os` calls that
become asynchronous IPC round-trips, and **6** renderer-only CommonJS modules
with no loader once `require` disappears (`docs/SECURITY-AUDIT.md`, the SEC-08
inventory table).

> **The audit's inventory is a snapshot and has already drifted.** It records
> `renderer.js` at **8,631** lines; at `db7b960` the file is **9,319**. Re-take
> the counts against the tree before planning the work — do not budget from the
> table above.

**2026-10-05 first-unit design check; no implementation at that point.** A minimal
Electron 43.4.1 window with the main window's current
`nodeIntegration: true, contextIsolation: false` settings printed
`{"bridge":null,"preload":"contextBridge API can only be used when contextIsolation is enabled","requireType":"function"}`
when its preload called `contextBridge.exposeInMainWorld`. The proposed
first-unit test preload therefore cannot use `contextBridge` until the
later flag flip: it must use a narrowly scoped, main-gated plain global
for interim test access, **not** claim isolation or a security fix, and
switch its exposure mechanism along with the eventual flag flip. Opus
and Luna agreed on harness-first sequencing and a test-only mode; Luna
correctly narrowed the first migration from all injection sites to one
fixed-purpose, non-security suite route. Their uncertainty about
whether the current flags let `contextBridge` attach at all is resolved
by the observed runtime exception. SEC-08 is still PENDING, the main
renderer remains Node-privileged, and the complete migration and
performance gates below remain mandatory.

**First harness-unit handoff.** A clean isolated worktree
`feat/w2-sec08-harness-one-20261005` was created from the combined
integration HEAD `7cc985a`. Sol (high) has implemented only the
main-window test-preload selection gate there, uncommitted: the
nonpackaged, explicitly marked `--folia-test-preload` path selects
`test/test-preload.js`, and a marked launch with a missing file fails
loudly. Terra then added the test-only preload, one PDF-restoration signal
migration with a current-window, fresh-token, post-result witness,
the exact test-only packaging exception, and two individual reversions.
The targeted Mermaid suite passed **120/120**, the unmarked security
suite **193/193**, and packaging **304 passed** with **two built-asar
SKIPs**; R674 and R675 each reported PROVEN with their named failures
and passing controls, and all 616 anchor setups resolved. This does
not substitute for a freshly built strict asar or complete suite.
Three **fresh**, independent Sol/Terra/Luna reviews of the entire
unit, including its untracked preload, completed a first round:
Terra found no blocker; Sol and Luna independently found that the
new signal can be sent before the renderer finishes its awaited PDF
theme restoration. Sol's follow-up established that the missing
post-restore observable was also present in the old test, but the new
path removes its 2.5-second delay and exposes the race. Terra owns a
bounded correction using the existing post-restore notification,
and that correction now passes Mermaid **122/122**, individually
PROVEN R675 with the expected three bridge failures and passing
pre/post-result controls, and **616/616** anchor setups. In the fresh
second review Sol and Terra reported no new blocker, but Luna found
that the scenario's stored light preference may skip the very awaited
dark-theme restore the new notification is meant to witness. Both
the Terra role owner and Sol reviewer independently confirmed this:
the old fixture also had the conflicting preference, but the new
completion claim requires an exercised restore. Terra revised the
PDF fixture to a late dark preference, light prepare, exact
success-notification-time restored hold and all-node dark-fill
checks, and fresh bridge token only afterward. The targeted Mermaid
suite passed **126/126**, R675-R679 each reported individually
PROVEN with exact named failures and required passing controls, and
all **620** anchors resolved. R674 was already PROVEN against its
separate packaging gate. This was substantially more test/proof
machinery than the initial one-route design (roughly 450 changed
tracked lines); a new independent Sol/Terra/Luna round is now
checking both correctness and whether that scope earns its
maintenance cost. That round found no remaining correctness blocker:
all three agreed the late dark preference and event-time all-node
snapshot are meaningful; Sol and Terra identified the synthetic
stale/fresh-token exchange as unnecessary harness machinery, while
Luna did not regard it as a vacuity. Sol and Luna also found the
separate frozen/exact-one-key test-global reverts R678/R679 low ROI
for a non-isolated, test-only global; Terra considered them distinct
contract proofs. The integration owner is keeping the real
gate/delivery/dark-restore/all-node controls while requesting a
bounded trim of the synthetic exchange and R678/R679. Sol
incorrectly treated R674 as not yet individually run; its earlier
targeted packaging proof is recorded above. Terra's bounded ROI trim
removed that synthetic stale/rejected-token exchange and the
test-global shape reverts R678/R679 while retaining R674-R677,
the single fresh-token/sender bridge delivery witness and
notification-time all-node restore probe. Mermaid passed **125/125**;
the four remaining records were each run and PROVEN with exact
failures and passing controls; all **618** anchors resolved. A new
independent Sol/Terra/Luna review of this **reduced** final diff is
complete: all three found no new significant issue, and Luna
confirmed the late dark-restore/event-time controls survive the
trim. A before/after cold-start and first-paint check against the
unchanged integration tree is now underway because the gate touches
main-window creation. The first probe was rejected before producing
a window (Electron 43's immutable `BrowserWindow` export prevented
instrumentation), so it supplies **no samples or gate clearance**.
One bounded fallback will observe `browser-window-created` instead
of replacing the export. That fallback measured seven fresh,
before/after-interleaved Electron 43.4.1 launches from **different
worktree paths** and crossed the predeclared material-regression
budget: first-contentful-paint proxy p50 **805.3 to 906.9 ms**
(+101.6 ms, +12.62%), and main-window load p50 **843.0 to
940.3 ms** (+97.3 ms, +11.54%). Both p95 deltas were smaller
(+15.2 and +26.7 ms, respectively); raw sample pairs varied in
sign, with a paired FCP median delta of about +17 ms. This is a
**failed/unexplained performance gate**, not evidence that the
unmarked preload branch alone costs 100 ms and not permission to
waive the budget. One final same-path, balanced-order diagnostic
initially failed before Electron launched because its positive
control removed the declaration block but overlooked the associated
`...testPreloadPreferences` spread; a read-only diff confirmed these
were the only 12 main.js insertions. That guard is being corrected
once to allow the planned same-path measurement to distinguish code
from worktree-path/order effects. The corrected same-path experiment
then observed **seven AB/BA-interleaved pairs** under one identical
worktree filename, renderer URL and Electron 43.4.1 runtime:
FCP-proxy p50/p95 HEAD **1168.0/1203.0 ms**, candidate
**1161.6/1190.5 ms**; load p50/p95 HEAD
**1203.3/1234.5 ms**, candidate **1193.9/1230.7 ms**.
Neither metric crossed the fixed **both >10% and >25 ms** regression
budget in the controlled comparison. This clears only the
**unmarked, harness-only selection gate** under the stated empty
window/in-memory-compile limitations, not the complete SEC-08
benchmark set. Both experiments and their uncertainties are recorded
in `docs/PERF-AUDIT.md`. The source unit is reviewed, measured for
its bounded scope, and its six named files were committed as
`6be9311` on the clean isolated
`feat/w2-sec08-harness-one-20261005` stream after the targeted
startup suite passed **11/11**. The stream then fast-forwarded
serially into the integration checkout at `6be9311`. Post-landing
startup **11/11**, Mermaid **125/125**, security **193/193** and
packaging **313 passed, 0 failed, 1 packaged-feed SKIP**; all **618**
combined anchors resolved
(`files/sec08-integrated-anchor-audit-20261005.log`; setup only, not
proof). One complete integrated `npm test`
subsequently exited **0** with all 13 suites completing, including
tabs **478/478** and theme **363/363**
(`files/sec08-integrated-full-suite-20261005.log`). This result was
on the integration checkout with documentation changes pending,
**not** the final clean-tree release run; its packaging leg still
did not strictly verify a freshly built asar. The old failed tabs
and combined `--expects` observations are retained. One complete
machine-exclusive, read-only `--expects` run on the newly landed
tree then exited **0**: all **618** records' assertion names were
live across **15** suite catalogues, with the three existing
mutation-only names excused and one packaged-update-feed assertion
SKIPPED/unobservable without a new build
(`files/sec08-integrated-live-name-audit-20261005.log`). This audit
does **not** execute the reverts or replace the prior failed runs.
The full clean-tree revert inventory, fresh strict packaging, viewed
screenshots and complete SEC-08 isolation remain open.
Opus found that the existing packaging scanner only matches
direct single-literal `preload: path.join(__dirname, "...")`
references and that `test/` is not shipped. Do not evade the scanner
by changing `path.join` shape: the new conditional test-only
reference must be explicitly covered by a packaging assertion and
must never be selectable in a packaged or unmarked launch. The
first harness unit has completed independent Sol/Terra/Luna review
and integration; the remaining renderer migration has not. This
is a harness migration, not completion of SEC-08.

**Next unit handoff (2026-10-05).** The integration owner created clean
`feat/w2-sec08-loader-one-20261005` from `1d088ab` to migrate exactly
one renderer-only module's loader. Opus mapped module dependencies;
Luna independently checked the smallest safe dual-mode design.
Both found pure, already-packaged modules suitable for a first unit,
but Opus preferred `mermaid-config.js` with a renderer `require`
fallback and a separate no-Node probe, whereas Luna preferred
`utils.js` without the fallback. The integration owner selected
`utils.js`: it has one product importer and no dependencies, and
using its browser global directly makes an absent or misordered tag
fail instead of succeeding through Node. Preserve its CommonJS API,
wrap classic-script declarations to avoid collisions, and have Terra
prove browser-without-Node behavior and existing Node behavior
independently. Sol (high) now owns the three product-file edits in
the isolated worktree; Terra follows with tests, automation and
individual revert proof. No isolation flag change is authorized.
Sol completed the three-file product edit, preserving the CommonJS
API and making `renderer.js` fail loudly without the preceding local
script; source syntax and the diff check passed. Terra's independent
test design preferred a dedicated new suite, whereas the integration
owner requested reusing the existing security suite if its isolated
no-Node window can prove the same browser behavior without adding
another full-suite catalogue. Terra now owns that bounded test,
packaging, post-merge and individually reverting proof work; at that
handoff, neither targeted tests nor reviews were claimed.
Terra's focused security suite passed **199/199**, its no-Node
loader leg **6/6**, and packaging **309 passed, 0 failed** with
two absent-asar SKIPs. The **621** combined anchor setups resolved;
R680-R682 each individually reported PROVEN with the intended exact
failure and passing controls, and their source bytes were restored.
Three fresh Sol/Terra/Luna read-only reviews of the complete eight-file
unit (including the new fixture) are now in flight. They must finish
before any performance attribution or integration; the full SEC-08
benchmark matrix, clean-tree release suite, fresh strict asar, full
revert inventory and wave screenshots remain open.
The first fresh review round found no product blocker: Sol and Terra
reported no significant issue, while Luna identified an overclaim in
the fixture's hard-coded terminal marker. It proves that the isolated
test document loaded, not that `utils.js` executed; the separate
representative-behavior assertion proves script execution. Terra is
renaming that independent R680 passing control to reflect its actual
meaning, without making it depend on the very global-publication
branch R680 removes. The reviewers agreed the main renderer remains
Node-enabled and the missing asar and startup evidence remain open.
Terra corrected the label and its exact R680 passing-control matcher
without altering the static marker: it now says the **document reached
its terminal DOM marker**, while the separate behavior assertion alone
proves utility execution. Focused **6/6**, full security **199/199**,
individual R680 **PROVEN**, and **621** anchor setups still pass.
Fresh-review follow-ups are checking that correction. Terra is
running a machine-exclusive, same-path real-file seven-pair startup
comparison in a disposable session probe; until it produces complete
samples, the loader unit's performance gate remains open.
All three independent Sol/Terra/Luna follow-ups found the corrected
test control accurate and no new blocker. Their code-review agreement
does not independently execute the claimed suites or reverts; the
test owner's focused results above remain the execution evidence.
The first real-file same-path A/B run stopped at pair 3B: Chromium had
no FCP entry when its complete page fired `did-finish-load`; only
three baseline and two candidate observations were valid, with two
complete pairs too few for the predeclared seven-pair p50/p95 gate
(`files/sec08-loader-fcp-probe-20261005/results.json`). Source
hashes matched, the disposable app was restored to candidate bytes,
and the reviewed worktree was unchanged. This is **inconclusive**,
not a pass or attributed regression. One bounded session-only
measurement correction will await the actual buffered FCP entry
without changing its recorded timestamp, then repeat the full
balanced run; another failed collection will be recorded rather
than retried blindly.
The corrected real-file run completed all seven alternating AB/BA pairs
with valid original-timestamp FCP entries. Under the predeclared
**both >10% and >25 ms** criterion, candidate FCP p95 crossed the
gate: baseline **1601.0 ms**, candidate **1812.4 ms**
(+211.4 ms, +13.20%); FCP p50 was 1214.2 to 1221.0 ms
(+6.8 ms, +0.56%). Load p50/p95 did not cross it.
Paired FCP deltas changed sign and ranged from -453.2 to
+674.5 ms; this is a **blocked startup gate**, not a proved
module-loader cost or permission to integrate. The unchanged
candidate worktree, restored disposable app and raw samples are
recorded in `files/sec08-loader-fcp-probe-v2-20261005/results.json`
and `docs/PERF-AUDIT.md`. Before further measurement, Terra
predeclared one machine-exclusive confirmation with 14 further
balanced pairs and a pooled 21-per-variant p50/p95 decision
against the **same** budget, retaining both runs and stopping
if collection or the pooled gate failed. Read-only research of
the next module did not waive this unit's performance gate.
That single confirmation completed **14 further balanced pairs**,
with no excluded samples. V3 FCP p50/p95 baseline to candidate
was **1202.1/1660.9 to 1167.9/1534.6 ms**. The predeclared
pooled **21 A/21 B** decision produced FCP p50/p95
**1213.8/1601.0 to 1211.9/1534.6 ms** and load
**1216.47/1790.43 to 1218.36/1585.58 ms**: no pooled
metric crossed the unchanged both >10% and >25 ms budget.
The original seven-pair p95 failure remains an observed failure,
**not** silently relabelled as a pass. Nearest-rank p95 is the
maximum at seven observations but the second-highest at 21,
so the failed candidate's 1812.4 ms outlier remains in the
pooled data but not in its p95 value. Even the pooled maxima
compare **1660.9 to 1812.4 ms** (+151.5 ms, +9.12%),
below the >10% half of the material-regression rule. The
pooled comparison combines two runs, each path-controlled
within its own A/B pair (pooled p95 A from V2 and B from V3);
it clears only the bounded startup gate, with substantial
per-launch noise;
it does not clear packaged startup, file-open/render or the
complete SEC-08 benchmark matrix. All original and disposable
source hashes matched candidate B after the run, with no
probe-owned process left; raw results and the fixed pooled
decision are retained at
`files/sec08-loader-fcp-probe-v3-20261005/results.json`.
The isolated loader unit was committed as `839e1f8` on the
clean `feat/w2-sec08-loader-one-20261005` stream after the
three independent correction follow-ups, then fast-forwarded
serially into the integration checkout at `839e1f8`.
Post-landing impacted startup, Mermaid, security, tabs, packaging
and combined anchor checks then passed: startup **11/11**,
Mermaid **125/125**, security **199/199**, tabs **478/478**,
packaging **318 passed, 0 failed** with one packaged-feed
SKIP (no auto-updatable build), and all **621** anchor setups
resolved. Packaging inspected an existing built `app.asar`,
not a fresh build from this commit. The anchor result is
a setup audit, not proof that
the full revert inventory ran. Full clean-tree suite,
strict freshly built asar, full revert inventory, viewed wave
screenshots and complete SEC-08 isolation remain open.

**Next loader handoff (2026-10-05).** After the utility loader
landed and its impacted checks passed, the integration owner
created clean `feat/w2-sec08-loader-mermaid-20261005` from
`839e1f8`. Independent Opus architecture research and Luna
design assessment agree `mermaid-config.js` is the smallest
next dependency-free module with one renderer importer.
Both require an IIFE, preserved CommonJS API, one fail-loud
browser-global consumer and a real no-Node proof; neither
supports reviving a renderer `require` fallback. Luna
additionally identified existing R319 source-anchor sensitivity
and theme geometry checks as relevant; Terra should assess
whether a separate IIFE revert proves distinct value instead
of adding redundant machinery. The prior six-module inventory
is a snapshot: the `notification-helpers.js` packaged module
has no current product importer, so count active imports afresh
before calling loader migration complete. Sol (high) now owns
only the three product-file edits in the isolated worktree;
Terra's test, proof and performance handoff follows. The
main-window isolation flag remains unchanged.
Sol completed the three-file Mermaid config product migration
without changing config values or call sites, keeping the
existing R319 theme-selection anchor intact. Syntax and
diff checks passed; no Electron suite or mutation proof had
run at that handoff. Terra now owns focused no-Node and Node
behavior tests, theme/Mermaid controls, packaging and post-merge
guards, and individual reverts in the isolated worktree.
The fresh independent review and startup performance attribution
remain pending; no second-unit integration is authorized yet.
Terra's no-Node loader leg passed **12/12**, Mermaid **125/125**,
theme **363/363**, and packaging **315 passed** with two absent-`dist`
asar-notice SKIPs. The preceding integration run had an existing
built asar and passed more artifact assertions; neither result
is the required strict check against a fresh build. All **625**
anchor setups resolved. R683-R686
each reported one intended named failure with restored product
hashes. The first R681 adaptation only duplicated `utils.js`,
losing its original script-order proof; the integration owner
caught that after the initial review. Terra restored R681's
three-tag **Utils-before-renderer** order mutation. The
mutated source now fails exactly the two coupled script-order
assertions, leaves package and direct-consumer controls passing,
and was individually PROVEN with product hashes restored;
packaging and all 625 anchors still pass. R319's
existing theme-selection anchor resolves, but a separate
individual mutation is **UNUSABLE**, not PROVEN: theme reached
the expected 361/363 failure state, then the harness rejected a
post-footer `Shutdown approval renderer unusable: webContents
destroyed` diagnostic also observed after the normal 363/363
theme run. It is not assigned a release-proof exception;
investigate it within a bounded follow-up. The R681 correction
triggered a new fresh independent Sol/Terra/Luna review round;
startup attribution, commit and serial integration of this
second unit remain pending.
The fresh GPT-6 Sol, GPT-5.6 Terra and GPT-6 Luna read-only
round found no further significant implementation or test
issue; Sol explicitly confirmed the corrected R681's two
ordering failures and independent controls, while Luna
retained R319's UNUSABLE status and the pending performance
gate. None independently executed suites or reverts.
Terra now owns one machine-exclusive, real-file, same-path
21-pair AB/BA startup comparison (baseline `839e1f8` vs
the three reviewed product files), with a predeclared material
rule of **both >10% and >25 ms** at FCP or window-load
p50/p95. It must report raw samples, the original buffered
FCP timestamps and restored-source integrity; no result
or integration is claimed until it completes.
The fixed **21-pair / 42-launch** real-file same-path
comparison then completed with all buffered FCP entries present
and no excluded samples or retries. Baseline-to-candidate
entry-to-FCP p50/p95 was **978.3/1141.8 to
988.8/1089.1 ms** (+10.5/-52.7 ms); entry-to-load was
**999.989/1125.363 to 1005.036/1127.190 ms**
(+5.046/+1.827 ms). Neither metric crossed the fixed
**both >10% and >25 ms** budget. The paired FCP
median/mean were **-11.40/-19.63 ms**, opposite in sign to
the unpaired p50, with 21 pair deltas spanning
**-213.5 to +231.5 ms**. Nearest-rank p95 at 21 samples
selects one second-highest launch per variant; that tail
estimate is noisy. This does not show zero module cost or
clear file-open/render, packaged startup or the full SEC-08
benchmark set. Original worktree hashes matched and the
disposable product bytes were restored to candidate.
Raw results, snapshots and logs are retained in
`files/sec08-mermaid-loader-fcp-20261005/results.json`;
the method and limitations are recorded in `docs/PERF-AUDIT.md`.
The second loader unit is ready for a named-diff check,
reviewed stream commit and serial integration, followed by
post-landing impacted checks. R319 remains UNUSABLE as
recorded above **at that handoff**, not a new proof exception.
The nine-file reviewed unit was committed as `05f7862` on
clean `feat/w2-sec08-loader-mermaid-20261005`. The integration
branch had since committed the prior utility-loader evidence
as `a7449ac`, so fast-forward was unavailable; the same
reviewed patch landed serially by cherry-pick as `28b4dcf`,
without a product/test merge conflict. At landing, startup,
Mermaid, theme, security, tabs, packaging and anchor checks
were still pending; no integrated suite pass was then claimed.
Those checks then completed serially on integration `28b4dcf`
with exit **0** throughout: startup **11/11**, Mermaid
**125/125**, theme **363/363**, security **205/205**,
tabs **478/478**, packaging **324 passed, 0 failed** with
one packaged-update-feed SKIP (no auto-updatable build),
and all **625** anchor setups resolved. The anchor run is
setup only, not behavioral revert execution; packaging
inspected the existing asar, not a fresh strict release
artifact. Documentation alone is pending in the integration
checkout. At that handoff, the full clean-tree 13-suite
run, R319 resolution and complete revert inventory,
fresh strict asar, regenerated-and-viewed wave screenshots
and complete SEC-08 isolation were still open.
The R319 individual-proof blocker was later resolved by
the separate harness-only stream recorded under `fullrun`;
this historical post-landing status does not supersede
that later result. The **complete** revert inventory
remains open.
**Next SEC-08 loader design, read-only (2026-10-05).**
Independent Opus architecture research and GPT-6 Luna
design assessment selected `context-menu-utils.js` as the
smallest remaining *complete-module* loader unit. It has
no Node dependency but two live product consumers,
`renderer.js` and `custom-tabs.js`; migrate **both** in
one unit so a Node-enabled fallback cannot silently mask
an unmigrated tab client. Luna observed that a split
consumer unit is technically safe while the module remains
dual-mode, but agreed the complete-module migration is
the coherent boundary. Keep the renderer's own
`hideContextMenu()` separate; its imported hide alias
is unused, while `custom-tabs.js` uses both aliases.
Use an IIFE, preserved CommonJS exports and one fail-loud
browser global, with an actual no-Node viewport-clamping
proof and the bounded startup measurement. No third
product unit is started while R319's harness-only stream
holds the shared revert file; the main window remains
Node-privileged and SEC-08 remains pending.
After targeted R319 proof landed, the integration owner created
clean `feat/w2-sec08-loader-context-20261005` from `97e66cc`.
Sol (high) now owns only the four product files
`context-menu-utils.js`, `index.html`, `renderer.js` and
`custom-tabs.js`, including removal of both CommonJS
consumer fallbacks. No product test, no-Node fixture,
startup verdict, review or integration is claimed at
this handoff.
Sol completed the four-file product-only edit in its isolated
stream: the IIFE preserves CommonJS and publishes
`FoliaContextMenu`, the local tag precedes both consumers,
and the renderer and tabs consume that browser global
without a Node fallback. Independent read-only Opus/Luna
product checks found no blocking issue; syntax and diff
checks passed, but no behavior or startup gate is thereby
proven. Terra now owns the bounded no-Node behavior and
CommonJS tests, both-consumer packaging/order guards,
post-merge checks and individually discriminating reverts.
The new HTML tag also invalidates the contiguous R681/R684
anchors, which must be repaired without weakening R681's
original order sensitivity. No test, revert, performance
verdict or integration is claimed at this role handoff.
Terra completed the test/automation unit without changing
Sol's four product files: a real no-Node fixture exercises
viewport clamping, visibility, hiding, CommonJS parity and
live error sentinels; packaging and post-merge guards cover
both consumers and their ordered classic scripts. R681/R684
retain their original distinct order mutations; R687-R692
pin the new loader and consumers, including renderer before
tabs. Terra reported focused no-Node **18/18**, security
**211/211**, and packaging **322 passed** with two absent-asar
skips; those pre-landing suite transcripts were not retained.
All **631** anchors resolved. R680-R691 were individually
PROVEN in the first retained run; after Luna found a missing
renderer-before-tabs guard, Terra corrected that gap and
individually reproved R681/R684/R686/R688/R691 plus new R692.
The second proof log confirms restored source hashes. Evidence:
`files/sec08-context-loader-r680-r691-proofs-20261005.log`
and `files/sec08-context-loader-order-correction-r681-r692-proofs-20261005.log`.
Three fresh independent Sol/Terra/Luna full-unit reviews agreed
there is no remaining significant issue. Sol noted the helper
fixture is not a live right-click UX check; the script-order
guards and passing tab suite do not amount to visual proof.
The first predeclared, serial **21-pair** real-file startup
run passed only the numeric material-regression rule
(**both >10% and >25 ms** at p50 or p95):
FCP p50/p95 **936.5/1026.0 -> 943.4/1124.0 ms**,
load **938.171/1064.835 -> 960.077/1115.381 ms**.
Its FCP p95 worsened **98.0 ms (+9.552%)**, close to
the 10% limb, and the candidate's **1979 ms** maximum
remains in the 42 raw launches. Exclusivity was not
monitored throughout; a second numeric-pass comparison
also could not classify helper processes without parentage.
Both runs and the failed monitor remain retained. The
third run used the same fixed rule and **21 pairs**,
scheduled with no other Folia tests, harness, screenshots
or benchmarks. Preflight found no Electron process;
an ancestry-based monitor took **78 samples over 70.2
seconds**, finding no outside Electron or Folia test
process. Its FCP p50/p95 was **1010.4/1104.8 ->
1023.8/1120.9 ms** (+13.4/+16.1 ms); load
**1033.097/1140.885 -> 1037.735/1117.770 ms**
(+4.638/-23.115 ms). All 42 FCP entries were valid,
source hashes restored, and the monitored per-unit
startup gate **PASSED**. This is bounded, noisy
nonpackaged evidence, not a zero-cost claim: process
sampling can miss brief competitors and unrelated CPU
work was not instrumented. See `docs/PERF-AUDIT.md` and
`files/sec08-context-loader-fcp-lineage-20261005/`.
The reviewed nine-file stream committed as `7f27df8` and
landed serially via cherry-pick `b039eb7`. Post-landing,
security **211/211**, tabs **478/478**, startup **11/11**,
theme **363/363**, packaging **331 passed, 0 failed** with
one packaged-update-feed SKIP, and all **631** anchor
setups passed (retained `files/sec08-context-integrated-*-20261005.log`).
The packaging run reused an existing asar,
not a newly built strict artifact. SEC-08 isolation,
the complete clean-tree release suite and revert inventory, fresh
strict asar, and viewed screenshots remain open.
**Next loader design, read-only (2026-10-05).** Opus and
Luna independently selected the complete
`emoji-map.js` -> `emoji-parser.js` dependency pair. The
parser is the remaining non-builtin local renderer import;
the map is its pure-data prerequisite. Both scripts must
precede `renderer.js` in dependency order, preserve their
Node/CommonJS interfaces, and fail loudly if a required
browser global is missing. This is one coherent unit rather
than loading the parser without its map. The alternative
`file-helpers.js` mixes Node `fs`/`path` I/O with
renderer-used helpers and spans the main process; it needs
a separate boundary design, not an eager script tag.
Luna identified R681/R684/R688's contiguous HTML anchors
as order-sensitive repair work. The integration owner
created clean `feat/w2-sec08-loader-emoji-20261005` from
`b039eb7`; no product or test implementation, review or
performance result is claimed for that stream yet.
Sol (high) completed only the four product files in the
isolated emoji stream. IIFE-scoped map and parser retain
CommonJS, publish `FoliaEmojiMap` and `FoliaEmoji`, and
the renderer consumes the latter without a Node fallback.
The script tags load map -> parser -> renderer; emoji data,
parse behavior and isolation flags are unchanged. Syntax,
diff and CRLF checks passed; independent Opus/Luna product
feedback found no blocker. Terra now owns the bounded
no-Node known/unknown-shortcode fixture, Node parity and
both render paths, packaging/post-merge order controls
and individually proven reverts. No targeted suite, revert,
startup result or integration is claimed at this handoff.
Terra then added one real no-Node fixture and checks for
map/parser publication, known and unknown shortcodes,
missing-map failure, CommonJS parity, live error sentinels,
single-load/order packaging and post-merge guards. The
focused security leg passed **27/27**, packaging **332
passed** with two absent-asar skips, and the render-patch
suite **198/198** including full/light emoji behavior
(retained `files/sec08-emoji-loader-*-20261005.log`).
R681/R684/R688 preserved their original distinct order
mutations; R693-R701 each reported individually **PROVEN**
with intended failures and passing controls in their
per-record logs. Sol's four product-file hashes matched
before and after the reverts. The final anchor log reports
**640** setups resolved, not proof of all 640 behaviors.
Three fresh independent Sol/Terra/Luna full-unit reviews
found no significant regression. Sol observed that the
helper's inherited-object-property lookup for certain
unknown shortcodes already existed in baseline, not a
defect introduced by this loader unit.
One operator-scheduled, process-monitored, same-path
**21-pair** real-file
startup comparison passed the predeclared regression rule
(**both >10% and >25 ms**): FCP p50/p95 **1288.9/1571.1
-> 1224.2/1431.5 ms**, load **1321.728/1624.677 ->
1266.897/1475.644 ms**. Preflight had zero Electron
processes; 76 ancestry-based process samples across 82.7
seconds found no external Electron or Folia test process.
No other Folia harness, screenshot, suite or benchmark was
scheduled during that window; unrelated machine workloads
and sub-sample process lifetimes were not instrumented.
All 42 FCP entries were valid and candidate bytes restored.
This is a bounded noisy startup gate, not proof of a speedup
or the full SEC-08 matrix (`docs/PERF-AUDIT.md`,
`files/sec08-emoji-loader-fcp-20261005/`).
The reviewed nine-file stream committed as `3444485` and
landed serially via cherry-pick `04e1d14`. Post-landing
security **220/220**, render patch **198/198**, tabs
**478/478**, startup **11/11**, theme **363/363**,
packaging **341 passed, 0 failed** with one
packaged-update-feed SKIP, and all **640** anchor setups
passed (retained `files/sec08-emoji-integrated-*-20261005.log`).
The packaging run inspected an existing asar, not a newly
built strict artifact. Main-window isolation, the complete
clean-tree release suite and revert inventory, fresh
strict asar and viewed screenshots remain open.
**Next SEC-08 boundary design (read-only, 2026-10-05).**
Opus and Luna independently selected a renderer-safe
`file-helpers` core split before IPC migration, preserving
the audit's fixed module-loader-first order. Only
`custom-tabs.js` still imports a local Node-backed module;
its BOM/Mermaid normalisation must not drift from the main
process during refresh, restore or multi-open. The pure
shared logic and extension checks belong in a browser-safe
core; `readMarkdownFile` and `sendIPCResult` stay in the
main-process adapter with its existing CommonJS API.
The extension helper must match Windows and POSIX
`path.extname` cases, including dotfiles and trailing dots.
Do not turn the tabs' synchronous stat/read/stat snapshot
loop into async IPC in this loader unit or retain its
silent BOM-only fallback. Luna suggested moving two
renderer-side test probes from Node `require` to the new
global now; Opus said they can wait until the flag flip.
The integration owner chose to migrate those two test
probes with this unit, so they cannot mask a missing
browser loader. An isolated clean worktree
`feat/w2-sec08-file-helpers-core-20261005` was created
from `04e1d14`. No implementation or gate result is
claimed yet; Node integration remains enabled.
Sol (high) completed only the four product paths in that
isolated stream: a new IIFE-scoped dual-mode core publishes
`FoliaFileHelpers`, the existing main-process adapter
retains the 13-key CommonJS API and its Node I/O helpers,
the local script precedes its consumers, and tabs use the
fail-loud global with no BOM-only fallback. The sync
stat/read/stat snapshot loop and fitted estimator constants
are unchanged. A first direct probe exposed POSIX
backslash-filename drift; Sol then made extension parsing
follow Node's Windows/POSIX separator rules using
`process.platform` for CommonJS and `navigator.platform`
without Node. Its direct **4,851-case** comparison per
OS mode passed; this is not a suite or revert proof.
Terra now owns bounded no-Node and Node parity, tab
normalisation, renderer-side test probe migration,
package/order guards and individually discriminating
reverts, including R681/R684/R688 anchor repairs.
No targeted suite, startup verdict, review or integration
is claimed at this handoff.
Terra's first bounded test/proof pass exposed two product
blockers rather than closing the unit. The 20-case Windows
extension matrix catches `C:.mmd` classified as Mermaid
although `path.win32.extname("C:.mmd")` is empty; focused
security **11/13** and full security **231/233** fail only
on that difference. Packaging **337 passed, 3 failed**
with two absent-asar skips because `package.json` omits
`src/file-helpers-core.js` from `build.files`. Corpus
**316/316**, tabs **478/478**, all then-existing anchors and
individual R702/R705/R707 proofs passed with source
restored, but neither anchors nor selected proofs close
the remaining individual records. Terra has frozen test
edits and Sol now owns those two narrow product corrections;
the required targeted rerun, remaining individual proofs,
fresh independent full-unit reviews and startup gate remain
open. No integration is claimed.
Sol corrected the two product blockers in place: the
new core is now included in `package.json`'s `build.files`,
and the Windows extension extractor treats a bare drive
prefix as the basename boundary (`C:.mmd` is no longer a
Mermaid file on Windows). Direct **5,283-case** parity
checks per OS mode and the Node packaging oracle
**340 passed, 0 failed** with absent-asar skips; these
do not replace Terra's targeted security rerun, remaining
individual reversions, full-unit reviews or startup
measurement. Terra now owns only those bounded reruns;
no integration is claimed.
The frozen correction then passed focused security
**13/13**, full security **233/233** and packaging
**340 passed, 0 failed** with two absent-asar skips;
the anchor setups resolved. R703/R704/R706/R708
each reported individually **PROVEN** with one intended
failure; their retained group transcript has no separate
before/after hash attestation.
R702/R705/R707 were proven before the correction and
their anchors still resolve. Retained transcripts are under
`files/sec08-file-helpers-rerun-20261005/`. Because the
HTML script block changed, R681/R684/R688's original
order discrimination still needs individual execution
before the fresh full-unit review. No benchmark,
integration or release gate is claimed yet.
R681/R684/R688 subsequently each proved its original
ordered-loader failure shape against the new HTML block,
with intended failure counts **4/3/2** and restored
`index.html`. R702/R705/R707 were re-proven on the
final corrected product bytes with exact failures,
live passing controls and restored hashes. Together
with R703/R704/R706/R708, every new core record is now
individually **PROVEN**; the anchor audit remains
setup-only, and the complete inventory is still open.
Three fresh independent Sol/Terra/Luna full-unit reviews
found no shipped-use blocker. Terra noticed that invalid
non-string CommonJS helper paths now throw plain
`TypeError` instead of Node `path.extname`'s incidental
`ERR_INVALID_ARG_TYPE` code/message; Sol validated it,
and all three reviewers agreed it is a low-priority
internal API deviation, not a SEC-08 blocker: shipped
callers pass strings, and preserving exact Node error
fields would add adapter wrappers solely for unsupported
input while breaking core/adapter function identity.
Do not describe this as exact error-object parity.
One operator-scheduled, process-monitored **21-pair**
same-path startup comparison passed its predeclared
material-regression rule (**both >10% and >25 ms**):
FCP p50/p95 **932.1/1193.8 -> 960.0/1004.7 ms**,
load **962.334/1489.661 -> 987.720/1033.688 ms**.
Its A variant omitted the new core file; all **42** FCP
entries were valid, candidate bytes restored, and 69
process samples over 59.5 seconds found no outside
Electron or Folia test process. The positive paired
medians and noisy baseline tail preclude a speedup
claim (`docs/PERF-AUDIT.md`,
`files/sec08-file-helpers-core-fcp-20261005/`).
The reviewed 12-file stream committed as `225baef`
and landed serially as `cbe233f`. Post-landing security
**233/233**, tabs **478/478**, corpus **316/316**,
startup **11/11**, theme **363/363** passed. The
first packaging run **350 passed, 1 failed** because
an older `app.asar` lacked the new core. A fresh
`npm run build-all` generated Windows portable and
NSIS artifacts; with `PACKAGING_STRICT=1`, packaging
then passed **352/352** against the new archive
(`files/sec08-file-helpers-fresh-build-20261005.log`,
`files/sec08-file-helpers-integrated-strict-packaging-20261005.log`).
The fresh `app.asar` SHA-256 is
`01255C5E9FCC81ACF8C0D8CE309D49E4773E2BBDDB4EB2220876B0CF4AA80CF7`.
This proves a local Windows package, not signing,
Linux/macOS artifacts or published release attestation.
Main-window Node isolation, the clean-tree complete
suite/revert inventory, regenerated-and-viewed wave
screenshots and published-artifact verification remain
open; no release is authorized.
The manifest inclusion itself had no dedicated individual
revert. Terra added R709 in the isolated file-helper stream:
removing the browser core from `build.files` must produce
exactly three named packaging failures while five independent
guards continue to pass. Fresh Sol and Terra reviews found
no issue; Luna found that exact failure names alone did not
reject repeated failures, so Terra added the explicit count
and extended the harness's counted-record self-check without
weakening R319's synthetic controls. A fresh independent
Sol/Terra/Luna round found no further issue. R709 was proven
individually with the manifest hash restored, then committed
as `e122da2` and landed serially as `a917faf`. The integrated
R709 proof passed with exactly its three intended failures,
the anchor audit resolved, and a self-attesting
`PACKAGING_STRICT=1` run at `a917faf` against the fresh local
asar passed **352/352** (`files/sec08-file-helpers-rerun-20261005/
r709-post-landing-20261005.log`,
`files/sec08-file-helpers-r709-strict-packaging-20261005.log`).
No clean-tree full-suite, complete non-deferred revert inventory,
viewed screenshot or published-artifact gate is claimed.
**Next SEC-08 IPC boundary (read-only).** Opus and Luna
independently prefer an on-demand, main-issued one-use grant
for each extra path from the native multi-select dialog over
eagerly reading every selected file. This preserves sequential
per-file failures and avoids new blocking size dialogs for
extras; the renderer must never supply an arbitrary read path.
Opus initially proposed invalidating grants with
`fileOpenDeliveryEpoch`; Luna identified that a failed newer
open advances that pending-open epoch without superseding the
renderer batch. Use a separately scoped delivered-batch identity
and revoke on a later successful `file-opened` delivery or page
session/generation change. Keep main's stable read and the
existing independent disk-adoption attestation; preserve the
current unguarded-extra behavior rather than silently adding
per-extra main-process modals. This is design evidence only:
no extra-file IPC migration or main-window isolation has landed.
An isolated clean stream `feat/w2-sec08-dialog-extras-20261005`
started from `a917faf`. Terra's first baseline could not exercise
the intended scenario: the new worktree lacked the generated,
gitignored `libs/vendor/` and `fonts/` runtime assets (and initially
had no Electron dependency link), so renderer bootstrap failed
before the multi-select tests. After linking the existing dependency
tree and running `npm run vendor` in that worktree, the unchanged
targeted baselines passed tabs **478/478** and security **233/233**
with no competing Electron process. The initial failures are not
product regressions (`files/sec08-dialog-ipc-20261005/`).
Sol (high) now owns only the dialog-selected extra-file product
slice; Terra owns the subsequent targeted tests and independent
revert proofs. No implementation, changed-suite verdict, benchmark
or integration is claimed at this handoff.
Sol changed only `src/main.js` and `src/custom-tabs.js` in the
isolated stream: main retains each extra path and issues an opaque,
single-use read grant with the delivered dialog batch. Its handler
checks the main frame, page identity and batch before and after the
asynchronous stable read; a failed newer open leaves the active
batch alone, while a delivered newer open or page replacement
retires it. Tabs now invoke this read sequentially before their
independent disk-adoption attestation and suppress an error toast
if another delivered open overtakes the batch mid-read. The primary
dialog path, open-time size guard and other synchronous snapshot
callers are unchanged. Both product files passed `node --check`;
no changed-product Electron test, revert proof, performance verdict
or review is claimed. Terra now owns bounded targeted tests and
individually discriminating proofs, with any product defect
returned to Sol.
Terra added bounded real-main multi-select coverage in
`test/test-tab-refresh.js` and two individual R710/R711
records in the revert harness. An initial changed tabs run
was reported green without a retained transcript. R710
rejected a replayed grant; R711 initially reported `PROVEN`
after restoring renderer-side reads, but the first review
round later found its downstream failure non-discriminating.
Those initial verdicts did not close the proof gate.
The scenarios exercise ordered main-owned reads, the absence
of extra open-time modals, forged/replayed grants, failure
continuation, failed-later-open preservation and superseded
held reads. This is isolated-stream evidence only; fresh
independent full-unit review, cross-suites, performance
comparison and integration are still pending.
The first fresh independent Sol/Terra/Luna full-unit round
found no product defect. Sol and Terra agreed the R711
renderer-read revert was not a discriminating proof: its
mutated snapshot lacked `path`, so an unrelated shape
guard could fail instead, and unlisted collateral failures
were not excluded. Terra also called out R710's missing
exact-failure guard. Sol separately found the supersession
scenario held the renderer invoke before main began reading,
so it never exercised main's post-read batch check. Luna
reported no blocker. Sol validated that a held second
`fs.stat` callback in main's stable read is a narrow way
to test that missing boundary. Terra owns these bounded
test/proof corrections; the first review round does not
close the unit or authorize integration.
Terra's corrected R710/R711 each requires exactly its one
intended failure with independent passing controls: R711
now injects a renderer disk read without breaking the normal
main-granted snapshot or the batch's shape. A narrow
main-process test also holds the stable read's second
`fs.stat` callback after grant consumption, delivers a
newer open, then verifies the pending IPC rejects the
superseded batch; R712 reverses the post-read check and
fails that assertion alone. The final isolated tabs run
passed **491/491** and R710/R711/R712 were individually
**PROVEN** with source restored; the anchor audit resolved
(`files/sec08-dialog-ipc-20261005/`). One intermediate tabs
run had **488/489** on the existing F22 updater identity
assertion; intermediate R711/R712 proof attempts also
reported `COLLATERAL` before their exact-failure corrections.
The final clean runs passed. Fresh independent
full-unit re-review, the per-unit performance comparison,
serialized integration and release gates remain open.
In the second fresh Sol/Terra/Luna full-unit round, Sol and
Luna found no product or proof blocker after the corrected
in-flight scenario. Terra questioned why the harness
self-check does not separately fingerprint the new
exact-one proof declarations, then retracted the finding
after checking the individual verdicts: changing the count
or adding collateral cannot yield `PROVEN` in these runs.
R319's special transcript-role pin is not a template for
fingerprinting every record against future manual edits.
The three fresh reviewers converge with no blocker. The
reviewed stream remains uncommitted and unintegrated until
its measured file-I/O/IPC performance gate is settled.
The first bounded performance-runner attempt **did not run a
measurement**. Reusing the existing startup/FCP runner for
dialog multi-open requires deterministic dialog injection,
extra-tab/content timing, IPC-call controls and repeatable
three-size fixture state. Independent Opus and Luna
assessments found that the proposed small adaptation would
not supply those controls; Terra stopped before producing
a success-shaped proxy (`files/sec08-dialog-ipc-perf-20261006/
run-not-started.json`). The product/test stream is still
uncommitted, the performance gate remains open, and no
startup or multi-open regression verdict is claimed.
The maintainer chose the complete bounded real multi-open
comparison rather than deferring this IPC slice. Terra now
owns a disposable, session-artifact-only baseline/candidate
runner with the required size variants, real dialog/extra
tab witnesses, IPC-call discrimination and machine-level
exclusivity. No performance result is claimed at this handoff.
That bounded comparison subsequently completed without a
material regression under the **both >10% and >25 ms**
rule, predeclared for p50 or p95. Across 21 actual
multi-open repetitions per variant at each extra-file size,
the baseline-to-candidate p50/p95 values were **40.1/48.8
-> 42.0/61.7 ms** at 50 KiB, **45.2/65.5 ->
51.2/67.4 ms** at 500 KiB and **53.6/102.2 ->
68.1/108.4 ms** at 2 MiB. Candidate invokes occurred
exactly once per extra; the baseline made none, and every
extra tab's unique content was verified after the timed
arrival. Six fresh-profile launches used 2 AB and 1 BA
size pairs, with sampled process monitoring finding no
unrelated Electron process. The 2 MiB p50
rose **14.5 ms (+27.1%)**, below the rule's absolute
25 ms limb; it is not a speedup or zero-cost result.
Launch-level noise, post-arrival rendering and packaged
startup remain outside this per-unit measurement. See
`docs/PERF-AUDIT.md` and retained raw samples in
`files/sec08-dialog-ipc-perf-20261006/`. The reviewed
unit is now eligible for a named-file stream commit and
serial integration, not for SEC-08 isolation or release.
The reviewed four-file stream committed as `f74ae75` and
landed serially as `c44308c`. Post-landing tabs **491/491**,
security **233/233** and startup **11/11** passed; all current anchor
setups resolved (`files/sec08-dialog-ipc-20261005/
tabs-post-landing-20261006.log`,
`security-post-landing-20261006.log`,
`startup-post-landing-20261006.log`,
`anchors-post-landing-20261006.log`). No post-landing
individual revert run or new packaged archive is claimed.
Other renderer disk reads, main-window Node isolation,
the full 13-suite clean-tree chain, complete non-deferred
revert inventory, regenerated-and-viewed wave screenshots
and published-artifact verification remain open. No release
is authorized.

**Order of work is fixed by the audit** (each step independently shippable):
rebuild the harnesses' renderer access on a test-only preload → give the 6 local
modules a dual-mode loader → move the 18 `fs`/`path`/`os` sites to IPC one at a
time → replace the 70 `ipcRenderer` sites with a validating bridge → only then
flip the flags, and `sandbox: true` last.

**Path validation lands *inside* this item, not after it.** Several handlers
accept renderer-supplied paths with no validation — `save-markdown-file` writes
any path, `reload-file` reads any path, `start-file-watching` and
`set-active-file` watch any path, `open-folder-in-explorer` calls
`shell.showItemInFolder` on any path. Today that is not an escalation, because
the renderer already has unrestricted `fs`. The audit is explicit that it *"does
become a real path-traversal/arbitrary-write vulnerability class the moment
SEC-08 is fixed — so path validation must be added **as part of** that refactor,
not after it"* (`docs/SECURITY-AUDIT.md`). Deferring it to `w2-f03` would open
the class it is supposed to close.

**Completion criteria.** Main window runs `nodeIntegration: false`,
`contextIsolation: true`; every channel crossing the bridge validates its
arguments, **and every renderer-supplied path is validated**; all impacted
cross-suites pass on the reworked harness and the full 13-suite `npm test` runs
at the next declared milestone boundary; the full benchmark set in *Performance
acceptance gates* is recorded; SEC-08's section in the audit is rewritten from
*deferred* to *fixed*.

### `w2-f03` — validate sender and frame on every IPC handler · BLOCKED on `w2-sec08`

Every `ipcMain` handler should verify which `webContents` and which frame sent
the message rather than trusting any sender. The audit enumerated the full
surface and found no privilege escalation beyond what the renderer already holds;
that last clause is precisely why this is sequenced *after* SEC-08. While the
renderer is Node-privileged, sender validation defends against a frame, not
against an attacker who already has the renderer.

> **Count the handlers freshly; do not quote a number from anywhere.** The
> audit's heading says "all 31 handlers reviewed" while the enumeration on the
> same line lists **29** line numbers, and a direct count of `ipcMain.*`
> registrations in `src/main.js` at `db7b960` agrees with neither. The surface
> is "every `ipcMain` registration", and the first task of this item is to
> establish that set and reconcile the audit.

**Scope boundary.** *Sender and frame* validation belongs here. *Path*
validation belongs to `w2-sec08` — see the note there.

**Completion criteria.** Every handler validates sender and frame; a probe
proves an unexpected sender is rejected; reverts pin it; the audit's handler
count is corrected to the measured one.

### `w2-privacy` — turn the packaged diagnostic log off by default · ACTIVE · wave-2 release blocker

**2026-10-12 implementation handoff — ACTIVE.** The isolated integration
owner selected the existing minimal privacy contract while the frozen hosted
clean-refresh validation runs, before the next SEC-08 Node-operation migration.
Live `main.js` opened an append stream unconditionally, including packaged
defaults. The implementation now gates sink creation on exact opt-in, preserves
existing logs when disabled, and keeps development console output.

**2026-10-12 product/proof handoff — IMPLEMENTED / PROVEN.** The existing
plain-Node profile suite executes the shipped logging block and startup calls
against native file streams: 52/52 passed, including fresh and retained logs,
strict opt-in, stream-close/error sentinels and disabled serialization. R719–R724
are individually PROVEN with exact intended failures and independent passing
controls; source bytes were restored. Live isolated Electron startup passed
11/11 and source packaging passed 352/352. Fresh independent Sol and Luna
implementation reviews found no significant issues; BUILD documents temporary
use and unredacted-log limitations. No active diagnostic-file-dependent launcher
was identified, so normal launches were not opted in. Final rebuilt/installed
application and integrated Wave-2 checks remain release obligations, not evidence
supplied by these source-level results. No performance, integration or release
gate is claimed. Diagnostic-log hardening remains deferred.

> **Folia uploads no logs. There is no telemetry, and this item does not add
> any.** No first-party code sends document content, usage data, or log content
> anywhere. Every rendering library is vendored under `libs/`, so no CDN is
> contacted at runtime (`docs/SECURITY-AUDIT.md`, SEC-10 — *"Runtime libraries
> vendored locally; no CDN load"*).
>
> **Two things do reach the network, and both are stated in `README.md` rather
> than buried:** `electron-updater`'s check against this project's own releases
> feed, gated on `app.isPackaged` and carrying no document content; and **any
> image a document itself points at with an `https:` URL** — the CSP keeps
> `img-src … https:` deliberately so remote images in markdown keep working
> (`docs/SECURITY-AUDIT.md`, SEC-09), and the resulting read-receipt exposure is
> recorded there rather than traded away. That request is the document's doing,
> not Folia's, and it is not a log upload.

What this item actually is: **`src/main.js` opens an append-only write stream to
`<userData>\debug.log` at module load and writes to it unconditionally** —
including in packaged builds, where the console half is suppressed
(`if (!app.isPackaged)`) but the file half is not. The work is therefore **local
data minimisation and disk hygiene**, and nothing to do with remote telemetry.

**What the file actually accumulates, and why it outlives the app** (evidence
gathered during review, all read from the tree):

- **It records filesystem paths and the full command line.** `log("Attempting to
  open file:", filePath)`, `log("Extracted file path:", filePath)`,
  `log("handleFileArgument called with argv:", argv)` and
  `log("Initial process.argv:", process.argv)` are all in `src/main.js`. Document
  paths are frequently sensitive on their own — they carry project names, client
  names and directory structure.
- **It records raw updater error text.** `autoUpdater.on("error", …)` calls
  `log("Auto-updater error (silent):", err.message)` — the message is written
  verbatim, unfiltered.
- **It survives uninstall.** `package.json` sets `nsis.deleteAppDataOnUninstall:
  false`, so removing Folia leaves `<userData>\debug.log` on disk indefinitely.
  That flag is otherwise deliberate — it is what preserves the user's tabs and
  settings across an upgrade — so the fix belongs in the logging, not in the
  uninstall behaviour.

**Realistic severity: Low-to-Medium**, for a single-user desktop install. It is a
*local* privacy and disk-hygiene issue: an unbounded, uninstall-surviving file
containing paths and argv, readable by anything else running as that user. It is
**not** a data-exfiltration issue and must not be written up as one — nothing
uploads it.

#### Release logging policy (the target state for this item)

**Scope narrowed by maintainer decision, 2026-09-02.** Because the diagnostic
file is being turned off by default in packaged builds, the *hardening* of that
file — rotation, size/count retention, sanitising and redaction — no longer has
to ship inside this release-blocking item. It moves to
`diagnostic-log-hardening` below. What remains here is deliberately minimal,
tested, and expected neutral-to-slightly-faster.

This is the policy the item must land, stated so it can be asserted against
rather than re-litigated:

1. **Packaged/release builds create no `debug.log` and write no diagnostic file
   by default.** Not an empty file, not a zero-byte placeholder — no file.
2. **Development builds may log to the console.** That is already the existing
   `!app.isPackaged` behaviour and is not the problem. Console-only stays the
   development default; nothing in this item adds a development file.
3. **Diagnostics are enabled only by an explicit, documented switch.** Name:
   **`FOLIA_DIAGNOSTIC_LOG=1`**. This follows the repository's existing
   environment-variable convention — `FOLIA_DEVTOOLS` and `FOLIA_GOLDEN_COMMIT`
   are the precedents, alongside the unprefixed `PACKAGING_STRICT`. No collision
   exists in the tree today; confirm again at implementation time, and document
   it in `docs/BUILD.md` where the other switches live. With the switch set, the
   diagnostic file may be created — in its current unhardened form, which is the
   accepted tradeoff below.
4. **Disabled must mean the stream is never opened.** The `createWriteStream`
   call currently runs at module load, before anything has decided whether
   logging is wanted. Gate the *creation*, not just the writes — otherwise the
   default install still creates the file, which is exactly what point 1
   forbids.
5. **An existing stale packaged `debug.log` stops being a growing artefact.**
   Users who already ran an affected build have one on disk. On a default
   (opt-out) packaged start, Folia removes it, or at minimum never appends to it
   again. Leaving a file that keeps growing after the fix ships would defeat the
   item.
6. **No upload path is added, and none exists.** This item introduces no network
   call whatsoever.

**Explicitly out of scope here** — all of it owned by `diagnostic-log-hardening`:
rotation, maximum size, retained-file count and retention policy, redaction of
paths and `argv`, and the replacement of raw updater `err.message` with safe
structured fields.

**What deferring actually costs, stated plainly.** Making the file opt-in removes
it from the default install, which is where nearly all of the exposure was: no
file means nothing to accumulate, nothing to survive uninstall, nothing for
another process running as that user to read. That genuinely reduces urgency.
It does **not** make the risk disappear. When a user *does* set
`FOLIA_DIAGNOSTIC_LOG=1`, the file they get is still the unhardened one — it
still records document paths and the full `argv`, it still writes updater
`err.message` verbatim (which can carry response metadata such as a status line,
a URL or header-derived text, depending on what `electron-updater` surfaces), and
it is still unbounded and still survives uninstall via
`nsis.deleteAppDataOnUninstall: false`. This is an **accepted tradeoff**, not a
resolved risk.

**Therefore, until `diagnostic-log-hardening` lands, the documentation must tell
users to enable diagnostics only temporarily** — turn it on to reproduce a
problem, turn it off afterwards, and delete the file. That sentence belongs in
`docs/BUILD.md` alongside the switch, and it is part of this item's completion
criteria.

**Completion criteria.** A packaged default run **creates no new diagnostic
file** and neither opens nor appends to `debug.log` (asserted, not assumed); an
assertion proves the write stream is not opened when logging is disabled; a
*pre-existing* packaged `debug.log` is either removed or provably left untouched
and unappended on a default start — the two permitted outcomes of point 5, and
the only sense in which a file may still be present after a default run;
`FOLIA_DIAGNOSTIC_LOG=1` does create the diagnostic file; no upload path is
added; `docs/BUILD.md` documents the switch **and** the temporary-use guidance
above. Reverts pin each of those independently. Hardening assertions are
explicitly *not* required here — they belong to `diagnostic-log-hardening`.

### `diagnostic-log-hardening` — harden the opt-in diagnostic log · PENDING · DEFERRED

**Not a wave-2 release blocker.** Deferred out of `w2-privacy` by maintainer
decision on **2026-09-02** (see *Maintainer decisions on record*), on the
reasoning that once the file is off by default, hardening it is no longer on the
release path.
It is not BLOCKED — nothing technical prevents it — it is scheduled after the
milestone. It does depend on `w2-privacy` in the practical sense that the opt-in
switch has to exist before there is a gated file to harden.

This item owns everything `w2-privacy` no longer does:

1. **Rotation and bounds.** A maximum file size and a maximum retained file
   count, both fixed constants, oldest rotated out. An opt-in log that grows
   forever is the same defect behind a flag — it is merely no longer a *default*
   defect, which is why it can wait but cannot be dropped.
2. **Retention.** How long rotated files are kept, and what removes them. Both
   halves are in scope: a chosen **retention duration** (a fixed constant, not
   "until the disk fills"), and the **cleanup behaviour** that enforces it —
   what deletes an over-age file, and when it runs.
3. **Sanitising and redaction of what is already logged.** Document paths, the
   extracted file path, `argv` and `process.argv` are all written today
   (`src/main.js`). Decide per call site whether the value is needed at all,
   redacted, or reduced — a basename or a hash rather than a full path.
4. **Safe structured fields for the updater error path.** Replace
   `log("Auto-updater error (silent):", err.message)` with a deliberate,
   enumerated shape: an error class or `code`, an HTTP `status`, and at most the
   *host* — never a full URL with a query string, never headers, never a
   response body, never cookies.
5. **Documentation, tests and reverts for the opt-in path in detail** — what the
   log contains once hardened, what it deliberately omits, and revert records
   pinning each guarantee independently. The temporary-use warning added by
   `w2-privacy` is revisited here and relaxed only if the hardening earns it.

**Completion criteria.** With `FOLIA_DIAGNOSTIC_LOG=1`: the log rotates at a
fixed size, retains a fixed count, and an assertion proves both; **a specific
retention duration is chosen and documented in `docs/BUILD.md` as a named
constant — not left implicit — and age-based cleanup is proven by two
assertions: an over-age rotated file *is* removed, and a within-age file is
*not*** — a cleanup that deletes everything passes a naive retention test while
destroying the diagnostics the flag exists to produce; an assertion proves no raw
updater `err.message` is persisted and that only the enumerated safe fields
appear; an assertion proves path/`argv` redaction; `docs/BUILD.md` documents the
hardened format; **each of those guarantees — size, count, the retention duration
and the age-based removal behaviour included — has its own revert record**,
proven individually rather than as a batch. No change to the packaged default,
which `w2-privacy` already settled.

### `w2-hygiene` — dead code and one file-extension policy · IMPLEMENTED / SOURCE-REVIEWED; integration pending

Remove handlers and code paths that nothing reaches, and consolidate the
file-extension policy into a single source of truth. Extension handling is
currently a *security* policy (SEC-12 routes local-file links through an
extension check applied to the `realpathSync`-resolved path) as well as a
file-association and open-dialog concern; more than one list of extensions is a
divergence waiting to happen.

**Completion criteria.** One extension policy, referenced everywhere it is
needed; every removal proven unreachable before deletion, not after; suites and
`--anchors` clean.

**2026-10-14 bounded implementation.** Main now imports the existing browser/Node
core's canonical Markdown/Mermaid groups for trusted drop and native-dialog
filters, and its existing `isMarkdownFile` predicate for CLI selection.
The ordinary and uppercase extension matrices are unchanged. Native dialogs
retain **All Files** and do not apply the drop/CLI allowlist to selected files.
`.ow` remains an explicit CLI/link-only legacy exception. The narrower
resolved-target link policy and the intentionally smaller OS associations
remain distinct; sharing a broader list would change their policies.
Main's unused `isMermaidFile` and `readMarkdownFile` import bindings were
removed only after the pre-edit identifier census found each solely in that
destructuring import. Their shared implementations remain available; no
possibly reachable handler or compatibility path was deleted.

Plain-Node packaging/source controls pass 407/407, including the actual CLI
function, native-dialog options and separate drop/link policy matrices. The
first new link-source assertion used the wrong local variable name; that failed
log is retained separately, and the corrected assertion follows actual
`realpathSync.native(logicalPath)` / `readTarget` classification. These are
source-level invariance controls for a refactor, not new native runtime or
mutation-sensitivity claims. No new proof campaign or app launch was run.
Private evidence is `.context-viewport-evidence/wave2-hygiene-r1/`.
The dry anchor audit resolves; it proves no runtime behavior. Fresh independent
GPT-6.1 Sol and GPT-6 Luna source reviews found no behavioral/test blockers.
Sol had no findings; Luna identified the stale pending-audit status, now
corrected. Neither reviewer launched tests or an app. No behavioral disagreement
or new performance, package, integration or release qualification is claimed.

**One current Wave-2 reconciliation.** The milestone preamble, not an item's
prefix or an old todo, defines release scope. The finite inventory is:

| Item | Current disposition |
|---|---|
| `w2-f22` | Original shutdown/clean-refresh implementation is present; explicitly user-deferred Save-alias/shutdown/ordinary hosted-CI campaigns stay P2, not passed. |
| `w2-sec08` | Production isolation/authority implementation is provisionally committed; responsiveness remains unqualified. R886 remains an open sensitivity-harness follow-up, with accepted same-guard native behavior coverage, not an established product defect or a completed proof. |
| `w2-privacy` | Implementation/proof closed; final integrated checks are not implied. |
| `w2-hygiene` | Bounded shared-group refactor and focused source review/anchor closure complete; integration pending. |
| `w2-upstream` | Classification complete with the narrow paragraph-wrapper disposition below; optional features remain deferred/rejected as recorded. |
| `w2-f03`, `w2-kbscroll` | Genuinely unimplemented backlog, explicitly **non-blocking** in the milestone preamble. Main still has unguarded ordinary IPC callbacks; the viewer still lacks keyboard-scroller focus/key handling. They are not silently marked done or added as new release blockers. |
| Remaining release gates | Actual no-visible-slowdown acceptance; final clean-tree ordinary suite/full proof inventory, regenerated-and-viewed wave-wide surfaces, final cleanup, final source-matched package/installed verification, coordinated integration and version/lock/tag/publication. None is supplied by this source-only unit. |

After this unit closes, no other unimplemented mandatory product unit is
identified within the canonical release dependency set. That is **not**
implementation-readiness or release acceptance: the verification/performance
and delivery gates above remain open, and the full historical proof register
is not complete. Other non-blocking/post-wave roadmap items are not absorbed.
`93150df8` remains the preserved provisional base. Its R3 package and all prior
performance samples retain their original identities; this changed `main.js`
is **not** the packaged/profiled R3 source. No replacement build was made.

**2026-10-14 bounded final-verification outcome**

- Shipping implementation remains `668d17f3`; this phase changes test actors,
  not production guards, preload capabilities or renderer flags.
- The document-session replay actor now uses an isolated fixed replay
  capability and an actual Main-frame nonce witness, not page Node/raw IPC.
  Its ordinary suite passes 68/68; R760 produces its exact replay-refusal
  failures and restores Main byte-for-byte.
- The theme popup probe now observes the actual native Main IPC delivery.
  It clicks the same real table control in all six states, preserves the
  payload/content checks, and restores the production listener. Theme passes
  398/398. R346 detects the runtime mode leak plus its structural violation;
  R359 detects missing content while its declared parser controls pass.
  Renderer restoration is byte-exact. Independent Sol/Luna reviews converge
  after correcting a duplicate test-local declaration.
- Source packaging 407/407, privacy 52/52, corpus 322/322, startup 11/11 and
  native browser 32/32 pass. The latest native reload selector is **33/34**:
  before-version/owner/source forwarding and refusal pass; preparing the
  after-version owner fails to paint. This is retained setup failure, not
  proof of a new product defect or a reason to relaunch R886.
- One private portable/NSIS 0.4.0 build matches current shipping sources.
  Strict actual-asar checks pass 407/407; all shipped source/assets/libs/font
  identities match. Private/test evidence roots are absent. Archive SHA-256:
  `0b456d97df3163b277d3992605fbe52721bcb500f42dea8be2c48e725bdf48c8`.
  Retained R3 stays `d3299fe015f1f8d16446c802157212a3846fd96205b1f35e56bb19a669660c2e`.
- Current unpacked smoke passes actual open, dirty edit, normal Save,
  correlated Reload, zoomed Mermaid, toolbar/menu, six scheme selections
  and full clipboard readback. It uses production Node-off/sandbox/preload.
  All captures were viewed; normal exit is 0 with no owned survivors.
  Normal Save waits for its natural edited preview first: it does **not**
  clear the retained historical rapid Save/Exit failure or measure latency.
- Zoomed capture shows the complete decision label; the answer extends below
  that viewport. At 100% both labels are visible. Menu and six-scheme views
  are scoped evidence, not full wave-wide visual certification.
- First fixture failures, the syntax-failed theme launch and private oracle
  scheduling failure remain separate. The latter adapter now finishes its
  synchronous archive census before starting the unchanged async suite;
  no assertion, expected outcome or deadline was weakened.
- Evidence: `.context-viewport-evidence/final-verification-20261014/`.
  Full ordinary-suite/full historical-proof completion, remaining wave-wide
  scenes, installed verification and coordinated integration/delivery are
  not claimed. P2 Save/shutdown/hosted-CI exceptions and R886 sensitivity
  remain as recorded. No-visible-slowdown still blocks merge/tag/publication.

**2026-10-14 corrected Save comparison: blocked, no release acceptance**

- A distinct authorized phase froze actual `f87aa779` versus `41389fe`
  shipping `668d17f3`, the original large-only pair order, two normal Save
  modes, 42 launches maximum and a fixed 60-minute ceiling.
- Only the existing benchmark and its static fixture changed. Explicit
  browser crypto, actual natural preview/history, separate ACK/store/view/
  layout endpoints and failure preservation received independent Sol/Luna
  feedback. Existing readiness and launch deadlines stayed unchanged.
- One reference launch completed normally with three Saves per mode;
  candidate execution never began. The supervisor then hit a Windows
  sharing exception while rewriting its private progress journal.
  Zero matched pairs; the exact remaining 41 jobs stay unexecuted.
- Preserve the reference's multi-second setup/Main-loop pause without
  assigning it to isolation or the environment. No comparative overhead
  conclusion, risk waiver, retry, extra profiler or replacement campaign.
- Evidence: `.context-viewport-evidence/corrected-large-save-comparison-r1/`.
  Native exit 0, source/runtime identity rechecked, no owned survivors.
- Shipping sources and both private package identities above are unchanged.
  All prior failed/partial evidence, P2 exceptions, R886 sensitivity and
  nonblocking F03/kbscroll dispositions remain. Delivery and publication
  remain held on actual no-visible-slowdown acceptance.

### `w2-upstream` — classify the outstanding upstream commits · CLASSIFIED; dispositions complete, integration pending

Folia is a hard fork, not a branch: upstream commits are taken as deliberate
individual cherry-picks, never merged wholesale
(`.github/copilot-instructions.md`, `docs/CUSTOMIZATIONS.md`). Sixteen upstream
commits are outstanding and unclassified — verified at `db7b960` with
`git rev-list --count HEAD..upstream/main`, which is how the number should be
re-checked rather than trusted from this file.

Policy for this item: **bug fixes and security fixes are taken autonomously**
after evaluation. **Feature additions are a decision gate** — the fork's stated
direction is *leaner and faster*, and two upstream features have already been
evaluated and declined on exactly that ground.

It is sequenced after `upstream-toolbar-overflow` because that item is itself an
upstream-derived fix in the same surface; classifying the backlog before it lands
would mean classifying against a moving target.

**Completion criteria.** All 16 commits classified as *taken*, *declined*, or
*escalated to the maintainer*, with the reason recorded per commit; everything
taken carries tests and a revert; `docs/CUSTOMIZATIONS.md` updated for anything
that changes the fork's divergence.

**2026-10-12 classification against immutable `4be4d31` and the retained
`upstream/main` ref.** The local cohort is the following commits; absence from
ancestry is not absence of a hard-fork adaptation. No wholesale merge, upstream
version adoption or new feature acceptance follows from this inventory.
The coordinator, using delegated lean-release scope management, deferred
standalone HTML export and persistent refresh-button blinking. This is a
coordinator decision, not a new user quotation; neither feature is implemented.

| Upstream commit | Disposition and evidence |
|---|---|
| `397a7a8` | Decline upstream README/identity/feature advertising; Folia maintains its own. |
| `03b5423` | Batch-error/popout adaptations taken in `67d04bf`; obsolete Mermaid-10 lifeline workaround declined. The completed `8e075ad` geometry fix is separate. |
| `a5f2b00` | Decline upstream-only version bump. |
| `6089305` | Offline libraries/fonts adapted by vendoring; CommonMark soft-break change declined in `774cdd8`; HTML export deferred; Mermaid paragraph-wrapper shape/spacing cleanup deferred after the narrow compatibility disposition below. |
| `550017f` | Decline upstream-only version bump; remaining manifest delta is line-ending churn. |
| `ef81474` | Dialog/drag-drop/splitter/view lookup adapted in `7088418`; fork save handling retained and non-note view-mode autosave superseded by `584ae4a` policy. |
| `80646de` | Zoom-correct scrolling adapted in `dee261b`; temporary diagnostics declined; blinking deferred; right-click-menu viewport fit adapted in this continuation (proof below). |
| `d64b166` | Decline upstream-only version bump. |
| `28d1cb4` | Decline tscircuit-specific label filtering, bundle and authoring material under the existing feature rejection. |
| `7e48d9f` | Decline upstream-local ignore-directory policy; no runtime fix. |
| `b0e991b` | Number-marker correction adapted in `fd12632`; keep Folia's wider numbered gutter and unchanged bullet indent. |
| `6b9c51a` | Decline the previously rejected tscircuit feature family/dependencies/associations. |
| `b439565` | Decline line-ending-only churn; every changed historical blob matches after EOL normalization. |
| `bc70edd` | Decline the height-cap change for rejected D2 support. |
| `f100ddf` | Toolbar overflow adapted in `4be4d31`; D2 remains declined. |
| `29d6060` | Parameterized HTML parsing adapted in `c713900`; per-block HTML zoom remains declined. |

Astra's read-only classification established no additional mandatory security
fix in this cohort. **Right-click overflow is IMPLEMENTED / PROVEN, unintegrated.**
The actual minimum viewport reproduced negative positioning; caps, narrow
wrapping, logical-size positioning, menu-owned scrolling and reopening now
preserve command access. Theme is 398/398
(`.context-viewport-evidence/final-r5.log`); genuine Node-free/CommonJS loader
is 27/27 (`context-menu-nodefree-loader-r1-20261012.log`). Before/after captures
were viewed by the owner and integration stream. Fresh Sol/Luna reviews agree
on no blockers. R749-R752 are individually exact PROVEN, with affected toolbar
R741/R742 retained in `adoption-context-exact-proofs-r2-20261012.log`; R752's
proof is in the first run. Initial guessed failure sets reported COLLATERAL,
not proof; the complete measured name inventories were pinned and reproven.
Only these named theme mutations, alongside R741/R742, accept the already
observed lone post-footer shutdown diagnostic; extra, duplicate, reordered and
fatal tails still fail. No shutdown fix or new release deferral is claimed.
Final proof review disagreement: Sol found unsupported `edits` fields that
silently omitted the compound parts of R748/R749/R750; Luna missed them. Thus
the earlier R749/R750 partial-mutation verdicts do not establish their claimed
complete rollbacks. Those records now use supported `also`; a narrow fail-loud
field-discrimination self-check prevents recurrence. Complete R750 is exact
PROVEN in `adoption-context-compound-proofs-r3-20261012.log`; complete R749's
full name inventory is exact PROVEN in
`adoption-context-compound-proofs-r4-20261012.log`. Partial and COLLATERAL
histories are retained, not promoted. Final anchor audit also resolves the
compound parts (`adoption-context-final-anchors-20261012.log`).
**2026-10-14 paragraph-wrapper disposition.** The actual upstream diff changes
both Mermaid placeholder restorations from replacing the bare token to
replacing either `<p>token</p>` or the token. Folia already has the secure shared
nonce/function-replacer implementation, with explicit `unwrapParagraph=false`
at both Mermaid call sites and `true` at both raw-HTML iframe sites.
Upstream's Mermaid-only adaptation would change the empty-paragraph/spacing
and top-level patch input shape; it is not the zoomed-label clipping fix.
`test-render-security.js` separately records that the HTML parser already moves
`pre` out of paragraphs, and does not claim its Mermaid-parent observation
proves the flag or spacing. No required current spacing/patch failure was
established in the retained evidence. Therefore defer this compatibility/cosmetic
change rather than speculate or reopen completed Mermaid geometry work.
This is a complete classification, not implementation of the upstream change.

### `w2-kbscroll` — keyboard scrolling of the document · PENDING

Keyboard scrolling in the document pane does not work. This is a plain
correctness bug in the reading experience — for a document viewer, "the arrow
keys and Page Down do nothing" is a first-minute defect.

**Completion criteria.** The standard keys scroll the viewer; the fix does not
re-break the arrow-key file navigation that F23 established (arrow keys must not
be swallowed when there is nowhere to navigate); assertion + revert.

### `w2-release` — ship wave 2 · BLOCKED

The milestone exit: documentation, the complete suite, version bump, tag, and
release. The current version is whatever `package.json` declares — read it there;
it is not restated here, because a version literal in a planning document is the
one number guaranteed to go stale.

**Blocked on:** `w2-f22`, `w2-hygiene`, `w2-privacy`, `w2-sec08`, `w2-upstream`,
and — corrected 2026-09-03 — `fullrun`, `shots`, `final-cleanup`; and on
`w2-ci`, `w2-docs`, `w2-f23`, `w2-f25`, which are **already done**.

**Release traps, both already paid for once** (`.github/copilot-instructions.md`):

- **Tag pushes do not trigger the release workflow on this fork.** `git push
  origin vX.Y.Z` succeeds, prints a new-tag line, and starts nothing. Dispatch on
  the tag ref: `gh workflow run release.yml --ref vX.Y.Z`. Dispatching on `main`
  builds everything and publishes nothing.
- **Bump `package-lock.json` with `package.json`.** The workflow runs `npm ci`,
  which fails when they disagree.

**Completion criteria.** Full `npm test` green from a clean tree; `PACKAGING_STRICT=1
npm run test:packaging` green; docs current; version and lockfile bumped
together; tag dispatched on the tag ref; artifacts verified by looking at the
installed app, not by capturing a screenshot of it.

---

## C. Mermaid

Three items in the same surface. The first two are **correctness** items from the
F43 / N18 work; the third is a **performance** question in the same code. They
are listed separately because they fail differently and can be proven separately.

### `mermaid-cold-cache-source` — reused SVG must not become "source" · PENDING

After a cache eviction, previously rendered SVG markup can be mistaken for the
diagram's Mermaid source. The recent hardening removed fallback source
reconstruction and made these paths fail closed (commit `db7b960`); this item is
the remaining cold-cache case.

**Completion criteria.** With the cache cold, an edit either reaches the true
source or fails closed with a visible reason — never silently edits rendered SVG;
assertions on both the full and light render paths; revert.

### `mermaid-block-identity` — renderer-owned identity for edit/delete · PENDING

Introduce renderer-owned `WeakMap` identities for Mermaid blocks so an edit or a
delete acts on the block the user actually pointed at. Identity currently rests
on positional or markup-derived matching, which is exactly the assumption F43
showed a hostile or merely unlucky document can break.

**Completion criteria.** Edit and delete are proven to act on the intended block
with duplicate and near-duplicate diagrams present in one document; a decoy
cannot capture a real block on either render path; revert.

### `perf-mermaid-sweep` — remove a duplicate DOM traversal · PENDING

There is a redundant second traversal of the Mermaid DOM. **Measure its cost
before removing it** — a traversal that is free is not worth the churn, and this
repository's rule is that the measurement decides.

**Completion criteria.** The measurement is recorded in `docs/PERF-AUDIT.md`
whichever way it goes; if removed, the class census and node counts are unmoved
and the saving is stated as a measured number.

---

## D. Performance and UI correctness

### `ctime-byte-witness` — restore content-aware disk-change detection · PENDING · DEFERRED

**Not a wave-2 release blocker.** The 2026-10-01 maintainer decision accepts
ignoring ctime-only disk-version changes for now: on Windows an unchanged
file's `ctimeMs` can move after selection, falsely refusing Save and
re-selection. Unlike identity, size or mtime, ctime is metadata, not proof
that document bytes changed.

**Accepted limitation, not an eliminated risk:** a separate writer can
replace bytes with different content of the same length and restore the
previous `mtimeMs` while retaining the same file identity. With ctime
ignored, the version tuple alone cannot detect that change, and an
unsaved local edit may overwrite it. Normal external edits that move
mtime or size, and changes of file identity, must still fail closed.
Do not describe the current policy as protecting against deliberate
restored-mtime edits.

**Future scope.** Bind a trusted raw-byte witness to the original disk
read or adoption, carry it into main's owner baseline, and use it
across watcher notification, tab re-selection and the final Save
write boundary. Preserve deletion and path-identity guards, prove
same-size changed bytes with restored mtime are refused, and measure
the read/hash cost against the predeclared performance gates. This
is scheduled **after `w2-release`**, not blocked on it.

**Completion criteria.** Genuine ctime-only, byte-identical changes
remain usable; equal-size changed bytes with restored mtime cannot
overwrite external content; denied/unknown attestations fail closed;
the targeted tests have individual break-code/restore-code proofs;
startup, selection and Save costs are measured and accepted.

### `table-breakout-perf` — the single largest remaining render cost · PENDING

`applyTableBreakout()` is the dominant phase on wide documents. Measured in
`bench/BASELINE.md`: with `marked` linear, it is **2,595–2,686 ms of the `wide`
profile's 3,439 ms render at 1 MB — about 76%** — and it is the phase sitting
closest to the harness's nonlinear bound on most runs.

Two earlier figures from the same file, neither interchangeable with the `wide`
number above. The gutted-versus-intact experiment was run on the **`tables`**
profile at 256 KB and measured **372 ms → 0 ms** with every output oracle silent
— and that 372 ms is the cost of the pass's **no-op path**, because every table
the corpus generated at the time fitted inside the reading column, so the pass
measured its containers, decided nothing needed widening, and returned. (That
column is **860 px measured**, not the 900 px the stylesheet names; the
difference is padding.) Separately, the pass was **79%** of a 1 MB render before
the layout-thrash fix — `bench/BASELINE.md` does **not** name a profile for that
one, and the `wide` profile did not yet exist when it was taken, so read it as a
table-profile figure and re-derive it rather than quoting it at `wide`.

That last detail is why this item also carries a testing obligation: **no oracle
over rendered output can cover a pass that produces no output.** The corpus now
has a `wide` profile precisely so this pass is exercised; any optimisation must
keep it exercised.

**Completion criteria.** A measured reduction in the breakout phase on the `wide`
profile at 256 KB / 512 KB / 1 MB, reported with the harness's own numbers; the
class census and `.table-breakout` counts unchanged; `bench/BASELINE.md` updated
with the method as well as the result.

### `upstream-toolbar-overflow` — menus must not escape a narrow window · REVIEWED / PROVEN; integration pending

Menus extend outside the window at narrow widths. The fix must handle overflow
**without clipping nested flyouts** — the naive `overflow: hidden` fix trades one
visible defect for a worse, less obvious one.

**Completion criteria.** At the narrowest supported window width, no menu escapes
the window and every nested flyout is fully reachable; verified by *looking* at
the screenshots, not by capturing them.

**2026-10-12 isolated implementation closeout.** Both wide menu classes have a
viewport cap without changing their frozen minimum-width declarations or
clipping nested flyouts. Compact File/View/Theme panels flow inside one bounded,
scrollable root; labels wrap at the actual OS minimum instead of adding an
implicit minimum window size. The runtime fixture measures settled native and
renderer dimensions separately: DPR 1.25 produced 701 versus 702 height, not a
missing compact-state update. No timeout increase or forced body class was used.
Measured boundary is 780 wide / 778 compact and minimum viewport 100 by 342.
Final theme run is 374/374 (`files/toolbar-compact-runtime-r5-20261012.log`).
Wide File, minimum Theme/File and returned-wide Theme screenshots were opened
and inspected by both owner and integration writer. Fresh Sol/Luna implementation
reviews and the parent proof-integration reviews have no remaining blockers.
R741 and R742 are exact PROVEN in
`toolbar-compact-exact-proofs-r2-20261012.log` and
`toolbar-compact-exact-proofs-r3-20261012.log`; reverted sources were restored.
Their only accepted post-footer line is the existing theme-suite shutdown
diagnostic, narrowly scoped to those mutants with bad-tail controls. It does not
clear the user-deferred hosted shutdown issue. Failed earlier runs remain intact.
This completes the toolbar source/proof dependency for upstream classification
in this feature branch; it is not a claim of main integration or publication.

### `perf-node-count` — fewer Prism token spans on very large code blocks · PENDING · GATE

Evaluate reducing the number of DOM nodes Prism emits for very large code
blocks. Prism was deliberately left eager and is not the startup problem — it is
**96 KB** against Mermaid's 3.2 MB, and a fresh bundle load/eval measures
**16.7 ms** (`docs/PERF-AUDIT.md`). The question here is *node count in the
rendered output*, not load cost.

**Gate — the threshold only.** The simplification threshold — the size at which a
code block stops being fully tokenised — is a maintainer decision, because it
trades syntax fidelity for speed on exactly the documents where the user is most
likely to be reading code. **The measurement and the evaluation are autonomous**;
only picking the threshold stops. There is no contradiction with the completion
criterion below: the bench *derives* the candidate value, and the maintainer
accepts the trade or declines it. See *Decision gates*.

**Completion criteria.** The threshold is derived from the bench, not chosen by
taste (the repository's rule for fitted constants); the node-count reduction and
the render-time effect are both measured; the fidelity loss above the threshold
is described in the docs and visible in a screenshot.

### `rv4-nth` — remaining theme/render review findings · PENDING

The unresolved tail of the RV4 theme/render review round. These are individually
small; they are kept as one item because they came from one review and share its
context.

**Completion criteria.** Every finding in the round is closed as fixed, declined
with a reason, or promoted to its own ID here. None left unaddressed.

### `n16-insert-anchor` — insertion position must match the source · PENDING · GATE

Insertions can land at a badly mismatched source/DOM position — the DOM location
the user pointed at and the source offset the text is written to disagree.

**Gate:** scope and design. Mapping DOM position back to source offset can be
done narrowly (fix the specific mismatching call sites) or generally (a real
position map maintained across renders). The general version is a substantially
larger change to the render pipeline. See *Decision gates*.

**Completion criteria.** Whatever scope is chosen, insertion position is asserted
against the *source* for the cases in scope, the out-of-scope cases are written
down, and a revert proves the mapping is load-bearing.

### `n2-user` — Ctrl+wheel zoom anchoring · PENDING · GATE

Decide whether `Ctrl`+wheel zoom should anchor around the **pointer** rather than
the pane centre. This is a preference question, not a defect: pointer-anchored
zoom is the common convention, and centre-anchored zoom is what the existing
zoom work — which deliberately holds the reader's place — currently gives.

**Gate:** the maintainer's call. No implementation until it is made.

---

## E. Delivery and verification

### `sign-provenance` — build provenance and signing · PENDING · partial GATE

Two separable pieces, deliberately split so the free one is not held hostage by
the paid one:

- **Free GitHub artifact attestations — autonomous.** Add build provenance
  attestations to the release workflow. No cost, no external decision; proceed.
- **Paid Azure Artifact Signing — GATE.** Actual code signing costs money and is
  the maintainer's decision. Until it is taken, builds remain unsigned.

**Do not read the build log as evidence here:** electron-builder logs `signing
with signtool.exe` whether or not a certificate exists
(`.github/copilot-instructions.md`). The builds are unsigned.

**2026-10-04 stream handoff.** The free-attestation workflow and its initial
oracles were committed on the separate provenance branch (`c571acab`); the
reviewed publication/upload-path checks and corrected verification guidance
followed as `6ab5466`. The branch-local revert IDs were R600-R610. Packaging
passed with the built-asar oracle explicitly skipped because that branch had
no current build; its publication/upload-path records each failed their
named assertion under its own revert, with required controls passing. Fresh
independent Sol/Terra/Luna reviews converged after the release asset and
updater-manifest omissions were corrected.

**Integration after F22.** The first cherry-pick conflicted with F22's
revert-harness and packaging-oracle blocks; Terra preserved both sets of
checks. The two provenance commits are now landed as `f245cb8` and
`6712089` in the integration checkout. Because F22 already owned the
branch-local record IDs, provenance uses **R663-R673** in the combined
inventory. A fail-closed duplicate-ID self-check now runs before every
harness mode, and its injected-duplicate negative control exits 2. The
combined anchor audit resolves
(`files/sec08-integrated-anchor-audit-20261005.log`) and packaging passes with
the remaining packaged-update-feed skip; neither result individually
reproves the renamed records. Fresh independent Sol/Terra/Luna
integration-seam reviews agreed
there is no new blocker in the merged ID guard, paired-edit restore or
publication assertions; none treated the renamed records as individually
proven. The first combined `--expects` run exited **2**
(`files/combined-provenance-live-name-20261005.log`): tabs returned
**477/478**, leaving that suite's names UNAUDITED, while the other
catalogues showed no orphan. A separate clean tabs run and the prior
complete F22 worktree suite both passed **478/478**; neither changes
the combined-audit verdict. The original harness did not retain the
failing assertion line, so Terra added bounded fail-closed diagnostics.
The targeted one-suite `--expects R543` with those
diagnostics also exited 2: its one tabs failure was **"a pre-install
updater error leaves the exact update commit active and its replaced
deadline stale"**, with `updateCommitHeld:false`
(`files/combined-tabs-audit-diagnostic-20261005.log`). A subsequent
direct tabs run exited **477/478** on a *different* updater assertion,
**"a missing paired updater quit expires fail-closed, retires only its
attempt, and replays the absorbed user close"**. Its recorded events
showed the replayed window-close request and then a real renderer
`unresponsive` event, which routed main through its fallback instead
of leaving the held request pending
(`files/integrated-tabs-update-commit-diagnosis-20261005.log`). These
are actual failed runs, not an approved fixture exception or evidence
that the product can discard edits. F22 product and tabs-test bytes
are unchanged by the provenance landing. The subsequent integrated
live-name audit is recorded above as healthy; a clean-tree suite
still remains pending. One
subsequent idle-machine, machine-exclusive direct tabs run on the
same combined tree passed **478/478**
(`files/combined-tabs-exclusive-diagnosis-20261005.log`). This
does not explain the distinct earlier updater-fixture failures,
replace the failed full `--expects` result, or authorize another
blind retry loop.

The integrated provenance records **R663-R673** were each executed in
one bounded targeted mutation run
(`files/combined-provenance-targeted-proofs-20261005.log`). Every
record reported **PROVEN** with its named failure and required controls,
and the run restored its touched files. A fresh independent
Sol/Terra/Luna review of the added bounded diagnostic also found no
blocker; it does not change an unusable baseline's exit or verdict.
The reviewed combined-ID guard and diagnostic were committed as
`7cc985a` on the integration branch. This does not complete the
separate full revert inventory or the published-artifact attestation
check.
This is **integrated but not complete**: verify an actual downloaded artifact
from an attestation-enabled published release when one exists. Do not cut a
release merely to manufacture that evidence; automatic pre-publication
verification is not a completion requirement. Paid signing still needs the
maintainer's decision.

**Completion criteria.** Attestations are produced by the release workflow and
verifiable against a published artifact; the packaging suite asserts the workflow
still emits them; the signing decision is recorded here either way.

### `readme-story` — rewrite the README around the fork's story · PENDING

Rewrite `README.md` around Folia's divergence from upstream, what was improved,
the measurements behind those claims, and where it is going. **Verify the
README's own claims before publishing them** — stated counts in this repository
have rotted every single time they were hand-maintained, which is why several of
them are now pinned by assertions in `test/test-packaging.js`.

**Two known inconsistencies to resolve while doing it**, both found by review of
this register and neither fixed here:

- `README.md` states in one place that the two network paths are the update check
  and document-authored `https:` images, and in another that *"Folia makes no
  network requests"*. Both cannot be true; the first is the accurate one.
- `docs/SECURITY-AUDIT.md`'s coverage note still says the only outbound activity
  is "the CDN/font loads in `index.html` (SEC-10) and `electron-updater`'s GitHub
  Releases check". That predates the SEC-10 fix — libraries are vendored and no
  CDN is contacted — and it omits SEC-09's deliberate `img-src https:`. The row in
  the same document's summary table (SEC-10 **FIXED**) is the current truth.
*(A third inconsistency — hardcoded harness counts of **458** records and **276**
`mustPass` entries in `.github/copilot-instructions.md`, against **487** and
**303** counted at `HEAD` on 2026-09-02 — was **resolved on 2026-09-03** by
removing the numbers from that file rather than refreshing them. The harness is
extended by almost every item in this register, so any hand-maintained count is
stale again within a wave. Counts are now stated to be dynamic and to be derived
from the harness itself — `--anchors`, `--expects`, or the counting method
already used against the file. Do not reintroduce a prose count anywhere,
including here.)*

**Completion criteria.** Every factual claim traced to a measurement or an
assertion; the two inconsistencies above resolved in their own files; any newly
stated count pinned by the packaging suite so it cannot rot silently; **and the
*Planned next* link to this register survives the rewrite** — it is one of the
two entry points that make this file discoverable (see the note at the top), so
a rewrite that drops it re-opens the gap that was closed on 2026-09-02.

### `fullrun` — the complete revert harness from a clean tree · PENDING · blocks `w2-release`

Account for every record in `scripts/prove-table-fixes.js` from a clean
tree: run every non-deferred record end to end, and report the two
explicitly approved deferred individual proofs (R545 and R568) as
**DEFERRED/UNPROVEN**, not PROVEN or behaviorally withdrawn `skip`.
Explicit targeted runs of those records must remain available for
future proof work. No other record may be silently deferred.
This takes hours, which is why it is a scheduled item rather than a routine step.
It is nonetheless a **release blocker**: the milestone gate requires the complete
harness inventory with all non-deferred proofs executed, not a green
result obtained by hiding failed or unattempted records.
**Resolved targeted proof, not the complete run:** R319's
individual mutation previously reached the expected theme
failures but was reported UNUSABLE because the harness rejected
a post-footer shutdown diagnostic also seen in a normal theme
run. The targeted harness-only correction below proves R319
individually; the complete clean-tree inventory still needs
to run and R319 has no DEFERRED exception.
The integration owner isolated a bounded harness-only investigation
at `test/r319-exact-theme-tail-20261005` from `9731e95`.
Read-only source tracing found the same exact shutdown line is
accepted after clean theme and after designated R454/R660
mutations, but R319 lacks a mutation-specific allowance;
independent Opus/Luna design checks are now assessing whether
an exact R319-only allowance retains fail-closed semantics.
No mutation verdict or fix is claimed at this handoff.
Opus and Luna independently agreed an exact R319-ID-only
mutation tail can reuse the existing parser without widening
the clean-run or other mutation policies; added/fatal/reordered
tails and adjacent R320 must still be rejected. Luna found a
second gate: R319 currently declares one `expect` and one
`mustPass` without requiring exact failures or observed
controls, yet the real mutation yields **two** theme failures.
Terra now owns a bounded harness-only correction in that
isolated worktree: identify both actual failure names and
their causal relation first, then enforce exact expected
failures and live controls if justified, add fail-closed
self-checks and prove the real R319 revert with source
restoration. If the second failure is unrelated or the
evidence cannot be recovered, stop and report UNUSABLE
instead of manufacturing a passing proof. The next SEC-08
context-menu loader awaits this serial harness outcome.
Terra found both real mutation failures: the mode-only
Mermaid configuration assertion and the configuration actually
passed to `mermaid.initialize`. The isolated harness-only
candidate now requires those two exact failures and two
observed passing controls, permits only R319's exact single
shutdown line, and self-checks unrelated/fatal/reordered tails
and adjacent R320. Clean theme passed **363/363**, all **625**
anchors resolved, and the individual R319 revert reported
**PROVEN**. This is targeted
evidence, **not** the complete `fullrun` gate or an approved
proof exception. The candidate diff is approximately 278
lines in one harness file; three fresh independent Sol/Terra/Luna
reviews are evaluating both fail-closed correctness and whether
that size is warranted before any commit or integration.
The first fresh round agreed the real R319 mutation and two
named assertions now reach a usable footer; Sol and Luna
found no significant behavioral blocker, though both noted
the synthetic `411/413` footer does not match the real
`361/363`. Terra separately identified two coupling risks:
the new exact-tail precedence tightens R454/R660's former
generic two-line teardown acceptance, and the new
exact-failure-count helper is self-checked without a proof
that bypassing its invocation in the live verdict goes red.
These are not consensus findings; the integration owner
accepted a bounded correction to preserve the older
records' semantics, align the fixture with observed totals,
and make the count branch sensitive to break/restore.
If that demands substantially more harness machinery,
stop and report rather than expand the unit. A material
correction must repeat the three fresh reviews.
The bounded correction preserved legacy R454/R660 acceptance,
aligned the synthetic 361/363 footer and routed the live
mutation verdict through a shared classifier. Clean theme
**363/363**, all **625** anchors and individual R319
**PROVEN** still pass, with source restored. Sol found no
blocker in the follow-up, but Luna identified that the
duplicate-failure synthetic test bypasses footer accounting:
it appends a parsed failure instead of recording a third
`FAIL` and a matching 360/363 footer. The integration
owner allowed one final small correction to make this
negative control use the real suite-health path, with a
strict stop if it expands beyond the bounded harness unit.
No review convergence or integration is claimed yet.
The final negative control now inserts a third duplicate
failure with a consistent **360/363** footer and routes it
through `suiteRunHealth` before the live count classifier.
R319 alone receives strict exact-tail matching; the older
R454/R660 generic two-line teardown behavior is preserved.
The fresh post-correction Sol/Terra/Luna round found **no
significant issue**. A retained individual run reports
R319 **PROVEN** with exactly two named failed assertions,
both required controls passing and all **625** anchors resolving;
the clean theme **363/363** control log shows the same
shutdown line. Evidence is in
`files/r319-final-proof-20261005.log`,
`files/r319-final-anchors-20261005.log` and
`files/r319-clean-theme-20261005.log`; the retained
post-landing source-restoration hash attestation is in
`files/r319-integrated-source-hashes-20261005.log`.
This is an individual proof, not a full clean-tree revert inventory.
The reviewed, isolated one-file test stream was committed as
`97e66cc` on `test/r319-exact-theme-tail-20261005`;
it fast-forwarded serially into integration at `97e66cc`.
The final one-file patch was **351 insertions/15 deletions**,
larger than the initial 278-line candidate because the
fail-closed synthetic controls and record-scoped legacy
behavior were made explicit. Sol found no clear smaller
safe alternative; Terra and Luna found no final blocker.
Post-landing machine-exclusive targeted proofs R319,
R454 and R660 each reported **PROVEN**: R319 with exactly
two named failures and observed passing controls; R454
with its one named failure under its no-unlisted policy;
R660 with two named expected failures and controls but
**no exact-failure enforcement** (neither a no-unlisted gate
nor an expected-failure count)
(`files/r319-integrated-three-proof-20261005.log`).
The mutated Mermaid config hash matched before and after
(`files/r319-integrated-source-hashes-20261005.log`);
the integration tree remained dirty only in this register.
All **625** combined anchors resolved
(`files/r319-integrated-anchors-20261005.log`, byte-identical
to the pre-landing audit), which is setup evidence only.
R454/R660 were included because the
shared exact-tail parser was touched; they do not substitute
for the still-open complete `fullrun` gate.

**Preconditions that make the result meaningful:** a clean working tree, no
Electron process running, and **no review diff generated while it runs** — the
harness mutates repository files, so a diff taken mid-run contains reverted code
and reads exactly like a real finding.

**Completion criteria.** Every non-deferred record PROVEN or explicitly
explained under its existing policy; exactly R545/R568 reported as
DEFERRED/UNPROVEN with their reasons; no unapproved deferral and no
`SETUP-FAILED`. Anchors and live assertion-name audits still cover
the deferred records. A rotted anchor never reports a pass.

### `shots` — regenerate and *look at* every theme screenshot · PENDING · blocks `w2-release`

Regenerate the theme screenshots across all six schemes and inspect them.

**Capturing a PNG is not verification.** The repository rule is explicit:
*verify by viewing, not by capturing*. An unlooked-at screenshot is another
vacuous green.

**This is regenerate-and-view, not capture-only, and it is a release blocker.**
The scope is every visual surface the wave touched — the six theme schemes, and
any other rendered surface a landed item changed. Each regenerated image is
opened and looked at by the reviewer before the item is closed; an image that was
produced but not viewed does not count toward it.

**Completion criteria.** Every scheme and every wave-touched visual surface
regenerated **and visually confirmed by a human or reviewing agent that actually
opened the image**; the golden re-captured only if a deliberate change requires
it.

**2026-10-05 partial visual pass.** The six regenerated
`screenshots/themes/` scheme images and three theme-menu images were
opened and inspected: prose, tables, code, blockquotes, menu panels
and selection ticks were visible. The same integrated run's recently
generated search, Mermaid, popup zoom, list/TOC, table, dialog,
security-inline-style and F22 tab images were opened and inspected.
`dialog-short-window.png` visibly contains the Insert Table dialog
within the short viewport; its earlier handoff description as a bare
Beta tab was not reproduced when the file was reopened. The blue
`selfcheck-frame-freshness.png` is a capture sentinel, not a product
surface. This is **not** a completion claim: the wave-wide surface
inventory, any later changed surfaces, and the final clean-tree
regenerate-and-view pass remain open.

### `final-cleanup` — clean the tree before release · PENDING · blocks `w2-release`

Remove probe scripts and scratch output, normalise files (CRLF — the working tree
is CRLF and hand-written files are the usual offender), and run the complete
test and revert chain, then push.

**Staging discipline:** stage named files. Never `git add -A` or `git add .` —
the root directory carries untracked scratch output, and a bulk add can abort on
`core.safecrlf` while the `commit` after it still succeeds, producing a commit
that looks ordinary and contains a fraction of the change.

**Completion criteria.** `git status` shows nothing unintended; `--anchors`
resolves; the full chain is green; pushed.

### `user-verify` — verification against the real workflow · BLOCKED on `final-cleanup`

Final verification by the maintainer against the real multi-file Copilot
workflow — the actual use case Folia exists to serve. This is last on purpose:
it is only meaningful against a clean, released-shaped tree.

**Completion criteria.** The maintainer confirms the workflow behaves correctly,
or files what does not.

---

## Dependencies and order

Explicit dependencies:

| Item | Waits on | Why |
|---|---|---|
| `w2-f03` | `w2-sec08` | Sender validation defends a frame, not an attacker who already owns a Node-privileged renderer. Ordering it first would be defence that measures nothing. |
| `w2-upstream` | `upstream-toolbar-overflow` | That fix is in the same upstream-derived surface; classifying the backlog first means classifying against a moving target. |
| `w2-release` | `w2-f22`, `w2-hygiene`, `w2-privacy`, `w2-sec08`, `w2-upstream`, **`fullrun`, `shots`, `final-cleanup`** (+ `w2-ci`, `w2-docs`, `w2-f23`, `w2-f25`, all **done**) | The milestone ships once, not per fix. The last three are verification prerequisites, not courtesies: the milestone gates require the **complete** revert harness, **viewed** screenshots and a clean tree, so a release without them is a release that skipped its own gates. |
| `user-verify` | `final-cleanup` | Verifying a dirty tree verifies nothing that will ship. It runs after `final-cleanup` and may be returned either side of the release cut, as the maintainer's own verification. |
| `diagnostic-log-hardening` | `w2-privacy` (practical, not blocking) | The opt-in switch has to exist before there is a gated file to harden. It is DEFERRED rather than BLOCKED: it is scheduled after wave 2 by the 2026-09-02 decision, not prevented by anything. |
| `ctime-byte-witness` | `w2-f22` (practical, not blocking) | The ctime-only policy and its measured false-conflict baseline must exist first. The stronger witness is scheduled after wave 2 by the 2026-10-01 decision, not required for release. |

Everything else is independent and may be taken in any order.

**`diagnostic-log-hardening` and `ctime-byte-witness` are deliberately absent
from `w2-release`'s row.** Neither is a wave-2 release blocker. If that changes,
the item is added to
`w2-release`'s "Waits on" cell above and nowhere else.

**`fullrun`, `shots` and `final-cleanup` are blockers, corrected 2026-09-03.**
They were previously listed here as *strongly recommended, not blocking*, with
the note that releasing without them was "a maintainer call, not a protocol
violation". That was **wrong and is withdrawn**: it contradicted the milestone
gates in *Completion criteria* and *Parallel delivery*, which require the full
13-suite run **and the complete revert harness** at a milestone boundary, and
require visual changes to be verified by screenshots that are actually viewed. A
document cannot mandate a gate in one section and make it optional in another.
**No release may bypass the full suite, the complete revert harness, the tree
cleanup, or the required viewed screenshots.**

**Suggested order**, given the above:

1. **`w2-f22`** — landed on the integration branch, not released; finish
   its remaining clean-tree and release verification without reopening
   the maintainer-deferred R545/R568 individual proofs as release blockers.
2. **`w2-sec08`** — the long pole, and an **exclusive** stream: while it holds
   `src/`, no other source work runs (see *Parallel delivery without reducing
   quality*). Only docs-scoped work proceeds alongside it.
3. **`w2-f03`** — immediately after SEC-08, while the bridge is fresh.
4. **`w2-privacy`, `w2-hygiene`, `w2-kbscroll`** — small, independent, no gates.
5. **`upstream-toolbar-overflow` → `w2-upstream`** — in that order.
6. **Mermaid trio** (`mermaid-cold-cache-source`, `mermaid-block-identity`,
   `perf-mermaid-sweep`) — one surface, best done together.
7. **`table-breakout-perf`** — the largest remaining perf win; independent of
   everything above.
8. **Gated items** (`n2-user`, `n16-insert-anchor`, `perf-node-count`,
   Azure signing) — as decisions arrive.
9. **`readme-story`, `rv4-nth`** — any time. The free-attestation half of
   `sign-provenance` is integrated; published-artifact verification remains.
10. **`shots` → `fullrun` → `final-cleanup` → `w2-release` → `user-verify`** —
    the closing sequence. All three of `shots`, `fullrun` and `final-cleanup` are
    **blockers** of `w2-release`; `fullrun` and `final-cleanup` both want a quiet
    tree, and `fullrun` must not overlap any edit in its worktree. `user-verify`
    is the maintainer's own pass and follows `final-cleanup`; it is the one item
    in this sequence that is not a release blocker.
11. **`diagnostic-log-hardening`** — **after** `w2-release`. Deferred out of
    wave 2 on 2026-09-02; it ships in a later stage, not this milestone.
12. **`ctime-byte-witness`** — **after** `w2-release`. The accepted ctime-only
    policy ships with wave 2; the stronger content witness does not.

---

## Decision gates

Work that **stops** until the maintainer decides. Everything not listed here
proceeds autonomously.

| Gate | Item | The decision |
|---|---|---|
| Zoom anchoring | `n2-user` | Should `Ctrl`+wheel zoom anchor on the pointer instead of the pane centre? Preference, not defect. |
| Insertion-anchor scope | `n16-insert-anchor` | Narrow fix at the mismatching call sites, or a general source↔DOM position map? The general version is a render-pipeline change. |
| Prism simplification threshold | `perf-node-count` | At what document/block size does Prism stop fully tokenising? Trades syntax fidelity for speed. **Only the threshold is gated** — the measurement and evaluation proceed autonomously. |
| Paid code signing | `sign-provenance` | Purchase Azure Artifact Signing? **Only the paid half is gated** — free GitHub attestations proceed without asking. |
| Upstream feature additions | `w2-upstream` | Any upstream commit classified as a *feature* needs a call, because the fork's direction is deliberately leaner. Bug and security fixes are taken autonomously. |

### Explicitly autonomous

No decision needed; these proceed without asking: `w2-f22` and all six of its
subtasks, `w2-sec08`, `w2-f03`, `w2-privacy`, `w2-hygiene`, `w2-kbscroll`,
`w2-release`, `mermaid-cold-cache-source`, `mermaid-block-identity`,
`perf-mermaid-sweep`, `table-breakout-perf`, `upstream-toolbar-overflow`,
`rv4-nth`, `readme-story`, `fullrun`, `shots`, `final-cleanup`,
`diagnostic-log-hardening` and `ctime-byte-witness` (both deferred, but
ungated — no decision is outstanding on either), the free-attestation half
of `sign-provenance`, the measurement and
evaluation half of `perf-node-count`, and the *classification* work in
`w2-upstream` (only the feature calls are gated).

The three partially gated items — `sign-provenance`, `perf-node-count`,
`w2-upstream` — are each split above so that the ungated half is never held up
waiting for the gated one.

`user-verify` is not gated — it is maintainer work by definition.

### Maintainer decisions on record

Decisions already taken. Recorded here so a later reader sees the reasoning and
the cost, and so a decision is not silently re-opened by someone who only reads
the item entry.

| Date | Decision | Consequence |
|---|---|---|
| **2026-09-02** | **Make this register discoverable from the repository's documented entry points.** The tracker it mirrors does not survive a session, so a register nothing links to is one lost session away from being invisible. | `.github/copilot-instructions.md` lists `docs/PLANNED-WORK.md` among the load-bearing documents and adds a startup rule: read it before selecting or starting work; treat its IDs, status, dependencies, decision gates, performance gates and parallel-worktree process as authoritative; update it at every status transition and after every merge; only the integration owner writes it. `README.md`'s *Planned next* links here as the live roadmap instead of restating a subset of it. Both pointers are now load-bearing: renaming or moving this file must update them in the same commit, and `readme-story` carries a criterion that the link survives the README rewrite. |
| **2026-09-02** | **`w2-f22`'s close-path measurement is unconditional.** The gate applies to any change touching IPC or DOM traversal, and this item adds a shutdown IPC round trip and an all-tab dirty scan; it is benchmarked, not argued. | A first measurement was taken the same day: `bench/bench-f22-shutdown.js`, Electron 43.4.1 / Node 24.18.1, two runs; worst p95 **3.09 ms** at 25 tabs, once per shutdown. There is no "before" figure because the approval path did not previously exist. **Superseded in part on 2026-09-03:** that run is initial characterization, not a passed gate — one fixture, no before-path, and no budget declared in advance. `w2-f22` is **ACTIVE** and the final gate is pending. |
| **2026-09-02** | **Narrow `w2-privacy` to "off by default", and defer diagnostic-log hardening.** Because the diagnostic file will not be created in packaged/release builds by default, rotation, size/count retention and detailed sanitising need not ship inside the release-blocking item. | `w2-privacy` stays a wave-2 release blocker with minimal, tested scope. Rotation, retention, path/`argv` redaction, safe structured updater-error fields, and the detailed opt-in documentation/tests/reverts move to the new `diagnostic-log-hardening` item, PENDING · DEFERRED and explicitly **not** a wave-2 blocker. **Accepted tradeoff, not an eliminated risk:** a user who sets `FOLIA_DIAGNOSTIC_LOG=1` still gets the unhardened file, which records paths and `argv` and writes updater `err.message` verbatim — and that message can carry response metadata. Documentation must tell users to enable diagnostics only temporarily until hardening lands. |
| **2026-09-02** | **Fix the model for each role, and make code review three independent reviews rather than two.** GPT-5.6 Sol at high reasoning effort implements product change; GPT-5.6 Terra owns tests, benchmark, screenshot and revert-harness automation; GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna review independently in fresh contexts; Claude Opus 5 explores and researches, and no longer owns product implementation. | These assignments apply **going forward** and **supersede every earlier *current-process* model assignment in this register** — the `w2-f22` `code-review` and `design-review` subtasks, the per-stream quality loop, the completion criteria and *Process controls* are all restated accordingly. Explicitly historical records of who did what keep their names and are labelled historical rather than rewritten. The full procedure — the deterministic handoff order, how it composes with the isolated-worktree and file-ownership rules, and who owns which evidence — is in *Model roles and the delivery handoff*. **Accepted cost, not an eliminated one:** a third reviewer plus a mandatory re-review after every material correction adds a round to each unit, and because the agent that produced the work cannot review it, each unit now needs more separate fresh contexts than before. **What it buys:** the reviewer that finds a defect is never the agent that wrote it, and a fix is never blessed by the round that demanded it. **No item status changes because of this decision** — nothing here closes or advances an item, and `w2-f22` remains **ACTIVE** with its review still outstanding. |
| **2026-09-03** | **Corrections from the first three-reviewer gate, applied to the process documents.** The gate ran fresh, independent reviews by GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna over this register and `.github/copilot-instructions.md`. Five findings were accepted. | **Sol (HIGH):** `fullrun` was declared non-blocking while the milestone gates demanded the complete revert harness — a self-contradiction. `fullrun` is now a `w2-release` prerequisite. **Luna (HIGH), same area, independently:** `shots` and `final-cleanup` conflicted with the milestone and visual-verification rules for the same reason; both are now prerequisites too, and `shots` must be **regenerated and viewed**, not captured. **Luna (HIGH):** `w2-f22` could not be called a performance-gate pass — one fixture, no before-path, no budget declared in advance; downgraded to initial characterization with the final gate pending, and GPT-5.6 Terra owes a predeclared UX budget and a wider fixture matrix before the final run. **Terra (MEDIUM):** the instructions still said *"commit directly to `main`"*, contradicting the isolated-worktree and serialized-integration process; replaced. **Luna (MEDIUM):** the instructions hardcoded harness counts that had already rotted; the numbers were removed rather than refreshed, and counts are now derived from the harness. **Where they differed:** each HIGH came from a different reviewer, and only the `fullrun`/`shots`/`final-cleanup` contradiction was found by two independently — evidence that the three-reviewer gate is doing work a two-reviewer one did not. No reviewer contradicted another; nothing was rejected. **These corrections are documentation only** and have not themselves been through a review round — the follow-up three-reviewer pass has not run. |
| **2026-09-04** | **Two review findings about the portable updater's temp-file surface are rejected as out of scope, not as wrong.** Both are real properties of the design; neither is introduced by this work, and both would need a different mechanism rather than a bigger check. | **Rejected — "the acknowledgement token is readable by another same-user process".** True: it is embedded in `update.bat` inside a `mkdtemp` directory, and `mode: 0o600` does nothing to Windows ACLs, so any process running as the same user can read it and forge an `ack`. The token is what the review round asked for and it does what it can — it makes a *stale* or *blind* marker useless and raises a forgery from "guess the directory name" to "read the directory". It cannot defend against a same-user process, and neither can anything else here: that process can already replace `update.bat` before it runs, replace the downloaded installer, or kill the app. A genuine fix is an OS-protected channel (a named pipe with an ACL, or a helper process), which is a design change, not a hardening tweak. **Residual risk, accepted and recorded:** a same-user local process can make Folia quit without an installer having started. It cannot make it quit with unsaved work, because the commit re-asks whenever the document has moved. **Rejected — "`%` in an interpolated path is expanded by `cmd.exe`".** Also true, also pre-existing: `downloadedUpdatePath` and the batch directory have been interpolated into this script since SEC-20. Nothing in this round widened it, and the `if not exist "<installer>" goto failed` line added here makes the failure mode *observable and fail-closed* where it used to be a silent no-install. A real fix means not building a batch file at all. |
| **2026-09-04** | **Two implementation decisions taken while fixing the `w2-f22` review findings.** No sealed finding was rejected — all ten were valid — but both of these changed something a reader could reasonably expect to have been left alone, so they are recorded rather than absorbed. | **The portable spawn handler no longer cancels merely because another question is open.** The old guard was `if (pendingShutdown \|\| !isSameShutdownDocumentSession(...))`. The commit now raises its own force-fresh approval, and `requestShutdown` already **queues** a force-fresh intent behind an open question and re-raises it on settle — which is what the installed updater's public commit does, and what *"an updater commit arriving behind another question remains a required fresh question"* already asserts. Cancelling would make the portable path the only one that silently drops a stronger intent. The document-session half of the guard is kept, and the acknowledgement boundary re-checks both. **Cost, not an eliminated risk:** a portable child can now sit parked while an unrelated close question is on screen. It is bounded — the queued intent either runs or is declined, and a decline stands the child down through the new `onDeclined` channel. **R560's id is repurposed, not reused.** Its mutation (`return attempt.committed` → `return false`) is provably inert: `attempt.committed` is true only when the commit fired synchronously, and that path has already revoked the authorization and raised a fresh request, so both return values leave identical state. The record keeps its id and its subject — authorization across the installed updater's deferred-commit gap — and gains a mutation that can actually fail, plus a new assertion written for it. Deleting it and allocating a fresh id instead would have left a silent gap where a record used to be. |
| **2026-09-05** | **`w2-f22`'s performance gate is CLOSED, and the 2026-09-02 and 2026-09-03 rows above are superseded on that point only.** Neither is rewritten: their reasoning is why the closed gate can be trusted, and the numbers they recorded were never in dispute. | The 2026-09-02 row recorded a first measurement and the 2026-09-03 row correctly refused to call it a pass — one fixture, no before-path, no budget declared in advance. **Two of those three are now closed** (a 50 KB / 500 KB / 2 MB × 1 / 10 / 25 tab matrix plus all-dirty LF and CRLF worst cases at 2 MB × 25 tabs; a **16.7 ms** raw-p95 budget fixed *before* the runs it judged). **The third cannot be closed and is not claimed to be:** the approval path did not previously exist, so there is no before-number, which is exactly why a predeclared budget carries the verdict. Three runs, each executed exactly once: run 1 **failed honestly** at **22.4936 ms (LF)** and **98.1947 ms (CRLF)** and drove the maintained-dirty-state architecture; runs 2 and 3 passed every observation with 0 failures. **Run 1 is retained as a result, not a discarded outlier** — recording only the passing runs would hide the reason they pass. Full method and runs are in `bench/BASELINE.md`; the defect and fix are `docs/PERF-AUDIT.md` PERF-10. **Run 2's raw samples were not persisted** (the durable-output path did not yet exist); run 3's attestation artifact is machine-local and deliberately uncommitted. **No item status changes because of this decision:** `w2-f22` stays **ACTIVE**, is **not landed and not merged**, and still owes the final three-reviewer round over the executed state and serialised integration. |
| **2026-10-01** | **Ignore ctime-only disk-version changes in wave 2; defer content-aware verification.** The complete F22 fixture reproducibly saw Windows ctime drift after selection with unchanged dev/ino/size/mtime and disk bytes. A Save-only raw-byte-witness prototype itself triggered a later tab-selection refusal; a correct witness would span the original read, owner, watcher, selection and Save. The maintainer chose the smaller policy and explicitly said the stronger protocol is not a priority now. | `w2-f22` must still prove unchanged-file Saves work, while changes of identity, size and mtime continue to fail closed. **Accepted security/data-loss limitation:** a same-size external edit with restored mtime and unchanged file identity will no longer be distinguished by the version tuple alone and could be overwritten. Document this explicitly; do not claim otherwise. Track an end-to-end raw-byte witness as new `ctime-byte-witness`, PENDING · DEFERRED after `w2-release`, with no new release dependency. The abandoned prototype was byte-restored before this decision; no passing suite or fresh performance verdict is implied. |
| **2026-10-04** | **Defer the R545 and R568 individual proofs; switch to independent wave-2 work.** The bounded target-only designs failed to isolate these mutants without suppressing real assertions or accepting an unusable transcript. The maintainer explicitly chose not to block the eventual release on those two proofs, while saying **no release yet**. | Preserve both mutants and their target failures, label each **DEFERRED/UNPROVEN** in the full revert inventory, and keep targeted runs available; neither is PROVEN or a behaviorally withdrawn `skip`. Require an explicit, fail-closed exception for exactly these two IDs; all other harness records and all other release gates remain mandatory. Do not infer this decision authorizes F22 integration or release. |

---

## Model roles and the delivery handoff

**Maintainer decision, 2026-09-02 — mandatory.** These role assignments apply
**going forward** and supersede every earlier *current-process* model assignment
in this register. Where a passage is explicitly historical — a record of what a
particular round or commit already did — it keeps the names it had and is
labelled historical; it is not a description of how work is delivered now.

### The roles

| Role | Model | What the role owns |
|---|---|---|
| **Product coding and implementation** | **GPT-5.6 Sol** — `gpt-5.6-sol` | Reasoning effort **high**, always. Product source and any behavioural change to shipped code. |
| **Tests and automations** | **GPT-5.6 Terra** — `gpt-5.6-terra` | Test design and implementation, benchmark automation, screenshot-capture automation, revert-harness records in `scripts/prove-table-fixes.js`, and orchestration of the proofs. |
| **Code review** | **GPT-5.6 Sol** — `gpt-5.6-sol`, **GPT-5.6 Terra** — `gpt-5.6-terra`, and **GPT-5.6 Luna** — `gpt-5.6-luna` | Three *independent* reviews, each in a **fresh context**, read-only. Agreements and disagreements are both surfaced. |
| **Exploration and research** | **Claude Opus 5** — `claude-opus-5` | Maps architecture, history and risk, and supplies the evidence a change is planned against. It does **not** own product implementation under this process. |

**Independence is structural, not nominal.** The Sol agent that wrote the code is
**not** the independent Sol reviewer, and the Terra agent that wrote the tests is
**not** the independent Terra reviewer. An agent that has already committed to a
change cannot find its own blind spot — that is the entire reason there are
three. Each review starts from a fresh context and the diff, not from the
conversation that produced them.

**Blocking findings return to the role owner, not to whoever found them.**
Product defects go back to Sol at high reasoning effort; test, benchmark,
screenshot and revert-harness defects go back to Terra. **A product fix that a
Terra test exposed is still Sol's work.** After any material correction the
three-reviewer gate **repeats** — a fix is not blessed by the round that demanded
it. Stop when a round produces no new blocking findings.

### The handoff sequence

Deterministic, and in this order for every behavioural unit:

1. **Opus 5 — exploration.** Architecture, history, risk, and the evidence the
   change will be judged against. Read-only; no product edits.
2. **Sol at high reasoning effort — the product change.** Only the files the
   stream owns.
3. **Terra — tests, automation and evidence.** The targeted suite, the
   revert-harness records, the benchmark and screenshot automation, and the
   recorded results.
4. **Independent review — Sol, Terra and Luna**, three fresh contexts. These may
   run at once, because review is read-only.
5. **Corrections by the role owner** — product to Sol at high reasoning effort,
   tests and automation to Terra.
6. **Repeat step 4** after any material correction, until a round produces no new
   blocking findings.
7. **Serialised integration** — one stream merges at a time, per *Integration is
   serialised*.

**Where an item carries its own pre-implementation design review** — `w2-f22`'s
`design-review` subtask is the only current example — that review sits **between
steps 1 and 2**, runs with the same three independent reviewers, and
**supplements rather than replaces** the review at step 4. Reviewing a state
machine before it is built and reviewing the code that implements it are two
different questions.

### How this composes with the isolated-worktree model

The role split changes **who** performs a step. It relaxes nothing in *Parallel
delivery without reducing quality*.

- **One behavioural unit is edited by exactly one role owner at a time.** Sol and
  Terra never hold the same file concurrently, and never edit the same
  behavioural unit concurrently. If a product fix and its test live in the same
  file, they are sequential steps, not parallel ones.
- **Research and test *design* may run in parallel with an edit** — but only
  while they stay read-only and touch nothing the editing owner holds. Reading
  and designing compose safely; writing does not.
- **Test *automation* must not run a mutation harness while an edit is in flight
  in the worktree that harness will mutate.** `scripts/prove-table-fixes.js`
  rewrites the working tree of the worktree it runs in, so Terra runs it when
  nobody is editing that worktree — never alongside an edit there, and never two
  harnesses at once anywhere on the machine.
- **Screenshots, performance measurement and the full harness remain
  machine-exclusive** across all worktrees, exactly as *Machine-level
  exclusivity* states. Three reviewers do not make a shared machine safe.
- **The per-unit gates stand unchanged except for the explicit R545/R568
  individual-proof deferral recorded above**: the targeted suite,
  individually proven revert records for other fixes, screenshots actually
  *viewed*, the performance acceptance gates, a clean diff, and the
  milestone-boundary full suite and complete revert inventory.

### Evidence ownership

| Evidence | Owner | What that owner is accountable for |
|---|---|---|
| Commands, results and sample counts | **Terra** | Recording the exact command, the machine and runtime versions, the sample count and the p50/p95 — and building automation that reproduces them. A result nobody else can re-run is not evidence. |
| Product behaviour and performance correctness | **Sol** | That the change does what this register says it does, and that the numbers Terra recorded actually clear the *Performance acceptance gates* rather than merely existing. |
| Non-vacuity of the evidence, and the claims made about it | **The three reviewers** | That each test can fail, that each revert is proven individually with `expect` *and* `mustPass`, that screenshots were viewed rather than captured, and that every claim in the diff and the commit message is supported. Assume a new green result is vacuous until shown otherwise. |
| This register | **The integration owner** | Updating `docs/PLANNED-WORK.md` at **every** transition — role handoff, review round, material correction, status change and merge — under the single-writer protocol in *Process controls*. |

---

## Completion criteria

Per-item criteria are stated with each entry. These apply to **every** item:

1. **A fix without a revert is not finished.** Each fix gets a record in
   `scripts/prove-table-fixes.js` that undoes it, with `expect` (assertions that
   must fail) and `mustPass` (assertions that must keep passing, so a revert that
   fails everything cannot be mistaken for a detection).
2. **Every scenario proves its own setup** before asserting the interesting
   thing, and negative cases are exact — *which* assertions failed, not how many.
3. **`node scripts/prove-table-fixes.js --anchors` after any rename, move or
   reformat.** Anchor rot is the one failure this project cannot detect by
   testing; it reports `SETUP-FAILED` rather than a false pass, but only when it
   is actually run.
4. **Three-reviewer independent review** — GPT-5.6 Sol (`gpt-5.6-sol`), GPT-5.6
   Terra (`gpt-5.6-terra`) and GPT-5.6 Luna (`gpt-5.6-luna`), each in a fresh
   context, agreements and disagreements both surfaced. Two to three rounds is
   the usual shape, not a cap: blocking findings return to the role owner and
   the full round repeats after any material correction. Stop when a round
   produces no new blocking findings. See *Model roles and the delivery
   handoff*.
5. **Measurements are recorded** in `docs/PERF-AUDIT.md` or `bench/BASELINE.md`
   with the method, not just the result — including measurements that came out
   negative.
6. **The relevant audit document is updated**: `docs/SECURITY-AUDIT.md` for any
   SEC finding, `docs/CUSTOMIZATIONS.md` for anything that changes the fork's
   divergence from upstream.
7. **No lint suppressions, no new tooling** to make something pass.
8. **The performance acceptance gates below are met** for any change touching
   startup, rendering, file I/O, tab switching, IPC, or DOM traversal —
   including security changes, which get no exemption.

### Wave-2 exit criteria

`w2-release` requires **all** of the following. None of them is optional, and
none is a maintainer's discretionary call:

1. **Full `npm test` green from a clean tree** — all 13 suites, not a subset.
2. **`PACKAGING_STRICT=1 npm run test:packaging` green.** Without the flag, a run
   that built nothing reports "0 failed" having verified nothing.
3. **`fullrun` complete** — the *complete* revert inventory from a clean
   tree, every non-deferred record PROVEN or explained under its
   existing policy, exactly R545/R568 explicitly DEFERRED/UNPROVEN
   under the maintainer's recorded exception, no `SETUP-FAILED`.
4. **`shots` complete** — every screenshot for the wave's visual surfaces
   **regenerated and viewed**. Capturing is not verifying.
5. **`final-cleanup` complete** — clean tree, `--anchors` resolving, chain green,
   pushed.

`user-verify` is **not** a release blocker: it is the maintainer's own
verification against the real workflow, runs after `final-cleanup`, and may be
returned either side of the release cut.

**Corrected 2026-09-03.** This section previously listed items 3–5 as *"strongly
recommended, not blocking"* and said releasing without them was "a maintainer
call, not a protocol violation". That contradicted the milestone gates stated
above and in *Parallel delivery*, and is withdrawn.

**Reaffirmed 2026-10-01.** Keep these release gates. Time-box low-return
investigations and report their exact blockers rather than building elaborate
fixture machinery or quietly treating an unproved gate as complete.

---

## Performance acceptance gates

**Mandatory for every product and security change in this register.** These sit
alongside the completion criteria above, not instead of them.

### The rule

**No security change is accepted on reasoning alone when it touches startup,
rendering, file I/O, tab switching, IPC, or DOM traversal.** "It is only a
validation check", "it is just a preload", "this cannot be hot" are all
predictions, and this repository's standing rule is *measure; do not reason from
the code* — a rule that exists because measurement has repeatedly contradicted
the obvious reading (bytes were a **12.9×**-wrong proxy for render cost; `lines`,
the obvious replacement, scored **26.9×**, worse than what it replaced). Security
work gets no exemption from that. A change in the six areas above ships with
numbers or it does not ship.

### What every such change must produce

1. **Before and after, on representative fixtures.** Not a synthetic microbench.
   Use the corpus and the audit fixtures that already exist — `plain50k`,
   `plain500k`, `plain2m`, `code10`, `code200`, `mermaid5`, `mermaid20`, and the
   `tables` / `wide` bench profiles — so the numbers are comparable to everything
   already recorded.
2. **Repeated samples, reported honestly.** Where a measurement is noisy or
   user-perceived, report **p50 and p95** (or median-of-N with the spread) rather
   than a single run. The bench already refuses `--reps=2` on the grounds that *a
   median needs at least 3 samples*; hold hand-run measurements to the same
   standard.
3. **A stated regression budget, fixed before the measurement is taken.** Decide
   what counts as acceptable *first*, then measure. Deciding afterwards is how a
   regression becomes "within noise".
4. **The result recorded in the tracker and in the permanent document** —
   `docs/PERF-AUDIT.md` or `bench/BASELINE.md`, with the method, the machine and
   the runtime version, not just the number. **Negative and neutral results are
   recorded too**; "we measured and it did not move" is a finding.
5. **Like-for-like comparison.** Same machine, same Electron version, same
   profile state, no other suite or harness running. A before/after taken across
   two machines or two Electron versions is not a comparison.

### Regressions are blockers

**A measured performance regression blocks the change** unless the maintainer
explicitly accepts it, and the acceptance is recorded here with the number and
the reason. A regression that is noticed and then absorbed silently is the
failure mode this gate exists to prevent.

### SEC-08 (`w2-sec08`) — the explicit benchmark set

SEC-08 is the change most likely to move these numbers, because it converts
**18** synchronous `fs`/`path`/`os` calls into asynchronous IPC round-trips,
several of which sit inside the render pipeline. It does not ship without the
following, measured before and after on the **same machine and the same Electron
version**:

| Measurement | Why it is in the set |
|---|---|
| **Cold startup** and **first paint** | The preload, the bridge and the module loader all execute before anything is drawn. |
| **Open + reload at 50 KB / 500 KB / 2 MB** | The three scales the existing fixtures already cover, so the numbers join the existing series. Reload is included because `reload-file` is the fork's core loop. |
| **Tab switching at 10 and 25 open tabs** | `switchToTab()` is where the render cost actually lands — tabs render lazily, so a guard on the read path saves nothing and a regression here is felt immediately. |
| **Save and open round-trips** | These are exactly the `fs` calls that become async. |
| **IPC latency and bytes per call** | The bridge replaces 70 direct call sites; both the added latency and any serialisation growth need a number. |
| **Renderer long tasks** | The user-visible symptom of a pipeline whose ordering changed. Count and duration. |

The audit already names where a regression would hide: several of the converted
call sites *"sit inside the render pipeline whose ordering invariants are exactly
what PERF-04/05/06 and the mermaid race work were about"*. That is the sentence
this benchmark set exists to answer.

### Style-heavy fixtures: benchmark CSS normalisation

The sanitizer no longer hand-tokenises CSS. It **delegates to Chromium**: a style
attribute is assigned to a detached element's `style.cssText` and read back, and
a `<style>` element's text goes through `new CSSStyleSheet()` + `replaceSync()`
(`docs/SECURITY-AUDIT.md`). That is correct — it is what closed the escaped-`url`
and SVG-`<style>` bypasses — but it is **per-attribute and per-element CSSOM work
on every sanitize**, and its cost has never been measured.

Any change touching the sanitizer, the style allowlist, or the theme system must
therefore be benchmarked on a **style-heavy fixture** — many inline `style`
attributes and multiple `<style>` blocks — which the current corpus does not
contain. Building that fixture is part of the first such change.

### What is already measured, and what is not

Do not let the two be confused. The distinction matters because an existing
number is a baseline to defend, while an absent one is work to do.

| Claim | Status |
|---|---|
| `DOMPurify.sanitize` costs **4.9 ms** on the `mermaid20` fixture (225 KB, 20 diagrams) for a **changed render** after a one-line text edit | **Measured** — `docs/PERF-AUDIT.md`, PERF-04, alongside `renderMarkdownFull()` **93.9 ms**, `marked.parse` **7.8 ms**, `patchViewerDOM` **8.0 ms**, `mermaid.run` **0 calls**. |
| The cost of CSSOM-based CSS normalisation on style-heavy documents | **Not measured.** No style-heavy fixture exists. |
| The cost of an `ipcMain` handler, with or without sender validation | **Partially measured, and now recorded.** `bench/bench-f22-shutdown.js` records a bare IPC round trip at **p50 0.165–0.177 ms / p95 0.21–0.30 ms** (Electron 43.4.1, two runs) — a useful floor, but it is *round-trip* cost on one channel with a trivial payload, not per-handler cost and not the cost of adding sender validation. **Those two remain unmeasured.** What has since been measured and written down is the whole F22 close path, including its IPC round trip, across 50 KB / 500 KB / 2 MB × 1 / 10 / 25 tabs: `bench/BASELINE.md`, *The F22 shutdown-approval gate*, and `docs/PERF-AUDIT.md` PERF-10. |
| The cost of the `debug.log` write stream | **Not measured.** |
| Any steady-state cost of `contextIsolation` on the main window | **Not measured.** The popups run isolated with no recorded consequence, but an absence of a record is not a measurement, and a popup workload would not predict the main window's. |

Quoting the 4.9 ms figure for anything other than that fixture, that render path
and that edit is a misattribution.

## Parallel delivery without reducing quality

Parallelism here is a **file-ownership** problem, not a scheduling problem. The
constraint that decides everything: `scripts/prove-table-fixes.js` **mutates the
working tree of the worktree it runs in**, so any edit made while it runs is
made against reverted source. The repository already records the consequence —
*never generate a review diff while the revert harness is running; it will
contain reverted code you did not write, and it reads exactly like a real
finding.* Two streams sharing one working tree cannot both be trusted.

### Topology

- **One git worktree per independent stream**, each on its own branch.
- **The main worktree is integration-only.** No stream develops in it. It is
  where branches land, one at a time, and where milestone-boundary runs happen.
- **Each worktree is fully isolated at runtime:** its own Electron `userData`
  path, its own dev profile, its own temp directory prefix, and its own ports if
  anything binds one. The repository already treats shared profile state as a
  defect class — it produced a suite that hung with zero assertions until
  `test/test-userdata-isolation.js` made isolation structural, and that was the
  *fourth* instance of suites measuring inherited session state. Sharing a
  profile across worktrees would reintroduce it at a new level.

### The hard rule

> **No two concurrent streams may modify the same product, test, or harness
> file.** Not "coordinate carefully" — not at all. If two candidate streams both
> need `src/renderer.js`, they are not parallel; they are sequential.

Broad-surface work **serialises**: `w2-sec08` and `w2-f03` (they rewrite the
renderer's entire boundary), any renderer architecture change, and `w2-release`.
While one of those holds the renderer, nothing else touches it.

### File-ownership matrix

Ownership is exclusive for the duration of a stream. `scripts/prove-table-fixes.js`
is the contended file in almost every row — every stream adds records to it —
which is why the sequencing below matters more than it first appears.

| Stream | Owns exclusively | Must not touch |
|---|---|---|
| **A — F22 shutdown** | `src/main.js`, `src/custom-tabs.js`, `test/test-tab-refresh.js`, `test/test-render-security.js`, `scripts/prove-table-fixes.js`, `bench/bench-f22-shutdown.js` | `src/renderer.js` beyond what the protocol strictly needs |
| **B — docs / provenance / upstream research** | `README.md`, `.github/workflows/*`, and the narrative documents no other stream is recording into | `src/`, and `test/` except the two pinning assertions named below |
| **C — SEC-08 then F03** | `src/renderer.js`, `src/main.js`, `src/index.html`, a new preload, every Electron suite's renderer access, `scripts/prove-table-fixes.js` | nothing else may run concurrently against `src/` |
| **D — Mermaid** | the Mermaid regions of `src/renderer.js`, `test/test-mermaid-render.js`, `test/test-render-patch.js` | `src/main.js`; cannot overlap C at all |
| **E — UI keyboard / menu** | `src/custom-styles.css`, `src/styles.css`, the menu/keyboard regions of `src/renderer.js` | anything C or D holds |
| **F — Performance** | `bench/*`, the specific pass under optimisation | any file another stream holds |

Note what the matrix makes obvious: **C and D and E all want `src/renderer.js`**.
Only one of them can be live. Be conservative wherever `src/renderer.js`,
`src/main.js` or `scripts/prove-table-fixes.js` overlap — the cost of guessing
wrong is a silently corrupted diff, which is expensive to detect and worse to
review.

**The record documents are append-scoped, not owned.** Every stream writes its
own findings into `docs/SECURITY-AUDIT.md`, `docs/PERF-AUDIT.md`,
`bench/BASELINE.md` and `docs/CUSTOMIZATIONS.md` — completion criteria 5 and 6
and the performance gates require it, and SEC-08 cannot be closed otherwise.
Those four files are therefore excluded from Stream B's exclusivity, and
`bench/BASELINE.md` is excluded from Stream F's: F owns the harness *code* under
`bench/`, not the recorded results. Streams append to disjoint sections and never
rewrite another stream's entry.

**`docs/PLANNED-WORK.md` has exactly one writer** — the integration owner, per
*Process controls*. Streams report status transitions to that owner rather than
editing this file themselves.

### Suggested streams and order, from the current queue

**Now, in parallel:**

- **Stream A — `w2-f22`, the critical shutdown work.** Its product and test
  changes have landed on the integration branch; release verification remains.
  It owned `src/main.js`, `src/custom-tabs.js`, `test/test-tab-refresh.js`,
  `test/test-render-security.js`, `scripts/prove-table-fixes.js` and
  `bench/bench-f22-shutdown.js`. Its two deferred individual proofs do not
  waive the other release gates.
- **Stream B — documentation, provenance and upstream research.** Touches no
  product source: `readme-story` and the free-attestation half of
  `sign-provenance`. Its one `test/` exception is `test/test-packaging.js`, and
  only to add the two pinning assertions those items require — the count
  `readme-story` states, and the assertion that the workflow still emits free
  attestations — and only while no other stream holds that file. Every other
  `test/` file is out of bounds. B may also do *preparatory* reading of the 16
  outstanding upstream commits: building the list and its context, not recording
  verdicts. The classification itself is `w2-upstream`, which stays BLOCKED on
  `upstream-toolbar-overflow` precisely so it is not done against a moving
  target; feature additions found during that reading still go through their
  decision gate. Its provenance changes have also landed on the integration
  branch. The disjoint-file rule still applies to any remaining work.

**After A lands (now the integration branch's state):**

- **Stream C — `w2-sec08`, then `w2-f03`, as one exclusive broad security
  stream.** These are not parallelisable with each other or with anything else
  that touches `src/`. Path validation lands inside SEC-08; sender/frame
  validation follows in F03. Expect this to be long — it is the five-step
  sequence the audit fixed, and it carries the full benchmark set above.
- **Stream D — Mermaid**, in its own renderer worktree, **only while it does not
  conflict with C**. Serial within the stream:
  `mermaid-cold-cache-source` → `mermaid-block-identity` → `perf-mermaid-sweep`.
  Each depends on the identity model the previous one establishes. If C is live
  in `src/renderer.js`, D waits — do not attempt region-level sharing of that
  file.
- **Stream E — UI keyboard and menu work:** `w2-kbscroll` and
  `upstream-toolbar-overflow`. Mostly CSS and event handling, largely disjoint
  from C's boundary work, but it still touches `src/renderer.js` — so it yields
  to C.
- **Stream F — performance:** `table-breakout-perf` first, as the largest
  measured remaining cost. `perf-node-count`'s **measurement and evaluation are
  autonomous and may start here** — the bench has to derive a candidate
  threshold before the maintainer can decide anything; only *adopting* a
  threshold and acting on it waits on the gate. `n16-insert-anchor` is gated on
  scope and design and does not start until the maintainer decides — starting it
  before that is speculative work that may be discarded.

`w2-hygiene`, `w2-privacy` and `rv4-nth` are small and can be slotted into
whichever stream owns the files they touch, rather than being given streams of
their own. `w2-privacy` in particular is now a narrow `src/main.js` change, so it
belongs to whichever stream holds that file. `w2-release`, `fullrun`, `shots`,
`final-cleanup` and `user-verify` are the closing sequence and run in the
integration worktree with nothing else in flight.
`diagnostic-log-hardening` sits **after** that sequence entirely: it is deferred
out of wave 2, and it takes `src/main.js` when no other stream holds it.

### Quality gates are per stream, not per milestone

Parallelism must not dilute any of this. **Every stream runs the full loop for
every unit of work it takes on:**

1. **Baseline** — measurements and a green targeted suite *before* touching
   anything, so the after-number has something to compare against. This is
   Terra's execution and it runs against unmodified source, alongside Opus 5's
   exploration and Terra's read-only test *design*. No product edit and no new
   test or harness record exists yet at this point.
2. **Scoped implementation by Sol at high reasoning effort** — only the files
   the stream owns.
3. **Targeted suite, written by Terra** — the narrowest suite that covers the
   changed behaviour.
4. **Isolated revert proofs, recorded by Terra** — each fix gets a record with
   `expect` and `mustPass`; each is proven individually, not as a batch.
5. **Independent review in three fresh contexts** — GPT-5.6 Sol, GPT-5.6 Terra
   and GPT-5.6 Luna, none of them the agent that produced the work under review.
6. **Reviewer feedback returned to the role owner** — product to Sol at high
   reasoning effort, tests and automation to Terra — for validation and
   correction, with agreements and disagreements both surfaced. Re-run the three
   reviews after any material correction. Stop when a round produces no new
   blocking findings.
7. **Performance comparison** against the stream's own baseline, per the gates
   above.
8. **Screenshots regenerated and actually viewed** for any visual change.
   Capturing a PNG is not verification.
9. **A clean diff** — reviewed, nothing unrelated, nothing swept in.
10. **One commit**, message stating the problem rather than the patch.

### Integration is serialised

- **One stream merges at a time.** Cherry-pick or merge into the integration
  worktree, never two at once.
- **After each merge, re-run the impacted cross-suites** — not just the stream's
  own targeted suite. A stream that was green in isolation can break a suite it
  never ran.
- **The full 13-suite `npm test` and the complete revert harness run at milestone
  boundaries only.** The full chain is ~11 minutes and the full harness takes
  hours; running them after every merge would stop the pipeline without adding
  information that the impacted cross-suites do not already give.
- **Run `--anchors` after every merge.** It is ~1 second and it is the only thing
  that detects anchor rot, which is the one failure this project cannot detect by
  testing. Merges reformat and move code; that is exactly the damage class.

### Machine-level exclusivity

Worktree isolation is not sufficient for everything. These take an **exclusive
machine lock, across all worktrees**:

- **The revert harness.** It mutates its worktree's files. Never run it
  concurrently with edits *in that worktree*, and never run two harnesses at
  once — they are CPU-saturating and the timings become meaningless.
- **Screenshot and focus-sensitive Electron suites.** They depend on window
  focus and compositor state, which are machine-global. A second Electron window
  appearing mid-capture produces a wrong screenshot, not a failure.
- **Any performance measurement.** A benchmark sharing a machine with a test run
  is not a measurement.

Kill stray Electron processes before every run — a leftover instance holds files
and produces confusing failures.

## Process controls

**Historical incident these controls exist to prevent a repeat of:** a single
opaque agent run once went five hours without a reportable status. The failure
was not the duration; it was that nothing was observable while it happened and
nothing was recoverable when it stopped.

1. **Split work into bounded behavioural units.** A unit is one behaviour that
   can be described, implemented, tested and reverted on its own. `w2-f22`'s six
   subtasks are the model. If a unit cannot be stated in a sentence, it is not
   bounded yet.
2. **Emit a checkpoint after every phase** — design, implementation, test,
   revert, review. Each checkpoint states what was done, what was verified, what
   is uncommitted, and what is next. A phase that produces no checkpoint is
   indistinguishable from a phase that produced nothing.
3. **Stop and report the exact blocker; do not explore open-endedly.** When
   something is genuinely undecidable — a gate, a contradiction in the evidence,
   a missing measurement — report it precisely and stop. Hours of speculative
   exploration are how a run becomes opaque.
4. **One editing owner per unit; every reviewer is read-only.** The role owner
   edits — Sol for product, Terra for tests and automation — and the three
   reviewers only read and report. Two agents editing the same unit produce
   interleaved changes that neither can account for, and that is as true of two
   role owners as it is of two reviewers.
5. **Parallelise research, review and test design early** — those are read-only
   and compose safely, which is why the three independent reviews run at once.
   **Never parallelise editing within a unit**, and never run a mutation harness
   while an edit is in flight in the worktree that harness will mutate.
6. **The integration owner updates this register** after every merge, every role
   handoff, every review round, every material correction and every status
   transition. One writer for this file avoids the merge conflicts that a shared
   tracking document otherwise guarantees — and a tracker that conflicts is a
   tracker people stop updating.

## Expected performance impact of the security work


Stated **only where the repository has evidence.** No estimate appears here that
is not traceable to a measurement or an enumeration already in the tree. These
are *expectations to be tested by the gates above*, not results — none of them
substitutes for a before/after measurement.

| Item | Classification | Evidence |
|---|---|---|
| `w2-sec08` | **Credible, noticeable interaction risk. Requires the full benchmark set above; magnitude unmeasured.** This is the one item here where a user-perceptible regression is genuinely plausible. | `docs/SECURITY-AUDIT.md` (SEC-08 deferred section) enumerates **18** synchronous `fs`/`path`/`os` call sites that become asynchronous IPC round-trips, and states that several *"sit inside the render pipeline whose ordering invariants are exactly what PERF-04/05/06 and the mermaid race work were about. This is where regressions would hide."* |
| `w2-sec08`, steady-state cost of the flags themselves | **Not classified.** | The four popups already run `nodeIntegration: false, contextIsolation: true` behind preloads, and no performance consequence is recorded for them — but an *absence* of a record is not a measurement, and a popup workload would not predict the main window's anyway. No number is offered. |
| `w2-f03` sender/frame checks, and the existing navigation guards | **Expected negligible** — a constant-time comparison on an already-asynchronous message boundary. Still measured, because it is on the IPC path, which the gate names. | No IPC handler timing exists in `docs/PERF-AUDIT.md` or `bench/BASELINE.md`. The expectation is stated as an expectation, not a result. |
| `w2-privacy` logging fix | **Expected neutral to slightly faster** in packaged builds, because the default path stops opening a stream and stops writing to disk. With the scope narrowed on 2026-09-02 this is the whole of the item — no rotation accounting is added here. | `src/main.js` writes to an append-only `debug.log` stream on every `log()` call in packaged builds. No logging measurement exists anywhere in the repository. |
| `diagnostic-log-hardening` | **Expected confined to the opt-in path.** Rotation adds per-write size accounting and periodic rename/truncate; redaction adds per-call string work. Both are unmeasured, and neither runs in a default packaged build, where no file is opened at all. | The default-off behaviour is established by `w2-privacy`; this item only changes what happens once `FOLIA_DIAGNOSTIC_LOG=1` is set. |
| `sign-provenance` (free attestations) | **No runtime cost — CI-only.** Attestations are produced by the release workflow and change nothing the user executes. | The work is confined to `.github/workflows/release.yml`. |
| `w2-f22` | **Close-time only. Measured against a predeclared budget; gate CLOSED.** The work runs on shutdown paths — window close, `Ctrl+Q`, quit, update install — and does not touch the render or open path. It adds a shutdown IPC round trip and an all-tab dirty scan, which the gates name explicitly, so it is benchmarked rather than argued. The gate found a real defect and refused it: the first run reached **22.4936 ms (LF)** and **98.1947 ms (CRLF)** at 25 tabs × 2 MB with every tab edited, against a **16.7 ms** budget fixed beforehand. With the dirty answer maintained at the edit instead of recomputed at the close, the same observations are **1.002 ms** and **1.2792 ms**, and every observation clears the budget across two subsequent runs with 0 failures. | `bench/BASELINE.md`, *The F22 shutdown-approval gate* — method and all three runs; `docs/PERF-AUDIT.md` PERF-10 — the defect and the fix. Matrix 50 KB / 500 KB / 2 MB × 1 / 10 / 25 tabs; bounded to ≤25 tabs and ≤2 MB per tab. The earlier one-fixture characterization (worst p95 3.09 ms, worst sample 3.78 ms) is kept as history in group A and is superseded. |
| CSS normalisation (any sanitizer/theme change) | **Secondary, unmeasured risk.** Per-attribute and per-element CSSOM work on every sanitize; no style-heavy fixture exists to measure it with. | `docs/SECURITY-AUDIT.md` — `style.cssText` round-trip and `new CSSStyleSheet()` + `replaceSync()`. See *Style-heavy fixtures: benchmark CSS normalisation* above. |
| `w2-hygiene` | **Not classified.** | Dead-code removal has no measured effect recorded here. Payload reductions elsewhere in the fork were measured individually; this item has not been. |

The one number this repository *does* have for the security direction is the CSP
work: every directive in the main-window CSP was chosen by a runtime probe that
reported what stopped working (`docs/SECURITY-AUDIT.md`, SEC-09) — a method to
copy for SEC-08, not a performance figure.

---

## Completed recently

Short and pruned deliberately; the permanent record for each of these is in the
audit documents and the commit history.

| Item | Commit | What landed |
|---|---|---|
| F43 follow-up | **`db7b960`** — *Harden Mermaid edit sessions and F43 regression coverage* | Removed fallback source reconstruction; Mermaid edits now **fail closed** on ambiguous or stale state; navigation and placeholder probes made exact and hermetic. Touched `src/renderer.js`, `test/test-mermaid-render.js`, `test/test-render-patch.js`, `test/test-render-security.js`, `scripts/prove-table-fixes.js` (+1,857 / −136). The two open Mermaid **correctness** items in group C (`mermaid-cold-cache-source`, `mermaid-block-identity`) are the remainder of this surface; `perf-mermaid-sweep` is a separate performance question in the same code. |
| F43 / N18 | `1132fc7` | Hardened block-placeholder assembly (per-render nonce tokens, so a decoy placeholder in a code span cannot capture the real diagram) and restored the Mermaid source attribute. |
| `w2-ci`, `w2-docs`, `w2-f23`, `w2-f25` | various, through `a80c813` | The wave-2 checkpoint: security, hygiene, CI and payload work. All four are `w2-release` prerequisites and are **done**. |
| Release 0.4.0 | `eae1429` | The release the register's remaining work builds on top of. Check `package.json` for the version actually on `main`. |

### `reading-improvements` - released 0.7.0 / COMPLETE (2026-10-15)

- [Folia 0.7.0](https://github.com/lostinsea/folia/releases/tag/v0.7.0) is public
  and latest. Exact tagged source:
  [`f2fb46dd2d6366fb7279b39a4ad3df8cb5d5d7ec`](https://github.com/lostinsea/folia/commit/f2fb46dd2d6366fb7279b39a4ad3df8cb5d5d7ec).
  Reviewed feature: `d134e71c80ac7f077a67090b7be4afe5a304555c`.
- [Release run 38848188455](https://github.com/lostinsea/folia/actions/runs/38848188455)
  passed all platform builds, attestations and publication. The tag push started
  it; no duplicate dispatch or tag replacement was used.
- Shipped: remembered closed/TOC/Notes drawer, original sticky table headers,
  persistent visible-owner File Updated notice and 2px dark Mermaid connectors.
  The notice clears on explicit Dismiss, accepted Reload, committed departure
  or affected-document close. Authored diagram styles and light mode remain.
- Astra investigated; independent Sol6.1/high and Luna6/high reviewed design,
  implementation and release preparation. Final reviews have no blocker.
  Luna's nested-header finding is fixed and regression-covered.
- Focused source suite: 50/50. TOC: 30/30; tables: 215/215; theme: 398/398;
  isolation/empty-Prism controls: 40/40. Release-candidate reading/TOC reruns
  pass. R932-R935 are individually exact PROVEN with passing controls.
- Strict built-archive checks pass 414/0 locally and in the Windows release job.
  The downloaded portable has the same executable and archive as the checked
  local package. All shipped source/library/font/asset bytes, extra resources,
  version, production isolation flags and updater repository match.
- Actual local and downloaded Windows payloads each pass 29/29: real process
  drawer restarts, native wheel, table boundaries, normal/split 100/200 zoom,
  current TOC, dark/light authored Mermaid styles and real watcher notice
  lifetime/actions/owner changes. Captures were viewed. Diagnostics stay off.
- Every asset was downloaded and matched by size and SHA256. All three feeds
  match target versions, filenames, sizes and SHA512. All five runnable assets'
  provenance verifies exact source, signer, workflow, tag and run attempt.
  Feeds and blockmaps are digest-checked, not provenance-attested.
- Matched scrolling showed no observed cadence regression on the tested
  Windows/Electron runtime: median frame-p95 +0.2ms normal / +0.1ms split;
  added table callback p95 0.10ms. Settled scrolling has no geometry reads or
  viewer scans. These are local measurements, not a universal FPS guarantee.
- The old Mermaid harness still fails before its first assertion on unchanged
  main and candidate. Ordinary CI's tab harness stops at 33/34 with an undefined
  legacy renderer IPC `invoke`; no full ordinary-CI-green claim is made.
  Existing P2 follow-ups remain deferred; production isolation is not weakened.
- Windows/macOS remain unsigned; macOS automatic updates retain their signature
  limitation. Linux/macOS artifacts were built and verified, not live-UI tested
  on this Windows PC. No app was installed or updated.
- Evidence: `release-070-*` logs/JSON/downloads in session `b0dbcd9e` artifacts;
  viewed captures in `tmp/release-070-local-r1` and
  `tmp/release-070-published-ui-r1`. Initial verifier-initialization failures
  are retained; both passed serial retries. Previous worktrees, the running
  installed app and private evidence stayed untouched. No force push,
  protection bypass or global credential change was used.

### `left-toc-tracking` — released 0.6.0 · COMPLETE

- Owner and sole register writer: the isolated `folia-left-toc-tracking` stream. Feature: `85c1183f3a2ea325046bb5740ad0f34bc6f09f1a`. Normal main integration and tag `v0.6.0`: [`0030b720961c8925d985e48e6e211d5d8da1f348`](https://github.com/lostinsea/folia/commit/0030b720961c8925d985e48e6e211d5d8da1f348).
- [Folia 0.6.0 is published](https://github.com/lostinsea/folia/releases/tag/v0.6.0). The [release workflow](https://github.com/lostinsea/folia/actions/runs/38777442670) passed all builds, provenance and publication. The tag push started it; no duplicate dispatch was made. Reviewed release notes are present.
- Shipped: left TOC, H1-H6 current-section tracking and the user-approved one-at-a-time TOC/All Notes drawer. Investigation, separate PoC, independent Sol/Luna design/change reviews, exact revert proofs and viewed UI are complete. Feature evidence remains TOC 30/30, themes 398/398, tables 215/215 and focused isolation/empty-Prism controls 40/40.
- Strict built-archive packaging passed 414/414 locally and in the actual Windows release job. The local unpacked app and downloaded portable each passed 23/23 production-path checks, including 48 H1-H6 samples across normal/split view at 100/200%, skipped levels, long H6 sections, clicks, drawers, tabs/reload and narrow layout. Node-off, context isolation, sandboxing, the fixed-method bridge and every packaged product-source hash were verified. Each app's three captures were viewed.
- Every published asset was downloaded; sizes and GitHub SHA-256 digests match. All three update feeds match their published target names, versions, sizes and SHA-512 digests. All five binaries' provenance verifies against the exact source commit, tag, signer workflow and hosted release run. Feeds/blockmaps are digest-checked, not provenance-attested. A tag name is not inherently immutable; verification pins the commit.
- Evidence remains in this feature session: `release-060-strict-packaging.log`, `release-060-local-r5/`, `release-060-published-r2/` and `release-060-downloads/`. Failed harness attempts and transient verifier-initialization failures are retained; the two verifier failures passed serial retries. No dependency or product-source changes were needed after the reviewed feature, and documentation-only updates did not rebuild the app.
- Scrolling scope remains measured, not universal: frame p95 was about 31.3ms before/after on the tested runtime, with added CPU/style work. The final 1,001-heading split initial callback reached 26.3ms; the earlier 27.1ms observation remains. These are callback timings, not total opening time. High-refresh displays and unobserved CSS animation remain unverified. See `docs/PERF-AUDIT.md`, "Left TOC tracking", for the full method and limits.
- Windows/macOS builds remain unsigned; macOS automatic updates retain the signature-validation limitation. Linux/macOS binaries were built, downloaded and provenance-verified, not launched on this Windows PC. Existing P2 deferrals and known render-patch baseline failures remain unchanged; no full ordinary-CI-green claim is made.
- Nothing was installed or updated on this PC. Primary checkouts, the running installed app and previous release evidence were not changed. No force push, protection bypass or global credential change was used.

---

## Open work tracked elsewhere

Work that is documented as open in the tree but has **no tracker ID**, and is
therefore not one of the 24 items above. It is listed so the register's boundary
is explicit rather than implicit. Give any of these an ID and promote it to a
group above if it is picked up.

| Work | Where it is recorded | Status there |
|---|---|---|
| The partial-reuse removal path — many removals *with* some reuse — is unmeasured and likely still quadratic; the 5 MB leg remains super-linear, and the render-cost guard covers it rather than a fix. | `docs/PERF-AUDIT.md`, "Still open". It was also the first bullet of `README.md`'s old *Planned next* list, which now links here instead — so this document is the only place it is still visible outside the audit. | Open, unmeasured. |

## Where the permanent detail lives

This register is intentionally thin on background. When an entry above is not
enough:

| Document | What it holds |
|---|---|
| `docs/SECURITY-AUDIT.md` | Every SEC finding, its evidence, its fix, and its deliberate deferrals. |
| `docs/PERF-AUDIT.md` | The PERF findings, the measurement methodology, and the fixtures. |
| `bench/BASELINE.md` | Every benchmark measurement with the method used to get it. |
| `docs/CUSTOMIZATIONS.md` | What the fork changed and why, so an upstream merge cannot silently undo it. |
| `.github/copilot-instructions.md` | How work is done here: the mandatory model-role assignment in summary, test discipline, the traps, the conventions. |
| `docs/BUILD.md`, `docs/RELEASE.md` | Build, signing and release procedure. |
