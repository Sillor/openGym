// Calorie and macro targets, and the day totals read off a food log.
//
// The formulas are the ones Fud AI uses (MIT, Apoorv Darshan): UserProfile.kt for BMR, TDEE,
// the 7700 kcal/kg adjustment and the macro split, ActivityLevel.kt for the multipliers and the
// protein rates. Integer targets truncate toward zero the way Kotlin's toInt() does. A custom
// number replaces that one target and leaves the others on the formula — macro locks are not
// ported. Nothing here talks to a model or a screen; the diary and the coach both call it.

import { LB_TO_KG } from './recovery.js'

export const KCAL_PER_KG = 7700

// Serial names and rates from ActivityLevel.kt. Moderate is the default for a profile that
// never picked one.
export const ACTIVITIES = {
  sedentary: { multiplier: 1.2, proteinPerKg: 0.8 },
  light: { multiplier: 1.375, proteinPerKg: 1.2 },
  moderate: { multiplier: 1.465, proteinPerKg: 1.6 },
  active: { multiplier: 1.55, proteinPerKg: 1.8 },
  veryActive: { multiplier: 1.725, proteinPerKg: 2.0 },
  extraActive: { multiplier: 1.9, proteinPerKg: 2.2 },
}

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack']

const LIST_MAX = 40
const ITEM_MAX = 80
const NOTE_MAX = 500

const trunc = n => Math.trunc(n)

function numOrNull(v, { min = -Infinity, max = Infinity, int = false } = {}) {
  // Number(null) and Number('') are 0. An empty field must stay empty.
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return int ? trunc(n) : n
}

function cleanList(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const x of v) {
    const s = String(x ?? '').trim().slice(0, ITEM_MAX)
    if (!s || out.includes(s)) continue
    out.push(s)
    if (out.length >= LIST_MAX) break
  }
  return out
}

export function emptyNutrition() {
  return {
    heightCm: null,
    birthday: null,
    sex: null,
    activity: 'moderate',
    goal: null,
    weeklyKg: null,
    customKcal: null,
    customProtein: null,
    customCarbs: null,
    customFat: null,
    likes: [],
    dislikes: [],
    wontEat: [],
    note: '',
  }
}

/** The nutrition profile with every field present and in range. Missing or junk becomes the default. */
export function nutritionOf(S) {
  const raw = S?.nutrition && typeof S.nutrition === 'object' ? S.nutrition : {}
  const sex = raw.sex === 'male' || raw.sex === 'female' ? raw.sex : null
  const activity = Object.prototype.hasOwnProperty.call(ACTIVITIES, raw.activity) ? raw.activity : 'moderate'
  const goal = raw.goal === 'lose' || raw.goal === 'maintain' || raw.goal === 'gain' ? raw.goal : null
  const birthday = typeof raw.birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.birthday) ? raw.birthday : null
  return {
    ...emptyNutrition(),
    heightCm: numOrNull(raw.heightCm, { min: 50, max: 300 }),
    birthday,
    sex,
    activity,
    goal,
    weeklyKg: numOrNull(raw.weeklyKg, { min: 0, max: 5 }),
    customKcal: numOrNull(raw.customKcal, { min: 0, max: 20000, int: true }),
    customProtein: numOrNull(raw.customProtein, { min: 0, max: 1000, int: true }),
    customCarbs: numOrNull(raw.customCarbs, { min: 0, max: 2000, int: true }),
    customFat: numOrNull(raw.customFat, { min: 0, max: 1000, int: true }),
    likes: cleanList(raw.likes),
    dislikes: cleanList(raw.dislikes),
    wontEat: cleanList(raw.wontEat),
    note: typeof raw.note === 'string' ? raw.note.trim().slice(0, NOTE_MAX) : '',
  }
}

function isoDate(d) {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10)
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  return null
}

function parts(iso) {
  const s = isoDate(iso)
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null
  return { y, m, d }
}

/** Whole years from a YYYY-MM-DD birthday to `today` (a date or an ISO day). Null when either is missing. */
export function ageYears(birthday, today) {
  const b = parts(birthday), t = parts(today)
  if (!b || !t) return null
  let age = t.y - b.y
  if (t.m < b.m || (t.m === b.m && t.d < b.d)) age -= 1
  return Math.max(0, age)
}

/** Latest weigh-in in the profile's unit, by day then by edit time. */
export function latestWeighIn(S) {
  const entries = (S?.bodyweight || []).filter(e => e && e.w > 0 && e.d)
  if (!entries.length) return null
  return entries.slice().sort((a, b) => String(a.d).localeCompare(String(b.d)) || (Number(a.t) || 0) - (Number(b.t) || 0)).at(-1)
}

/** Latest body-fat measurement as a fraction in (0, 1], or null. Measurements store a percent. */
export function latestBodyFatFraction(S) {
  const rows = (S?.measurements || []).filter(e => e && e.d && e.bodyFat > 0 && e.bodyFat <= 100)
  if (!rows.length) return null
  const last = rows.slice().sort((a, b) => String(a.d).localeCompare(String(b.d)) || (Number(a.t) || 0) - (Number(b.t) || 0)).at(-1)
  return last.bodyFat / 100
}

/**
 * Which way the calorie target should point. An explicit nutrition goal wins. Otherwise a goal
 * weight on either side of the latest weigh-in, then the coach's fat-loss or muscle goal, then
 * maintain. Weight and target are compared in the same unit the profile stores.
 */
export function inferGoal({ goal, weight, targetW, coachGoal } = {}) {
  if (goal === 'lose' || goal === 'maintain' || goal === 'gain') return { goal, source: 'set' }
  const w = Number(weight)
  // Number(null) is 0, which would look like a goal weight of nothing.
  const t = targetW == null || targetW === '' ? NaN : Number(targetW)
  if (Number.isFinite(w) && w > 0 && Number.isFinite(t) && t > 0) {
    if (t < w - 0.05) return { goal: 'lose', source: 'targetW' }
    if (t > w + 0.05) return { goal: 'gain', source: 'targetW' }
    return { goal: 'maintain', source: 'targetW' }
  }
  if (coachGoal === 'fatloss') return { goal: 'lose', source: 'coach' }
  if (coachGoal === 'muscle') return { goal: 'gain', source: 'coach' }
  return { goal: 'maintain', source: 'default' }
}

/**
 * Daily targets from body stats. Null when a formula input is missing (no weight, or Mifflin
 * without height and age). `bodyFat` is a fraction; when it is set, Katch-McArdle is used and
 * height, age and sex are not required. `weeklyKg` null means 0.5 while losing or gaining.
 */
export function nutritionTargets({
  weightKg, heightCm, age, sex, bodyFat, activity, goal, weeklyKg,
  customKcal, customProtein, customCarbs, customFat,
} = {}) {
  const kg = Number(weightKg)
  if (!(kg > 0)) return null
  const act = ACTIVITIES[activity] || ACTIVITIES.moderate
  const g = goal === 'lose' || goal === 'gain' ? goal : 'maintain'
  let bmr, method, sexAssumed = false
  if (bodyFat > 0 && bodyFat < 1) {
    bmr = 370 + 21.6 * (1 - bodyFat) * kg
    method = 'katch'
  } else {
    const cm = Number(heightCm)
    // null is a missing birthday. Number(null) is 0, which would invent a newborn.
    const years = age == null || age === '' ? NaN : Number(age)
    if (!(cm > 0) || !Number.isFinite(years) || years < 0) return null
    let base = 10 * kg + 6.25 * cm - 5 * years - 161
    if (sex === 'male') base += 166
    else if (sex !== 'female') { base += 83; sexAssumed = true }
    bmr = base
    method = 'mifflin'
  }
  const tdee = trunc(bmr * act.multiplier)
  const rate = g === 'maintain' ? 0 : (weeklyKg == null || !Number.isFinite(Number(weeklyKg)) ? 0.5 : Number(weeklyKg))
  // Negating a truncated zero is -0 in JS; Kotlin's toInt() of 0 stays 0.
  const mag = trunc(rate * KCAL_PER_KG / 7)
  const adjustment = mag === 0 || g === 'maintain' ? 0 : g === 'lose' ? -mag : mag
  const formulaKcal = tdee + adjustment
  const proteinPer = act.proteinPerKg + (g === 'lose' ? 0.2 : 0)
  const formulaProtein = trunc(proteinPer * kg)
  const formulaFat = trunc(0.6 * kg)
  const formulaCarbs = Math.max(0, trunc((formulaKcal - formulaProtein * 4 - formulaFat * 9) / 4))
  const kcal = customKcal == null ? formulaKcal : trunc(customKcal)
  const protein = customProtein == null ? formulaProtein : trunc(customProtein)
  const fat = customFat == null ? formulaFat : trunc(customFat)
  const carbs = customCarbs == null ? formulaCarbs : trunc(customCarbs)
  return {
    kcal, protein, carbs, fat, bmr, tdee, adjustment, method, sexAssumed,
    goal: g, activity: ACTIVITIES[activity] ? activity : 'moderate', weeklyKg: rate,
    formula: { kcal: formulaKcal, protein: formulaProtein, carbs: formulaCarbs, fat: formulaFat },
  }
}

/** Targets for a profile: latest weigh-in, measurements, coach goal, and S.nutrition. */
export function profileTargets(S, today = new Date()) {
  const nutrition = nutritionOf(S)
  const weigh = latestWeighIn(S)
  const inferred = inferGoal({
    goal: nutrition.goal, weight: weigh?.w, targetW: S?.targetW, coachGoal: S?.coach?.profile?.goal,
  })
  const weightKg = weigh ? (S?.unit === 'lb' ? Number(weigh.w) * LB_TO_KG : Number(weigh.w)) : null
  const targets = nutritionTargets({
    weightKg,
    heightCm: nutrition.heightCm,
    age: ageYears(nutrition.birthday, today),
    sex: nutrition.sex,
    bodyFat: latestBodyFatFraction(S),
    activity: nutrition.activity,
    goal: inferred.goal,
    weeklyKg: nutrition.weeklyKg,
    customKcal: nutrition.customKcal,
    customProtein: nutrition.customProtein,
    customCarbs: nutrition.customCarbs,
    customFat: nutrition.customFat,
  })
  return { nutrition, goal: inferred.goal, goalSource: inferred.source, weightKg, targets }
}

/** Why the settings page can or cannot show a target. `missing` is weight, height, or birthday. */
export function targetExplain(S, today = new Date()) {
  const r = profileTargets(S, today)
  const fat = latestBodyFatFraction(S)
  if (!r.targets) {
    if (r.weightKg == null) return { ok: false, missing: 'weight' }
    if (!fat && r.nutrition.heightCm == null) return { ok: false, missing: 'height' }
    if (!fat && r.nutrition.birthday == null) return { ok: false, missing: 'birthday' }
    return { ok: false, missing: 'stats' }
  }
  return {
    ok: true,
    kcal: r.targets.kcal,
    protein: r.targets.protein,
    carbs: r.targets.carbs,
    fat: r.targets.fat,
    goal: r.goal,
    goalSource: r.goalSource,
    weeklyKg: r.targets.weeklyKg,
    sexAssumed: r.targets.sexAssumed,
    method: r.targets.method,
    customKcal: r.nutrition.customKcal != null,
    heightCm: r.nutrition.heightCm,
  }
}

/** A weekly rate stored in kg, shown in the profile's weight unit. */
export function weeklyInUnit(kg, unit) {
  if (kg == null || !Number.isFinite(Number(kg))) return null
  const n = Number(kg)
  return unit === 'lb' ? Math.round((n / LB_TO_KG) * 100) / 100 : Math.round(n * 100) / 100
}

/** A weekly rate typed in the profile's unit, stored in kg. */
export function weeklyFromUnit(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return null
  const n = Number(value)
  const kg = unit === 'lb' ? n * LB_TO_KG : n
  return Math.round(kg * 1000) / 1000
}

/** Breakfast before 11:00, lunch before 15:00, dinner before 21:00, otherwise a snack. Local time. */
export function mealFromTime(date) {
  const h = date instanceof Date ? date.getHours() : Number(date)
  if (!(h >= 0)) return 'snack'
  if (h < 11) return 'breakfast'
  if (h < 15) return 'lunch'
  if (h < 21) return 'dinner'
  return 'snack'
}

const round1 = n => Math.round(n * 10) / 10

/** Sum of one day's log. `day` is YYYY-MM-DD. */
export function dayTotals(log, day) {
  const rows = (log || []).filter(e => e && e.d === day)
  const sum = k => rows.reduce((n, e) => n + (Number(e[k]) || 0), 0)
  return {
    kcal: Math.round(sum('kcal')),
    protein: round1(sum('protein')),
    carbs: round1(sum('carbs')),
    fat: round1(sum('fat')),
    meals: rows.length,
  }
}

const MEAL_SOURCES = ['photo', 'text', 'barcode', 'manual']

function mealNum(v, max, dec) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return dec ? 0 : 0
  const c = Math.min(n, max)
  return dec ? Math.round(c * 10) / 10 : Math.round(c)
}

/**
 * A food-log entry ready to store. Null when the name or the day is missing.
 * `edited` stays set once the person changes a number the model suggested.
 */
export function cleanMeal(raw, { day, id, source } = {}) {
  const name = String(raw?.name ?? '').trim().slice(0, 120)
  const d = typeof (raw?.d || day) === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw?.d || day) ? (raw?.d || day) : null
  if (!name || !d) return null
  const meal = MEALS.includes(raw?.meal) ? raw.meal : 'snack'
  const src = MEAL_SOURCES.includes(raw?.source) ? raw.source : (MEAL_SOURCES.includes(source) ? source : 'manual')
  const grams = raw?.grams == null || raw?.grams === '' ? null : mealNum(raw.grams, 10000, true)
  const media = Array.isArray(raw?.media) ? raw.media.filter(m => m && typeof m === 'object').slice(0, 3) : []
  return {
    id: raw?.id || id,
    d,
    t: Number(raw?.t) || Date.now(),
    name,
    kcal: mealNum(raw?.kcal, 20000, false),
    protein: mealNum(raw?.protein, 2000, true),
    carbs: mealNum(raw?.carbs, 2000, true),
    fat: mealNum(raw?.fat, 2000, true),
    grams,
    meal,
    source: src,
    note: String(raw?.note ?? '').trim().slice(0, 280),
    media,
    edited: !!raw?.edited,
  }
}

/**
 * Scale kcal and macros from the entry's gram basis to `grams`. Unchanged when the entry has
 * no positive gram basis — there is nothing honest to scale from.
 */
export function scaleToGrams(entry, grams) {
  const from = Number(entry?.grams)
  const to = Number(grams)
  if (!(from > 0) || !(to >= 0) || !entry) return entry
  const f = to / from
  const scale = n => round1((Number(n) || 0) * f)
  return {
    ...entry,
    grams: to,
    kcal: Math.round((Number(entry.kcal) || 0) * f),
    protein: scale(entry.protein),
    carbs: scale(entry.carbs),
    fat: scale(entry.fat),
  }
}
