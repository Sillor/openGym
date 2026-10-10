import { describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ api: vi.fn() }))

import { api } from './api.js'
import { analyzeFood, combineFoodItems } from './food-analyze.js'

describe('combineFoodItems', () => {
  it('keeps one meal and sums several', () => {
    expect(combineFoodItems([{ name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 6, grams: 80 }])).toMatchObject({ name: 'Oats', kcal: 300 })
    expect(combineFoodItems([
      { name: 'Eggs', kcal: 140, protein: 12, carbs: 1, fat: 10, grams: 100 },
      { name: 'Toast', kcal: 80, protein: 3, carbs: 14, fat: 1, grams: 30 },
    ])).toMatchObject({ name: 'Eggs, Toast', kcal: 220, protein: 15, carbs: 15, fat: 11, grams: 130 })
  })
})

describe('analyzeFood', () => {
  it('posts text and images and returns one item', async () => {
    api.mockResolvedValueOnce({ ok: true, items: [{ name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150 }] })
    const out = await analyzeFood({ text: 'a bowl of rice', images: [{ mime: 'image/jpeg', base64: 'qq' }] })
    expect(api).toHaveBeenCalledWith('/api/nutrition/analyze', expect.objectContaining({ method: 'POST', timeout: 120000 }))
    const sent = JSON.parse(api.mock.calls.at(-1)[1].body)
    expect(sent).toEqual({ text: 'a bowl of rice', images: [{ mime: 'image/jpeg', base64: 'qq' }] })
    expect(out).toEqual({ ok: true, item: { name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150 } })
  })

  it('turns a cap, a bad reading, and a signed-out answer into a code', async () => {
    api.mockRejectedValueOnce(Object.assign(new Error('cap'), { data: { error: 'cap' }, status: 429 }))
    expect(await analyzeFood({ text: 'eggs' })).toEqual({ ok: false, error: 'cap' })
    api.mockRejectedValueOnce(Object.assign(new Error('parse'), { data: { error: 'parse' }, status: 422 }))
    expect(await analyzeFood({ text: 'eggs' })).toEqual({ ok: false, error: 'parse' })
    api.mockRejectedValueOnce(Object.assign(new Error('no'), { status: 401, data: {} }))
    expect(await analyzeFood({ text: 'eggs' })).toEqual({ ok: false, error: 'auth' })
  })
})
