import { describe, expect, it } from 'vitest'
import {
  ageYears, cleanMeal, convertServingUnit, dayTotals, inferGoal, mealFromTime, nutritionOf, nutritionTargets, profileTargets, scaleIngredient, scaleToGrams, scaleToServings, targetExplain, weeklyCalorieNudge, weeklyFromUnit, weeklyInUnit,
} from './nutrition.js'

// Male, 30, 180 cm, 80 kg, moderate, maintain. Mifflin then the moderate multiplier.
// BMR = 10*80 + 6.25*180 - 5*30 - 161 + 166 = 1780
// TDEE = trunc(1780 * 1.465) = 2607
const male = { weightKg: 80, heightCm: 180, age: 30, sex: 'male', activity: 'moderate', goal: 'maintain' }

describe('nutritionTargets', () => {
  it('uses Mifflin-St Jeor, the moderate multiplier, and truncates like Kotlin', () => {
    const t = nutritionTargets(male)
    expect(t.method).toBe('mifflin')
    expect(t.bmr).toBe(1780)
    expect(t.tdee).toBe(2607)
    expect(t.kcal).toBe(2607)
    expect(t.protein).toBe(128)
    expect(t.fat).toBe(48)
    expect(t.carbs).toBe(415)
    expect(t.sexAssumed).toBe(false)
    expect(t.adjustment).toBe(0)
  })

  it('adds 166 for male, nothing for female, and the midpoint when sex is unset', () => {
    expect(nutritionTargets({ ...male, sex: 'female' }).bmr).toBe(1614)
    const mid = nutritionTargets({ ...male, sex: null })
    expect(mid.bmr).toBe(1697)
    expect(mid.sexAssumed).toBe(true)
  })

  it('adjusts by 7700 kcal per kg per week, and adds protein while losing', () => {
    const lose = nutritionTargets({ ...male, goal: 'lose', weeklyKg: 0.5 })
    expect(lose.adjustment).toBe(-550)
    expect(lose.kcal).toBe(2057)
    expect(lose.protein).toBe(144)
    expect(lose.fat).toBe(48)
    expect(lose.carbs).toBe(262)
    const gain = nutritionTargets({ ...male, goal: 'gain' })
    expect(gain.adjustment).toBe(550)
    expect(gain.weeklyKg).toBe(0.5)
    expect(nutritionTargets({ ...male, goal: 'lose', weeklyKg: 0 }).adjustment).toBe(0)
  })

  it('uses Katch-McArdle whenever body fat is known, without height or age', () => {
    const t = nutritionTargets({ weightKg: 80, bodyFat: 0.2, activity: 'moderate', goal: 'maintain' })
    expect(t.method).toBe('katch')
    expect(t.bmr).toBeCloseTo(370 + 21.6 * 0.8 * 80, 5)
    expect(t.protein).toBe(128)
  })

  it('keeps protein on full body weight when body fat is known', () => {
    const cutting = { weightKg: 100, activity: 'moderate', goal: 'lose', heightCm: 180, age: 30, sex: 'male' }
    expect(nutritionTargets({ ...cutting, bodyFat: 0.3 }).protein).toBe(180)
    expect(nutritionTargets(cutting).protein).toBe(180)
  })

  it('uses the extra-active rates', () => {
    const t = nutritionTargets({ ...male, activity: 'extraActive' })
    expect(t.tdee).toBe(Math.trunc(1780 * 1.9))
    expect(t.protein).toBe(Math.trunc(2.2 * 80))
  })

  it('lets a custom number replace only that target', () => {
    const t = nutritionTargets({ ...male, customKcal: 2000, customProtein: 160 })
    expect(t.kcal).toBe(2000)
    expect(t.protein).toBe(160)
    expect(t.fat).toBe(48)
    expect(t.carbs).toBe(415)
    expect(t.formula.kcal).toBe(2607)
  })

  it('returns null without a weight, and without height or age when body fat is unknown', () => {
    expect(nutritionTargets({ heightCm: 180, age: 30, sex: 'male' })).toBeNull()
    expect(nutritionTargets({ weightKg: 80, age: 30, sex: 'male' })).toBeNull()
    expect(nutritionTargets({ weightKg: 80, heightCm: 180, sex: 'male' })).toBeNull()
  })
})

describe('inferGoal', () => {
  it('keeps an explicit goal', () => {
    expect(inferGoal({ goal: 'gain', weight: 80, targetW: 70, coachGoal: 'fatloss' })).toEqual({ goal: 'gain', source: 'set' })
  })
  it('reads the goal weight, then the coach, then maintain', () => {
    expect(inferGoal({ weight: 80, targetW: 75 })).toEqual({ goal: 'lose', source: 'targetW' })
    expect(inferGoal({ weight: 80, targetW: 85 })).toEqual({ goal: 'gain', source: 'targetW' })
    expect(inferGoal({ weight: 80, targetW: 80 })).toEqual({ goal: 'maintain', source: 'targetW' })
    expect(inferGoal({ coachGoal: 'fatloss' })).toEqual({ goal: 'lose', source: 'coach' })
    expect(inferGoal({ coachGoal: 'muscle' })).toEqual({ goal: 'gain', source: 'coach' })
    expect(inferGoal({ coachGoal: 'strength' })).toEqual({ goal: 'maintain', source: 'default' })
    expect(inferGoal({})).toEqual({ goal: 'maintain', source: 'default' })
    expect(inferGoal({ weight: 80, targetW: null })).toEqual({ goal: 'maintain', source: 'default' })
  })
})

describe('profileTargets', () => {
  const S = (over = {}) => ({
    unit: 'kg',
    bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }],
    targetW: 75,
    measurements: [{ d: '2026-10-01', bodyFat: 20, t: 1 }],
    nutrition: { heightCm: 180, birthday: '1996-01-15', sex: 'male', activity: 'moderate' },
    ...over,
  })

  it('uses the latest weigh-in, body fat, and an inferred loss', () => {
    const r = profileTargets(S(), '2026-10-10')
    expect(r.goal).toBe('lose')
    expect(r.goalSource).toBe('targetW')
    expect(r.weightKg).toBe(80)
    expect(r.targets.method).toBe('katch')
    expect(ageYears('1996-01-15', '2026-01-14')).toBe(29)
    expect(ageYears('1996-01-15', '2026-01-15')).toBe(30)
  })

  it('converts a pound weigh-in before the formula', () => {
    const r = profileTargets(S({ unit: 'lb', bodyweight: [{ d: '2026-10-01', w: 176.37, t: 1 }], measurements: [] }), '2026-10-10')
    expect(r.weightKg).toBeCloseTo(80, 1)
    expect(r.targets.method).toBe('mifflin')
  })

  it('has no target without a weigh-in', () => {
    expect(profileTargets(S({ bodyweight: [] }), '2026-10-10').targets).toBeNull()
  })
})

describe('targetExplain', () => {
  const ready = {
    unit: 'kg',
    bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }],
    nutrition: { heightCm: 180, birthday: '1996-01-15', sex: 'male', activity: 'moderate', goal: 'lose', weeklyKg: 0.5 },
  }
  it('names what is missing', () => {
    expect(targetExplain({ unit: 'kg', nutrition: { heightCm: 180, birthday: '1996-01-15' } }, '2026-10-10').missing).toBe('weight')
    expect(targetExplain({ ...ready, nutrition: { birthday: '1996-01-15', sex: 'male' } }, '2026-10-10').missing).toBe('height')
    expect(targetExplain({ ...ready, nutrition: { heightCm: 180, sex: 'male' } }, '2026-10-10').missing).toBe('birthday')
  })
  it('reports a ready target, and a custom calorie target as the person’s own', () => {
    const x = targetExplain(ready, '2026-10-10')
    expect(x.ok).toBe(true)
    expect(x.kcal).toBe(2057)
    expect(x.method).toBe('mifflin')
    expect(x.sexAssumed).toBe(false)
    expect(targetExplain({ ...ready, nutrition: { ...ready.nutrition, customKcal: 1800 } }, '2026-10-10').customKcal).toBe(true)
  })
  it('keeps the formula when a custom target was never set', () => {
    const x = targetExplain({
      ...ready,
      targetW: null,
      nutrition: { ...ready.nutrition, goal: null, weeklyKg: null, customKcal: null, customProtein: null, customCarbs: null, customFat: null },
    }, '2026-10-10')
    expect(x.ok).toBe(true)
    expect(x.kcal).toBe(2607)
    expect(x.customKcal).toBe(false)
    expect(x.goal).toBe('maintain')
    expect(x.goalSource).toBe('default')
  })
  it('converts a weekly rate at the edge', () => {
    expect(weeklyInUnit(0.5, 'kg')).toBe(0.5)
    expect(weeklyFromUnit(weeklyInUnit(0.5, 'lb'), 'lb')).toBeCloseTo(0.5, 2)
  })
})

describe('nutritionOf', () => {
  it('fills defaults and drops junk', () => {
    const n = nutritionOf({ nutrition: { heightCm: 10, sex: 'other', activity: 'nope', likes: ['  oats ', '', 'oats', 'x'.repeat(200)], note: '  hi  ' } })
    expect(n.heightCm).toBeNull()
    expect(n.sex).toBeNull()
    expect(n.activity).toBe('moderate')
    expect(n.likes).toEqual(['oats', 'x'.repeat(80)])
    expect(n.note).toBe('hi')
    expect(n.wontEat).toEqual([])
  })
  it('keeps a real profile', () => {
    const n = nutritionOf({ nutrition: { heightCm: 178, birthday: '1990-05-01', sex: 'female', goal: 'lose', weeklyKg: 0.25, wontEat: ['pork'] } })
    expect(n).toMatchObject({ heightCm: 178, birthday: '1990-05-01', sex: 'female', goal: 'lose', weeklyKg: 0.25, wontEat: ['pork'] })
  })
  it('leaves an empty custom target and weekly rate empty', () => {
    const n = nutritionOf({ nutrition: { customKcal: null, customProtein: null, weeklyKg: null, heightCm: null } })
    expect(n.customKcal).toBeNull()
    expect(n.customProtein).toBeNull()
    expect(n.weeklyKg).toBeNull()
    expect(n.heightCm).toBeNull()
  })
})

describe('day totals, meals, and serving scale', () => {
  const log = [
    { d: '2026-10-10', kcal: 400, protein: 30, carbs: 40, fat: 10 },
    { d: '2026-10-10', kcal: 100.4, protein: 5.2, carbs: 10, fat: 2 },
    { d: '2026-10-09', kcal: 900, protein: 1, carbs: 1, fat: 1 },
  ]
  it('sums one day', () => {
    expect(dayTotals(log, '2026-10-10')).toEqual({ kcal: 500, protein: 35.2, carbs: 50, fat: 12, meals: 2 })
    expect(dayTotals(log, '2026-10-11').meals).toBe(0)
  })
  it('picks a meal from the hour', () => {
    expect(mealFromTime(new Date(2026, 9, 10, 8, 30))).toBe('breakfast')
    expect(mealFromTime(new Date(2026, 9, 10, 12, 0))).toBe('lunch')
    expect(mealFromTime(new Date(2026, 9, 10, 18, 0))).toBe('dinner')
    expect(mealFromTime(new Date(2026, 9, 10, 22, 0))).toBe('snack')
    expect(mealFromTime(11)).toBe('lunch')
  })
  it('scales from the gram basis and refuses to invent one', () => {
    expect(scaleToGrams({ grams: 100, kcal: 200, protein: 10, carbs: 20, fat: 5, name: 'rice' }, 150)).toMatchObject({
      grams: 150, kcal: 300, protein: 15, carbs: 30, fat: 7.5, name: 'rice',
    })
    const bare = { kcal: 200, name: 'rice' }
    expect(scaleToGrams(bare, 150)).toBe(bare)
    const lined = {
      kcal: 200, name: 'rice',
      ingredients: [{ name: 'rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 100 }],
    }
    expect(scaleToGrams(lined, 150)).toBe(lined)
  })
})

describe('cleanMeal', () => {
  it('keeps a typed meal and drops a blank name', () => {
    const meal = cleanMeal({ name: '  Oats ', kcal: 300, protein: 12.26, meal: 'breakfast', note: ' honey ' }, { day: '2026-10-10', id: 'm1' })
    expect(meal).toMatchObject({ id: 'm1', d: '2026-10-10', name: 'Oats', kcal: 300, protein: 12.3, meal: 'breakfast', source: 'manual', note: 'honey', grams: null, edited: false })
    expect(cleanMeal({ name: '  ', kcal: 10 }, { day: '2026-10-10' })).toBeNull()
    expect(cleanMeal({ name: 'Oats' }, {})).toBeNull()
  })
  it('keeps at most three photos', () => {
    const media = [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }, { hash: 'd' }]
    expect(cleanMeal({ name: 'Plate', media, source: 'photo' }, { day: '2026-10-10' }).media).toHaveLength(3)
  })
  it('sums kept ingredients and drops junk rows', () => {
    const rows = [
      { name: '  oats ', kcal: 150.4, protein: 5, carbs: 27, fat: 3, grams: 40 },
      { name: '', kcal: 50, protein: 1, carbs: 1, fat: 1, grams: 10 },
      { name: 'salt', kcal: -5, protein: 0, carbs: 0, fat: 0, grams: 1 },
      null,
      { name: 'milk', kcal: 80, protein: 4, carbs: 6, fat: 4, grams: 100 },
    ]
    const meal = cleanMeal({ name: 'Bowl', kcal: 999, protein: 1, carbs: 1, fat: 1, grams: 140, ingredients: rows }, { day: '2026-10-10' })
    expect(meal.ingredients).toEqual([
      { name: 'oats', kcal: 150, protein: 5, carbs: 27, fat: 3, grams: 40, qty: 1, unit: 'serving' },
      { name: 'milk', kcal: 80, protein: 4, carbs: 6, fat: 4, grams: 100, qty: 1, unit: 'serving' },
    ])
    expect(meal).toMatchObject({ kcal: 230, protein: 9, carbs: 33, fat: 7, grams: 140 })
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `bit ${i}`, kcal: 10, protein: 1, carbs: 1, fat: 0, grams: 5 }))
    const capped = cleanMeal({ name: 'Plate', kcal: 1, ingredients: many }, { day: '2026-10-10' })
    expect(capped.ingredients).toHaveLength(20)
    expect(capped.kcal).toBe(200)
  })
  it('leaves a meal with no usable ingredients on its own numbers', () => {
    const meal = cleanMeal({ name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 6, ingredients: [{ name: 'nope' }] }, { day: '2026-10-10' })
    expect(meal).toMatchObject({ kcal: 300, protein: 12, carbs: 40, fat: 6, grams: null })
    expect(meal.ingredients).toBeUndefined()
  })
  it('scales ingredient lines with the meal, then one line on its own', () => {
    const meal = cleanMeal({
      name: 'Plate', grams: 200, kcal: 1,
      ingredients: [
        { name: 'rice', kcal: 200, protein: 4, carbs: 44, fat: 0.4, grams: 150 },
        { name: 'chicken', kcal: 100, protein: 20, carbs: 0, fat: 2, grams: 50 },
      ],
    }, { day: '2026-10-10' })
    const half = scaleToGrams(meal, 100)
    expect(half.grams).toBe(100)
    expect(half.ingredients).toEqual([
      { name: 'rice', kcal: 100, protein: 2, carbs: 22, fat: 0.2, grams: 75, qty: 1, unit: 'serving' },
      { name: 'chicken', kcal: 50, protein: 10, carbs: 0, fat: 1, grams: 25, qty: 1, unit: 'serving' },
    ])
    expect(half).toMatchObject({ kcal: 150, protein: 12, carbs: 22, fat: 1.2 })
    const rice = scaleIngredient(meal, 0, 75)
    expect(rice.grams).toBe(200)
    expect(rice.ingredients[0]).toMatchObject({ name: 'rice', grams: 75, kcal: 100, protein: 2, carbs: 22, fat: 0.2 })
    expect(rice.ingredients[1]).toEqual(meal.ingredients[1])
    expect(rice).toMatchObject({ kcal: 200, protein: 22, carbs: 22, fat: 2.2 })
    const noBasis = { ...meal, ingredients: [{ name: 'salt', kcal: 0, protein: 0, carbs: 0, fat: 0 }] }
    expect(scaleIngredient(noBasis, 0, 5)).toBe(noBasis)
    expect(scaleIngredient(meal, 3, 10)).toBe(meal)
  })
  it('keeps the serving and each ingredient amount', () => {
    const meal = cleanMeal({
      name: 'Juice', servingQty: 2, servingUnit: 'cup', kcal: 1,
      ingredients: [{ name: 'juice', kcal: 80, protein: 1, carbs: 18, fat: 0, grams: 240, qty: 2, unit: 'cup' }],
    }, { day: '2026-10-10' })
    expect(meal.servingQty).toBe(2)
    expect(meal.servingUnit).toBe('cup')
    expect(meal.ingredients[0]).toMatchObject({ qty: 2, unit: 'cup', kcal: 80 })
    const junk = cleanMeal({
      name: 'Snack', servingQty: 0, servingUnit: 'bowl', kcal: 100,
      ingredients: [{ name: 'bar', kcal: 100, protein: 2, carbs: 12, fat: 4, grams: 40, unit: 'handful' }],
    }, { day: '2026-10-10' })
    expect(junk.servingQty).toBe(1)
    expect(junk.servingUnit).toBe('serving')
    expect(junk.ingredients[0]).toMatchObject({ qty: 1, unit: 'serving' })
  })
})

describe('serving scale and liquid units', () => {
  const soup = () => cleanMeal({
    name: 'Soup', kcal: 1, grams: 240, servingQty: 1, servingUnit: 'cup',
    ingredients: [
      { name: 'broth', kcal: 40, protein: 2, carbs: 4, fat: 1, grams: 240, qty: 1, unit: 'cup' },
      { name: 'bread', kcal: 60, protein: 3, carbs: 6, fat: 1, grams: 30, qty: 1, unit: 'piece' },
    ],
  }, { day: '2026-10-10' })

  it('doubles calories and ingredient calories when the serving count goes from 1 to 2', () => {
    const meal = soup()
    const doubled = scaleToServings(meal, 2)
    expect(doubled.kcal).toBe(200)
    expect(doubled.servingQty).toBe(2)
    expect(doubled.servingUnit).toBe('cup')
    expect(doubled.ingredients[0]).toMatchObject({ kcal: 80, qty: 2, unit: 'cup', grams: 480 })
    expect(doubled.ingredients[1]).toMatchObject({ kcal: 120, qty: 2, unit: 'piece' })
    const bare = { kcal: 100, name: 'rice' }
    expect(scaleToServings(bare, 2)).toBe(bare)
    expect(scaleToServings({ ...meal, servingQty: 0 }, 2)).toEqual({ ...meal, servingQty: 0 })
  })

  it('turns 1 cup into 240 ml and leaves calories unchanged', () => {
    const meal = soup()
    const ml = convertServingUnit(meal, 'ml')
    expect(ml.servingQty).toBe(240)
    expect(ml.servingUnit).toBe('ml')
    expect(ml.kcal).toBe(meal.kcal)
    expect(ml.protein).toBe(meal.protein)
    expect(ml.ingredients[0]).toMatchObject({ qty: 240, unit: 'ml', kcal: 40 })
    expect(ml.ingredients[1]).toMatchObject({ qty: 1, unit: 'piece', kcal: 60 })
    expect(convertServingUnit(meal, 'g')).toBe(meal)
    expect(convertServingUnit(meal, 'piece')).toBe(meal)
    expect(convertServingUnit({ ...meal, servingUnit: 'slice' }, 'cup')).toEqual({ ...meal, servingUnit: 'slice' })
  })
})

describe('weeklyCalorieNudge', () => {
  // Male, 30, 180 cm, 80 kg, moderate, maintain. TDEE 2607, BMR 1780.
  // Weigh-ins a week apart make a slope of exactly 1 kg/week.
  const foods = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map(d => ({ d, kcal: 2000 }))
  const losing = [
    { d: '2026-09-12', w: 82, t: 1 },
    { d: '2026-09-19', w: 81, t: 1 },
    { d: '2026-09-26', w: 80, t: 1 },
  ]
  const gaining = [
    { d: '2026-09-12', w: 78, t: 1 },
    { d: '2026-09-19', w: 79, t: 1 },
    { d: '2026-09-26', w: 80, t: 1 },
  ]
  const state = (over = {}) => ({
    unit: 'kg',
    bodyweight: losing,
    foodLog: foods,
    nutrition: { heightCm: 180, birthday: '1996-10-10', sex: 'male', activity: 'moderate', goal: 'maintain' },
    ...over,
  })

  it('clamps a large gap to 150 kcal and ignores one under 25', () => {
    const S = state()
    const up = weeklyCalorieNudge(S, '2026-10-10')
    expect(up.proposed).toBe(true)
    expect(up.kcal).toBe(2757)
    expect(up.reason).toContain('+150')
    expect(up.reason).toContain('2757')
    expect(S.nutrition.customKcal).toBeUndefined()
    const flat = state({
      bodyweight: [
        { d: '2026-09-12', w: 80, t: 1 },
        { d: '2026-09-19', w: 80.01, t: 1 },
        { d: '2026-09-26', w: 80.02, t: 1 },
      ],
    })
    const small = weeklyCalorieNudge(flat, '2026-10-10')
    expect(small).toMatchObject({ proposed: false, kcal: null })
  })

  it('will not set calories below the greater of BMR and 1200', () => {
    const atBmr = weeklyCalorieNudge(state({
      bodyweight: gaining,
      nutrition: { heightCm: 180, birthday: '1996-10-10', sex: 'male', activity: 'moderate', goal: 'maintain', customKcal: 1900 },
    }), '2026-10-10')
    expect(atBmr.proposed).toBe(true)
    expect(atBmr.kcal).toBe(1780)
    // 51 kg, 150 cm, female, 30: BMR is under 1,200, so the floor is 1,200.
    const atTwelve = weeklyCalorieNudge(state({
      bodyweight: [
        { d: '2026-09-12', w: 49, t: 1 },
        { d: '2026-09-19', w: 50, t: 1 },
        { d: '2026-09-26', w: 51, t: 1 },
      ],
      nutrition: { heightCm: 150, birthday: '1996-10-10', sex: 'female', activity: 'moderate', goal: 'maintain', customKcal: 1300 },
    }), '2026-10-10')
    expect(atTwelve.proposed).toBe(true)
    expect(atTwelve.kcal).toBe(1200)
  })

  it('will not set calories above TDEE × 1.25', () => {
    const capped = weeklyCalorieNudge(state({
      nutrition: { heightCm: 180, birthday: '1996-10-10', sex: 'male', activity: 'moderate', goal: 'maintain', customKcal: 3200 },
    }), '2026-10-10')
    expect(capped.proposed).toBe(true)
    expect(capped.kcal).toBe(3259)
  })

  it('stays quiet without 4 food days and 3 weigh-ins, and today does not count', () => {
    const threeDays = weeklyCalorieNudge(state({
      foodLog: [
        { d: '2026-10-07', kcal: 2000 },
        { d: '2026-10-08', kcal: 2000 },
        { d: '2026-10-09', kcal: 2000 },
        { d: '2026-10-10', kcal: 2000 },
      ],
    }), '2026-10-10')
    expect(threeDays).toMatchObject({ proposed: false, kcal: null })
    expect(threeDays.reason).toContain('4')
    const todayOnly = weeklyCalorieNudge(state({
      bodyweight: [
        { d: '2026-10-10', w: 80, t: 1 },
        { d: '2026-10-10', w: 79, t: 2 },
        { d: '2026-10-10', w: 78, t: 3 },
      ],
    }), '2026-10-10')
    expect(todayOnly).toMatchObject({ proposed: false, kcal: null })
    const twoWeights = weeklyCalorieNudge(state({ bodyweight: losing.slice(0, 2) }), '2026-10-10')
    expect(twoWeights).toMatchObject({ proposed: false, kcal: null })
  })
})
