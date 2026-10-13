// Meals the coach is reading right now. A photo or a description is handed off here and the
// sheet that took it closes, so the diary stays usable while the model works — the way Cal AI
// shows a card with the photo and "Analyzing…" in the list. When the answer lands the diary
// opens the review; if something else is on screen the card waits with "Tap to review".
//
// Nothing here is saved: the image bytes live only in memory, for the request and a retry.

import { create } from 'zustand'
import { analyzeFood, combineFoodItems } from '../../lib/food-analyze.js'
import { uid } from '../../lib/format.js'

export function foodsFrom(out) {
  if (!out?.ok) return []
  if (Array.isArray(out.items) && out.items.length) return out.items.filter(i => i && i.name)
  if (out.item && out.item.name) return [out.item]
  return []
}

export const useFoodReads = create(() => ({ reads: [] }))

const patch = (id, fields) => useFoodReads.setState(s => ({
  reads: s.reads.map(r => (r.id === id ? { ...r, ...fields } : r)),
}))

async function run(id) {
  const read = useFoodReads.getState().reads.find(r => r.id === id)
  if (!read) return
  patch(id, { status: 'reading', error: null, started: Date.now() })
  const out = await analyzeFood(read.image ? { images: [read.image], text: read.text || undefined } : { text: read.text })
  if (!useFoodReads.getState().reads.some(r => r.id === id)) return
  const meal = combineFoodItems(foodsFrom(out))
  if (meal) patch(id, { status: 'ready', result: meal })
  else patch(id, { status: 'failed', error: (out && out.error) || 'provider' })
}

/** Start reading a meal for `day`: a photo (`image`, with its saved `media`), a sentence, or both. */
export function startRead({ day, image, media, text }) {
  const id = uid()
  const read = {
    id, day, image: image || null, media: media || [], text: String(text || '').trim(),
    source: image ? 'photo' : 'text', status: 'reading', started: Date.now(), result: null, error: null,
  }
  useFoodReads.setState(s => ({ reads: [read, ...s.reads] }))
  run(id)
  return id
}

export const retryRead = id => run(id)

export function dropRead(id) {
  useFoodReads.setState(s => ({ reads: s.reads.filter(r => r.id !== id) }))
}
