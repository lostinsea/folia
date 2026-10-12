"use strict";
const assert = require("node:assert/strict");

const POLICY = Object.freeze({
  id: "sec08-balanced-worker-pairs-v1",
  baselineRevision: "790c1bc9267f4b794700a8eede506bb48e8be189",
  pairsPerCell: 8,
  samplesPerWorkerOperation: 21,
  cells: ["50k-1", "50k-10", "50k-25", "500k-1", "500k-10", "500k-25", "2m-1", "2m-10", "2m-25"],
  seeds: { aa: 0x51c08001, ab: 0x51c08002 },
  workersPerPhase: 144,
  phaseDeadlineMs: 90 * 60 * 1000,
  phasesMaximum: 2,
  aaOutput: "aa-01",
  abOutput: "ab-01",
  originalTwoMsObjective: "Explicit nonblocking objective under this prospectively revised policy; NOT the old prerequisite satisfied.",
  estimand: "Median paired material margin of empirical rank-11/rank-20 worker statistics under an equally weighted AB/BA fixed 21-observation regime. NOT population p95, mean worker p95 or rare-regression guarantee.",
  assumptions: [
    "Independent outcomes across the eight pairs of each endpoint; dependence within each pair and between endpoints is allowed.",
    "Stationary pair distributions within each orientation; AB and BA may differ, target is their equal-weight mixture.",
    "Fixed outcome-independent balanced schedule, fixed source/workload/endpoint, no known invalidating disturbance or carryover.",
    "Fresh profiles/ordinary cleanup/order balance support but do not prove independence or stationarity.",
  ],
  oneSidedMedianCoverage: 1 - 2 ** -8,
  twoSidedMedianCoverage: 1 - 2 * 2 ** -8,
  globalFalseAllPassBoundConditional: 2 ** -8,
  jointAAABFalseCertificationBoundConditional: 2 * 2 ** -8,
  intervalCoverageIsNotSimultaneous: true,
  stop: "First invalid/missing worker, native/setup/ownership/deadline failure, known assumption violation, or irreversible observed material veto; no replacement, extension or selective rerun. No early success.",
});

function schedule(mode) {
  assert(["aa", "ab"].includes(mode), "invalid phase mode");
  let state = POLICY.seeds[mode];
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const shuffled = (input) => {
    const values = [...input];
    for (let i = values.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  };
  const orientations = Object.fromEntries(POLICY.cells.map((cell) =>
    [cell, shuffled(["AB", "BA", "AB", "BA", "AB", "BA", "AB", "BA"])]));
  const result = [];
  for (let round = 1; round <= POLICY.pairsPerCell; round++) {
    for (const cell of shuffled(POLICY.cells)) {
      const separator = cell.lastIndexOf("-");
      result.push({
        round, cell, size: cell.slice(0, separator), tabCount: Number(cell.slice(separator + 1)),
        order: [...orientations[cell][round - 1]],
      });
    }
  }
  return result;
}

function percentile(values, fraction) {
  assert(values.length > 0 && values.every((v) => Number.isFinite(v) && v > 0), "invalid timing values");
  assert(fraction > 0 && fraction <= 1, "invalid quantile");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function materialMargin(operation, quantile, a, b) {
  assert(["changed", "unchanged"].includes(operation) && ["p50", "p95"].includes(quantile));
  assert(Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0, "invalid quantile inputs");
  const absolute = operation === "changed" ? 25 : quantile === "p50" ? 2 : 5;
  const difference = b - a;
  // Preserve the original percentage evaluation order at strict binary boundaries.
  const regular = Math.min(difference - absolute, (difference / a * 100 - 10) * (a / 100));
  if (operation !== "unchanged" || quantile !== "p95") return regular;
  const crossing = a <= 16.7 ? Math.min(b - 16.7, b - a - 2) : 0;
  return Math.max(regular, crossing);
}

function summary(values) {
  return {
    raw: [...values], p50: percentile(values, .5), p95: percentile(values, .95),
    min: Math.min(...values), max: Math.max(...values),
  };
}

function compactWorker(launch, pair, mode) {
  const p = launch.payload;
  assert(launch.exitCode === 0 && launch.signal === null && p.ok === true, "invalid native worker");
  assert(p.variant === launch.variant && ["A", "B"].includes(p.variant));
  const expectedSource = mode === "aa" || p.variant === "A" ? "baseline" : "candidate";
  assert(p.sourceVariant === expectedSource, "wrong source arm");
  assert(p.snapshotReadMode === (expectedSource === "baseline" ? "renderer-baseline" : "logical-fd-pinned"));
  assert(p.diagnosticRecords.length === 42, "missing leg records");
  const samples = {};
  const summaries = {};
  for (const operation of ["changed", "unchanged"]) {
    const values = p.samples[operation];
    assert(values.length === 21, "missing worker samples");
    samples[operation] = values.map((s, i) => {
      assert(s.repetition === i + 1 && s.tabIndex === i % pair.tabCount + 1, "wrong sample sequence");
      assert(s.headingVisible === true && s.witness.completionCalls.length === 1 &&
        s.witness.completionCalls[0].accepted === true, "invalid endpoint/completion");
      const records = p.diagnosticRecords.filter((r) => r.operation === operation && r.repetition === s.repetition);
      assert(records.length === 1, "missing/duplicate leg");
      const r = records[0];
      assert(r.status === "exact-witness-complete-instrumented" &&
        r.timed.elapsedMs === s.elapsedMs && r.filePath === s.activeTitle &&
        r.heading === s.expectedHeading && r.setup.outsideHeadingTimer === true, "invalid leg witness");
      assert(r.setup.directFixtureWrites === (operation === "changed" ? 1 : 0) && r.setup.timestampSetters === 0);
      assert(r.setup.control.completion.accepted === true &&
        r.setup.control.resumed.length === 1 && r.setup.control.paused.length === 0);
      assert.deepEqual(r.assertedWitness, r.expectedWitness);
      assert.deepEqual(r.assertedAdoption, r.expectedAdoption);
      return { repetition: s.repetition, tabIndex: s.tabIndex, elapsedMs: s.elapsedMs };
    });
    summaries[operation] = summary(samples[operation].map((s) => s.elapsedMs));
  }
  return {
    label: launch.label, variant: launch.variant, fixture: pair.cell, round: pair.round,
    orientation: pair.order.join(""), sourceVariant: p.sourceVariant, snapshotReadMode: p.snapshotReadMode,
    electron: p.electron, chrome: p.chrome, nativeExitCode: launch.exitCode, signal: launch.signal,
    pid: launch.pid, elapsedMs: launch.elapsedMs, samples, summaries,
  };
}

function comparePair(A, B, mode) {
  assert(A.variant === "A" && B.variant === "B" && A.fixture === B.fixture && A.round === B.round);
  const endpoints = {};
  for (const operation of ["changed", "unchanged"]) {
    for (const quantile of ["p50", "p95"]) {
      const a = A.summaries[operation][quantile], b = B.summaries[operation][quantile];
      const forward = materialMargin(operation, quantile, a, b);
      const reverse = materialMargin(operation, quantile, b, a);
      endpoints[`${operation}-${quantile}`] = {
        A: a, B: b, deltaMs: b - a, percent: (b - a) / a * 100,
        forwardMarginMs: forward, reverseMarginMs: reverse,
        decisionMarginMs: mode === "aa" ? Math.max(forward, reverse) : forward,
      };
    }
  }
  return { round: A.round, cell: A.fixture, orientation: A.orientation, endpoints };
}

function analyze(launches, mode) {
  assert(["aa", "ab"].includes(mode));
  assert(launches.length === POLICY.workersPerPhase, "incomplete phase");
  const expected = schedule(mode).flatMap((pair) =>
    pair.order.map((variant) => ({ round: pair.round, fixture: pair.cell, orientation: pair.order.join(""), variant })));
  for (let i = 0; i < launches.length; i++) {
    for (const [key, value] of Object.entries(expected[i])) assert.equal(launches[i][key], value, "wrong phase schedule");
    assert.equal(launches[i].nativeExitCode, 0);
    assert.equal(launches[i].signal, null);
    assert.equal(launches[i].sourceVariant, mode === "aa" || launches[i].variant === "A" ? "baseline" : "candidate");
    assert.equal(launches[i].snapshotReadMode,
      launches[i].sourceVariant === "baseline" ? "renderer-baseline" : "logical-fd-pinned");
    for (const operation of ["changed", "unchanged"]) {
      const values = launches[i].samples[operation];
      assert.equal(values.length, 21);
      for (let j = 0; j < values.length; j++) {
        assert.equal(values[j].repetition, j + 1);
        assert.equal(values[j].tabIndex, j % Number(launches[i].fixture.split("-").at(-1)) + 1);
      }
      assert.deepEqual(launches[i].summaries[operation], summary(values.map((s) => s.elapsedMs)));
    }
  }
  const cells = {};
  let certified = true, twoMsObjectiveMet = true;
  for (const cell of POLICY.cells) {
    const workers = launches.filter((l) => l.fixture === cell);
    const pairs = Array.from({ length: 8 }, (_, i) => {
      const group = workers.filter((l) => l.round === i + 1);
      assert.equal(group.length, 2);
      return comparePair(group.find((l) => l.variant === "A"), group.find((l) => l.variant === "B"), mode);
    });
    const endpoints = {};
    for (const operation of ["changed", "unchanged"]) {
      for (const quantile of ["p50", "p95"]) {
        const key = `${operation}-${quantile}`;
        const margins = pairs.map((p) => p.endpoints[key].decisionMarginMs);
        const upper = Math.max(...margins);
        const lower = Math.min(...margins);
        const pooled = Object.fromEntries(["A", "B"].map((variant) => [variant,
          summary(workers.filter((w) => w.variant === variant)
            .flatMap((w) => w.samples[operation].map((s) => s.elapsedMs)))]));
        const forward = materialMargin(operation, quantile, pooled.A[quantile], pooled.B[quantile]);
        const reverse = materialMargin(operation, quantile, pooled.B[quantile], pooled.A[quantile]);
        const pooledDecision = mode === "aa" ? Math.max(forward, reverse) : forward;
        const passed = upper <= 0 && pooledDecision <= 0;
        certified &&= passed;
        endpoints[key] = {
          pairedMarginsMs: margins, medianMarginIntervalMs: [lower, upper],
          individualTwoSidedCoverageConditional: POLICY.twoSidedMedianCoverage,
          notSimultaneousCoverage: true, passed, pooledDecisionMarginMs: pooledDecision,
          pooledAuditOnlyNotIIDInference: pooled,
        };
      }
    }
    const absoluteP95 = pairs.map((p) => Math.abs(p.endpoints["unchanged-p95"].deltaMs));
    const objectiveMet = Math.max(...absoluteP95) <= 2;
    twoMsObjectiveMet &&= objectiveMet;
    cells[cell] = {
      pairs, endpoints,
      originalTwoMsObjective: { absoluteUnchangedP95DifferencesMs: absoluteP95, worstMs: Math.max(...absoluteP95),
        met: objectiveMet, blocking: false, typicalAbsoluteMarginUpperMs: Math.max(...absoluteP95) - 2 },
    };
  }
  return {
    status: mode === "aa"
      ? certified
        ? twoMsObjectiveMet ? "AA_MATERIAL_QUALIFIED_ORIGINAL_2MS_OBJECTIVE_MET"
          : "AA_MATERIAL_QUALIFIED_ORIGINAL_2MS_OBJECTIVE_NOT_MET_NOT_A_2MS_PRECISION_CERTIFICATE"
        : "AA_NOT_QUALIFIED_OBSERVED_MATERIAL_GUARD_BREACH"
      : certified ? "AB_TYPICAL_PAIRED_EMPIRICAL_QUANTILE_NONREGRESSION_CERTIFIED_NOT_POPULATION_P95"
        : "AB_NOT_CERTIFIED_OBSERVED_MATERIAL_GUARD_BREACH",
    mode, qualified: certified, originalTwoMsObjectiveMet: mode === "aa" ? twoMsObjectiveMet : null,
    certificateScope: POLICY.estimand, assumptions: POLICY.assumptions,
    globalFalseAllPassBoundConditional: POLICY.globalFalseAllPassBoundConditional,
    statisticalProofOfRegressionWhenFailed: false, cells,
  };
}

module.exports = { POLICY, schedule, percentile, materialMargin, summary, compactWorker, comparePair, analyze };
