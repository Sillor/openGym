// The diary's call to POST /api/nutrition/analyze. Image bytes are a request payload only.
// A photo or a description is read only through this route.

import { api } from './api.js'

const EDGE = 1024

const MAX_LINES = 20
const round1 = n => Math.round(n * 10) / 10

/** Several foods become one meal. One food stays that meal. A longer list is one meal whose
 * ingredients are those foods (at most 20), each keeping its own amount and units, named by
 * joining them, with the macros summed and the meal counted as 1 serving. */
export function combineFoodItems(items) {
  const rows = (items || []).filter(i => i && i.name).slice(0, MAX_LINES)
  if (!rows.length) return null
  if (rows.length === 1) return { ...rows[0] }
  const sum = (k, dec) => {
    const n = rows.reduce((a, i) => a + (Number(i[k]) || 0), 0)
    return dec ? round1(n) : Math.round(n)
  }
  const ingredients = rows.map(i => ({
    name: String(i.name).trim(),
    kcal: Math.round(Number(i.kcal) || 0),
    protein: round1(Number(i.protein) || 0),
    carbs: round1(Number(i.carbs) || 0),
    fat: round1(Number(i.fat) || 0),
    grams: Number(i.grams) > 0 ? Number(i.grams) : null,
    qty: Number(i.servingQty) > 0 ? Number(i.servingQty) : (Number(i.qty) > 0 ? Number(i.qty) : 1),
    unit: i.servingUnit || i.unit || 'serving',
    units: Array.isArray(i.units) ? i.units.map(u => ({ ...u })) : [],
  }))
  const weighed = ingredients.every(r => r.grams > 0)
  return {
    name: rows.map(i => String(i.name).trim()).filter(Boolean).join(', ').slice(0, 120),
    kcal: sum('kcal', false),
    protein: sum('protein', true),
    carbs: sum('carbs', true),
    fat: sum('fat', true),
    grams: weighed ? sum('grams', true) : null,
    servingQty: 1,
    servingUnit: 'serving',
    units: [],
    ingredients,
  }
}

/**
 * The meal on screen, in the model's own schema, for a correction. Grams are included, so
 * "the rice was 200 g, not 100" points at a number the model can see.
 */
export function fixPrevious(meal) {
  const amount = (qty, unit, grams) => ({
    ...(Number(grams) > 0 ? { grams: round1(Number(grams)) } : {}),
    quantity: Number(qty) > 0 ? Math.round(Number(qty) * 1000) / 1000 : 1,
    unit: unit || 'serving',
  })
  const nums = r => ({
    calories: Math.round(Number(r.kcal) || 0),
    protein: round1(Number(r.protein) || 0),
    carbs: round1(Number(r.carbs) || 0),
    fat: round1(Number(r.fat) || 0),
  })
  const out = {
    name: String(meal?.name || '').trim().slice(0, 120),
    ...amount(meal?.servingQty, meal?.servingUnit, meal?.grams),
    ...nums(meal || {}),
  }
  const lines = Array.isArray(meal?.ingredients) ? meal.ingredients.slice(0, MAX_LINES) : []
  if (lines.length) {
    out.ingredients = lines.map(r => ({ name: String(r.name || '').trim().slice(0, 120), ...amount(r.qty, r.unit, r.grams), ...nums(r) }))
  }
  return out
}

/** A photo shrunk to a JPEG around 1024px. `{ mime, base64 }`, raw base64, no data URL. */
export function foodImageFromFile(file, edge = EDGE) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, edge / Math.max(img.width || 1, img.height || 1))
      const w = Math.max(1, Math.round((img.width || 1) * scale))
      const h = Math.max(1, Math.round((img.height || 1) * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error('image')); return }
      ctx.drawImage(img, 0, 0, w, h)
      const data = canvas.toDataURL('image/jpeg', 0.82)
      URL.revokeObjectURL(url)
      const base64 = data.slice(data.indexOf(',') + 1)
      if (!base64) { reject(new Error('image')); return }
      resolve({ mime: 'image/jpeg', base64 })
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')) }
    img.src = url
  })
}

function foodItems(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter(i => i && typeof i === 'object' && i.name).map(i => ({ ...i }))
}

const CODES = new Set(['cap', 'parse', 'provider', 'bad request', 'too long', 'timeout'])

/**
 * Ask the instance coach to read a meal. `{ ok:true, items }` or `{ ok:false, error }`.
 * One meal is also `item`, so a single-item answer is not dropped. Several foods stay
 * separate in `items`. `fix` is a correction: `{ previous, note, context }`, where
 * `previous` comes from fixPrevious. `error` is cap, parse, provider, auth, bad request,
 * too long, too big, timeout, or offline.
 */
export async function analyzeFood({ text, images, fix } = {}) {
  try {
    const body = await api('/api/nutrition/analyze', {
      method: 'POST',
      body: JSON.stringify({
        ...(text ? { text } : {}),
        ...(images && images.length ? { images } : {}),
        ...(fix ? { fix } : {}),
      }),
      // The server gives a model 150 s for both of its tries; this waits a little longer, so
      // the answer it does get is never thrown away here.
      timeout: 170000,
    })
    const items = foodItems(body && body.items)
    if (!body?.ok || !items.length) return { ok: false, error: 'parse' }
    const out = { ok: true, items }
    if (items.length === 1) out.item = items[0]
    return out
  } catch (e) {
    const code = e?.data?.error
    if (CODES.has(code)) return { ok: false, error: code }
    if (e?.status === 401) return { ok: false, error: 'auth' }
    if (e?.status === 413) return { ok: false, error: 'too big' }
    if (e?.code === 'timeout') return { ok: false, error: 'timeout' }
    if (e?.status == null || e?.status === 0) return { ok: false, error: 'offline' }
    return { ok: false, error: 'provider' }
  }
}
