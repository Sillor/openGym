import { describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ api: vi.fn() }))

import { api } from './api.js'
import { analyzeFood, combineFoodItems, fixPrevious } from './food-analyze.js'

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
      { name: 'Eggs', kcal: 140, protein: 12, carbs: 1, fat: 10, grams: 100, qty: 1, unit: 'serving', units: [] },
      { name: 'Toast', kcal: 80, protein: 3, carbs: 14, fat: 1, grams: 30, qty: 1, unit: 'serving', units: [] },
    ])
  })
  it('keeps each food’s own amount, and no meal weight when one is unknown', () => {
    const plate = combineFoodItems([
      { name: 'Pizza', kcal: 570, grams: 210, servingQty: 2, servingUnit: 'slice', units: [{ unit: 'slice', g: 105 }] },
      { name: 'Cola', kcal: 140, grams: null, servingQty: 1, servingUnit: 'can' },
    ])
    expect(plate.ingredients[0]).toMatchObject({ qty: 2, unit: 'slice', units: [{ unit: 'slice', g: 105 }] })
    expect(plate.ingredients[1]).toMatchObject({ grams: null, qty: 1, unit: 'can' })
    expect(plate.grams).toBe(null)
    const many = combineFoodItems(Array.from({ length: 25 }, (_, i) => ({ name: 'F' + i, kcal: 1 })))
    expect(many.ingredients).toHaveLength(20)
  })
})

describe('fixPrevious', () => {
  it('writes the meal in the model schema, grams included', () => {
    expect(fixPrevious({
      name: ' Rice bowl ', kcal: 400.4, protein: 10, carbs: 80, fat: 3, grams: 300, servingQty: 1, servingUnit: 'bowl',
      ingredients: [{ name: 'rice', kcal: 260, protein: 5, carbs: 56, fat: 1, grams: 200, qty: 1, unit: 'cup' }, { name: 'sauce', kcal: 140, qty: 2, unit: 'tbsp' }],
    })).toEqual({
      name: 'Rice bowl', grams: 300, quantity: 1, unit: 'bowl', calories: 400, protein: 10, carbs: 80, fat: 3,
      ingredients: [
        { name: 'rice', grams: 200, quantity: 1, unit: 'cup', calories: 260, protein: 5, carbs: 56, fat: 1 },
        { name: 'sauce', quantity: 2, unit: 'tbsp', calories: 140, protein: 0, carbs: 0, fat: 0 },
      ],
    })
  })
})

describe('analyzeFood', () => {
  it('posts text and images and returns one item', async () => {
    const rice = { name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150 }
    api.mockResolvedValueOnce({ ok: true, items: [rice] })
    const out = await analyzeFood({ text: 'a bowl of rice', images: [{ mime: 'image/jpeg', base64: 'qq' }] })
    expect(api).toHaveBeenCalledWith('/api/nutrition/analyze', expect.objectContaining({ method: 'POST', timeout: 170000 }))
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
    api.mockRejectedValueOnce(Object.assign(new Error('late'), { code: 'timeout' }))
    expect(await analyzeFood({ text: 'eggs' })).toEqual({ ok: false, error: 'timeout' })
    api.mockRejectedValueOnce(Object.assign(new Error('big'), { status: 413, data: {} }))
    expect(await analyzeFood({ text: 'eggs' })).toEqual({ ok: false, error: 'too big' })
    api.mockRejectedValueOnce(Object.assign(new Error('long'), { status: 400, data: { error: 'too long' } }))
    expect(await analyzeFood({ text: 'eggs' })).toEqual({ ok: false, error: 'too long' })
    api.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await analyzeFood({ text: 'eggs' })).toEqual({ ok: false, error: 'offline' })
  })

  it('sends a correction with the previous meal', async () => {
    api.mockResolvedValueOnce({ ok: true, items: [{ name: 'Rice', kcal: 260 }] })
    const previous = { name: 'Rice', calories: 130, grams: 100, quantity: 100, unit: 'g' }
    await analyzeFood({ fix: { previous, note: '200 g, not 100' } })
    expect(JSON.parse(api.mock.calls.at(-1)[1].body)).toEqual({ fix: { previous, note: '200 g, not 100' } })
  })
})
