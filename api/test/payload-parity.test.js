/* payload.js's own header comment says its duplicated reading rules are pinned against the
   frontend's originals so the copy cannot drift silently, but frontend/src/lib/coach-parity.test.js
   only ever imported three of the five: modeOf, isBw, isPerSide. isWarmupSet and readSession were
   pinned by nothing. This file closes that gap.

   It cannot live inside coach-parity.test.js itself: that file runs under vitest, and readSession
   is not exported from payload.js (only isWarmupSet is), so the only way to observe it from
   outside is through payload.build()'s aggregates, which needs a real DATA_DIR and the rest of the
   coach module graph — the same setup payload.test.js already uses under node:test. The frontend
   imports below are safe under plain node: workout-model.js and progression.js have no Vite- or
   React-only syntax, the same reason mcp/'s own tests import frontend/src/lib directly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempData, sampleState } from './helpers.mjs';
import { isWarmupRow } from '../../frontend/src/lib/workout-model.js';
import { readSession as frontendReadSession } from '../../frontend/src/lib/progression.js';
import { NOTE_MAX as frontendNoteMax } from '../../frontend/src/lib/history.js';

tempData();
const payload = await import('../coach/core/payload.js');
const { handleFor } = await import('../coach/handle.js');

/* The payload bounds a session note at the app's own cap, so a note the app let the athlete write
   is never cut on its way to the model. */
test('the payload\'s NOTE_MAX is the app\'s NOTE_MAX', () => {
  assert.equal(payload.NOTE_MAX, frontendNoteMax);
});

test('isWarmupSet agrees with the frontend isWarmupRow', () => {
  const cases = [
    {}, null, undefined,
    { warmup: true }, { warmup: false }, { warmup: 'true' },
    { phase: 'warmup' }, { phase: 'warm-up' }, { phase: 'warm_up' }, { phase: 'WARMUP' },
    { phase: 'work' }, { phase: '' }, { phase: 'bogus' },
    { phase: 'warmup', warmup: false }, { phase: 'work', warmup: true },
  ];
  for (const c of cases) assert.equal(payload.isWarmupSet(c), isWarmupRow(c), JSON.stringify(c));
});

/* readSession decides whether a logged session counts as a hit, feeding stallCount and every
   progression signal the aggregates carry. It is not exported, so it is read here the way the
   engine itself reads it: through build()'s aggregates, on an exercise with three sessions (the
   inclusion floor `aggregates` applies before it will report on an exercise at all). */
const EX_ID = '0001'; // bodyweight, real catalogue id — same one coach-parity.test.js uses
const PLAN = { id: EX_ID, sets: 3, reps: 10, mode: 'reps', weight: 20, prog: 'linear' };
const set = r => ({ w: 0, r, done: true });
const entry = sets => ({ id: EX_ID, target: { sets: 3, reps: 10 }, sets });

function reviewFor(entries) {
  const S = sampleState({
    routines: [{ id: 'r1', name: 'Full body A', ex: [PLAN] }],
    workouts: entries.map((en, i) => ({
      id: 'w' + i, d: `2026-08-${String(i + 1).padStart(2, '0')}`, name: 'Full body A',
      start: 1000, end: 2000, entries: [en],
    })),
  });
  return payload.build(S, { handle: handleFor('u_parity'), kind: 'review' });
}
const exOf = p => p.aggregates.exercises.find(e => e.id === EX_ID);

test('readSession agrees with the frontend on an ordinary session', () => {
  const passing = entry([set(10), set(10), set(10)]);
  const p = reviewFor([passing, passing, passing]);
  assert.equal(exOf(p).lastOk, true);
  assert.equal(frontendReadSession(passing, PLAN).ok, true);
});

// Exact inputs: a session logged with a fourth set beyond the planned three, whose reps fall
// short of the goal. frontend/src/lib/progression.js readSession grades only the first
// `target.sets` sets (issue #233: "a hard [extra set] taken short of the target reps reported
// the whole session as missed") and calls this a hit. payload.js's copy graded every logged
// set and called the same session a miss, so stallCount reported a stall the athlete never
// had, and the Coach's review and proposal were built on it.
test('readSession agrees with the frontend on a bonus set logged beyond the plan', () => {
  const passing = entry([set(10), set(10), set(10)]);
  const bonus = entry([set(10), set(10), set(10), set(5)]);
  const p = reviewFor([passing, passing, bonus]);

  assert.equal(frontendReadSession(bonus, PLAN).ok, true, 'the frontend grades the first 3 sets and calls this a hit');
  assert.equal(exOf(p).lastOk, true, 'and so must this, or stallCount invents a stall');
  assert.equal(exOf(p).stalls, 0);

  // A short set INSIDE the plan is still a miss on both sides: the slicing must not swallow it.
  const short = entry([set(10), set(10), set(5)]);
  assert.equal(frontendReadSession(short, PLAN).ok, false);
  assert.equal(exOf(reviewFor([passing, passing, short])).lastOk, false);
  assert.equal(exOf(reviewFor([passing, passing, short])).stalls, 1);

  // Fewer sets than planned is short whichever way it is read, and `enough` says so on both
  // sides before the slicing is reached.
  const tooFew = entry([set(10), set(10)]);
  assert.equal(frontendReadSession(tooFew, PLAN).ok, false);
  assert.equal(exOf(reviewFor([passing, passing, tooFew])).lastOk, false);
});

// An entry with no target of its own (a Hevy or CSV import, anything logged before v1.2.2) is
// never sliced on either side: grading it against the routine's set count TODAY would read the
// warm-up end of a session nobody planned that way. Here the fourth set falls short, and with
// no plan to say it was extra, it counts.
test('readSession agrees with the frontend on an imported session with no plan of its own', () => {
  const passing = entry([set(10), set(10), set(10)]);
  const imported = { id: EX_ID, sets: [set(10), set(10), set(10), set(5)] };

  assert.equal(frontendReadSession(imported, PLAN).ok, false, 'the frontend reads all four sets');
  assert.equal(exOf(reviewFor([passing, passing, imported])).lastOk, false, 'and so does the payload');
  assert.equal(exOf(reviewFor([passing, passing, imported])).stalls, 1);
});

// Triple progression (issue #179) asks each set for its own reps: a fourth set climbing from 8
// is a hit at 8, though the top of the range is 12. Both copies grade by the session's own aims.
test('readSession agrees with the frontend on per-set aims under triple progression', () => {
  const passing = entry([set(10), set(10), set(10)]);
  const triple = sets => ({ id: EX_ID, target: { sets: 4, reps: 12, rowReps: [12, 12, 12, 8] }, sets });
  const hit = triple([set(12), set(12), set(12), set(8)]);
  const miss = triple([set(12), set(12), set(12), set(7)]);
  assert.equal(frontendReadSession(hit, PLAN).ok, true);
  assert.equal(exOf(reviewFor([passing, passing, hit])).lastOk, true);
  assert.equal(frontendReadSession(miss, PLAN).ok, false);
  assert.equal(exOf(reviewFor([passing, passing, miss])).lastOk, false);
});

/* Nutrition is a review/debrief category. Create never carries it. Turning the category off
   leaves it out of a review too. When it is on, only the allowlist leaves — no photos. */
test('nutrition is absent when the category is off, and present as an allowlist when it is on', () => {
  const today = new Date().toISOString().slice(0, 10);
  const HASH = 'cd'.repeat(32);
  const VISION = 'VISION_PROMPT_plate_not_for_the_coach';
  const B64 = 'data:image/jpeg;base64,BBBBSECRETPLATE';
  const meals = Array.from({ length: 13 }, (_, i) => ({
    id: 'm' + i, d: today, t: i + 1, name: 'MEAL_' + i, kcal: 100 + i, protein: 5, carbs: 1, fat: 1,
    meal: 'snack', grams: 80, source: 'photo-SENTINEL', media: [{ hash: HASH, data: B64 }],
    vision: VISION, prompt: VISION, note: 'secret plate', edited: true,
  }));
  const S = sampleState({
    nutrition: {
      heightCm: 180, birthday: '1996-01-15', sex: 'male', activity: 'moderate', goal: 'maintain',
      likes: ['oats'], dislikes: [], wontEat: ['pork'], note: 'no shellfish',
    },
    foodLog: [
      ...meals,
      { id: 'old', d: '2020-01-01', t: 1, name: 'ANCIENT_OATS', kcal: 50, protein: 1, carbs: 1, fat: 1, meal: 'breakfast', media: [{ hash: HASH }] },
    ],
    bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }],
  });
  const opts = { handle: handleFor('u_nutrition') };
  const create = payload.build(S, { ...opts, kind: 'create' });
  assert.equal('nutrition' in create, false);
  const off = payload.build(S, { ...opts, kind: 'review', categories: ['plan', 'training', 'bodyweight', 'profile', 'prefs'] });
  assert.equal('nutrition' in off, false);
  const debriefOff = payload.build(S, { ...opts, kind: 'debrief', workoutId: 'w1', categories: ['plan', 'training'] });
  assert.equal('nutrition' in debriefOff, false);
  for (const leaked of [create, off, debriefOff]) {
    const json = JSON.stringify(leaked);
    for (const secret of [HASH, VISION, B64, 'ANCIENT_OATS', 'MEAL_0', 'photo-SENTINEL', 'secret plate']) {
      assert.ok(!json.includes(secret), `category-off payload leaked ${secret}`);
    }
  }

  const on = payload.build(S, { ...opts, kind: 'review' });
  const n = on.nutrition;
  assert.ok(n, 'review includes nutrition when the category is on');
  const keys = Object.keys(n).sort();
  assert.deepEqual(keys, ['days', 'dislikes', 'energy', 'inputs', 'likes', 'note', 'targets', 'today', 'window', 'wontEat']);
  assert.deepEqual(Object.keys(n.targets).sort(), ['carbs', 'fat', 'kcal', 'protein', 'source']);
  assert.ok(n.targets.source === 'inferred' || n.targets.source === 'custom');
  assert.deepEqual(Object.keys(n.inputs).sort(), ['activity', 'age', 'goal', 'heightCm', 'sex', 'weightKg']);
  assert.equal(n.today.length, 12);
  n.today.forEach(m => assert.deepEqual(Object.keys(m).sort(), ['kcal', 'meal', 'name', 'protein']));
  n.days.forEach(d => assert.deepEqual(Object.keys(d).sort(), ['carbs', 'd', 'fat', 'kcal', 'meals', 'protein']));
  assert.ok(!n.days.some(d => d.d === '2020-01-01'));
  assert.deepEqual(n.likes, ['oats']);
  assert.equal(n.wontEat[0], 'pork');
  const json = JSON.stringify(on);
  for (const secret of [HASH, VISION, B64, 'ANCIENT_OATS', 'photo-SENTINEL', 'secret plate', '"media"', '"grams"', '"vision"', 'base64']) {
    assert.ok(!json.includes(secret), `review payload leaked ${secret}`);
  }

  const debrief = payload.build(S, { ...opts, kind: 'debrief', workoutId: 'w1' });
  assert.ok(debrief.nutrition, 'a debrief includes nutrition');
  assert.ok(!JSON.stringify(debrief).includes(HASH));
});
