/* The Coach's nutrition summary, without the Vite frontend.
 *
 * Male, 30, 180 cm, 80 kg, moderate, maintain.
 * BMR = 10*80 + 6.25*180 - 5*30 - 161 + 166 = 1780
 * TDEE = trunc(1780 * 1.465) = 2607
 * protein = trunc(1.6 * 80) = 128, fat = trunc(0.6 * 80) = 48
 * carbs = trunc((2607 - 128*4 - 48*9) / 4) = 415
 * Birthday 1996-01-15 and today 2026-10-10 is age 30.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nutritionSummary } from '../coach/core/nutrition.js';

const TODAY = '2026-10-10';
const male = () => ({
  unit: 'kg',
  bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }],
  nutrition: {
    heightCm: 180, birthday: '1996-01-15', sex: 'male', activity: 'moderate', goal: 'maintain',
  },
  foodLog: [],
});

test('male 30, 180cm, 80kg, moderate, maintain → 2607 kcal, protein 128, fat 48, carbs 415', () => {
  const n = nutritionSummary(male(), '2026-10-01', TODAY, TODAY);
  assert.equal(n.inputs.age, 30);
  assert.equal(n.inputs.weightKg, 80);
  assert.equal(n.inputs.heightCm, 180);
  assert.equal(n.inputs.goal, 'maintain');
  assert.equal(n.inputs.activity, 'moderate');
  assert.deepEqual(n.targets, { kcal: 2607, protein: 128, carbs: 415, fat: 48, source: 'inferred' });
  assert.equal(n.energy, undefined);
});

test('a custom calorie target is reported as custom, with carbs filling what it leaves', () => {
  const S = male();
  S.nutrition.customKcal = 2200;
  const n = nutritionSummary(S, '2026-10-01', TODAY, TODAY);
  assert.equal(n.targets.source, 'custom');
  assert.equal(n.targets.kcal, 2200);
  assert.equal(n.targets.protein, 128);
  assert.equal(n.targets.fat, 48);
  // trunc((2200 - 128*4 - 48*9) / 4)
  assert.equal(n.targets.carbs, 314);
});

test('the window is 28 days, photos never leave, and meals outside it are dropped', () => {
  const HASH = 'ab'.repeat(32);
  const VISION = 'VISION_PROMPT_describe_this_plate';
  const B64 = 'data:image/jpeg;base64,AAAASECRETPLATE';
  const S = male();
  S.foodLog = [
    { id: 'old', d: '2026-09-01', t: 1, name: 'ANCIENT_OATS', kcal: 400, protein: 10, carbs: 60, fat: 8, meal: 'breakfast', media: [{ hash: HASH }], vision: VISION, note: B64 },
    { id: 'edge', d: '2026-09-12', t: 1, name: 'DAY_BEFORE_WINDOW', kcal: 100, protein: 1, carbs: 1, fat: 1, meal: 'snack' },
    { id: 'in', d: '2026-09-13', t: 1, name: 'FIRST_IN_WINDOW', kcal: 500, protein: 20, carbs: 40, fat: 15, meal: 'lunch', grams: 250, source: 'photo-SENTINEL' },
    {
      id: 'today', d: TODAY, t: 2, name: 'TODAY_EGGS', kcal: 180, protein: 12, carbs: 1, fat: 14, meal: 'breakfast',
      media: [{ hash: HASH, data: B64 }], vision: VISION, prompt: VISION, grams: 100, source: 'photo', edited: true, note: 'secret plate',
    },
    { id: 'later', d: '2026-10-11', t: 3, name: 'TOMORROW', kcal: 900, protein: 1, carbs: 1, fat: 1, meal: 'dinner' },
  ];
  S.nutrition.likes = ['oats'];
  const n = nutritionSummary(S, '2026-01-01', TODAY, TODAY);
  assert.equal(n.window.from, '2026-09-13');
  assert.equal(n.window.to, TODAY);
  assert.deepEqual(n.days.map(d => d.d), ['2026-09-13', TODAY]);
  assert.equal(n.days[0].meals, 1);
  assert.equal(n.days[0].kcal, 500);
  assert.deepEqual(n.today, [{ name: 'TODAY_EGGS', meal: 'breakfast', kcal: 180, protein: 12 }]);
  assert.deepEqual(Object.keys(n.today[0]).sort(), ['kcal', 'meal', 'name', 'protein']);
  assert.ok(n.energy.includes('80 kg'));
  assert.equal(n.likes[0], 'oats');
  const json = JSON.stringify(n);
  for (const leak of [HASH, VISION, B64, 'ANCIENT_OATS', 'DAY_BEFORE_WINDOW', 'TOMORROW', 'photo-SENTINEL', 'secret plate', '"media"', '"grams"', '"vision"', 'base64']) {
    assert.ok(!json.includes(leak), `summary leaked ${leak}`);
  }
});
