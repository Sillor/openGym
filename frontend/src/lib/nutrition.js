// Calorie and macro targets, and the day totals read off a food log.
//
// The formulas are the ones Fud AI uses (MIT, Apoorv Darshan): UserProfile.kt for BMR, TDEE,
// the 7700 kcal/kg adjustment and the macro split, ActivityLevel.kt for the multipliers and the
// protein rates. Integer targets truncate toward zero the way Kotlin's toInt() does. A custom
// number replaces that one target and leaves the others on the formula — macro locks are not
// ported. Nothing here talks to a model or a screen; the diary and the coach both call it.

import { LB_TO_KG } from './recovery.js'
import { MASS_G } from './food-json.js'
import { amountOf, cleanUnits, gramsPer, isCount, isMass, normalizeUnit } from './food-units.js'

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
const INGREDIENT_MAX = 20
const LOOKBACK_DAYS = 90
const MIN_FOOD_DAYS = 4
const MIN_WEIGH_INS = 3
const MIN_DAILY_ADJUSTMENT = 25
const MAX_DAILY_ADJUSTMENT = 150
const KCAL_FLOOR = 1200

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
  // Carbs fill whatever the calorie target leaves, so a custom target still adds up.
  const carbs = customCarbs != null ? trunc(customCarbs)
    : customKcal == null && customProtein == null && customFat == null ? formulaCarbs
      : Math.max(0, trunc((kcal - protein * 4 - fat * 9) / 4))
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

function dayIndex(iso) {
  const p = parts(iso)
  if (!p) return null
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86400000)
}

/** Last 90 completed days: yesterday back through 89 days before that. Today is outside. */
function inLookback(iso, todayIso) {
  const t = dayIndex(todayIso)
  const d = dayIndex(iso)
  if (t == null || d == null) return false
  const end = t - 1
  const start = end - (LOOKBACK_DAYS - 1)
  return d >= start && d <= end
}

function loggedFoodDays(log, todayIso) {
  const days = new Set()
  for (const e of log || []) {
    if (e && inLookback(e.d, todayIso)) days.add(e.d)
  }
  return days.size
}

function trendWeights(S, todayIso) {
  const lb = S?.unit === 'lb'
  const out = []
  for (const e of S?.bodyweight || []) {
    if (!e || !(e.w > 0) || !inLookback(e.d, todayIso)) continue
    const kg = lb ? Number(e.w) * LB_TO_KG : Number(e.w)
    const x = dayIndex(e.d)
    if (!(kg > 0) || x == null) continue
    out.push({ x, y: kg })
  }
  return out
}

/**
 * Least-squares slope in kg/day. Weigh-ins are a calendar day, so x is that day and the slope
 * is already per day. WeightAnalysisService uses epoch seconds and multiplies by 86400; one
 * point per day at the same time of day gives the same slope. Null when fewer than two points
 * or every point falls on the same day.
 */
function slopeKgPerDay(points) {
  if (points.length < 2) return null
  const n = points.length
  let sumX = 0, sumY = 0
  for (const p of points) { sumX += p.x; sumY += p.y }
  const meanX = sumX / n, meanY = sumY / n
  let num = 0, den = 0
  for (const p of points) {
    const dx = p.x - meanX
    num += dx * (p.y - meanY)
    den += dx * dx
  }
  if (den === 0) return null
  return num / den
}

function nudge(proposed, kcal, reason) {
  return { proposed, kcal, reason }
}

/**
 * A suggested calorie change from the recent weight slope. Does not write state.
 * Needs 4 logged food days and 3 weigh-ins in the last 90 days, excluding today.
 * The gap between the target weekly rate and the observed slope, in kcal/day, is rounded
 * and clamped to ±150, and kept only when it is at least 25. The floor is the greater of
 * BMR and 1,200. The ceiling is TDEE × 1.25. There is no measured-burn input.
 * `kcal` is the proposed target, or null when nothing is proposed. Accepting it (writing
 * customKcal) is left to the screen.
 */
export function weeklyCalorieNudge(S, today = new Date()) {
  const day = isoDate(today)
  const foodDays = day ? loggedFoodDays(S?.foodLog, day) : 0
  const weights = day ? trendWeights(S, day) : []
  const slope = slopeKgPerDay(weights)
  const observedWeekly = slope == null ? null : slope * 7
  if (foodDays < MIN_FOOD_DAYS || weights.length < MIN_WEIGH_INS || observedWeekly == null) {
    return nudge(false, null, 'It needs at least 4 logged food days and 3 weigh-ins in the last 90 days, not counting today, before it can suggest a change.')
  }
  const { targets, goal } = profileTargets(S, day)
  if (!targets) return nudge(false, null, 'There is no calorie target yet, so no change is suggested.')
  const targetWeekly = goal === 'lose' ? -targets.weeklyKg : goal === 'gain' ? targets.weeklyKg : 0
  const raw = (targetWeekly - observedWeekly) * KCAL_PER_KG / 7
  const limited = Math.max(-MAX_DAILY_ADJUSTMENT, Math.min(MAX_DAILY_ADJUSTMENT, Math.round(raw)))
  if (Math.abs(limited) < MIN_DAILY_ADJUSTMENT) {
    return nudge(false, null, 'Your recent trend is close to your goal pace, so no calorie change is suggested.')
  }
  const current = targets.kcal
  const floor = Math.max(Math.round(targets.bmr), KCAL_FLOOR)
  const ceiling = Math.max(floor, Math.round(targets.tdee * 1.25))
  if (limited < 0 && current <= floor) {
    return nudge(false, null, 'Calories were not lowered because the current target is already at the safety floor.')
  }
  if (limited > 0 && current >= ceiling) {
    return nudge(false, null, 'Calories were not raised because the current target is already at the safety ceiling.')
  }
  const proposedCalories = current + limited
  const adjusted = limited < 0 ? Math.max(proposedCalories, floor) : Math.min(proposedCalories, ceiling)
  if (adjusted === current) {
    return nudge(false, null, 'The trend was checked, but the safety limits kept the calorie target unchanged.')
  }
  const delta = adjusted - current
  const sign = delta > 0 ? '+' : ''
  return nudge(true, adjusted, `Suggested ${sign}${delta} kcal, which would set the target to ${adjusted} kcal based on your recent weight trend.`)
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
const GRAMS_MAX = 10000
const round3 = n => Math.round(n * 1000) / 1000

function mealNum(v, max, dec) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  const c = Math.min(n, max)
  return dec ? round1(c) : Math.round(c)
}

/**
 * The amount made consistent. Grams win: the count is re-read from them in the picked unit.
 * A weighed amount with no gram field ("150 g") gives its grams. With no weight at all the
 * amount is a count, and nothing invents grams for it.
 *
 * Entries saved before units existed have no `units` list. Their ingredients were all stored
 * as "1 serving" next to a real weight, so those read as grams; any other unit they carried
 * becomes a unit of grams ÷ count.
 */
function cleanAmount(raw, meal) {
  const legacy = raw?.units === undefined
  let grams = Number(raw?.grams) > 0 ? Math.min(Number(raw.grams), GRAMS_MAX) : null
  let unit = normalizeUnit(meal ? raw?.servingUnit : raw?.unit)
  let qty = Number(meal ? raw?.servingQty : raw?.qty)
  qty = Number.isFinite(qty) && qty > 0 ? qty : null
  let units = cleanUnits(raw?.units)
  if (!grams && unit && qty && isMass(unit)) grams = Math.min(qty * MASS_G[unit], GRAMS_MAX)
  if (!grams) return { grams: null, qty: round3(qty || 1), unit: unit && !isMass(unit) ? unit : 'serving', units }
  if (legacy && unit && unit !== 'g' && !isMass(unit)) {
    if (!meal && unit === 'serving') unit = 'g'
    else units = cleanUnits([{ unit, g: grams / (qty || 1) }, ...units])
  }
  if (!unit) unit = units[0]?.unit || (meal ? 'serving' : 'g')
  let per = gramsPer(itemOf(meal, grams, unit, qty, units), unit)
  if (!(per > 0)) {
    // A count with no size yet: this amount defines it.
    units = cleanUnits([{ unit, g: grams / (qty || 1) }, ...units])
    per = grams / (qty || 1)
  }
  return { grams: round1(grams), qty: round3(grams / per), unit, units }
}

function itemOf(meal, grams, unit, qty, units) {
  return meal ? { grams, servingUnit: unit, servingQty: qty, units } : { grams, unit, qty, units }
}

function cleanIngredient(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = String(raw.name ?? '').trim().slice(0, 120)
  if (!name) return null
  const a = cleanAmount(raw, false)
  // An emptied field is 0, never a reason to lose the line.
  return {
    name,
    kcal: mealNum(raw.kcal, 20000, false),
    protein: mealNum(raw.protein, 2000, true),
    carbs: mealNum(raw.carbs, 2000, true),
    fat: mealNum(raw.fat, 2000, true),
    grams: a.grams,
    qty: a.qty,
    unit: a.unit,
    units: a.units,
  }
}

function cleanIngredients(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const row of raw) {
    const item = cleanIngredient(row)
    if (!item) continue
    out.push(item)
    if (out.length >= INGREDIENT_MAX) break
  }
  return out
}

function ingredientTotals(list) {
  let kcal = 0, protein = 0, carbs = 0, fat = 0
  for (const item of list) {
    kcal += Number(item.kcal) || 0
    protein += Number(item.protein) || 0
    carbs += Number(item.carbs) || 0
    fat += Number(item.fat) || 0
  }
  return { kcal: Math.round(kcal), protein: round1(protein), carbs: round1(carbs), fat: round1(fat) }
}

/**
 * The meal with these ingredients: its calories and macros are their sum, and its weight is
 * theirs too when every line has one. The meal keeps reading as the same count ("1 bowl")
 * — the bowl just holds more or less — unless it is shown as a weight or a volume.
 */
export function withIngredients(meal, ingredients) {
  const list = Array.isArray(ingredients) ? ingredients : []
  if (!list.length) return { ...meal, ingredients: [] }
  const next = { ...meal, ...ingredientTotals(list), ingredients: list }
  const known = list.every(r => Number(r.grams) > 0)
  if (!known) return next
  const grams = round1(list.reduce((n, r) => n + Number(r.grams), 0))
  return regram(next, grams)
}

/** Set a meal's weight without scaling its food: count units grow with it, the count stays. */
function regram(meal, grams) {
  const a = amountOf(meal)
  if (a.grams === grams) return meal
  let units = a.units
  if (a.grams) {
    const f = grams / a.grams
    units = cleanUnits(units.map(u => (isCount(u.unit) ? { ...u, g: u.g * f } : u)))
  } else if (isCount(a.unit)) {
    units = cleanUnits([{ unit: a.unit, g: grams / (a.qty || 1) }, ...units])
  }
  const per = gramsPer({ grams, servingUnit: a.unit, units }, a.unit)
  const unit = per > 0 ? a.unit : 'g'
  const qty = per > 0 ? grams / per : grams
  return { ...meal, grams, units, servingUnit: unit, servingQty: round3(qty) }
}

/**
 * A food-log entry ready to store. Null when the name or the day is missing.
 * `edited` stays set once the person changes a number the model suggested.
 * Up to 20 ingredients are kept; a line with an empty number keeps it as 0. When any remain,
 * calories, macros and (when every line is weighed) grams are their sum.
 * `servingQty`/`servingUnit` is how the amount is shown; `units` lists `{ unit, g }`.
 */
export function cleanMeal(raw, { day, id, source } = {}) {
  const name = String(raw?.name ?? '').trim().slice(0, 120)
  const d = typeof (raw?.d || day) === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw?.d || day) ? (raw?.d || day) : null
  if (!name || !d) return null
  const meal = MEALS.includes(raw?.meal) ? raw.meal : 'snack'
  const src = MEAL_SOURCES.includes(raw?.source) ? raw.source : (MEAL_SOURCES.includes(source) ? source : 'manual')
  const media = Array.isArray(raw?.media) ? raw.media.filter(m => m && typeof m === 'object').slice(0, 3) : []
  const a = cleanAmount(raw, true)
  const entry = {
    id: raw?.id || id,
    d,
    t: Number(raw?.t) || Date.now(),
    // When it was eaten. `t` doubles as the sync stamp and moves with every edit; this does not.
    at: Number(raw?.at) || Number(raw?.t) || Date.now(),
    name,
    kcal: mealNum(raw?.kcal, 20000, false),
    protein: mealNum(raw?.protein, 2000, true),
    carbs: mealNum(raw?.carbs, 2000, true),
    fat: mealNum(raw?.fat, 2000, true),
    grams: a.grams,
    servingQty: a.qty,
    servingUnit: a.unit,
    units: a.units,
    meal,
    source: src,
    note: String(raw?.note ?? '').trim().slice(0, 280),
    media,
    edited: !!raw?.edited,
  }
  const ingredients = cleanIngredients(raw?.ingredients)
  if (!ingredients.length) return entry
  return withIngredients(entry, ingredients)
}

function scaleNumbers(item, f) {
  return {
    ...item,
    kcal: Math.round((Number(item?.kcal) || 0) * f),
    protein: round1((Number(item?.protein) || 0) * f),
    carbs: round1((Number(item?.carbs) || 0) * f),
    fat: round1((Number(item?.fat) || 0) * f),
  }
}

/** One line `f` times as big, still in its own unit. */
function scaleLine(row, f) {
  const next = scaleNumbers(row, f)
  const grams = Number(row.grams)
  if (grams > 0) {
    next.grams = round1(grams * f)
    const per = gramsPer(row, row.unit)
    next.qty = round3(per > 0 ? next.grams / per : (Number(row.qty) || 1) * f)
  } else next.qty = round3((Number(row.qty) || 1) * f)
  return next
}

/**
 * The same food at a new amount, scaled from `base` — a snapshot taken when editing started,
 * so typing 1, 15, 150 never compounds. Works for a meal or an ingredient. With a weight, the
 * amount becomes grams through the unit; without one, it scales by the count. Unchanged when
 * the amount is not positive or the unit cannot be measured.
 */
export function resize(base, qty, unit) {
  const to = Number(qty)
  if (!base || !(to > 0)) return base
  const meal = 'servingUnit' in base || 'servingQty' in base
  const a = amountOf(base)
  const u = normalizeUnit(unit) || a.unit
  let f, grams = null
  const per = a.grams ? gramsPer(base, u) : null
  if (per > 0) { grams = to * per; f = grams / a.grams }
  else if (u === a.unit) f = to / (a.qty || 1)
  else return base
  let next = scaleNumbers(base, f)
  if (meal) {
    next.servingQty = round3(to)
    next.servingUnit = u
  } else {
    next.qty = round3(to)
    next.unit = u
  }
  next.grams = grams != null ? round1(grams) : a.grams
  const list = base.ingredients
  if (meal && Array.isArray(list) && list.length) {
    next = { ...next, ...ingredientTotals(list.map(r => scaleLine(r, f))), ingredients: list.map(r => scaleLine(r, f)) }
  }
  return next
}

/** Show the same amount in another unit. Calories never change. Unchanged without a weight. */
export function changeUnit(item, unit) {
  const u = normalizeUnit(unit)
  const a = amountOf(item)
  if (!item || !u || !a.grams) return item
  const per = gramsPer(item, u)
  if (!(per > 0)) return item
  const qty = round3(a.grams / per)
  return 'servingUnit' in item || 'servingQty' in item
    ? { ...item, servingQty: qty, servingUnit: u }
    : { ...item, qty, unit: u }
}

/**
 * A typed meal total ("this is 600 kcal") spread over the ingredients in proportion to what
 * each already has. When they all had 0 of it, it is shared by weight, or evenly.
 */
export function setMealTotal(meal, key, value) {
  const to = Math.max(0, Number(value) || 0)
  const list = meal?.ingredients
  if (!Array.isArray(list) || !list.length) return { ...meal, [key]: key === 'kcal' ? Math.round(to) : round1(to) }
  const from = list.reduce((n, r) => n + (Number(r[key]) || 0), 0)
  const weight = list.reduce((n, r) => n + (Number(r.grams) || 0), 0)
  const share = r => from > 0 ? (Number(r[key]) || 0) / from
    : weight > 0 ? (Number(r.grams) || 0) / weight : 1 / list.length
  const rnd = key === 'kcal' ? Math.round : round1
  return withIngredients(meal, list.map(r => ({ ...r, [key]: rnd(to * share(r)) })))
}
