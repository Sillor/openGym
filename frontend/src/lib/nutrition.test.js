import { describe, expect, it } from 'vitest'
import {
  ageYears, cleanMeal, dayTotals, inferGoal, mealFromTime, nutritionOf, nutritionTargets, profileTargets, scaleToGrams, targetExplain, weeklyFromUnit, weeklyInUnit,
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
})
