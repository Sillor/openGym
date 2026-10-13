/* Bounded nutrition summary for the Coach and the MCP bridge.
 *
 * Formula constants and the rounding are copied from frontend/src/lib/nutrition.js
 * (Mifflin–St Jeor / Katch–McArdle, 7700 kcal per kg per week, activity multipliers,
 * Kotlin-style trunc). The api image does not import the Vite frontend. If you change
 * the formula, change both, and keep api/test/nutrition-summary.test.js and
 * frontend/src/lib/coach-parity.test.js in step.
 *
 * Photos, vision prompts, gram bases and meal notes never leave this function.
 */

const KCAL_PER_KG = 7700
// frontend/src/lib/recovery.js LB_TO_KG — weigh-ins in lb become kg before the formula.
const LB_TO_KG = 0.45359237

const ACTIVITIES = {
  sedentary: { multiplier: 1.2, proteinPerKg: 0.8 },
  light: { multiplier: 1.375, proteinPerKg: 1.2 },
  moderate: { multiplier: 1.465, proteinPerKg: 1.6 },
  active: { multiplier: 1.55, proteinPerKg: 1.8 },
  veryActive: { multiplier: 1.725, proteinPerKg: 2.0 },
  extraActive: { multiplier: 1.9, proteinPerKg: 2.2 },
}

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack']
const LIST_MAX = 40
const ITEM_MAX = 80
const NOTE_MAX = 500
const MEAL_NAME_MAX = 80
export const NUTRITION_WINDOW_DAYS = 28
export const TODAY_MEALS_MAX = 12

const trunc = n => Math.trunc(n)

function numOrNull(v, { min = -Infinity, max = Infinity, int = false } = {}) {
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

function isoDay(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
}

function isoFromDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function shiftISO(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function parts(iso) {
  const s = isoDay(iso)
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null
  return { y, m, d }
}

function ageYears(birthday, today) {
  const b = parts(birthday), t = parts(today)
  if (!b || !t) return null
  let age = t.y - b.y
  if (t.m < b.m || (t.m === b.m && t.d < b.d)) age -= 1
  return Math.max(0, age)
}

function nutritionOf(S) {
  const raw = S?.nutrition && typeof S.nutrition === 'object' ? S.nutrition : {}
  const sex = raw.sex === 'male' || raw.sex === 'female' ? raw.sex : null
  const activity = Object.prototype.hasOwnProperty.call(ACTIVITIES, raw.activity) ? raw.activity : 'moderate'
  const goal = raw.goal === 'lose' || raw.goal === 'maintain' || raw.goal === 'gain' ? raw.goal : null
  const birthday = typeof raw.birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.birthday) ? raw.birthday : null
  return {
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

function latestWeighIn(S) {
  const entries = (Array.isArray(S?.bodyweight) ? S.bodyweight : []).filter(e => e && e.w > 0 && e.d)
  if (!entries.length) return null
  return entries.slice().sort((a, b) => String(a.d).localeCompare(String(b.d)) || (Number(a.t) || 0) - (Number(b.t) || 0)).at(-1)
}

function latestBodyFatFraction(S) {
  const rows = (Array.isArray(S?.measurements) ? S.measurements : []).filter(e => e && e.d && e.bodyFat > 0 && e.bodyFat <= 100)
  if (!rows.length) return null
  const last = rows.slice().sort((a, b) => String(a.d).localeCompare(String(b.d)) || (Number(a.t) || 0) - (Number(b.t) || 0)).at(-1)
  return last.bodyFat / 100
}

function inferGoal({ goal, weight, targetW, coachGoal } = {}) {
  if (goal === 'lose' || goal === 'maintain' || goal === 'gain') return goal
  const w = Number(weight)
  const t = targetW == null || targetW === '' ? NaN : Number(targetW)
  if (Number.isFinite(w) && w > 0 && Number.isFinite(t) && t > 0) {
    if (t < w - 0.05) return 'lose'
    if (t > w + 0.05) return 'gain'
    return 'maintain'
  }
  if (coachGoal === 'fatloss') return 'lose'
  if (coachGoal === 'muscle') return 'gain'
  return 'maintain'
}

function nutritionTargets({
  weightKg, heightCm, age, sex, bodyFat, activity, goal, weeklyKg,
  customKcal, customProtein, customCarbs, customFat,
} = {}) {
  const kg = Number(weightKg)
  if (!(kg > 0)) return null
  const act = ACTIVITIES[activity] || ACTIVITIES.moderate
  const g = goal === 'lose' || goal === 'gain' ? goal : 'maintain'
  let bmr
  if (bodyFat > 0 && bodyFat < 1) {
    bmr = 370 + 21.6 * (1 - bodyFat) * kg
  } else {
    const cm = Number(heightCm)
    const years = age == null || age === '' ? NaN : Number(age)
    if (!(cm > 0) || !Number.isFinite(years) || years < 0) return null
    let base = 10 * kg + 6.25 * cm - 5 * years - 161
    if (sex === 'male') base += 166
    else if (sex !== 'female') base += 83
    bmr = base
  }
  const tdee = trunc(bmr * act.multiplier)
  const rate = g === 'maintain' ? 0 : (weeklyKg == null || !Number.isFinite(Number(weeklyKg)) ? 0.5 : Number(weeklyKg))
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
  return { kcal, protein, fat, carbs }
}

function mealNum(v, max, dec) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return dec ? 0 : 0
  const c = Math.min(n, max)
  return dec ? Math.round(c * 10) / 10 : Math.round(c)
}

function round1(n) { return Math.round(n * 10) / 10 }

/**
 * Read-only summary for [from, to], capped at 28 days ending on `to`.
 * `today` is the clock day whose meals may be listed (only when that day sits inside the window).
 */
export function nutritionSummary(S, from, to, today) {
  const clock = isoDay(today) || isoFromDate(new Date())
  const end = isoDay(to) || clock
  const earliest = shiftISO(end, -(NUTRITION_WINDOW_DAYS - 1))
  let start = isoDay(from) || earliest
  if (start < earliest) start = earliest
  if (start > end) start = end

  const profile = nutritionOf(S)
  const weigh = latestWeighIn(S)
  const weightKg = weigh ? (S?.unit === 'lb' ? Number(weigh.w) * LB_TO_KG : Number(weigh.w)) : null
  const goal = inferGoal({
    goal: profile.goal,
    weight: weigh?.w,
    targetW: S?.targetW,
    coachGoal: S?.coach?.profile?.goal,
  })
  const age = ageYears(profile.birthday, clock)
  const computed = nutritionTargets({
    weightKg,
    heightCm: profile.heightCm,
    age,
    sex: profile.sex,
    bodyFat: latestBodyFatFraction(S),
    activity: profile.activity,
    goal,
    weeklyKg: profile.weeklyKg,
    customKcal: profile.customKcal,
    customProtein: profile.customProtein,
    customCarbs: profile.customCarbs,
    customFat: profile.customFat,
  })
  const anyCustom = profile.customKcal != null || profile.customProtein != null
    || profile.customCarbs != null || profile.customFat != null
  let targets = null
  if (computed || anyCustom) {
    const pick = (custom, formula) => (custom != null ? custom : (formula ?? null))
    targets = {
      kcal: pick(profile.customKcal, computed?.kcal),
      protein: pick(profile.customProtein, computed?.protein),
      carbs: pick(profile.customCarbs, computed?.carbs),
      fat: pick(profile.customFat, computed?.fat),
      source: anyCustom ? 'custom' : 'inferred',
    }
  }

  const byDay = new Map()
  const todayMeals = []
  for (const e of (Array.isArray(S?.foodLog) ? S.foodLog : [])) {
    if (!e || typeof e !== 'object') continue
    const d = isoDay(e.d)
    if (!d || d < start || d > end) continue
    const kcal = mealNum(e.kcal, 20000, false)
    const protein = mealNum(e.protein, 2000, true)
    const carbs = mealNum(e.carbs, 2000, true)
    const fat = mealNum(e.fat, 2000, true)
    const row = byDay.get(d) || { d, kcal: 0, protein: 0, carbs: 0, fat: 0, meals: 0 }
    row.kcal += kcal
    row.protein += protein
    row.carbs += carbs
    row.fat += fat
    row.meals += 1
    byDay.set(d, row)
    if (d === clock) {
      const name = String(e.name ?? '').trim().slice(0, MEAL_NAME_MAX)
      if (name) {
        todayMeals.push({
          t: Number(e.t) || 0,
          name,
          meal: MEALS.includes(e.meal) ? e.meal : 'snack',
          kcal,
          protein,
        })
      }
    }
  }

  const days = [...byDay.values()]
    .sort((a, b) => a.d.localeCompare(b.d))
    .map(r => ({
      d: r.d,
      kcal: Math.round(r.kcal),
      protein: round1(r.protein),
      carbs: round1(r.carbs),
      fat: round1(r.fat),
      meals: r.meals,
    }))

  const logged = days.filter(d => d.meals > 0)
  let energy
  if (weightKg > 0 && logged.length) {
    const avg = Math.round(logged.reduce((n, d) => n + d.kcal, 0) / logged.length)
    const w = Math.round(weightKg * 10) / 10
    const word = logged.length === 1 ? 'day' : 'days'
    energy = `Latest weigh-in ${w} kg. Logged intake averages ${avg} kcal/day over ${logged.length} ${word}.`
  }

  const showToday = clock >= start && clock <= end
  const todayOut = showToday
    ? todayMeals.sort((a, b) => a.t - b.t || a.name.localeCompare(b.name)).slice(0, TODAY_MEALS_MAX).map(({ name, meal, kcal, protein }) => ({ name, meal, kcal, protein }))
    : []

  return {
    window: { from: start, to: end },
    targets,
    inputs: {
      weightKg: weightKg > 0 ? Math.round(weightKg * 1000) / 1000 : null,
      heightCm: profile.heightCm,
      goal,
      activity: profile.activity,
      sex: profile.sex,
      age,
    },
    days,
    ...(energy ? { energy } : {}),
    today: todayOut,
    likes: profile.likes,
    dislikes: profile.dislikes,
    wontEat: profile.wontEat,
    note: profile.note,
  }
}
