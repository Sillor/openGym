// The diary's call to POST /api/nutrition/analyze. Image bytes are a request payload only.
// A photo or a description is read only through this route.

import { api } from './api.js'

const EDGE = 1024

/** Several foods become one meal. One food stays that meal. A longer list is one meal whose
 * ingredients are those foods (at most 8), named by joining them, with the macros summed
 * and the serving set to 1 serving. */
export function combineFoodItems(items) {
  const rows = (items || []).filter(i => i && i.name).slice(0, 8)
  if (!rows.length) return null
  if (rows.length === 1) return { ...rows[0] }
  const sum = (k, dec) => {
    const n = rows.reduce((a, i) => a + (Number(i[k]) || 0), 0)
    return dec ? Math.round(n * 10) / 10 : Math.round(n)
  }
  const ingredients = rows.map(i => ({
    name: String(i.name).trim(),
    kcal: Math.round(Number(i.kcal) || 0),
    protein: Math.round((Number(i.protein) || 0) * 10) / 10,
    carbs: Math.round((Number(i.carbs) || 0) * 10) / 10,
    fat: Math.round((Number(i.fat) || 0) * 10) / 10,
    grams: Number(i.grams) > 0 ? Number(i.grams) : null,
    qty: Number(i.qty) > 0 ? Number(i.qty) : (Number(i.servingQty) > 0 ? Number(i.servingQty) : 1),
    unit: i.unit || i.servingUnit || 'serving',
  }))
  return {
    name: rows.map(i => String(i.name).trim()).filter(Boolean).join(', ').slice(0, 120),
    kcal: sum('kcal', false),
    protein: sum('protein', true),
    carbs: sum('carbs', true),
    fat: sum('fat', true),
    grams: sum('grams', true),
    servingQty: 1,
    servingUnit: 'serving',
    ingredients,
  }
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

/**
 * Ask the instance coach to read a meal. `{ ok:true, items }` or `{ ok:false, error }`.
 * One meal is also `item`, so a single-item answer is not dropped. Several foods stay
 * separate in `items`. `error` is cap, parse, provider, auth, or bad request.
 */
export async function analyzeFood({ text, images } = {}) {
  try {
    const body = await api('/api/nutrition/analyze', {
      method: 'POST',
      body: JSON.stringify({
        ...(text ? { text } : {}),
        ...(images && images.length ? { images } : {}),
      }),
      timeout: 120000,
    })
    const items = foodItems(body && body.items)
    if (!body?.ok || !items.length) return { ok: false, error: 'parse' }
    const out = { ok: true, items }
    if (items.length === 1) out.item = items[0]
    return out
  } catch (e) {
    const code = e?.data?.error
    if (code === 'cap' || code === 'parse' || code === 'provider' || code === 'bad request') return { ok: false, error: code }
    if (e?.status === 401) return { ok: false, error: 'auth' }
    return { ok: false, error: 'provider' }
  }
}
