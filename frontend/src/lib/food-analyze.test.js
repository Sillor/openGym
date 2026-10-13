import { describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ api: vi.fn() }))

import { api } from './api.js'
import { analyzeFood, combineFoodItems } from './food-analyze.js'

describe('combineFoodItems', () => {
  it('keeps one meal and sums several', () => {
    expect(combineFoodItems([{ name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 6, grams: 80 }])).toMatchObject({ name: 'Oats', kcal: 300 })
    const plate = combineFoodItems([
      { name: 'Eggs', kcal: 140, protein: 12, carbs: 1, fat: 10, grams: 100 },
      { name: 'Toast', kcal: 80, protein: 3, carbs: 14, fat: 1, grams: 30 },
    ])
    expect(plate).toMatchObject({
      name: 'Eggs, Toast', kcal: 220, protein: 15, carbs: 15, fat: 11, grams: 130,
      servingQty: 1, servingUnit: 'serving',
    })
    expect(plate.ingredients).toEqual([
      { name: 'Eggs', kcal: 140, protein: 12, carbs: 1, fat: 10, grams: 100, qty: 1, unit: 'serving' },
      { name: 'Toast', kcal: 80, protein: 3, carbs: 14, fat: 1, grams: 30, qty: 1, unit: 'serving' },
    ])
  })
})

describe('analyzeFood', () => {
  it('posts text and images and returns one item', async () => {
    const rice = { name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150 }
    api.mockResolvedValueOnce({ ok: true, items: [rice] })
    const out = await analyzeFood({ text: 'a bowl of rice', images: [{ mime: 'image/jpeg', base64: 'qq' }] })
    expect(api).toHaveBeenCalledWith('/api/nutrition/analyze', expect.objectContaining({ method: 'POST', timeout: 120000 }))
    const sent = JSON.parse(api.mock.calls.at(-1)[1].body)
    expect(sent).toEqual({ text: 'a bowl of rice', images: [{ mime: 'image/jpeg', base64: 'qq' }] })
    expect(out).toEqual({ ok: true, item: rice, items: [rice] })
  })

  it('keeps a single meal and returns several foods separately', async () => {
    const oats = { name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 6, grams: 80, ingredients: [{ name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 6, grams: 80 }] }
    api.mockResolvedValueOnce({ ok: true, items: [oats] })
    const one = await analyzeFood({ text: 'oats' })
    expect(one.item).toEqual(oats)
    expect(one.items).toEqual([oats])

    const eggs = { name: 'Eggs', kcal: 140, protein: 12, carbs: 1, fat: 10, grams: 100 }
    const toast = { name: 'Toast', kcal: 80, protein: 3, carbs: 14, fat: 1, grams: 30 }
    api.mockResolvedValueOnce({ ok: true, items: [eggs, toast] })
    const many = await analyzeFood({ text: 'eggs and toast' })
    expect(many.items).toEqual([eggs, toast])
    expect(many.item).toBeUndefined()
  })

  it('posts a photo without a description', async () => {
    api.mockResolvedValueOnce({ ok: true, items: [{ name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150 }] })
    await analyzeFood({ images: [{ mime: 'image/jpeg', base64: 'qq' }] })
    const sent = JSON.parse(api.mock.calls.at(-1)[1].body)
    expect(sent).toEqual({ images: [{ mime: 'image/jpeg', base64: 'qq' }] })
    expect(sent.text).toBeUndefined()
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
