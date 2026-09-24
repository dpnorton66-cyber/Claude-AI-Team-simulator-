"use strict";

// Simulation engine: AI, team size and software delivery. P0 rebuild.
//
// What changed from the previous version, and why (see Model_Improvement_Review):
//  - Demand is a backlog stock, not an instantaneous ceiling on completed work.
//    Unmet demand now persists and accumulates instead of vanishing each step.
//  - Detection and repair are separate flows through separate stocks. A found
//    issue is not treated as fixed until repair capacity actually covers it.
//  - Pre-release and production issue tracking each split into "not yet found"
//    and "found, awaiting repair", matching the four states the review asked
//    for (undetected pre-release, known pre-release, latent production,
//    known production).
//  - The capability-shock ("aiStepSize") is now an additive change to the
//    coding gain, not a multiplier, so it can no longer fail to help (or make
//    things worse) purely because the base gain is zero or negative.
//  - Demand induced by spare capacity is a separate, delayed, capped signal,
//    not folded instantaneously into the same figure as externally set demand.
//  - A genuine learning-off switch (learningOn) is now exposed; learning
//    strength at zero is still labelled "slow", not "off".
//  - Every stock-reducing flow is capped at stock/dt so a step can never
//    remove more than exists.
//  - Work in progress during development is declared instantaneous rather
//    than modelled as its own stock: development capacity converts backlog
//    directly into completed work within a step. This is a stated
//    simplification, not a hidden one, and it is exercised by the timestep
//    test below at three step sizes.
//  - Cancellations are not modelled: baseline demand, once it enters the
//    backlog, is only ever removed by being developed. This is a stated
//    scope limit, not a silent one.

const DEFAULTS = {
  // --- levers: team ---
  startingTeamSize: 12,
  staffingEvents: [],
  burnoutAttrition: false,
  reviewAllowance: 4,            // hours per person per week
  productionRepairReserve: 60,    // hours per week available for production fixes, at MOST -- a ceiling,
                                   // not a floor (default set above typical need so it does not bind
                                   // unless deliberately lowered; see the F01-era note this replaced,
                                   // which was a minimum guarantee that could never actually bind because
                                   // production repair is already first in the allocation priority order
                                   // and typical need sits far below any value that guarantee ever set)
  sustainableHours: 40,          // hours per person per week. Does not feed demand;
                                  // see the note on demandMultiplier below.
  onboardingSupport: 1,
  familiarityTime: 0,
  newWorkShare: 1,                // grade: policy choice, not evidenced. Governs the
                                  // INDUCED demand signal only (see inducedDemandDelayWeeks
                                  // and inducedDemandCap). Off by default.
  demandMultiplier: 1.0,          // sustained scale on baseline demand. Baseline demand is
                                  // fixed in work units per week from team size and the
                                  // review policy alone; it does not move with working
                                  // hours or headcount changes after week 0.
  demandStepWeek: 0,
  demandStepSize: 0,
  inducedDemandDelayWeeks: 4,      // NEW: time for induced demand to catch up to its target
  inducedDemandCap: 1.0,           // NEW: induced demand cannot exceed this multiple of baseline
  queueLimit: 6,
  minReviewDepth: 0,

  // --- levers: AI generation ---
  aiShare: 0.6,
  codingGain: 0.30,
  aiDefectMultiplier: 1.0,
  selfCheckShare: 0.20,

  // --- levers: AI review and test ---
  aiReviewCoverage: 0.5,
  aiRecall: 0.50,
  aiRecallSecurity: 0.40,
  falseAlertDensity: 0.30,
  aiRepairShare: 0.40,
  aiRepairShareSecurity: 0.09,

  // --- levers: learning ---
  learningOn: true,                // NEW: the real off switch. False stops all acquisition
                                    // and all decay -- retained context is frozen, not erased.
  learningStrength: 5,             // 0 is "slow", not "off". Use learningOn for off.
  feedbackTime: 0.5,

  // --- scheduled change in AI capability ---
  aiStepWeek: 0,
  aiStepSize: 0,                   // NEW MEANING: additive change to codingGain (percentage
                                    // points), e.g. 0.1 = +10 points. Previously a multiplier,
                                    // which could not improve a zero or negative gain.
  aiRampWeeks: 8,

  // --- assumptions: capacity ---
  dependencyIntensity: 0.0167,
  coordinationCap: 0.60,
  fatigueHoursLoss: 0.12,
  mentoringHours: 3,
  onboardingWeeks: 13,
  starterStartOutput: 0.30,

  // --- assumptions: work and quality ---
  manualEffort: 20,
  reviewEffort: 4.0,
  aiReviewSaving: 0.25,
  triageHours: 0.25,
  verifyHours: 0.5,
  densityGeneral: 0.66,
  densitySecurity: 0.02,
  humanRepairGeneral: 8.5,
  humanRepairSecurity: 16,
  humanRecallCeiling: 0.85,
  humanRecallHalf: 0.7,
  testRecall: 0.385,
  testCoverage: 1.0,
  discoveryWeeks: 6,
  valuePerUnit: 1.0,
  productionIssueWeight: 0.02,
  securityValueWeight: 3.0,

  // --- assumptions: people ---
  fatigueBuildWeeks: 8,
  fatigueRecoverWeeks: 12,
  workloadEasy: 0.9,
  workloadHard: 1.5,
  departureRate: 0.012,
  understandingWeeks: 8,
  understandingStart: 0.70,
  generatedUnreadPenalty: 0.12,    // grade C: see notes in the model documentation. Restated
                                    // here plainly: this is a judgement-based numerical mapping
                                    // from a memory-literature effect size onto a 0-1 index, not
                                    // a direct, unit-consistent conversion of that effect size.
  skillHalf: 4,

  // --- assumptions: learning ---
  captureShare: 0.50,
  acceptanceShare: 0.70,
  hoursPerCase: 1.0,
  evaluationDelayWeeks: 2,
  casesForStep: 20,
  obsolescence: 0.002,
  ceilingGenIssues: 0.25,
  ceilingRecallGap: 0.30,
  ceilingReviewSaving: 0.20,
  ceilingAlerts: 0.40,
  ceilingRepairGap: 0.30,
  ceilingUnderstanding: 0.10,

  // --- run settings ---
  horizon: 52,
  dt: 0.125,
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// caps a flow so it can never remove more than the stock actually holds this step
const capFlow = (flow, stock, dt) => Math.max(0, Math.min(flow, stock / dt));

function learningProfile(s, p) {
  const f = clamp(s / 5, 0, 2);
  return {
    capture: clamp(p.captureShare * (0.5 + 0.5 * f), 0, 1),
    acceptance: clamp(p.acceptanceShare * (0.5 + 0.5 * f), 0, 1),
    cases: p.casesForStep * (2 - 0.5 * f),
    obsolescence: p.obsolescence * (2 - 0.5 * f),
    ceiling: 0.4 + 0.6 * f,
  };
}

// Validates the structural parameters this engine depends on for correct time
// bookkeeping, and rejects a set of parameters that are divisors (directly, or
// transitively through a value derived from them) with no physically sensible
// zero, negative, infinite or non-numeric value. This is a deliberate choice, not
// the only possible one: the alternative (support any dt/horizon by integrating an
// exact, variable-length final step and interpolating whole-week observations) is
// a larger and riskier change than validating inputs at this stage. Rejecting
// unsupported combinations explicitly, with a clear error, was offered as an
// acceptable resolution and is the one taken here.
//
// This list is deliberately broader than the specific cases reported so far, but
// it is still not exhaustive: it covers every parameter found by searching the
// engine for direct or one-step-removed divisor usage, prioritising inputs a real
// user or UI control could plausibly supply, not every internal constant.
function validateInput(p) {
  const isWholeMultiple = (a, b) => Math.abs(a / b - Math.round(a / b)) < 1e-6;
  const finitePositive = (name) => {
    const v = p[name];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(name + '=' + v + ' is invalid: this value is used as a divisor (directly or through '
        + 'a value derived from it) and must be a finite number greater than zero.');
    }
  };
  if (!(p.dt > 0)) throw new Error('dt must be a positive number of weeks.');
  if (!isWholeMultiple(1, p.dt)) {
    throw new Error('dt=' + p.dt + ' does not evenly divide one week. Weekly observations are only '
      + 'reported at their true, integrated time when dt divides evenly into a week (for example 0.125, '
      + '0.0625, 0.25, 0.5, 1) -- otherwise a step can cross a whole-week boundary without ever computing '
      + 'the state exactly at that week, and the reported value silently comes from a later time instead.');
  }
  if (!(p.horizon >= 0)) throw new Error('horizon must be zero or a positive number of weeks.');
  if (!Number.isFinite(p.horizon)) throw new Error('horizon must be a finite number of weeks.');
  if (!isWholeMultiple(p.horizon, p.dt)) {
    throw new Error('horizon=' + p.horizon + ' is not a whole multiple of dt=' + p.dt + '. A non-exact '
      + 'horizon currently cannot be integrated to its precise endpoint and would silently stop at the '
      + 'last full step short of it; use a horizon that is a whole multiple of dt.');
  }
  ['discoveryWeeks', 'reviewEffort', 'manualEffort', 'onboardingSupport', 'onboardingWeeks',
    'understandingWeeks', 'hoursPerCase', 'evaluationDelayWeeks', 'casesForStep', 'fatigueBuildWeeks',
    'fatigueRecoverWeeks'].forEach(finitePositive);
}

function simulate(input = {}, opts = {}) {
  const p = Object.assign({}, DEFAULTS, input);
  validateInput(p);
  const noAI = !!opts.noAI;
  const prof = learningProfile(p.learningStrength, p);
  // Uses the same rounding judgement validateInput already made: having confirmed
  // horizon/dt is within tolerance of a whole number, round to that number
  // directly, rather than flooring with a separately-tuned epsilon that could
  // disagree with validation's own tolerance and silently drop a full step for an
  // accepted, near-exact horizon (confirmed: horizon=0.99999999 at dt=0.125 passed
  // validation but a floor-based count still landed on 7 steps, not 8).
  const dt = p.dt, steps = Math.round(p.horizon / dt);

  // ---- stocks ----
  let experienced = p.startingTeamSize, starters = 0, starterAge = 0;
  let fatigue = 0.1, understanding = p.understandingStart, departurePressure = 0;
  let feedbackQ = 0, L = 0;
  let value = 0;

  // baseline demand reference: fixed from team size and review policy alone.
  const baseDemandRef = (p.startingTeamSize * p.reviewAllowance) / p.reviewEffort;

  // work stocks (P0 rebuild)
  let demandBacklog = baseDemandRef;     // one week's worth of requested work to start
  let queue = p.queueLimit;              // review backlog: developed, awaiting review/release
  let inducedDemandRate = 0;             // smoothed state for capacity-induced demand
  // conservation tracking counts every stock that exists at t=0 as "arrived": the
  // starting demand backlog and the starting review backlog are both real, already-
  // requested work, not work this run invented for itself.
  let cumArrivals = demandBacklog + queue;
  let cumReleased = 0;                   // conservation tracking: everything ever released

  // issue stocks, split into "not yet found" and "found, awaiting repair" (P0 rebuild)
  let pendingUndetectedG = 0, pendingUndetectedS = 0;
  let pendingKnownG = 0, pendingKnownS = 0;
  let prodLatentG = 0, prodLatentS = 0;
  let prodKnownG = 0, prodKnownS = 0;
  let cumIntroducedG = 0, cumIntroducedS = 0;
  let cumResolvedG = 0, cumResolvedS = 0;      // resolved anywhere: pre-release or production
  let cumEscapesG = 0, cumEscapesS = 0;        // cumulative count that ever escaped to production

  const series = {
    week: [], team: [], throughput: [], value: [], valueRate: [],
    understanding: [], workload: [], fatigue: [], learning: [], reviewDepth: [],
    repairHours: [], reviewHours: [], prodRepairHours: [], queue: [], devCapacity: [], reviewCapacity: [],
    demandBacklog: [], pendingUndetected: [], pendingKnown: [], prodLatent: [], prodKnown: [],
    pending: [], production: [], productionSec: [],
    escapeRate: [], cumEscapes: [],
    // conservation diagnostics
    workBalance: [], defectBalanceG: [], defectBalanceS: [], hoursLedgerBalance: [],
    idleHours: [],
  };

  // F05 fix: record the untouched initial condition once, before any integration
  // step runs, rather than letting "week 0" quietly mean "after one step". Flow-type
  // series have no rate yet at the true instant t=0, so they start at 0 by
  // convention (documented here, not left implicit): they represent the rate
  // in effect DURING the week ending at the labelled week, not an instantaneous
  // snapshot at that exact instant.
  series.week.push(0); series.team.push(experienced + starters); series.throughput.push(0);
  series.value.push(0); series.valueRate.push(0); series.understanding.push(understanding);
  series.workload.push(0); series.fatigue.push(fatigue); series.learning.push(L);
  series.reviewDepth.push(0); series.repairHours.push(0); series.reviewHours.push(0);
  series.prodRepairHours.push(0); series.queue.push(queue); series.devCapacity.push(0);
  series.reviewCapacity.push(0); series.demandBacklog.push(demandBacklog);
  series.pendingUndetected.push(pendingUndetectedG + pendingUndetectedS);
  series.pendingKnown.push(pendingKnownG + pendingKnownS);
  series.prodLatent.push(prodLatentG + prodLatentS); series.prodKnown.push(prodKnownG + prodKnownS);
  series.pending.push(pendingUndetectedG + pendingKnownG + pendingUndetectedS + pendingKnownS);
  series.production.push(prodLatentG + prodKnownG); series.productionSec.push(prodLatentS + prodKnownS);
  series.escapeRate.push(0); series.cumEscapes.push(0);
  series.workBalance.push(cumArrivals - (cumReleased + demandBacklog + queue));
  series.defectBalanceG.push(0); series.defectBalanceS.push(0);
  series.hoursLedgerBalance.push(0); series.idleHours.push(0);

  // Merge events scheduled for the exact same week into one combined event before
  // processing. Two ways of describing the same hire (one event of six, or two of
  // three) should give the identical result; they did not, because the
  // understanding-dilution formula's repeated multiplication is not associative --
  // applying it twice for two smaller hires does not equal applying it once for
  // their sum, however that formula is defined. Merging at the input is simpler
  // and more robustly correct than trying to make the formula itself associative.
  // Merge CONSECUTIVE same-week events that share the same sign (all hires, or
  // all departures) into one combined event before processing. This keeps the
  // equivalent-hire fix above (one event of six behaves identically to two of
  // three) while NOT merging a same-week hire together with a same-week
  // departure: those represent gross replacement -- people leaving and new
  // people being onboarded -- not a net-zero no-op, and collapsing them would
  // silently erase that. `sort` is stable, so events at the same week keep the
  // order they were given in, and a hire followed by a departure (or vice
  // versa) is processed as two real, distinct events in that order.
  const eventsRaw = (p.staffingEvents || []).slice().sort((a, b) => a.week - b.week);
  const events = [];
  for (const ev of eventsRaw) {
    const last = events[events.length - 1];
    const sameSign = last && (Math.sign(last.change) === Math.sign(ev.change) || last.change === 0 || ev.change === 0);
    if (last && Math.abs(last.week - ev.week) < 1e-9 && sameSign) last.change += ev.change;
    else events.push({ week: ev.week, change: ev.change });
  }
  let nextEvent = 0;
  // the next whole-week boundary to record, advanced monotonically as it is
  // reached -- replaces a rounding-tolerance check that could fire on the wrong
  // step entirely for a timestep that doesn't evenly divide 1 week, producing
  // non-monotonic timestamps (confirmed: dt=0.3 previously produced week labels
  // [0, 1, 0.9] -- time appearing to run backwards)
  let nextSampleWeek = 1;

  let prevThroughput = baseDemandRef, prevWorkload = 1, prevDevCapacity = baseDemandRef;
  // last-computed-value trackers, for reporting a true final state even when a
  // horizon ends without ever crossing a whole-week recording boundary (F05B fix)
  let lastValueRate = 0, lastReviewDepth = 0, lastRepairHoursUsed = 0, lastReviewHoursUsed = 0,
    lastProdRepairHours = 0, lastReviewCapacity = 0, lastEscapeRate = 0,
    lastHoursLedgerBalance = 0, lastIdleHours = 0;

  for (let i = 0; i < steps; i++) {
    const t = i * dt;

    // --- staffing events ---
    while (nextEvent < events.length && events[nextEvent].week <= t + 1e-9) {
      const ev = events[nextEvent++];
      const team = experienced + starters;
      if (ev.change > 0) {
        const add = Math.min(ev.change, 30 - team);
        if (add > 0) {
          // diluted against the current TEAM (experienced + any starters already
          // present), not experienced alone -- the previous version ignored
          // existing starters' weight, so splitting one hire into several same-week
          // events gave a different result than doing it in one event (confirmed:
          // one hire of six vs. two hires of three produced different understanding
          // values for what should be the identical outcome)
          understanding = understanding * (team + add * 0.3) / (team + add);
          starters += add; starterAge = 0;
        }
      } else if (ev.change < 0 && team > 1) {
        // total removal is already floored at team-1 above, so total headcount
        // after this event can never reach zero. A further floor of 1 on
        // `experienced` specifically was wrong: when starters already account for
        // the minimum, that floor silently added a phantom person back (confirmed:
        // start 4, hire 6, cut 9 the next step left 2 people instead of the
        // correct 1). Floor at 0 only, as a defence against floating-point
        // rounding, not as an artificial minimum.
        let remove = Math.min(-ev.change, team - 1);
        const fromStarters = Math.min(starters, Math.round(remove * starters / team));
        starters -= fromStarters;
        experienced -= (remove - fromStarters);
        experienced = Math.max(0, experienced);
      }
    }

    // --- onboarding ---
    if (starters > 0) {
      starterAge += dt;
      if (starterAge >= p.onboardingWeeks / p.onboardingSupport) {
        experienced += starters; starters = 0; starterAge = 0;
      }
    }
    const team = experienced + starters;

    // --- hours ---
    const coord = clamp(p.dependencyIntensity * team, 0, p.coordinationCap);
    const staffed = team * p.sustainableHours;
    const mentoring = starters * p.mentoringHours * p.onboardingSupport;
    const starterRamp = p.starterStartOutput +
      (1 - p.starterStartOutput) * clamp(starterAge / (p.onboardingWeeks / p.onboardingSupport), 0, 1);
    const starterShortfall = starters * p.sustainableHours * (1 - starterRamp);
    let productive = staffed * (1 - coord) * (1 - p.fatigueHoursLoss * fatigue)
      - mentoring - starterShortfall - team * p.familiarityTime;
    productive = Math.max(0, productive);

    // --- AI settings ---
    const stepOn = p.aiStepWeek > 0 && t >= p.aiStepWeek ? p.aiStepSize : 0;
    const ramp = p.aiRampWeeks > 0 ? clamp(t / p.aiRampWeeks, 0, 1) : 1;
    const aiShare = noAI ? 0 : clamp(p.aiShare, 0, 1) * ramp;
    // additive shock: can improve a negative or zero gain, and can regress a positive one
    const gain = noAI ? 0 : p.codingGain + stepOn;
    const aiCov = noAI ? 0 : clamp(p.aiReviewCoverage, 0, 1) * ramp;
    const learnOn = !noAI && p.learningOn;

    const Lg = learnOn ? L : 0, Lr = Lg, Lp = Lg;
    const ceil = prof.ceiling;

    const feedbackHours = learnOn ? Math.min(p.feedbackTime * team, 0.05 * productive) : 0;

    // --- review depth and effort per unit ---
    const effectiveStaff = experienced + starters * starterRamp;
    const reviewAllow = Math.min(effectiveStaff * p.reviewAllowance, productive - feedbackHours);
    const effortPerUnitReview = p.reviewEffort *
      (1 - aiCov * (p.aiReviewSaving + ceil * p.ceilingReviewSaving * Lr));

    const reviewedUnits = Math.max(0, prevThroughput);
    const alerts = noAI ? 0 : reviewedUnits * aiCov * p.falseAlertDensity * (1 - ceil * p.ceilingAlerts * Lr);
    const triage = alerts * p.triageHours;
    const pressureFactor = clamp(1 - 0.5 * Math.max(0, prevWorkload - 1), 0.6, 1);
    const naturalPerUnit = effortPerUnitReview * pressureFactor;
    const slack = clamp(1 - queue / Math.max(p.queueLimit, 1e-9), 0, 1);
    let hoursPerUnitRead = naturalPerUnit * (1 + 0.25 * slack);
    const floorPerUnit = p.minReviewDepth * p.reviewEffort;
    const floorActive = floorPerUnit > hoursPerUnitRead;
    if (floorActive) hoursPerUnitRead = floorPerUnit;
    const reviewAllowEff = floorActive
      ? Math.min(productive - feedbackHours, Math.max(reviewAllow, reviewedUnits * hoursPerUnitRead + triage))
      : reviewAllow;
    const reviewHoursForReading = Math.max(0, reviewAllowEff - triage);
    const effectiveDepth = clamp(hoursPerUnitRead / p.reviewEffort, 0, 2);
    const reviewCapacity = hoursPerUnitRead > 0.001 ? reviewHoursForReading / hoursPerUnitRead : 1e6;

    // --- one shared hours budget, allocated in a fixed order (F01 fix) ---
    // Review is reserved using the previous step's actual review hours as an estimate
    // (this step's real review hours depend on throughput, which depends on capacity,
    // which depends on this reservation -- an unavoidable one-step lag, not a new
    // approximation). What changes here is that every claim on productive hours is
    // now subtracted from ONE shrinking pool, in a fixed order, so nothing can be
    // claimed twice. The order: feedback, review, production repair, pre-release
    // repair, then development gets whatever is left.
    let remainingHours = productive;
    remainingHours -= feedbackHours; remainingHours = Math.max(0, remainingHours);
    const reviewReserved = Math.min(reviewAllowEff, remainingHours);
    remainingHours -= reviewReserved; remainingHours = Math.max(0, remainingHours);

    // snapshot of the backlog BEFORE this step's new development adds to it -- the
    // denominator detection uses, since you cannot review code that has not been
    // written yet within the same instant it is written (F02A reorder)
    const queueAtStepStart = queue;

    // --- detection: a flow from "undetected" to "known", not a repair (P0 rebuild) ---
    const aiRecallEff = noAI ? 0 : clamp(p.aiRecall + (1 - p.aiRecall) * ceil * p.ceilingRecallGap * Lr + stepOn * 0.1, 0, 0.95);
    const aiRecallSecEff = noAI ? 0 : clamp(p.aiRecallSecurity + (1 - p.aiRecallSecurity) * ceil * p.ceilingRecallGap * Lr, 0, 0.95);
    const humanRecallCurve = p.humanRecallCeiling * effectiveDepth / (effectiveDepth + p.humanRecallHalf) * clamp(0.6 + 0.4 * understanding, 0.6, 1);
    const testsG = p.testRecall * p.testCoverage * (1 + ceil * p.ceilingRecallGap * Lr * 0.5);

    // --- detection and release as COMPETING hazards on the same pool (F02A fix) ---
    // Isolation testing found the timestep-dependence came from two places, not one:
    // detection and the "what travels with the released batch" split were each
    // computed as a flat per-step fraction of the pending pool (confirmed up to 19-23%
    // of the pool touched in a single 0.125-week step in the default scenario) and
    // then subtracted linearly. With every detection channel at zero, timestep
    // sensitivity in escapes was exactly 0.00%; reintroducing any one channel alone
    // reintroduced it.
    //
    // An earlier version of this fix treated detection and release as joint
    // competing hazards, solved together by exponential decay. That was wrong:
    // release is not probabilistic like detection is -- it is a deterministic
    // co-transfer (if X% of the queue's work ships, X% of its defects ship with it,
    // full stop), and treating it as a hazard let a complete release (100% of the
    // work leaving) transfer only 63.21% of the attached defects, stranding the
    // rest with no work left to carry them. The current implementation is
    // sequential, not joint: detection alone is resolved first, as an exact
    // exponential decay over the interval (this part of the hazard treatment is
    // still correct and still eliminates timestep sensitivity when isolated --
    // confirmed at 0.03% with every detection channel disabled). Release is then a
    // plain linear fraction of whatever detection left behind, using the exact same
    // fraction already used to drain the work itself, so a complete release always
    // transfers exactly 100% of what remains. This sequential treatment does not
    // fully eliminate timestep sensitivity in the coupled system -- the full model
    // still fails the 1% convergence gate on cumulative escapes -- and should not be
    // described as timestep-invariant beyond the isolated detection-only case.
    const humanReadingHours = Math.max(0, reviewReserved - triage);
    const humanUnitsPerWeekG = hoursPerUnitRead > 0.001 ? humanReadingHours / hoursPerUnitRead : 0;
    const humanUnitsPerWeek = Math.min(humanUnitsPerWeekG, queueAtStepStart / Math.max(dt, 1e-6));
    const workThroughAI = noAI ? 0 : aiCov * Math.max(prevThroughput, 0);
    const workThroughTests = Math.max(prevThroughput, 0);

    const hazardDetectG = queueAtStepStart > 1e-9
      ? (humanUnitsPerWeek / queueAtStepStart) * humanRecallCurve + (workThroughAI / queueAtStepStart) * aiRecallEff + (workThroughTests / queueAtStepStart) * testsG
      : 0;
    const hazardDetectS = queueAtStepStart > 1e-9
      ? (humanUnitsPerWeek / queueAtStepStart) * humanRecallCurve * 0.8 + (workThroughAI / queueAtStepStart) * aiRecallSecEff + (workThroughTests / queueAtStepStart) * testsG * 0.7
      : 0;

    // Release is NOT a hazard, and treating it as one was a real defect in the
    // previous version: it let a complete release (100% of the queue's work
    // leaving) transfer only 63.21% of the attached defects, stranding the rest on
    // an empty queue with no work left to carry them. Detection is genuinely
    // probabilistic -- a chance of catching an issue given review effort, correctly
    // treated as a hazard. Release is not probabilistic: whatever fraction of the
    // queue's WORK leaves, that exact same fraction of whatever defects remain in
    // it leaves too, deterministically, because the defects are physically part of
    // the code that ships. So detection is resolved first, as an exact exponential
    // decay over the interval; release then takes the same linear fraction `f` of
    // the survivors that it takes of the work itself -- the identical fraction
    // already used to drain `queue`, so a complete release (f=1) transfers exactly
    // 100% of what's left, matching the acceptance fixture exactly.
    //
    // Applied directly to the live pendingUndetected stocks, not stored in a
    // separate snapshot: detection now runs before this step's new issues are
    // introduced (see the reorder note above), so anything added afterward by
    // introduction must be added on top of the real post-detection value, not
    // silently overwritten later by a stale pre-introduction snapshot -- which is
    // exactly what a snapshot-based version of this did the first time it was
    // tried here, and it broke defect conservation by exactly the newly-introduced
    // amount each step.
    const survivalDetectG = Math.exp(-hazardDetectG * dt);
    const detectedAmountG = pendingUndetectedG * (1 - survivalDetectG);
    const detectionRateG = detectedAmountG / dt;
    pendingUndetectedG *= survivalDetectG;

    const survivalDetectS = Math.exp(-hazardDetectS * dt);
    const detectedAmountS = pendingUndetectedS * (1 - survivalDetectS);
    const detectionRateS = detectedAmountS / dt;
    pendingUndetectedS *= survivalDetectS;

    // newly detected issues join the known pool immediately, in this same step --
    // this is the actual fix: repair (below) can now act on them the same step
    // they are found, instead of only from next step onward
    pendingKnownG += detectedAmountG;
    pendingKnownS += detectedAmountS;

    // --- demand: baseline (exogenous) plus induced (delayed, capped) (P0 rebuild) ---
    const demandStepOn = p.demandStepWeek > 0 && t >= p.demandStepWeek ? p.demandStepSize : 0;
    const baselineDemand = baseDemandRef * p.demandMultiplier * (1 + demandStepOn);
    // induced demand is driven by an estimate of spare capacity from the PREVIOUS step,
    // smoothed toward its target over inducedDemandDelayWeeks, and capped -- a named
    // policy with a delay and a bound, not an instantaneous top-up.
    const inducedTargetRaw = p.newWorkShare * Math.max(0, prevDevCapacity - baselineDemand);
    const inducedTarget = Math.min(inducedTargetRaw, p.inducedDemandCap * baselineDemand);
    inducedDemandRate += (inducedTarget - inducedDemandRate) / Math.max(0.5, p.inducedDemandDelayWeeks) * dt;
    inducedDemandRate = Math.max(0, inducedDemandRate);
    const demandRate = baselineDemand + inducedDemandRate;

    demandBacklog += demandRate * dt;
    cumArrivals += demandRate * dt;

    // production repair is planned next (it is already live in the field): reserved
    // from what remains after feedback and review, not from productive directly
    const discoveredG = capFlow(prodLatentG / p.discoveryWeeks, prodLatentG, dt);
    const discoveredS = capFlow(prodLatentS / p.discoveryWeeks, prodLatentS, dt);
    const repShareG = noAI ? 0 : clamp(p.aiRepairShare * (1 + ceil * p.ceilingRepairGap * Lp), 0, 0.9);
    const repShareS = noAI ? 0 : clamp(p.aiRepairShareSecurity * (1 + ceil * p.ceilingRepairGap * Lp), 0, 0.9);
    const repairHoursPerIssueG = repShareG * p.verifyHours + (1 - repShareG) * p.humanRepairGeneral;
    const repairHoursPerIssueS = repShareS * p.verifyHours + (1 - repShareS) * p.humanRepairSecurity;
    const prodRepairNeeded = discoveredG * repairHoursPerIssueG + discoveredS * repairHoursPerIssueS
      + (prodKnownG * repairHoursPerIssueG + prodKnownS * repairHoursPerIssueS) / Math.max(1, p.discoveryWeeks);
    const prodRepairHours = Math.min(prodRepairNeeded, p.productionRepairReserve, remainingHours);
    const prodRepairRateG = prodRepairNeeded > 0 ? (prodRepairHours / prodRepairNeeded) * (discoveredG + prodKnownG / Math.max(1, p.discoveryWeeks)) : 0;
    const prodRepairRateS = prodRepairNeeded > 0 ? (prodRepairHours / prodRepairNeeded) * (discoveredS + prodKnownS / Math.max(1, p.discoveryWeeks)) : 0;
    remainingHours -= prodRepairHours; remainingHours = Math.max(0, remainingHours);

    // pre-release repair takes what's left after production repair
    const repairHoursAvailable = remainingHours;
    const preRepairCapacityG = repairHoursPerIssueG > 0.001 ? repairHoursAvailable / repairHoursPerIssueG : 1e6;
    // general and security pre-release repair share the same remaining pool, general first
    const preRepairRateG = capFlow(Math.min(preRepairCapacityG, pendingKnownG / dt), pendingKnownG, dt);
    const hoursLeftForSecurity = Math.max(0, repairHoursAvailable - preRepairRateG * repairHoursPerIssueG);
    const preRepairCapacityS = repairHoursPerIssueS > 0.001 ? hoursLeftForSecurity / repairHoursPerIssueS : 1e6;
    const preRepairRateS = capFlow(Math.min(preRepairCapacityS, pendingKnownS / dt), pendingKnownS, dt);
    const preRepairHoursUsed = preRepairRateG * repairHoursPerIssueG + preRepairRateS * repairHoursPerIssueS;
    remainingHours -= preRepairHoursUsed; remainingHours = Math.max(0, remainingHours);

    pendingKnownG -= preRepairRateG * dt; pendingKnownG = Math.max(0, pendingKnownG);
    pendingKnownS -= preRepairRateS * dt; pendingKnownS = Math.max(0, pendingKnownS);
    cumResolvedG += preRepairRateG * dt;
    cumResolvedS += preRepairRateS * dt;

    // --- development: whatever remains of the shared pool, capacity- and backlog-gated ---
    const skillCoverage = team / (team + p.skillHalf) / (1 / (1 + p.skillHalf / 30));
    const skillFactor = clamp(skillCoverage, 0.2, 1);
    const devHours = remainingHours;
    const effortPerUnit = p.manualEffort / (1 + gain * aiShare) / clamp(0.7 + 0.3 * understanding, 0.7, 1);
    const devCapacityRate = devHours / effortPerUnit;

    const soft = p.queueLimit, full = 2 * p.queueLimit;
    const queueFactor = clamp((full - queue) / Math.max(full - soft, 1e-9), 0.2, 1);
    // devRate can never exceed what the backlog actually holds this step
    const devRate = capFlow(Math.min(devCapacityRate * queueFactor, devCapacityRate), demandBacklog, dt);
    demandBacklog -= devRate * dt;
    demandBacklog = Math.max(0, demandBacklog);
    // hours actually spent on development, versus what was reserved but went unused
    // (queue- or backlog-gating can leave development hours idle rather than spent)
    const devHoursUsed = Math.min(devHours, devRate * effortPerUnit);
    const devIdleHours = Math.max(0, devHours - devHoursUsed);
    const aiUnits = devRate * aiShare, humanUnits = devRate * (1 - aiShare);
    const knowledge = clamp(1.6 - 0.6 * understanding / 0.7, 0.6, 2.0);
    const genIssuesG = aiUnits * p.densityGeneral * p.aiDefectMultiplier * knowledge * (1 - ceil * p.ceilingGenIssues * Lg);
    const genIssuesS = aiUnits * p.densitySecurity * p.aiDefectMultiplier * knowledge * (1 - ceil * p.ceilingGenIssues * Lg);
    const selfCheck = clamp(p.selfCheckShare * (1 + ceil * p.ceilingRepairGap * Lp), 0, 0.9);
    const humanIssuesG = humanUnits * p.densityGeneral * knowledge / clamp(skillFactor, 0.5, 1);
    const humanIssuesS = humanUnits * p.densitySecurity * knowledge / clamp(skillFactor, 0.5, 1);
    const introducedG = genIssuesG * (1 - selfCheck) + humanIssuesG;
    const introducedS = genIssuesS * (1 - selfCheck) + humanIssuesS;
    pendingUndetectedG += introducedG * dt;
    pendingUndetectedS += introducedS * dt;
    cumIntroducedG += introducedG * dt;
    cumIntroducedS += introducedS * dt;

    // --- queue (review backlog): developed work arrives, released work leaves ---
    queue += devRate * dt; // throughput (release) computed below and subtracted after
    // snapshot of the backlog before this step's release draws it down -- the shared
    // denominator for every hazard below, since detection, release and (later)
    // repair are all competing for shares of THIS standing pool during this step
    const queueForHazard = queue;

    // --- release gate (throughput): capacity-bound only, never demand-bound directly ---
    // moved ahead of detection: release competes with detection for the same
    // pending-issue pool within a step, so both hazards must be resolved together,
    // which means throughput has to be known before that resolution happens.
    const throughputCap = Math.max(0, Math.min(queueForHazard / dt, reviewCapacity));
    const throughput = capFlow(throughputCap, queueForHazard, dt);
    queue -= throughput * dt;
    queue = Math.max(0, queue);
    cumReleased += throughput * dt;

    const reviewHoursUsed = Math.min(reviewAllowEff, throughput * hoursPerUnitRead + triage);
    // F01 ledger completion: review is reserved ahead of knowing actual throughput
    // (an unavoidable one-step lag -- see the note where reviewReserved is computed).
    // Whatever of that reservation goes unused this step is named explicitly as idle
    // time, not left to vanish the way it did before this fix.
    const reviewIdleHours = Math.max(0, reviewReserved - reviewHoursUsed);
    const idleHours = devIdleHours + reviewIdleHours;
    const repairHoursUsed = preRepairRateG * repairHoursPerIssueG + preRepairRateS * repairHoursPerIssueS;
    // full ledger, mutually exclusive categories, should sum to exactly `productive`
    const hoursLedgerTotal = devHoursUsed + reviewHoursUsed + repairHoursUsed + prodRepairHours + feedbackHours + idleHours;


    // release: the same linear fraction of the queue's work that leaves also
    // carries away that same fraction of whatever undetected/known issues remain.
    // Operates on the live pendingUndetected values directly -- by this point they
    // correctly reflect detection's removal (applied earlier) AND this step's newly
    // introduced issues (added since), not a stale pre-introduction snapshot.
    const releaseFraction = queueForHazard > 1e-9 ? Math.min(1, (throughput * dt) / queueForHazard) : 0;
    const releasedUndetectedG = pendingUndetectedG * releaseFraction / dt;
    const releasedUndetectedS = pendingUndetectedS * releaseFraction / dt;
    pendingUndetectedG *= (1 - releaseFraction);
    pendingUndetectedS *= (1 - releaseFraction);

    const releasedKnownG = pendingKnownG * releaseFraction / dt;
    const releasedKnownS = pendingKnownS * releaseFraction / dt;
    pendingKnownG *= (1 - releaseFraction);
    pendingKnownS *= (1 - releaseFraction);

    const escapeRateG = releasedUndetectedG + releasedKnownG; // everything that reaches production this step
    const escapeRateS = releasedUndetectedS + releasedKnownS;
    cumEscapesG += escapeRateG * dt;
    cumEscapesS += escapeRateS * dt;

    // --- production: latent (undiscovered) and known (discovered, awaiting repair) ---
    prodLatentG += (releasedUndetectedG - discoveredG) * dt; prodLatentG = Math.max(0, prodLatentG);
    prodLatentS += (releasedUndetectedS - discoveredS) * dt; prodLatentS = Math.max(0, prodLatentS);
    prodKnownG += (releasedKnownG + discoveredG - prodRepairRateG) * dt; prodKnownG = Math.max(0, prodKnownG);
    prodKnownS += (releasedKnownS + discoveredS - prodRepairRateS) * dt; prodKnownS = Math.max(0, prodKnownS);
    cumResolvedG += prodRepairRateG * dt;
    cumResolvedS += prodRepairRateS * dt;

    // --- workload, fatigue, departures ---
    const demandHours = triage + feedbackHours + prodRepairHours + demandRate * (effortPerUnit + hoursPerUnitRead);
    const workload = productive > 0 ? (demandHours + repairHoursUsed) / productive : 3;
    const fatigueTarget = clamp((workload - p.workloadEasy) / (p.workloadHard - p.workloadEasy), 0, 1);
    const fatigueTau = fatigueTarget > fatigue ? p.fatigueBuildWeeks : p.fatigueRecoverWeeks;
    fatigue += (fatigueTarget - fatigue) / fatigueTau * dt;
    fatigue = clamp(fatigue, 0, 1);
    if (p.burnoutAttrition) {
      departurePressure += p.departureRate * team * clamp((fatigue - 0.5) / 0.5, 0, 1) * dt;
      if (departurePressure >= 1 && team > 1) {
        departurePressure -= 1;
        if (starters > 0 && starters / team >= 0.5) starters -= 1;
        else experienced -= 1;
      }
    }

    // --- understanding ---
    const unread = aiShare * clamp(1.2 - effectiveDepth, 0, 1);
    const understandingTarget = clamp(
      (0.35 + 0.55 * skillFactor + 0.02 * p.familiarityTime * 5 + ceil * p.ceilingUnderstanding * Lg)
      * (1 - p.generatedUnreadPenalty * unread), 0.05, 1);
    understanding += (understandingTarget - understanding) / p.understandingWeeks * dt;
    understanding = clamp(understanding, 0.05, 1);

    // --- learning ---
    if (learnOn) {
      const captured = (throughput + detectionRateG + detectionRateS) * prof.capture;
      const evaluatedCap = feedbackHours / p.hoursPerCase;
      const evaluated = Math.min(feedbackQ / p.evaluationDelayWeeks, evaluatedCap, feedbackQ / dt);
      const accepted = evaluated * prof.acceptance * clamp(understanding, 0.1, 1);
      feedbackQ += (captured - evaluated) * dt;
      feedbackQ = clamp(feedbackQ, 0, 500);
      const uptake = (accepted / prof.cases) / 3;
      L += ((1 - L) * uptake - L * prof.obsolescence) * dt;
      L = clamp(L, 0, 1);
    }
    // learningOn === false: L is frozen at its current value -- no acquisition, no decay.

    const valueRate = throughput * p.valuePerUnit
      - ((prodLatentG + prodKnownG) + (prodLatentS + prodKnownS) * p.securityValueWeight) * p.productionIssueWeight;
    value += valueRate * dt;

    // --- conservation diagnostics (P0 acceptance checks) ---
    const remainingWork = demandBacklog + queue;
    const workBalance = cumArrivals - (cumReleased + remainingWork); // should be ~0 throughout
    const remainingDefectsG = pendingUndetectedG + pendingKnownG + prodLatentG + prodKnownG;
    const remainingDefectsS = pendingUndetectedS + pendingKnownS + prodLatentS + prodKnownS;
    const defectBalanceG = cumIntroducedG - (cumResolvedG + remainingDefectsG);
    const defectBalanceS = cumIntroducedS - (cumResolvedS + remainingDefectsS);
    const hoursLedgerBalance = productive - hoursLedgerTotal; // should be ~0 at every step

    prevThroughput = throughput; prevWorkload = workload;
    prevDevCapacity = devCapacityRate;
    lastValueRate = valueRate; lastReviewDepth = effectiveDepth; lastRepairHoursUsed = repairHoursUsed;
    lastReviewHoursUsed = reviewHoursUsed; lastProdRepairHours = prodRepairHours;
    lastReviewCapacity = reviewCapacity; lastEscapeRate = escapeRateG + escapeRateS;
    lastHoursLedgerBalance = hoursLedgerBalance; lastIdleHours = idleHours;

    while (t + dt >= nextSampleWeek - 1e-9) {
      series.week.push(nextSampleWeek);
      // recorded live, not the `team` const captured at the top of the step:
      // burnout attrition (if it fires) changes experienced/starters partway
      // through the step, and using the stale const under-reported departures
      // that happened during the same step being recorded (confirmed: a 67-week
      // attrition run reported finalTeam=7 when the actually-integrated state was
      // 6, because that week's departure hadn't been reflected in `team` yet)
      series.team.push(experienced + starters);
      series.throughput.push(throughput);
      series.value.push(value);
      series.valueRate.push(valueRate);
      series.understanding.push(understanding);
      series.workload.push(workload);
      series.fatigue.push(fatigue);
      series.learning.push(L);
      series.reviewDepth.push(effectiveDepth);
      series.repairHours.push(repairHoursUsed);
      series.reviewHours.push(reviewHoursUsed);
      series.prodRepairHours.push(prodRepairHours);
      series.queue.push(queue);
      series.devCapacity.push(devCapacityRate);
      series.reviewCapacity.push(reviewCapacity);
      series.demandBacklog.push(demandBacklog);
      series.pendingUndetected.push(pendingUndetectedG + pendingUndetectedS);
      series.pendingKnown.push(pendingKnownG + pendingKnownS);
      series.prodLatent.push(prodLatentG + prodLatentS);
      series.prodKnown.push(prodKnownG + prodKnownS);
      // aggregate views kept for compatibility and for the existing charts: general and
      // security are kept separate, exactly as the previous version reported them.
      series.pending.push(pendingUndetectedG + pendingKnownG + pendingUndetectedS + pendingKnownS);
      series.production.push(prodLatentG + prodKnownG);
      series.productionSec.push(prodLatentS + prodKnownS);
      series.escapeRate.push(escapeRateG + escapeRateS);
      series.cumEscapes.push(cumEscapesG + cumEscapesS);
      series.workBalance.push(workBalance);
      series.defectBalanceG.push(defectBalanceG);
      series.defectBalanceS.push(defectBalanceS);
      series.hoursLedgerBalance.push(hoursLedgerBalance);
      series.idleHours.push(idleHours);
      nextSampleWeek += 1;
    }
    // No "keep the latest value" fallback: the recording branch above already fires
    // exactly once per whole week, at the step whose update reaches that boundary
    // (F05A fix). A later overwrite here was clobbering an already-correct week's
    // flow values with a value from progressing INTO the next week, while leaving
    // stocks untouched -- producing rows that mixed two different times. Removed
    // rather than patched further.
  }

  // F05B fix: always report the true final state, even for a horizon that isn't an
  // exact multiple of dt (so no whole-week boundary was ever crossed) or that falls
  // strictly between two recorded weeks. Stocks below are the real, current values
  // regardless of whether a recording happened to land here; flow-type figures are
  // carried forward from the most recent step actually computed, labelled as an
  // approximation rather than silently left at a stale earlier value (or, before
  // this fix, left at the untouched week-0 zero).
  const last = a => a[a.length - 1];
  const trueFinalTime = steps * dt;
  if (Math.abs(last(series.week) - trueFinalTime) > 1e-6) {
    series.week.push(trueFinalTime);
    series.team.push(experienced + starters);
    series.throughput.push(prevThroughput);
    series.value.push(value);
    series.valueRate.push(lastValueRate);
    series.understanding.push(understanding);
    series.workload.push(prevWorkload);
    series.fatigue.push(fatigue);
    series.learning.push(L);
    series.reviewDepth.push(lastReviewDepth);
    series.repairHours.push(lastRepairHoursUsed);
    series.reviewHours.push(lastReviewHoursUsed);
    series.prodRepairHours.push(lastProdRepairHours);
    series.queue.push(queue);
    series.devCapacity.push(prevDevCapacity);
    series.reviewCapacity.push(lastReviewCapacity);
    series.demandBacklog.push(demandBacklog);
    series.pendingUndetected.push(pendingUndetectedG + pendingUndetectedS);
    series.pendingKnown.push(pendingKnownG + pendingKnownS);
    series.prodLatent.push(prodLatentG + prodLatentS);
    series.prodKnown.push(prodKnownG + prodKnownS);
    series.pending.push(pendingUndetectedG + pendingKnownG + pendingUndetectedS + pendingKnownS);
    series.production.push(prodLatentG + prodKnownG);
    series.productionSec.push(prodLatentS + prodKnownS);
    series.escapeRate.push(lastEscapeRate);
    series.cumEscapes.push(cumEscapesG + cumEscapesS);
    series.workBalance.push(cumArrivals - (cumReleased + demandBacklog + queue));
    series.defectBalanceG.push(cumIntroducedG - (cumResolvedG + pendingUndetectedG + pendingKnownG + prodLatentG + prodKnownG));
    series.defectBalanceS.push(cumIntroducedS - (cumResolvedS + pendingUndetectedS + pendingKnownS + prodLatentS + prodKnownS));
    series.hoursLedgerBalance.push(lastHoursLedgerBalance);
    series.idleHours.push(lastIdleHours);
  }
  return {
    series,
    summary: {
      finalThroughput: last(series.throughput),
      cumulativeDelivery: cumReleased,
      cumulativeValue: value,
      finalValueRate: last(series.valueRate),
      finalTeam: last(series.team),
      understanding: last(series.understanding),
      productionIssues: last(series.production),
      securityIssues: last(series.productionSec),
      learning: last(series.learning),
      workload: last(series.workload),
      fatigue: last(series.fatigue),
      reviewDepth: last(series.reviewDepth),
      leadTimeWeeks: last(series.queue) / Math.max(0.01, last(series.throughput)),
      demandBacklog: last(series.demandBacklog),
      escapeRate: last(series.escapeRate),
      cumulativeEscapes: last(series.cumEscapes),
      workBalance: last(series.workBalance),
      defectBalanceG: last(series.defectBalanceG),
      defectBalanceS: last(series.defectBalanceS),
      maxWorkBalance: Math.max(...series.workBalance.map(Math.abs)),
      maxDefectBalanceG: Math.max(...series.defectBalanceG.map(Math.abs)),
      maxDefectBalanceS: Math.max(...series.defectBalanceS.map(Math.abs)),
      maxHoursLedgerBalance: Math.max(...series.hoursLedgerBalance.map(Math.abs)),
    },
  };
}

function run(input = {}) {
  const ai = simulate(input, { noAI: false });
  const control = simulate(Object.assign({}, input, { staffingEvents: [] }), { noAI: true });
  // an explicit undefined status, not a silently-propagating NaN, when the
  // control's value is zero or non-finite and the ratio is meaningless
  const relativeTo = (num, den) => (Number.isFinite(num) && Number.isFinite(den) && den !== 0) ? (num / den - 1) : null;
  return { ai, control, compare: {
    throughputVsControl: relativeTo(ai.summary.finalThroughput, control.summary.finalThroughput),
    valueVsControl: relativeTo(ai.summary.cumulativeValue, control.summary.cumulativeValue),
  }};
}

const SENSITIVITY_FACTORS = [
  ['reviewAllowance', 2, 6, 'lever'], ['codingGain', -0.2, 0.6, 'lever'],
  ['demandMultiplier', 0.7, 1.5, 'lever'],
  ['aiShare', 0.2, 1.0, 'lever'], ['aiDefectMultiplier', 0.8, 2.0, 'assumption'],
  ['selfCheckShare', 0, 0.5, 'lever'], ['aiRecall', 0.14, 0.80, 'lever'],
  ['falseAlertDensity', 0.05, 1.0, 'lever'], ['aiRepairShare', 0.05, 0.64, 'lever'],
  ['learningStrength', 0, 10, 'lever'], ['feedbackTime', 0.25, 0.75, 'lever'],
  ['queueLimit', 3, 12, 'lever'], ['minReviewDepth', 0, 1.0, 'lever'],
  ['productionRepairReserve', 5, 60, 'lever'], ['sustainableHours', 35, 45, 'lever'],
  ['onboardingSupport', 0.6, 1.6, 'lever'], ['familiarityTime', 0, 2, 'lever'],
  ['newWorkShare', 0, 1, 'lever'], ['aiReviewCoverage', 0.2, 1.0, 'lever'],
  ['manualEffort', 14, 26, 'assumption'], ['reviewEffort', 2.8, 5.2, 'assumption'],
  ['densityGeneral', 0.46, 0.86, 'assumption'], ['humanRepairGeneral', 6, 11, 'assumption'],
  ['testRecall', 0.15, 0.60, 'assumption'], ['dependencyIntensity', 0.0117, 0.0217, 'assumption'],
  ['discoveryWeeks', 3, 9, 'assumption'], ['captureShare', 0.25, 0.75, 'assumption'],
  ['acceptanceShare', 0.35, 0.85, 'assumption'], ['casesForStep', 12, 60, 'assumption'],
  ['obsolescence', 0.001, 0.01, 'assumption'], ['onboardingWeeks', 8, 26, 'assumption'],
  ['humanRecallCeiling', 0.6, 0.95, 'assumption'], ['departureRate', 0.006, 0.024, 'assumption'],
  ['securityValueWeight', 1.0, 5.0, 'assumption'],
];

function sensitivity(input = {}, outcome = 'finalThroughput') {
  const base = simulate(input).summary[outcome];
  const rows = SENSITIVITY_FACTORS.map(([key, lo, hi, tag]) => {
    const a = simulate(Object.assign({}, input, { [key]: lo })).summary[outcome];
    const b = simulate(Object.assign({}, input, { [key]: hi })).summary[outcome];
    return { key, tag, low: lo, high: hi, lowResult: a, highResult: b,
      effect: Math.abs(b - a), reverses: (a - base) * (b - base) > 0 && Math.abs(a - b) > 1e-9 };
  });
  rows.sort((x, y) => y.effect - x.effect);
  return { base, rows };
}

module.exports = { simulate, run, sensitivity, SENSITIVITY_FACTORS, DEFAULTS };
