/* The chat tools against fixture state, including the consent gate that must not read. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleState } from './helpers.mjs';
import { toolContext, runTool, TOOLS, STEP_WRITING, stepFor, isActionable } from '../coach/core/tools.js';

const today = '2026-07-20';
const STEPS = new Set([
  'Reading your workout history',
  'Checking your exercise progress',
  'Searching the exercise library',
  'Checking your food diary',
  'Checking your body metrics',
  'Looking at your routine',
  'Checking a proposal',
  'Writing a reply'
]);

const S = (over = {}) => sampleState({
  foodLog: [
    { d: '2026-07-20', meal: 'lunch', name: 'Chicken rice', kcal: 600, protein: 45, carbs: 50, fat: 12, t: 1 }
  ],
  nutrition: { targets: { kcal: 2200, protein: 160, carbs: 220, fat: 70, source: 'custom' } },
  ...over
});

test('every tool step is one of the strings the app translates', () => {
  for (const t of TOOLS) assert.ok(STEPS.has(t.step), `${t.name} step "${t.step}" is not in the closed list`);
  assert.equal(STEP_WRITING, 'Writing a reply');
  assert.equal(stepFor('get_workout_history'), 'Reading your workout history');
  assert.equal(stepFor('get_exercise_progress'), 'Checking your exercise progress');
  assert.equal(stepFor('get_body_metrics'), 'Checking your body metrics');
  assert.equal(stepFor('get_routine'), 'Looking at your routine');
});

test('read tools return bounded data from the fixture state', () => {
  const ctx = toolContext(S(), { today });
  const hist = runTool(ctx, 'get_workout_history', { days: 14, limit: 8 });
  assert.equal(hist.ok, true);
  assert.equal(hist.result.sessionsEver, 1);
  assert.equal(hist.result.workouts[0].entries[0].id, '0001');

  const prog = runTool(ctx, 'get_exercise_progress', { exerciseId: '0001' });
  assert.equal(prog.ok, true);
  assert.ok(prog.result.sessionsLogged >= 1);
  assert.equal(prog.result.bestLoad, 20);

  const search = runTool(ctx, 'search_exercises', { query: 'sit-up', limit: 5 });
  assert.equal(search.ok, true);
  assert.ok(search.result.results.some(e => e.id === '0001'));

  const diary = runTool(ctx, 'get_food_diary', {});
  assert.equal(diary.ok, true);
  assert.equal(diary.result.meals[0].name, 'Chicken rice');
  assert.equal(diary.result.meals[0].protein, 45);

  const body = runTool(ctx, 'get_body_metrics', {});
  assert.equal(body.ok, true);
  assert.equal(body.result.latest.w, 78.5);

  const plan = runTool(ctx, 'get_routine', {});
  assert.equal(plan.ok, true);
  assert.equal(plan.result.routines[0].id, 'r1');
});

test('a withheld consent category is refused without reading', () => {
  const ctx = toolContext(S(), { today, categories: ['plan'] });
  const diary = runTool(ctx, 'get_food_diary', {});
  assert.equal(diary.ok, false);
  assert.match(diary.result.errors[0], /not shared their nutrition/);

  const hist = runTool(ctx, 'get_workout_history', {});
  assert.equal(hist.ok, false);
  assert.match(hist.result.errors[0], /not shared their training/);

  const metrics = runTool(ctx, 'get_body_metrics', {});
  assert.equal(metrics.ok, false);
  assert.match(metrics.result.errors[0], /bodyweight/);

  const search = runTool(ctx, 'search_exercises', { query: 'row' });
  assert.equal(search.ok, true, 'the catalogue is nobody\'s data');
});

test('proposal tools run the same validators; errors go back, a valid card comes out', () => {
  const ctx = toolContext(S(), { today });
  const bad = runTool(ctx, 'propose_changes', { title: 'Nope', changes: [] });
  assert.equal(bad.ok, false);
  assert.match(bad.result.errors[0], /non-empty array/);

  const ok = runTool(ctx, 'propose_changes', {
    title: 'Add one set',
    summary: 'A little more volume.',
    changes: [{ id: 'c1', type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4, why: 'You asked.' }]
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.card.type, 'changes');
  assert.equal(isActionable(ok.card), true);
  assert.equal(ok.card.changes[0].after, 4);

  const shown = runTool(ctx, 'show_exercises', { ids: ['0001', '0007'], note: 'From the plan.' });
  assert.equal(shown.ok, true);
  assert.equal(shown.card.type, 'exercises');
  assert.equal(isActionable(shown.card), false);

  const food = runTool(ctx, 'show_nutrition', { summary: 'Protein is on target.' });
  assert.equal(food.ok, true);
  assert.equal(food.card.type, 'nutrition');
  assert.equal(food.card.summary, 'Protein is on target.');
  assert.ok(food.card.days.length <= 14);
  assert.ok(food.card.days.some(d => d.d === today && d.protein === 45));
});

test('an unknown tool names the catalogue rather than throwing', () => {
  const ctx = toolContext(S(), { today });
  const r = runTool(ctx, 'drop_tables', {});
  assert.equal(r.ok, false);
  assert.match(r.result.errors[0], /unknown tool/);
  assert.match(r.result.errors[0], /get_workout_history/);
});
