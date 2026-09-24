// F01 regression test: engineering hours must never be over-allocated.
// This instruments the real engine (no fixture, no seeded state) and checks
// EVERY integration step, not sampled weeks, across a wide scenario sweep,
// including the exact case (growth) the validation report named specifically.

const fs = require('fs');
const path = require('path');
const ENGINE_FILE = 'ai_team_model_engine.js';
const src = fs.readFileSync(path.join(__dirname, ENGINE_FILE), 'utf8');
const marker = '// --- conservation diagnostics';
const idx = src.indexOf(marker);
if (idx < 0) throw new Error('marker not found -- engine.js structure changed, update this test');
const hook = `
    global.__overspends = global.__overspends || [];
    const __used = devHoursUsed + reviewHoursUsed + repairHoursUsed + prodRepairHours + feedbackHours;
    if (__used > productive + 1e-6) global.__overspends.push({t, available: productive, allocated: __used, excess: __used - productive});
`;
const patched = src.slice(0, idx) + hook + src.slice(idx);
fs.writeFileSync(path.join(__dirname, '_f01_instrumented.js'), patched);
const { simulate } = require('./_f01_instrumented.js');

const scenarios = [
  ['defaults', {}],
  ['deep cut', { staffingEvents: [{ week: 10, change: -6 }] }],
  ['growth', { staffingEvents: [{ week: 10, change: 6 }] }],
  ['growth, large', { staffingEvents: [{ week: 5, change: 15 }] }],
  ['burnout attrition + deep cut', { staffingEvents: [{ week: 5, change: -8 }], burnoutAttrition: true }],
  ['demand step up', { demandStepWeek: 10, demandStepSize: 1.0 }],
  ['demand step down', { demandStepWeek: 10, demandStepSize: -0.5 }],
  ['induced demand on', { newWorkShare: 1.0 }],
  ['induced demand on + growth', { newWorkShare: 1.0, staffingEvents: [{ week: 5, change: 10 }] }],
  ['zero review budget', { reviewAllowance: 0 }],
  ['high AI, learning on', { aiShare: 1.0, learningStrength: 10, aiReviewCoverage: 1.0 }],
  ['capability upgrade', { aiStepWeek: 10, aiStepSize: 0.5 }],
  ['min review depth full', { minReviewDepth: 1.2 }],
  ['production repair reserve high', { productionRepairReserve: 40 }],
  ['high false positives', { falseAlertDensity: 1.2 } ],
  ['tiny team', { startingTeamSize: 2 } ],
  ['large team', { startingTeamSize: 30 } ],
];

let anyFail = false;
scenarios.forEach(([name, cfg]) => {
  [false, true].forEach(noAI => {
    global.__overspends = [];
    simulate(cfg, { noAI });
    const bad = global.__overspends;
    const label = name + (noAI ? ' [noAI]' : ' [AI]');
    if (bad.length) {
      anyFail = true;
      console.log('FAIL ' + label + ': ' + bad.length + ' overspending step(s), worst excess ' +
        Math.max(...bad.map(b => b.excess)).toFixed(4) + ' hours at t=' + bad.find(b => b.excess === Math.max(...bad.map(x => x.excess))).t.toFixed(3));
    } else {
      console.log('PASS ' + label + ': no step exceeds available hours');
    }
  });
});

console.log('\n' + (anyFail ? 'RESULT: FAIL -- at least one scenario overspends hours' : 'RESULT: PASS -- no overspend in any of ' + scenarios.length * 2 + ' scenario/arm combinations'));
process.exit(anyFail ? 1 : 0);
