// How much of a food, and in which unit. Grams are the truth whenever they are known; a unit
// (slice, cup, ml, serving…) is only how that weight is shown, so switching units re-expresses
// the same food and never changes its calories. A food with no known weight is counted
// ("1 serving") and scales by the count. The shape follows Fud AI's ServingUnitOption.
//
// A meal keeps its amount in `servingQty`/`servingUnit`, an ingredient in `qty`/`unit`; both
// keep `grams` (or null) and `units`, a short list of `{ unit, g }` with g = grams in one unit.

import { MASS_G, VOLUME_ML, normalizeUnit } from './food-json.js'

export { normalizeUnit }

const MAX_UNITS = 5
const MAX_GRAMS = 20000

export const isMass = unit => Object.prototype.hasOwnProperty.call(MASS_G, unit)
export const isVolume = unit => Object.prototype.hasOwnProperty.call(VOLUME_ML, unit)
/** A unit that counts things (slice, piece, serving, bowl…), not a weight or a volume. */
export const isCount = unit => !!unit && !isMass(unit) && !isVolume(unit)

const round = (n, places) => {
  const f = 10 ** places
  return Math.round(n * f) / f
}

/** Stored unit options: known names, positive grams per unit, no plain grams, at most five. */
export function cleanUnits(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue
    const unit = normalizeUnit(o.unit)
    const g = Number(o.g)
    if (!unit || unit === 'g' || !(g > 0) || g > MAX_GRAMS || out.some(u => u.unit === unit)) continue
    out.push({ unit, g: round(g, 2) })
    if (out.length >= MAX_UNITS) break
  }
  return out
}

/** The amount of a meal (servingQty/servingUnit) or an ingredient (qty/unit), read the same way. */
export function amountOf(item) {
  const meal = item && ('servingUnit' in item || 'servingQty' in item)
  const grams = Number(item?.grams) > 0 ? Number(item.grams) : null
  const qty = Number(meal ? item?.servingQty : item?.qty)
  return {
    grams,
    units: cleanUnits(item?.units),
    unit: normalizeUnit(meal ? item?.servingUnit : item?.unit) || (grams ? 'g' : 'serving'),
    qty: qty > 0 ? qty : null,
  }
}

/** Grams in one `unit` of this item, or null when the item has no weight to measure it by. */
export function gramsPer(item, unit) {
  return perUnit(amountOf(item), unit)
}

function perUnit(a, unit) {
  if (unit === 'g') return 1
  if (isMass(unit)) return MASS_G[unit]
  const own = a.units.find(u => u.unit === unit)
  if (own) return own.g
  if (isVolume(unit)) {
    // Any volume the item already has gives its density; another volume follows from it.
    // Picked as a volume with nothing else to go on: water-like, 1 g per ml.
    const vol = a.units.find(u => isVolume(u.unit)) || (isVolume(a.unit) ? { unit: a.unit, g: VOLUME_ML[a.unit] } : null)
    if (vol) return vol.g / VOLUME_ML[vol.unit] * VOLUME_ML[unit]
  }
  return null
}

/**
 * Ways to show this item, best first: the one picked, the model's units, then g. A liquid also
 * gets ml and cup. With no known weight there is one choice: the count it was logged as.
 */
export function unitOptions(item) {
  const a = amountOf(item)
  if (!a.grams) return [{ unit: a.unit, g: null }]
  const out = []
  const add = unit => {
    if (!unit || out.some(o => o.unit === unit)) return
    const g = perUnit(a, unit)
    if (g > 0) out.push({ unit, g })
  }
  add(a.unit)
  for (const u of a.units) add(u.unit)
  add('g')
  if (a.units.some(u => isVolume(u.unit)) || isVolume(a.unit)) { add('ml'); add('cup'); add('tbsp') }
  return out
}

/** Amount shown for `grams` in `unit`. */
export function qtyIn(item, unit) {
  const a = amountOf(item)
  if (!a.grams) return a.qty || 1
  const g = perUnit(a, unit)
  return g > 0 ? round(a.grams / g, 3) : (a.qty || 1)
}

const FRACTIONS = [[0.25, '¼'], [0.5, '½'], [0.75, '¾'], [1 / 3, '⅓'], [2 / 3, '⅔']]

/**
 * A quantity for the screen. Grams and millilitres are whole numbers (one decimal under 10);
 * a count shows a common fraction ("1½ slice") when it is one, otherwise up to two decimals.
 * `sep` is the decimal separator.
 */
export function formatQty(qty, unit, sep = '.') {
  const n = Number(qty)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (unit === 'g' || unit === 'ml') {
    const v = n >= 10 ? Math.round(n) : round(n, 1)
    return String(v).replace('.', sep)
  }
  const whole = Math.floor(n + 1e-9)
  const part = n - whole
  if (part < 0.01) return String(whole)
  if (unit !== 'oz' && unit !== 'fl oz' && unit !== 'kg' && unit !== 'lb' && unit !== 'l') {
    for (const [v, glyph] of FRACTIONS) {
      if (Math.abs(part - v) < 0.02) return (whole ? String(whole) : '') + glyph
    }
  }
  return String(round(n, n >= 10 ? 1 : 2)).replace('.', sep)
}

/** Parse a typed amount: "1,5", "1.5", "1 1/2", "½" and "3/4" all work. Null when it is not a positive number. */
export function parseQty(text) {
  let s = String(text ?? '').trim().replace(',', '.')
  if (!s) return null
  for (const [v, glyph] of FRACTIONS) s = s.replace(glyph, ' ' + v)
  const parts = s.split(/\s+/).filter(Boolean)
  let total = 0
  for (const p of parts) {
    const frac = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(p)
    const n = frac ? Number(frac[1]) / Number(frac[2]) : Number(p)
    if (!Number.isFinite(n)) return null
    total += n
  }
  return total > 0 ? total : null
}

/** How far one tap of − or + moves this unit. */
export function stepFor(unit, qty) {
  const n = Number(qty) || 0
  if (unit === 'g') return n < 50 ? 5 : n < 500 ? 10 : 50
  if (unit === 'ml') return n < 100 ? 10 : n < 1000 ? 25 : 100
  if (unit === 'kg' || unit === 'l') return 0.1
  if (unit === 'oz' || unit === 'fl oz' || unit === 'lb') return 0.5
  if (unit === 'cup') return 0.25
  if (unit === 'tbsp' || unit === 'tsp') return n < 1 ? 0.5 : 1
  return n < 1 ? 0.25 : 0.5
}

/** One tap of − (`dir` −1) or + (`dir` 1), landing on the step grid and never at 0. */
export function stepQty(qty, unit, dir) {
  const n = Number(qty) > 0 ? Number(qty) : 0
  const up = dir > 0
  const step = stepFor(unit, up ? n : n - 1e-9)
  const snapped = up ? Math.floor(n / step + 1e-9) * step + step : Math.ceil(n / step - 1e-9) * step - step
  const next = round(snapped, 3)
  if (next > 0) return next
  return round(stepFor(unit, 0), 3)
}
