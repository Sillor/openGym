// The diary's call to POST /api/nutrition/analyze. Image bytes are a request payload only.
// A phone that brings its own coach key does not use this route — that key never reaches the server.

import { api } from './api.js'

const EDGE = 1024

/** Several foods from one answer become one meal the sheet can save. */
export function combineFoodItems(items) {
  const rows = (items || []).filter(i => i && i.name)
  if (!rows.length) return null
  if (rows.length === 1) return { ...rows[0] }
  const sum = (k, dec) => {
    const n = rows.reduce((a, i) => a + (Number(i[k]) || 0), 0)
    return dec ? Math.round(n * 10) / 10 : Math.round(n)
  }
  return {
    name: rows.map(i => String(i.name).trim()).filter(Boolean).join(', ').slice(0, 120),
    kcal: sum('kcal', false),
    protein: sum('protein', true),
    carbs: sum('carbs', true),
    fat: sum('fat', true),
    grams: sum('grams', true),
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

/**
 * Ask the instance coach to read a meal. `{ ok:true, item }` or `{ ok:false, error }`.
 * `error` is cap, parse, provider, auth, or bad request.
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
    const item = combineFoodItems(body && body.items)
    if (!body?.ok || !item) return { ok: false, error: 'parse' }
    return { ok: true, item }
  } catch (e) {
    const code = e?.data?.error
    if (code === 'cap' || code === 'parse' || code === 'provider' || code === 'bad request') return { ok: false, error: code }
    if (e?.status === 401) return { ok: false, error: 'auth' }
    return { ok: false, error: 'provider' }
  }
}
