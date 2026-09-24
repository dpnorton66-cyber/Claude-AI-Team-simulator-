const ENGINE_FILE = 'ai_team_model_engine.js';
const fs = require('fs');
const path = require('path');
const { simulate } = require(path.join(__dirname, ENGINE_FILE));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

console.log('=== F02: detection tied to actual review capacity, not a hypothetical depth ===');
{
  // seed a pending pool directly, matching the validation report's fixture method;
  // also seed the matching cumulative-introduced total so conservation checks over
  // this fixture are meaningful, not just the raw stock.
  const src = fs.readFileSync(path.join(__dirname, ENGINE_FILE), 'utf8');
  const seeded = src
    .replace('let pendingUndetectedG = 0, pendingUndetectedS = 0;', 'let pendingUndetectedG = 10, pendingUndetectedS = 10;')
    .replace('let cumIntroducedG = 0, cumIntroducedS = 0;', 'let cumIntroducedG = 10, cumIntroducedS = 10;');
  fs.writeFileSync(path.join(__dirname, '_f02_seeded.js'), seeded);
  const { simulate: simSeeded } = require(path.join(__dirname, '_f02_seeded.js'));

  // the previous version of this assertion checked index 0, which after the F05
  // fix is the untouched initial state -- it could never fail even if detection
  // still fired for free, because nothing has integrated yet at that index. Check
  // after real integration has happened instead.
  const zero = simSeeded({ reviewAllowance: 0, aiReviewCoverage: 0, testRecall: 0 }, {}).series;
  const zeroDetectedThroughout = zero.pendingKnown.every(v => v === 0);
  check('zero review + zero AI review + zero test recall -> zero detection at every recorded step, not just the untouched start',
    zeroDetectedThroughout && zero.pendingUndetected[zero.pendingUndetected.length - 1] === 20,
    'detected anywhere: ' + !zeroDetectedThroughout + ', final undetected: ' + zero.pendingUndetected.at(-1));

  const some = simSeeded({ reviewAllowance: 4, aiReviewCoverage: 0, testRecall: 0 }, {}).series;
  // pendingKnown can legitimately be 0 here even with active detection: with
  // detection now resolved before repair in the same step (the F02A reorder),
  // whatever is detected can also be repaired or released before this observation
  // point, so an empty known-backlog is not evidence detection failed. Check the
  // undetected pool actually shrank from its seeded value instead -- a direct,
  // unambiguous sign detection is running.
  // the previous version of this assertion checked whether pendingUndetected fell
  // below an absolute threshold, which does not actually prove detection ran:
  // release also removes from the undetected pool, and a report confirmed this
  // exact assertion still passes even with human recall additionally disabled
  // (8.39 < 18, with every detector off). Fixed with a proper negative control:
  // compare detection-on against detection-off directly, in the same fixture, and
  // require detection-on to leave strictly less undetected material behind.
  const allDetectionOff = simSeeded({ reviewAllowance: 4, aiReviewCoverage: 0, testRecall: 0, humanRecallCeiling: 0 }, {}).series;
  check('detection-on leaves less undetected material than an otherwise-identical detection-off negative control',
    some.pendingUndetected[1] < allDetectionOff.pendingUndetected[1],
    'detection-on=' + some.pendingUndetected[1].toFixed(2) + ', detection-off=' + allDetectionOff.pendingUndetected[1].toFixed(2)
    + ' (release alone drains the pool to ' + allDetectionOff.pendingUndetected[1].toFixed(2) + ' regardless of detection)');

  // the actual point of the reorder: repair can now act on issues in the same step
  // they are detected, rather than only from the following step onward. The
  // previous version of this test compared cumEscapes at week 1, which at default
  // dt is eight integration steps, not one -- a report confirmed the OLD ordering
  // also passes that comparison by week 1, since the one-step delay simply
  // averages out over eight steps. Fixed to use a horizon of exactly one step
  // (0.125 weeks), which is the actual claim being tested.
  // dt pinned explicitly, not just horizon: this test's claim is "one integration
  // step", and horizon alone only equals one step for as long as it happens to
  // match whatever the default dt is. Pinning both means a future change to the
  // default timestep can't silently change how many steps this test measures.
  const fixtureBase = { reviewAllowance: 4, aiReviewCoverage: 0, testRecall: 0, horizon: 0.125, dt: 0.125 };
  const withRepair = simSeeded(fixtureBase, {}).summary.cumulativeEscapes;
  const noRepair = simSeeded(Object.assign({}, fixtureBase,
    { aiRepairShare: 0, humanRepairGeneral: 1e6, aiRepairShareSecurity: 0, humanRepairSecurity: 1e6 }), {}).summary.cumulativeEscapes;
  check('repair capacity reduces escapes within exactly one integration step, not averaged over a whole week',
    withRepair < noRepair, 'with repair=' + withRepair.toFixed(4) + ', without repair=' + noRepair.toFixed(4));
}

console.log('\n=== F05: exact time boundaries ===');
{
  const zero = simulate({ horizon: 0 });
  check('a zero-horizon run performs no evolution', zero.series.week.length === 1 && zero.series.week[0] === 0);
  check('a zero-horizon run leaves team size unchanged', zero.series.team[0] === 12);
}
{
  const s = simulate({});
  check('a 52-week run records exactly weeks 0 through 52 (53 points)', s.series.week.length === 53 &&
    s.series.week[0] === 0 && s.series.week[52] === 52);
  check('the true initial condition is recorded, not a post-update value',
    s.series.throughput[0] === 0 && s.series.escapeRate[0] === 0);
}
{
  // releases should now converge essentially exactly across timesteps, since the
  // off-by-one no longer adds an extra fractional week of integration
  const a = simulate({ dt: 0.125 }).summary.cumulativeDelivery;
  const b = simulate({ dt: 0.03125 }).summary.cumulativeDelivery;
  check('cumulative releases converge to within 0.1% across a 4x timestep change',
    Math.abs(a - b) / a < 0.001, 'dt=0.125: ' + a.toFixed(3) + ', dt=0.03125: ' + b.toFixed(3));
}

console.log('\n=== Complete-release regression: defects must transfer with the work that carries them ===');
{
  const fs2 = require('fs');
  const vm = require('vm');
  let src = fs2.readFileSync(path.join(__dirname, ENGINE_FILE), 'utf8');
  for (const [before, after] of [
    ['let demandBacklog = baseDemandRef;', 'let demandBacklog = 0;'],
    ['let pendingUndetectedG = 0, pendingUndetectedS = 0;', 'let pendingUndetectedG = 10, pendingUndetectedS = 0;'],
    ['let cumIntroducedG = 0, cumIntroducedS = 0;', 'let cumIntroducedG = 10, cumIntroducedS = 0;'],
  ]) {
    if (!src.includes(before)) throw new Error('fixture anchor missing: ' + before);
    src = src.replace(before, after);
  }
  const context = { module: { exports: {} } };
  vm.runInNewContext(src, context);
  const result = context.module.exports.simulate({
    horizon: 0.125, queueLimit: 1, reviewAllowance: 10,
    demandMultiplier: 0, humanRecallCeiling: 0, aiReviewCoverage: 0, testRecall: 0,
  }, { noAI: true });
  check('a complete release (100% of queued work) transfers 100% of its defects, not a hazard-based fraction',
    result.series.queue.at(-1) === 0 && result.series.pending.at(-1) === 0 && result.summary.cumulativeEscapes === 10 && result.summary.cumulativeDelivery === 1,
    'queue=' + result.series.queue.at(-1) + ' pending=' + result.series.pending.at(-1) + ' escapes=' + result.summary.cumulativeEscapes + ' delivery=' + result.summary.cumulativeDelivery);
}
{
  // partial release: with reviewAllowance reduced, only a fraction of the queue
  // clears in one step. Defects released should match that same fraction exactly.
  const fs2 = require('fs');
  const vm = require('vm');
  let src = fs2.readFileSync(path.join(__dirname, ENGINE_FILE), 'utf8');
  for (const [before, after] of [
    ['let demandBacklog = baseDemandRef;', 'let demandBacklog = 0;'],
    ['let pendingUndetectedG = 0, pendingUndetectedS = 0;', 'let pendingUndetectedG = 10, pendingUndetectedS = 0;'],
    ['let cumIntroducedG = 0, cumIntroducedS = 0;', 'let cumIntroducedG = 10, cumIntroducedS = 0;'],
  ]) { src = src.replace(before, after); }
  const context = { module: { exports: {} } };
  vm.runInNewContext(src, context);
  const result = context.module.exports.simulate({
    horizon: 0.125, queueLimit: 1, reviewAllowance: 2,
    demandMultiplier: 0, humanRecallCeiling: 0, aiReviewCoverage: 0, testRecall: 0,
  }, { noAI: true });
  const delivery = result.summary.cumulativeDelivery, escapes = result.summary.cumulativeEscapes;
  check('a partial release transfers the same fraction of defects as it does work (linear, not exponential)',
    Math.abs(escapes - delivery * 10) < 1e-6, 'delivery fraction=' + delivery + ', escapes=' + escapes + ', expected=' + (delivery * 10));
}

{
  // small-positive-queue regression: a coarse epsilon guard (0.01) meant only to
  // avoid dividing by zero was itself stranding defects at any queue at or below
  // that threshold, even though real work was still being released from it.
  const fs2 = require('fs');
  const vm = require('vm');
  [1, 0.01, 0.005].forEach(queueLimit => {
    let src = fs2.readFileSync(path.join(__dirname, ENGINE_FILE), 'utf8');
    for (const [before, after] of [
      ['let demandBacklog = baseDemandRef;', 'let demandBacklog = 0;'],
      ['let pendingUndetectedG = 0, pendingUndetectedS = 0;', 'let pendingUndetectedG = 10, pendingUndetectedS = 0;'],
      ['let cumIntroducedG = 0, cumIntroducedS = 0;', 'let cumIntroducedG = 10, cumIntroducedS = 0;'],
    ]) { src = src.replace(before, after); }
    const context = { module: { exports: {} } };
    vm.runInNewContext(src, context);
    const result = context.module.exports.simulate({
      horizon: 0.125, queueLimit, reviewAllowance: 10,
      demandMultiplier: 0, humanRecallCeiling: 0, aiReviewCoverage: 0, testRecall: 0,
    }, { noAI: true });
    check('complete release at queueLimit=' + queueLimit + ' transfers all defects, not stranded by a coarse epsilon',
      result.summary.cumulativeEscapes === 10 && result.series.pending.at(-1) === 0,
      'escapes=' + result.summary.cumulativeEscapes + ' pending=' + result.series.pending.at(-1));
  });
}

console.log('\n=== F03: the no-AI arm must be invariant to every AI-only parameter ===');
{
  const aiOnlyParams = ['aiShare', 'codingGain', 'aiDefectMultiplier', 'selfCheckShare', 'aiReviewCoverage',
    'aiRecall', 'aiRecallSecurity', 'aiRepairShare', 'aiRepairShareSecurity', 'aiStepWeek', 'aiStepSize'];
  const base = simulate({}, { noAI: true }).summary;
  const variants = {
    aiShare: 1, codingGain: 0.6, aiDefectMultiplier: 2.0, selfCheckShare: 0.5, aiReviewCoverage: 1.0,
    aiRecall: 0.8, aiRecallSecurity: 0.8, aiRepairShare: 0.64, aiRepairShareSecurity: 0.5,
    aiStepWeek: 10, aiStepSize: 0.5,
  };
  let anyChanged = [];
  aiOnlyParams.forEach(k => {
    const v = simulate({ [k]: variants[k] }, { noAI: true }).summary;
    const changed = ['finalThroughput', 'cumulativeValue', 'productionIssues', 'securityIssues'].some(
      key => Math.abs(v[key] - base[key]) > 1e-9);
    if (changed) anyChanged.push(k);
  });
  check('changing any AI-only parameter has zero effect on the no-AI arm',
    anyChanged.length === 0, anyChanged.length ? 'still leaking through: ' + anyChanged.join(', ') : '');
}

console.log('\n=== Timestamps: only dt values that evenly divide a week are supported, and validated ===');
{
  // dt values that DO evenly divide one week must still work, and stay monotonic
  const validCases = [[0.25, 1], [0.25, 2], [0.5, 3], [1, 5], [0.2, 1]];
  let allMonotonic = true, worst = null;
  validCases.forEach(([dt, horizon]) => {
    const w = simulate({ dt, horizon }).series.week;
    const ok = w.every((v, i) => i === 0 || v > w[i - 1]);
    if (!ok) { allMonotonic = false; worst = { dt, horizon, week: w }; }
  });
  check('recorded week labels are strictly increasing for every supported (evenly-dividing) dt',
    allMonotonic, worst ? JSON.stringify(worst) : '');

  // dt values that do NOT evenly divide a week must be explicitly rejected, not
  // silently accepted with a mislabelled observation (the previous behaviour: a
  // step ending at 1.2 weeks got copied into the "week 1" row unchanged, which
  // looked like a real week-1 observation but was actually 0.2 weeks later)
  const invalidDts = [0.3, 0.7, 1.5];
  let allRejected = true, notRejected = [];
  invalidDts.forEach(dt => {
    try { simulate({ dt, horizon: 3 }); allRejected = false; notRejected.push(dt); }
    catch (e) { /* expected */ }
  });
  check('a dt that does not evenly divide one week is rejected, not silently mislabelled',
    allRejected, notRejected.length ? 'accepted without error: ' + notRejected.join(', ') : '');
}

console.log('\n=== Robustness: degenerate inputs must not silently produce NaN ===');
{
  const d = simulate({ queueLimit: 0 }).summary.cumulativeDelivery;
  check('queueLimit=0 does not produce NaN', Number.isFinite(d), 'got ' + d);
  const c = require(path.join(__dirname, ENGINE_FILE)).run({ reviewAllowance: 0 }).compare;
  check('an undefined comparison (zero-denominator) returns null, not NaN',
    c.throughputVsControl === null && c.valueVsControl === null,
    JSON.stringify(c));
  const bal = simulate({ discoveryWeeks: 0.01 }).summary.maxDefectBalanceG;
  check('an extreme discoveryWeeks value does not break defect conservation',
    bal < 1e-6, 'max imbalance: ' + bal.toExponential(2) + ' (was ~688.8 before this fix)');
  let rejDW = false; try { simulate({ discoveryWeeks: 0 }); } catch (e) { rejDW = true; }
  check('discoveryWeeks=0 is rejected, not silently productive of non-finite output',
    rejDW, rejDW ? '' : 'accepted zero discovery weeks without error');
  let rejRE = false; try { simulate({ reviewEffort: 0 }); } catch (e) { rejRE = true; }
  check('reviewEffort=0 is rejected, not silently productive of non-finite output',
    rejRE, rejRE ? '' : 'accepted zero review effort without error');
}

console.log('\n=== The exact reproduction from the report: dt=0.3, horizon=1.2 ===');
{
  // this combination previously produced an identical, wrong state copied into
  // both the "week 1" and "week 1.2" rows -- week 1 was never actually integrated
  // to, only 1.2 was, and that later state was mislabelled as the week-1 result.
  // It is now rejected outright, since dt=0.3 does not evenly divide a week.
  let rejected = false, message = '';
  try { simulate({ dt: 0.3, horizon: 1.2 }); } catch (e) { rejected = true; message = e.message; }
  check('the exact dt=0.3/horizon=1.2 case from the report is rejected, not silently mislabelled',
    rejected, rejected ? '' : 'accepted without error, and week 1 would not be the true state at week 1');
}

console.log('\n=== Validation and step-count tolerance must agree with each other ===');
{
  // validateInput's tolerance (1e-6) previously disagreed with the step-count
  // calculation's own epsilon (1e-9 inside a floor), so a horizon that passed
  // validation as "effectively a whole multiple of dt" could still be floored down
  // to one fewer step than validation itself had just judged it to be.
  const r = simulate({ dt: 0.125, horizon: 0.99999999 });
  check('an accepted near-exact horizon integrates the full number of steps validation judged it to have',
    Math.abs(r.series.week.at(-1) - 1) < 1e-6, 'last recorded time=' + r.series.week.at(-1) + ' (was 0.875 before this fix)');
}

console.log('\n=== Broader input validation: finite-and-positive divisors, not just the two originally reported ===');
{
  const cases = [
    ['reviewEffort', Infinity], ['manualEffort', 0], ['onboardingSupport', 0],
    ['onboardingWeeks', -1], ['understandingWeeks', NaN], ['hoursPerCase', 0],
    ['evaluationDelayWeeks', 0], ['casesForStep', -5], ['fatigueBuildWeeks', 0], ['fatigueRecoverWeeks', 0],
  ];
  let notRejected = [];
  cases.forEach(([key, val]) => {
    try { simulate({ [key]: val }); notRejected.push(key + '=' + val); } catch (e) { /* expected */ }
  });
  check('every checked divisor-parameter rejects non-finite, zero or negative values',
    notRejected.length === 0, notRejected.length ? 'accepted without error: ' + notRejected.join(', ') : '');
}

console.log('\n=== V05/V06/V08: staffing, dilution and feedback-overdraw regressions ===');
{
  // V05a: a minimum-headcount floor applied to `experienced` alone could add a
  // phantom person back even when starters already covered the minimum
  const r1 = simulate({ startingTeamSize: 4, staffingEvents: [{ week: 0, change: 6 }, { week: 1, change: -9 }], horizon: 1.125 });
  check('a cut leaving exactly one person does not silently become two',
    r1.summary.finalTeam === 1, 'finalTeam=' + r1.summary.finalTeam);
}
{
  // V05b: team size was recorded using a stale pre-attrition snapshot
  const r2 = simulate({ startingTeamSize: 12, demandMultiplier: 2, burnoutAttrition: true, departureRate: 0.012, horizon: 67 });
  check('reported final team reflects attrition that happened within the same recorded step',
    r2.summary.finalTeam === 6, 'finalTeam=' + r2.summary.finalTeam + ' (was 7 before this fix)');
}
{
  // V06: two ways of describing the same hire must give the identical result
  const single = simulate({ staffingEvents: [{ week: 0, change: 6 }], horizon: 1 }).series.understanding[1];
  const split = simulate({ staffingEvents: [{ week: 0, change: 3 }, { week: 0, change: 3 }], horizon: 1 }).series.understanding[1];
  check('splitting one hire into two same-week events gives an identical result, not a different one',
    single === split, 'single=' + single + ', split=' + split);
}
{
  // V08: feedback evaluation must never draw down more than the queue actually holds
  const src = fs.readFileSync(path.join(__dirname, ENGINE_FILE), 'utf8');
  const seeded = src.replace('let feedbackQ = 0, L = 0;', 'let feedbackQ = 0.1, L = 0;');
  fs.writeFileSync(path.join(__dirname, '_v08_seeded.js'), seeded);
  const { simulate: simV08 } = require(path.join(__dirname, '_v08_seeded.js'));
  const before = simV08({ evaluationDelayWeeks: 0.01, demandMultiplier: 0, horizon: 0.125 }).summary.learning;
  // with the fix, learning from a 0.1-case queue at dt=0.125 must be capped by
  // what 0.1 cases can actually produce, not by the (much larger) rate the short
  // evaluation delay alone would imply
  check('a very short evaluation delay cannot evaluate more feedback cases than the queue holds',
    before < 0.001, 'learning=' + before + ' (was 0.00409 before this fix, from overdrawing the queue)');
}

console.log('\n=== productionRepairReserve: now a genuine cap, not a dead floor ===');
{
  const def = simulate({}).summary;
  const capped = simulate({ productionRepairReserve: 5 }).summary;
  const uncapped = simulate({ productionRepairReserve: 60 }).summary;
  check('the default (60) matches the original default behaviour exactly',
    Math.abs(def.finalThroughput - uncapped.finalThroughput) < 1e-9 && Math.abs(def.productionIssues - uncapped.productionIssues) < 1e-9,
    'default=' + def.productionIssues.toFixed(4) + ', at cap=60: ' + uncapped.productionIssues.toFixed(4));
  check('lowering the cap now produces a real, visible effect on outstanding production issues',
    capped.productionIssues > def.productionIssues * 2,
    'default=' + def.productionIssues.toFixed(2) + ', cap=5: ' + capped.productionIssues.toFixed(2));
}

console.log('\n=== F01: the hours ledger is complete, not just non-overspending ===');
{
  const s = simulate({}).summary;
  check('every named hour category plus idle time sums to exactly the available hours, at week 52',
    s.maxHoursLedgerBalance < 1e-6, 'max imbalance over the run: ' + s.maxHoursLedgerBalance.toExponential(2));
}

console.log('\n=== F02B: human detection must not credit triage time as reading time ===');
{
  const src = fs.readFileSync(path.join(__dirname, ENGINE_FILE), 'utf8');
  const idx = src.indexOf('// --- conservation diagnostics');
  const hook = 'global.__f02b = global.__f02b || []; global.__f02b.push(Math.abs((humanUnitsPerWeekG*hoursPerUnitRead) - (reviewReserved - triage)));\n';
  fs.writeFileSync(path.join(__dirname, '_f02b_instrumented.js'), src.slice(0, idx) + hook + src.slice(idx));
  const { simulate: simF02b } = require(path.join(__dirname, '_f02b_instrumented.js'));
  global.__f02b = [];
  simF02b({ falseAlertDensity: 1.2 });
  const maxGap = Math.max(...global.__f02b);
  check('implied human reading effort never exceeds paid reading effort (reserved minus triage)',
    maxGap < 1e-6, 'max gap across the run: ' + maxGap.toExponential(2));
}

console.log('\n=== F05A: a published week must not mix observations from two different times ===');
{
  const src = fs.readFileSync(path.join(__dirname, ENGINE_FILE), 'utf8');
  const idx = src.indexOf('// --- conservation diagnostics');
  const hook = 'if (Math.abs((t+dt)-1)<1e-9) global.__f05a = throughput;\n';
  fs.writeFileSync(path.join(__dirname, '_f05a_instrumented.js'), src.slice(0, idx) + hook + src.slice(idx));
  const { simulate: simF05a } = require(path.join(__dirname, '_f05a_instrumented.js'));
  global.__f05a = null;
  const s = simF05a({}).series;
  check('the published week-1 row matches the throughput computed by the step that actually reached week 1',
    Math.abs(s.throughput[1] - global.__f05a) < 1e-9, 'published=' + s.throughput[1] + ' actual=' + global.__f05a);
}

console.log('\n=== F05B: horizons that are exact multiples of dt integrate correctly; others are rejected ===');
{
  const short = simulate({ horizon: 0.5 }); // 0.5 / 0.125 = 4, an exact multiple
  check('a sub-week horizon that is an exact multiple of dt reports real work done, not a stale zero',
    short.summary.cumulativeDelivery > 0 && short.summary.finalThroughput > 0,
    'cumDelivery=' + short.summary.cumulativeDelivery.toFixed(2) + ' finalThroughput=' + short.summary.finalThroughput.toFixed(2));
  // horizon:1.1 is NOT a whole multiple of the default dt (1.1/0.125=8.8). The
  // previous version silently stopped at week 1, three-fourths of a step short of
  // what was asked for, with no indication anything had been truncated. It is now
  // rejected outright instead.
  let rejected = false;
  try { simulate({ horizon: 1.1 }); } catch (e) { rejected = true; }
  check('a horizon that is not a whole multiple of dt is rejected, not silently truncated',
    rejected, rejected ? '' : 'accepted a non-exact horizon without error, and would have ended at week 1, not 1.1');
  let rejectedShort = false;
  try { simulate({ horizon: 0.05 }); } catch (e) { rejectedShort = true; }
  check('a horizon shorter than dt is rejected, not silently a no-op',
    rejectedShort, rejectedShort ? '' : 'accepted a sub-dt horizon without error, and would have performed no integration at all');
}

console.log('\n=== F02A: quality-metric convergence -- FAILING ASSERTION, not a disclosure-only log ===');
{
  const a = simulate({ dt: 0.125 }).summary.cumulativeEscapes;
  const b = simulate({ dt: 0.03125 }).summary.cumulativeEscapes;
  const dev = Math.abs(a - b) / a;
  check('cumulative escapes converge to within 1% across a 4x timestep change (STILL OPEN, not closed by this round)',
    dev < 0.01, (dev * 100).toFixed(1) + '% difference -- dt=0.125: ' + a.toFixed(2) + ', dt=0.03125: ' + b.toFixed(2));
}

console.log('\n============================');
console.log(pass + ' passed, ' + fail + ' failed, out of ' + (pass + fail));
process.exit(fail > 0 ? 1 : 0);
