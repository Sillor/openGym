import { describe, expect, it } from 'vitest'
import {
  ageYears, changeUnit, cleanMeal, dayTotals, inferGoal, mealFromTime, nutritionOf, nutritionTargets, profileTargets, resize, setMealTotal, targetExplain, withIngredients, weeklyCalorieNudge, weeklyFromUnit, weeklyInUnit,
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

  it('lets a custom number replace that target, with carbs filling what the calories leave', () => {
    const t = nutritionTargets({ ...male, customKcal: 2000, customProtein: 160 })
    expect(t.kcal).toBe(2000)
    expect(t.protein).toBe(160)
    expect(t.fat).toBe(48)
    // trunc((2000 - 160*4 - 48*9) / 4)
    expect(t.carbs).toBe(232)
    expect(nutritionTargets({ ...male, customKcal: 2000, customCarbs: 300 }).carbs).toBe(300)
    expect(nutritionTargets(male).carbs).toBe(415)
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
})

describe('cleanMeal', () => {
  it('keeps a typed meal and drops a blank name', () => {
    const meal = cleanMeal({ name: '  Oats ', kcal: 300, protein: 12.26, meal: 'breakfast', note: ' honey ' }, { day: '2026-10-10', id: 'm1' })
    expect(meal).toMatchObject({ id: 'm1', d: '2026-10-10', name: 'Oats', kcal: 300, protein: 12.3, meal: 'breakfast', source: 'manual', note: 'honey', grams: null, servingQty: 1, servingUnit: 'serving', edited: false })
    expect(cleanMeal({ name: '  ', kcal: 10 }, { day: '2026-10-10' })).toBeNull()
    expect(cleanMeal({ name: 'Oats' }, {})).toBeNull()
  })
  it('keeps at most three photos', () => {
    const media = [{ hash: 'a' }, { hash: 'b' }, { hash: 'c' }, { hash: 'd' }]
    expect(cleanMeal({ name: 'Plate', media, source: 'photo' }, { day: '2026-10-10' }).media).toHaveLength(3)
  })
  it('sums ingredients, keeps a line with an emptied number, and drops a nameless one', () => {
    const rows = [
      { name: '  oats ', kcal: 150.4, protein: 5, carbs: 27, fat: 3, grams: 40, qty: 40, unit: 'g', units: [] },
      { name: '', kcal: 50, protein: 1, carbs: 1, fat: 1, grams: 10 },
      { name: 'milk', kcal: 80, protein: null, carbs: '', fat: 4, grams: 100, qty: 100, unit: 'ml', units: [{ unit: 'ml', g: 1 }] },
      null,
    ]
    const meal = cleanMeal({ name: 'Bowl', kcal: 999, protein: 1, carbs: 1, fat: 1, grams: 300, ingredients: rows }, { day: '2026-10-10' })
    expect(meal.ingredients).toEqual([
      { name: 'oats', kcal: 150, protein: 5, carbs: 27, fat: 3, grams: 40, qty: 40, unit: 'g', units: [] },
      { name: 'milk', kcal: 80, protein: 0, carbs: 0, fat: 4, grams: 100, qty: 100, unit: 'ml', units: [{ unit: 'ml', g: 1 }] },
    ])
    // Every line is weighed, so the meal weighs what they weigh.
    expect(meal).toMatchObject({ kcal: 230, protein: 5, carbs: 27, fat: 7, grams: 140 })
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `bit ${i}`, kcal: 10, protein: 1, carbs: 1, fat: 0, grams: 5 }))
    const capped = cleanMeal({ name: 'Plate', kcal: 1, ingredients: many }, { day: '2026-10-10' })
    expect(capped.ingredients).toHaveLength(20)
    expect(capped.kcal).toBe(200)
  })
  it('keeps a line with no weight as a count', () => {
    const meal = cleanMeal({ name: 'Plate', grams: 300, ingredients: [
      { name: 'rice', kcal: 200, grams: 150, qty: 150, unit: 'g', units: [] },
      { name: 'sauce', kcal: 60, qty: 2, unit: 'tbsp' },
    ] }, { day: '2026-10-10' })
    expect(meal.ingredients[1]).toMatchObject({ grams: null, qty: 2, unit: 'tbsp' })
    expect(meal).toMatchObject({ kcal: 260, grams: 300 })
  })
  it('reads an entry saved before units existed', () => {
    const meal = cleanMeal({
      name: 'Plate', grams: 250, servingQty: 1, servingUnit: 'serving', kcal: 1,
      ingredients: [
        { name: 'chicken', kcal: 200, protein: 25, carbs: 0, fat: 8, grams: 150, qty: 1, unit: 'serving' },
        { name: 'juice', kcal: 100, protein: 1, carbs: 24, fat: 0, grams: 240, qty: 2, unit: 'cup' },
      ],
    }, { day: '2026-10-10' })
    expect(meal.ingredients[0]).toMatchObject({ qty: 150, unit: 'g', grams: 150 })
    expect(meal.ingredients[1]).toMatchObject({ qty: 2, unit: 'cup', units: [{ unit: 'cup', g: 120 }] })
    // The bowl grew to hold what the lines weigh; it is still one serving.
    expect(meal).toMatchObject({ grams: 390, servingQty: 1, servingUnit: 'serving', units: [{ unit: 'serving', g: 390 }] })
    expect(cleanMeal(meal, { day: '2026-10-10' })).toEqual(meal)
  })
  it('re-reads the count from the weight, and junk amounts become one serving', () => {
    const pizza = cleanMeal({ name: 'Pizza', kcal: 600, grams: 300, servingQty: 9, servingUnit: 'slices', units: [{ unit: 'slice', g: 100 }] }, { day: '2026-10-10' })
    expect(pizza).toMatchObject({ servingQty: 3, servingUnit: 'slice' })
    const weighed = cleanMeal({ name: 'Rice', kcal: 260, servingQty: 200, servingUnit: 'g' }, { day: '2026-10-10' })
    expect(weighed).toMatchObject({ grams: 200, servingQty: 200, servingUnit: 'g' })
    const junk = cleanMeal({ name: 'Snack', servingQty: 0, servingUnit: '!!', kcal: 100 }, { day: '2026-10-10' })
    expect(junk).toMatchObject({ servingQty: 1, servingUnit: 'serving', grams: null })
  })
})

describe('resize and changeUnit', () => {
  const plate = () => cleanMeal({
    name: 'Plate', servingQty: 1, servingUnit: 'bowl', units: [{ unit: 'bowl', g: 200 }], kcal: 1,
    ingredients: [
      { name: 'rice', kcal: 200, protein: 4, carbs: 44, fat: 0.4, grams: 150, qty: 0.75, unit: 'cup', units: [{ unit: 'cup', g: 200 }] },
      { name: 'chicken', kcal: 100, protein: 20, carbs: 0, fat: 2, grams: 50, qty: 50, unit: 'g', units: [] },
    ],
  }, { day: '2026-10-10' })

  it('scales a meal and each line from the new count, in their own units', () => {
    const two = resize(plate(), 2, 'bowl')
    expect(two).toMatchObject({ servingQty: 2, servingUnit: 'bowl', grams: 400, kcal: 600, protein: 48 })
    expect(two.ingredients[0]).toMatchObject({ grams: 300, qty: 1.5, unit: 'cup', kcal: 400 })
    expect(two.ingredients[1]).toMatchObject({ grams: 100, qty: 100, unit: 'g', kcal: 200 })
  })
  it('scales from grams typed in another unit', () => {
    const g = resize(plate(), 100, 'g')
    expect(g).toMatchObject({ servingQty: 100, servingUnit: 'g', grams: 100, kcal: 150 })
  })
  it('never compounds when typing through 1, 15, 150', () => {
    const base = plate().ingredients[1]
    const steps = [1, 15, 150].map(n => resize(base, n, 'g'))
    expect(steps[2]).toMatchObject({ grams: 150, qty: 150, kcal: 300, protein: 60 })
  })
  it('scales a count with no weight by the count', () => {
    const bar = { name: 'bar', kcal: 200, protein: 10, carbs: 20, fat: 8, grams: null, qty: 1, unit: 'piece', units: [] }
    expect(resize(bar, 1.5, 'piece')).toMatchObject({ kcal: 300, qty: 1.5, grams: null })
    expect(resize(bar, 1.5, 'g')).toBe(bar)
    expect(resize(bar, 0, 'piece')).toBe(bar)
  })
  it('switches unit without touching calories', () => {
    const rice = plate().ingredients[0]
    const g = changeUnit(rice, 'g')
    expect(g).toMatchObject({ qty: 150, unit: 'g', kcal: 200, grams: 150 })
    expect(changeUnit(g, 'cup')).toMatchObject({ qty: 0.75, unit: 'cup', kcal: 200 })
    const juice = { name: 'juice', kcal: 100, grams: 250, qty: 250, unit: 'ml', units: [{ unit: 'ml', g: 1.04 }] }
    expect(changeUnit(juice, 'cup').qty).toBeCloseTo(250 / (1.04 * 240), 3)
    const bar = { name: 'bar', kcal: 200, grams: null, qty: 1, unit: 'piece', units: [] }
    expect(changeUnit(bar, 'g')).toBe(bar)
  })
})

describe('withIngredients and setMealTotal', () => {
  const meal = () => cleanMeal({
    name: 'Bowl', servingQty: 1, servingUnit: 'bowl', units: [{ unit: 'bowl', g: 250 }], kcal: 1,
    ingredients: [
      { name: 'rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150, qty: 150, unit: 'g', units: [] },
      { name: 'beans', kcal: 100, protein: 6, carbs: 18, fat: 0, grams: 100, qty: 100, unit: 'g', units: [] },
    ],
  }, { day: '2026-10-10' })

  it('keeps the meal one bowl when a line grows, and follows its weight', () => {
    const m = meal()
    const more = withIngredients(m, [resize(m.ingredients[0], 300, 'g'), m.ingredients[1]])
    expect(more).toMatchObject({ kcal: 500, grams: 400, servingQty: 1, servingUnit: 'bowl', units: [{ unit: 'bowl', g: 400 }] })
    const gramsShown = withIngredients(changeUnit(m, 'g'), [m.ingredients[1]])
    expect(gramsShown).toMatchObject({ grams: 100, servingQty: 100, servingUnit: 'g', kcal: 100 })
    expect(withIngredients(m, []).ingredients).toEqual([])
  })
  it('spreads a typed total over the lines', () => {
    const m = setMealTotal(meal(), 'kcal', 600)
    expect(m.ingredients.map(r => r.kcal)).toEqual([400, 200])
    expect(m.kcal).toBe(600)
    const fat = setMealTotal(meal(), 'fat', 10)
    expect(fat.ingredients.map(r => r.fat)).toEqual([10, 0])
    const sugarless = { ...meal(), ingredients: meal().ingredients.map(r => ({ ...r, protein: 0 })) }
    expect(setMealTotal(sugarless, 'protein', 25).ingredients.map(r => r.protein)).toEqual([15, 10])
    expect(setMealTotal({ name: 'x', kcal: 5 }, 'kcal', 99.6)).toEqual({ name: 'x', kcal: 100 })
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
