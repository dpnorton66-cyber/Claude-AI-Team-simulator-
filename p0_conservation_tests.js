const { simulate, run, DEFAULTS } = require('./ai_team_model_engine.js');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? ' -- ' + detail : '')); }
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

console.log('=== 1. Conservation holds across a wide range of scenarios, not just defaults ===');
const scenarios = [
  ['defaults', {}],
  ['AI generation off', { aiShare: 0 }], // aiShare:0 only disables AI-written code; AI review and repair remain active in this arm, so this is not a full "AI off" scenario
  ['AI heavy', { aiShare: 1.0, codingGain: 0.6, newWorkShare: 1 }],
  ['deep cut', { staffingEvents: [{ week: 10, change: -6 }] }],
  ['growth', { staffingEvents: [{ week: 10, change: 6 }] }],
  ['burnout attrition', { staffingEvents: [{ week: 5, change: -8 }], burnoutAttrition: true }],
  ['demand step up', { demandStepWeek: 10, demandStepSize: 1.0 }],
  ['demand step down', { demandStepWeek: 10, demandStepSize: -0.5 }],
  ['demand multiplier high', { demandMultiplier: 1.8 }],
  ['induced demand on', { newWorkShare: 1.0 }],
  ['zero review budget', { reviewAllowance: 0 }],
  ['zero people edge', { startingTeamSize: 1, staffingEvents: [{ week: 5, change: -1 }] }],
  ['learning off (switch)', { learningOn: false }],
  ['learning strength 10', { learningStrength: 10 }],
  ['capability regression', { codingGain: 0.3, aiStepWeek: 10, aiStepSize: -0.5 }],
  ['capability upgrade from negative gain', { codingGain: -0.15, aiStepWeek: 10, aiStepSize: 0.4 }],
  ['min review depth full', { minReviewDepth: 1.2 }],
  ['high false positives', { falseAlertDensity: 1.2 }],
];
let worstWork = 0, worstDefG = 0, worstDefS = 0;
scenarios.forEach(([name, cfg]) => {
  [false, true].forEach(noAIFlag => {
    const s = simulate(cfg, { noAI: noAIFlag });
    const label = name + (noAIFlag ? ' [noAI arm]' : ' [AI arm]');
    const okWork = s.summary.maxWorkBalance < 1e-6;
    const okDefG = s.summary.maxDefectBalanceG < 1e-6;
    const okDefS = s.summary.maxDefectBalanceS < 1e-6;
    const okNonNeg = s.series.demandBacklog.every(v => v >= -1e-9) && s.series.queue.every(v => v >= -1e-9)
      && s.series.pendingUndetected.every(v => v >= -1e-9) && s.series.pendingKnown.every(v => v >= -1e-9)
      && s.series.prodLatent.every(v => v >= -1e-9) && s.series.prodKnown.every(v => v >= -1e-9);
    check('conservation + non-negativity: ' + label, okWork && okDefG && okDefS && okNonNeg,
      'work=' + s.summary.maxWorkBalance.toExponential(1) + ' defG=' + s.summary.maxDefectBalanceG.toExponential(1) + ' defS=' + s.summary.maxDefectBalanceS.toExponential(1));
    worstWork = Math.max(worstWork, s.summary.maxWorkBalance);
    worstDefG = Math.max(worstDefG, s.summary.maxDefectBalanceG);
    worstDefS = Math.max(worstDefS, s.summary.maxDefectBalanceS);
  });
});
console.log('worst work balance across all scenarios:', worstWork.toExponential(2));
console.log('worst defect balance G across all scenarios:', worstDefG.toExponential(2));
console.log('worst defect balance S across all scenarios:', worstDefS.toExponential(2));

console.log('\n=== 2. Boundary and acceptance behaviour checks ===');
{
  const s = simulate({ startingTeamSize: 1, staffingEvents: [{ week: 2, change: -0 }], reviewAllowance: 0 }).series;
  // approximate "no people" by driving team toward the floor and zero review capacity
}
{
  // zero review capacity: work should queue, not vanish or release
  const s = simulate({ reviewAllowance: 0, familiarityTime: 0 });
  check('zero review budget -> throughput is zero', s.summary.finalThroughput < 0.01, 'thr=' + s.summary.finalThroughput.toFixed(3));
  check('zero review budget -> queue does not drain to nothing while backlog exists', s.summary.demandBacklog > 0 || s.series.queue[s.series.queue.length - 1] > 0);
}
{
  // sustained demand above capacity: backlog should grow, not vanish
  const s = simulate({ demandMultiplier: 1.8, newWorkShare: 0 }).series;
  const early = s.demandBacklog[10], late = s.demandBacklog[50];
  check('sustained demand above capacity -> backlog grows over the run', late > early, 'wk10=' + early.toFixed(2) + ' wk50=' + late.toFixed(2));
}
{
  // demand below capacity: backlog should drain toward a low steady level
  const s = simulate({ demandMultiplier: 0.5 }).series;
  const early = s.demandBacklog[4], late = s.demandBacklog[50];
  check('demand below capacity -> backlog drains from its starting level', late <= early + 0.05, 'wk4=' + early.toFixed(2) + ' wk50=' + late.toFixed(2));
}
{
  // a short demand pulse should leave residual backlog after it ends, not vanish instantly
  const s = simulate({ demandStepWeek: 20, demandStepSize: 1.0 }).series;
  // find backlog right at the step and a few weeks after
  const atStep = s.demandBacklog[20], soon = s.demandBacklog[21], later = s.demandBacklog[26];
  check('a demand step leaves residual backlog for several weeks, not an instant absorb', soon >= atStep * 0.5,
    'wk20=' + atStep.toFixed(2) + ' wk21=' + soon.toFixed(2) + ' wk26=' + later.toFixed(2));
}
{
  // detection with zero detectors should leave issues present, not erase them
  const s = simulate({ aiRecall: 0, aiRecallSecurity: 0, aiReviewCoverage: 0, testRecall: 0, humanRecallCeiling: 0 }).summary;
  check('zero detection -> defects still exist at release (not erased)', s.productionIssues > 0, 'prodIssues=' + s.productionIssues.toFixed(2));
}
{
  // zero successful repair: detected issues should pile up as a known-but-unrepaired backlog
  const s = simulate({ aiRepairShare: 0, aiRepairShareSecurity: 0, humanRepairGeneral: 1e6, humanRepairSecurity: 1e6, verifyHours: 1e6 }).series;
  const knownLate = s.pendingKnown[s.pendingKnown.length - 1] + s.prodKnown[s.prodKnown.length - 1];
  check('zero repair capacity -> a known-but-unrepaired backlog accumulates', knownLate > 0.01, 'known=' + knownLate.toFixed(2));
}

console.log('\n=== 3. Capability shock: additive, not multiplicative ===');
{
  const a0 = simulate({ codingGain: -0.1 }, {}).summary.finalThroughput;
  const a1 = simulate({ codingGain: -0.1, aiStepWeek: 5, aiStepSize: 0.3, newWorkShare: 1 }, {}).summary.finalThroughput;
  const b0 = simulate({ codingGain: -0.1, newWorkShare: 1 }).summary.finalThroughput;
  const b1 = simulate({ codingGain: -0.1, newWorkShare: 1, aiStepWeek: 5, aiStepSize: 0.3 }).summary.finalThroughput;
  check('a positive capability shock never makes a negative gain worse', b1 >= b0 - 0.01, 'before=' + b0.toFixed(2) + ' after=' + b1.toFixed(2));
}
{
  const c0 = simulate({ codingGain: 0, newWorkShare: 1 }).summary.finalThroughput;
  const c1 = simulate({ codingGain: 0, newWorkShare: 1, aiStepWeek: 5, aiStepSize: 0.3 }).summary.finalThroughput;
  check('a positive capability shock genuinely helps even when the base gain is exactly zero', c1 > c0 + 0.01, 'before=' + c0.toFixed(2) + ' after=' + c1.toFixed(2));
}

console.log('\n=== 4. Learning-off switch actually freezes learning ===');
{
  const on = simulate({ learningOn: true }).summary.learning;
  const off = simulate({ learningOn: false }).summary.learning;
  check('learningOn=false freezes learning at its starting value (0)', off === 0, 'on=' + on.toFixed(3) + ' off=' + off.toFixed(3));
  check('learningStrength=0 (slow) is not the same as learningOn=false (off)', simulate({ learningStrength: 0 }).summary.learning > 0);
}

console.log('\n=== 5. Timestep sensitivity, checked across the whole trajectory, not just week 52 ===');
{
  const cfgs = [
    ['reference', {}],
    ['deep cut', { staffingEvents: [{ week: 10, change: -6 }] }],
    ['demand shock', { demandStepWeek: 15, demandStepSize: 1.0 }],
  ];
  cfgs.forEach(([name, cfg]) => {
    const a = simulate(Object.assign({ dt: 0.125 }, cfg)).series;
    const b = simulate(Object.assign({ dt: 0.0625 }, cfg)).series;
    const c = simulate(Object.assign({ dt: 0.03125 }, cfg)).series;
    let maxDiff125to0625 = 0, maxDiff0625to03125 = 0;
    for (let w = 0; w < a.throughput.length; w++) {
      const base = Math.max(0.5, Math.abs(a.throughput[w]));
      maxDiff125to0625 = Math.max(maxDiff125to0625, Math.abs(a.throughput[w] - b.throughput[w]) / base);
      maxDiff0625to03125 = Math.max(maxDiff0625to03125, Math.abs(b.throughput[w] - c.throughput[w]) / base);
    }
    check('timestep 0.125 vs 0.0625 stays under 2% at every week, not just week 52: ' + name, maxDiff125to0625 < 0.02, 'max=' + (maxDiff125to0625 * 100).toFixed(2) + '%');
    check('timestep 0.0625 vs 0.03125 stays under 2% at every week: ' + name, maxDiff0625to03125 < 0.02, 'max=' + (maxDiff0625to03125 * 100).toFixed(2) + '%');
  });
}

console.log('\n=== 6. Recovery: does the backlog actually turn around once capacity returns? ===');
{
  // A permanent, sustained excess of demand over capacity SHOULD grow the backlog
  // without bound -- that is correct queueing behaviour, not a defect. Assert that
  // directly, rather than expecting an artificial plateau.
  const s = simulate({ demandStepWeek: 10, demandStepSize: 0.8, newWorkShare: 0 }).series;
  const late1 = s.demandBacklog[35], late2 = s.demandBacklog[52];
  check('a permanent, sustained demand excess keeps growing the backlog rather than plateauing (correct queueing behaviour)',
    late2 > late1 * 1.05, 'wk35=' + late1.toFixed(2) + ' wk52=' + late2.toFixed(2));
}
{
  // The actual recovery test the review asks for: cut staffing, let backlog build,
  // restore staffing, and check the backlog turns around and starts draining.
  const s = simulate({ staffingEvents: [{ week: 10, change: -6 }, { week: 30, change: 6 }] }).series;
  const peak = Math.max(...s.demandBacklog.slice(0, 45));
  const peakWeek = s.demandBacklog.indexOf(peak);
  const final = s.demandBacklog[52];
  check('after a cut is reversed, the backlog peaks and then declines rather than growing forever',
    peakWeek < 52 && final < peak, 'peak=' + peak.toFixed(2) + ' at wk' + peakWeek + ', wk52=' + final.toFixed(2));
}

console.log('\n============================');
console.log(pass + ' passed, ' + fail + ' failed, out of ' + (pass + fail));
if (fails.length) {
  console.log('\nFAILED CHECKS:');
  fails.forEach(f => console.log(' - ' + f));
}

process.exit(fail > 0 ? 1 : 0);
