// Food-diary export, and an import of a Fud AI diary (format 1.5).
//
// openGym's own file is a flat list of the meals already on S.foodLog, filtered by the local
// day stored on each entry (`d`, YYYY-MM-DD) — not by re-reading `t` in some other zone.
// JSON may carry media hash refs and, when a meal has them, its ingredients, plus the
// meal serving (servingQty, servingUnit) and each ingredient amount (qty, unit). It never
// carries photo bytes. CSV leaves the hashes, the ingredient lines, and those amounts out.
//
// The CSV time column is `new Date(t).toISOString()`: a UTC timestamp with a trailing Z
// (for example 2026-08-05T16:00:00.000Z), not the device's local wall clock. The date column
// stays the local day `d`. Writing the UTC instant keeps the file identical in every timezone.
//
// A Fud AI export nests days → meals → items, with protein_g / quantity_g and format_version
// "1.5". An item's ingredients use those same names (quantity_g, calories, protein_g,
// carbs_g, fat_g) and go through cleanMeal, so junk rows drop and the meal totals follow
// the list. Photos in that file are filenames on the phone that wrote it, so they are
// dropped and every meal comes in as source "manual". This only parses; the screen
// confirms before writing.

import { todayISO, uid } from './format.js'
import { cleanMeal } from './nutrition.js'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const ERR_FILE = 'This is not a valid Fud AI food diary JSON file.'
const ERR_VERSION = 'This food diary format is not supported.'

const MEAL_OF = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snack', other: 'snack' }

function shiftDay(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return dt.getUTCFullYear() + '-' + mm + '-' + dd
}

function isBase64(v) {
  if (typeof v !== 'string') return false
  if (v.startsWith('data:')) return true
  // A media hash is 64 hex characters. A photo payload is far longer.
  return v.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(v)
}

function cleanValue(v) {
  if (isBase64(v)) return undefined
  if (Array.isArray(v)) return v.map(cleanValue).filter(x => x !== undefined)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      const c = cleanValue(val)
      if (c !== undefined) out[k] = c
    }
    return out
  }
  return v
}

const INGREDIENT_KEYS = ['name', 'kcal', 'protein', 'carbs', 'fat', 'grams', 'qty', 'unit']

function copyIngredients(raw) {
  if (!Array.isArray(raw) || !raw.length) return undefined
  const out = []
  for (const row of raw) {
    const cleaned = cleanValue(row)
    if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) continue
    const item = {}
    for (const key of INGREDIENT_KEYS) {
      if (cleaned[key] !== undefined) item[key] = cleaned[key]
    }
    if (Object.keys(item).length) out.push(item)
  }
  return out.length ? out : undefined
}

function copyEntry(e) {
  const media = cleanValue(Array.isArray(e.media) ? e.media : [])
  const entry = {
    id: e.id,
    d: e.d,
    t: e.t,
    name: e.name,
    kcal: e.kcal,
    protein: e.protein,
    carbs: e.carbs,
    fat: e.fat,
    grams: e.grams == null || e.grams === '' ? null : e.grams,
    meal: e.meal,
    source: e.source,
    note: isBase64(e.note) ? '' : (e.note ?? ''),
    media: (Array.isArray(media) ? media : []).filter(m => m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length),
    edited: !!e.edited,
  }
  if (e.servingQty != null && e.servingQty !== '') entry.servingQty = e.servingQty
  if (e.servingUnit != null && e.servingUnit !== '') entry.servingUnit = e.servingUnit
  const ingredients = copyIngredients(e.ingredients)
  if (ingredients) entry.ingredients = ingredients
  return entry
}

/**
 * The meals in `foodLog` for a local-date window ending on `today` (YYYY-MM-DD).
 * `range` is 'today', '7' (today and the six days before it), '30', or 'all'.
 * For 'all', `from`/`to` span the logged days, or `today` when the log is empty.
 */
export function exportFoodDiary(foodLog, { range = 'all', today } = {}) {
  const day = DAY.test(today || '') ? today : todayISO()
  const log = (Array.isArray(foodLog) ? foodLog : []).filter(e => e && DAY.test(e.d))
  let from, to, picked
  if (range === 'today') {
    from = to = day
    picked = log.filter(e => e.d === day)
  } else if (range === '7' || range === '30') {
    from = shiftDay(day, range === '7' ? -6 : -29)
    to = day
    picked = log.filter(e => e.d >= from && e.d <= to)
  } else {
    const dates = log.map(e => e.d).slice().sort()
    from = dates[0] || day
    to = dates[dates.length - 1] || day
    picked = log
  }
  return { app: 'openGym', format_version: 1, from, to, entries: picked.map(copyEntry) }
}

function csvCell(v) {
  const s = v == null ? '' : String(v)
  if (/[",\n\r]/.test(s)) return '"' + s.replaceAll('"', '""') + '"'
  return s
}

/** Spreadsheet of an `exportFoodDiary` document. Time is UTC via `toISOString()`; no media. */
export function foodDiaryCsv(doc) {
  const lines = ['date,time,meal,name,grams,kcal,protein,carbs,fat,note']
  for (const e of doc?.entries || []) {
    const time = Number.isFinite(Number(e?.t)) ? new Date(Number(e.t)).toISOString() : ''
    lines.push([
      e.d, time, e.meal, e.name, e.grams == null ? '' : e.grams,
      e.kcal, e.protein, e.carbs, e.fat, e.note ?? '',
    ].map(csvCell).join(','))
  }
  return lines.join('\n') + '\n'
}

function readJson(json) {
  if (typeof json === 'string') {
    try { return JSON.parse(json) } catch { return null }
  }
  if (json && typeof json === 'object') return json
  return null
}

function is15(v) {
  return v === 1.5 || String(v ?? '').trim() === '1.5'
}

function mealOf(type) {
  return MEAL_OF[String(type || '').trim().toLowerCase()] || 'snack'
}

/** Fud ingredient rows use quantity_g / calories / protein_g / carbs_g / fat_g. Photo fields are not copied. */
function fudIngredients(raw) {
  if (!Array.isArray(raw)) return undefined
  return raw.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    return {
      name: row.name,
      kcal: row.calories,
      protein: row.protein_g,
      carbs: row.carbs_g,
      fat: row.fat_g,
      grams: row.quantity_g,
    }
  })
}

/** Local instant for a diary day plus "HH:mm" (or "HH:mm:ss"). Null when either is unusable. */
function atLocal(date, time) {
  if (!DAY.test(date || '')) return null
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(time || '').trim())
  if (!m) return null
  const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3] || 0)
  if (hh > 23 || mm > 59 || ss > 59) return null
  const [y, mo, d] = date.split('-').map(Number)
  const dt = new Date(y, mo - 1, d, hh, mm, ss, 0)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt.getTime()
}

function fail(error) {
  return { ok: false, error }
}

/**
 * Parse a Fud AI food diary (format_version 1.5) into food-log entries ready to append.
 * `id` supplies each new id (default `uid`). Photo filenames and any base64 are ignored.
 * Ingredients, when the item has them, are mapped through cleanMeal.
 */
export function importFudDiary(json, id = uid) {
  const doc = readJson(json)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return fail(ERR_FILE)
  const meta = doc.export
  if (!meta || typeof meta !== 'object' || String(meta.app || '').trim().toLowerCase() !== 'fud ai') return fail(ERR_FILE)
  if (!is15(meta.format_version)) return fail(ERR_VERSION)
  if (!Array.isArray(doc.days)) return fail(ERR_FILE)
  const next = typeof id === 'function' ? id : uid
  const entries = []
  for (const day of doc.days) {
    if (!day || typeof day !== 'object' || !DAY.test(day.date)) continue
    const meals = Array.isArray(day.meals) ? day.meals : []
    for (const meal of meals) {
      if (!meal || typeof meal !== 'object') continue
      const items = Array.isArray(meal.items) ? meal.items : []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const t = atLocal(day.date, item.time)
        if (t == null) continue
        const ingredients = fudIngredients(item.ingredients)
        const row = cleanMeal({
          id: next(),
          d: day.date,
          t,
          name: item.name,
          kcal: item.calories,
          protein: item.protein_g,
          carbs: item.carbs_g,
          fat: item.fat_g,
          grams: item.quantity_g == null || item.quantity_g === '' ? null : item.quantity_g,
          meal: mealOf(meal.type),
          source: 'manual',
          note: typeof item.note === 'string' ? item.note : '',
          media: [],
          edited: false,
          ...(ingredients ? { ingredients } : {}),
        }, { source: 'manual' })
        if (row) entries.push(row)
      }
    }
  }
  return { ok: true, entries }
}
