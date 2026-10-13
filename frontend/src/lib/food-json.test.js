import { describe, expect, it } from 'vitest'
import { normalizeUnit, parseFoodAnalysis } from './food-json.js'

const egg = {
  name: 'Egg',
  calories: 70.4,
  protein: 6.26,
  carbs: 0.44,
  fat: 4.76,
  serving_size_grams: 50
}

describe('normalizeUnit', () => {
  it('maps plurals and long names to one unit, and keeps a short food word', () => {
    expect(normalizeUnit('Grams')).toBe('g')
    expect(normalizeUnit('slices')).toBe('slice')
    expect(normalizeUnit('Tablespoons')).toBe('tbsp')
    expect(normalizeUnit('tsp.')).toBe('tsp')
    expect(normalizeUnit('fluid ounces')).toBe('fl oz')
    expect(normalizeUnit('pcs')).toBe('piece')
    expect(normalizeUnit('portion')).toBe('serving')
    expect(normalizeUnit('bowls')).toBe('bowl')
    expect(normalizeUnit('glasses')).toBe('glass')
    expect(normalizeUnit('')).toBe(null)
    expect(normalizeUnit('a very long unit name here')).toBe(null)
    expect(normalizeUnit('2x')).toBe(null)
  })
})

describe('parseFoodAnalysis', () => {
  it('reads a fenced JSON object and rounds kcal and macros', () => {
    const text = 'Here is the meal:\n```json\n' + JSON.stringify(egg) + '\n```\nHope that helps.'
    expect(parseFoodAnalysis(text)).toEqual({
      ok: true,
      items: [{ name: 'Egg', kcal: 70, protein: 6.3, carbs: 0.4, fat: 4.8, grams: 50, servingQty: 1, servingUnit: 'serving', units: [{ unit: 'serving', g: 50 }] }]
    })
    const bare = '```\n' + JSON.stringify({ ...egg, calories: 70.6, protein: '6.24' }) + '\n```'
    const again = parseFoodAnalysis(bare)
    expect(again.ok).toBe(true)
    expect(again.items[0].kcal).toBe(71)
    expect(again.items[0].protein).toBe(6.2)
  })

  it('fills what a model left out instead of failing the meal', () => {
    // No macros: they are 0. No calories: they come from the macros. No grams: a count.
    const oats = parseFoodAnalysis('{"name":"Oats","calories":150}')
    expect(oats.ok).toBe(true)
    expect(oats.items[0]).toMatchObject({ kcal: 150, protein: 0, carbs: 0, fat: 0, grams: null, servingQty: 1, servingUnit: 'serving' })
    const shake = parseFoodAnalysis('{"name":"Shake","protein":30,"carbs":10,"fat":2}')
    expect(shake.items[0].kcal).toBe(178)
    expect(parseFoodAnalysis('{"calories":70,"protein":6,"carbs":1,"fat":5,"serving_size_grams":50}')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"name":"   ","calories":70,"protein":6,"carbs":1,"fat":5,"serving_size_grams":50}')).toEqual({ ok: false })
  })

  it('rejects prose, broken JSON, and nonsense numbers', () => {
    expect(parseFoodAnalysis('not food')).toEqual({ ok: false })
    expect(parseFoodAnalysis('')).toEqual({ ok: false })
    expect(parseFoodAnalysis('```json\nhello\n```')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"name":"X","calories":-5,"protein":0,"carbs":0,"fat":0,"serving_size_grams":10}')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"name":"X","calories":1,"protein":"lots","carbs":0,"fat":0,"serving_size_grams":10}').items[0].protein).toBe(0)
  })

  it('skips a bad ingredient row and keeps the rest', () => {
    const meal = {
      name: 'Plate', calories: 300, protein: 30, carbs: 20, fat: 10, serving_size_grams: 250,
      ingredients: [{}, 'rice', { name: 'Chicken', grams: 150, calories: 200, protein: 25, carbs: 0, fat: 8 }, { name: 'Rice', calories: 100, protein: 5, carbs: 20, fat: 2 }]
    }
    const parsed = parseFoodAnalysis(JSON.stringify(meal))
    expect(parsed.ok).toBe(true)
    expect(parsed.items[0].ingredients.map(r => r.name)).toEqual(['Chicken', 'Rice'])
    expect(parsed.items[0].ingredients[1]).toMatchObject({ grams: null, qty: 1, unit: 'serving' })
    // One row has no weight, so the meal keeps its own gram total.
    expect(parsed.items[0].grams).toBe(250)
  })

  it('lets the ingredients set the totals, unless they describe a different meal', () => {
    const plate = {
      name: 'Plate', calories: 310, protein: 30, carbs: 20, fat: 10, serving_size_grams: 250, sugar: 1,
      ingredients: [
        { name: 'Chicken', grams: 150, calories: 200, protein: 25, carbs: 0, fat: 8, quantity: 150, unit: 'g' },
        { name: 'Rice', grams: 100, calories: 100, protein: 5, carbs: 20, fat: 2, quantity: 0.5, unit: 'cups' }
      ]
    }
    const ok = parseFoodAnalysis(JSON.stringify(plate))
    expect(ok.items[0]).toMatchObject({ kcal: 300, protein: 30, carbs: 20, fat: 10, grams: 250, servingQty: 1, servingUnit: 'serving' })
    expect(ok.items[0].ingredients).toEqual([
      { name: 'Chicken', kcal: 200, protein: 25, carbs: 0, fat: 8, grams: 150, qty: 150, unit: 'g' },
      { name: 'Rice', kcal: 100, protein: 5, carbs: 20, fat: 2, grams: 100, qty: 0.5, unit: 'cup', units: [{ unit: 'cup', g: 200 }] }
    ])
    expect(ok.items[0].sugar).toBeUndefined()

    const far = {
      ...plate, calories: 100, protein: 10, carbs: 10, fat: 2, serving_size_grams: 100,
      ingredients: [
        { name: 'A', grams: 80, calories: 400, protein: 30, carbs: 40, fat: 12 },
        { name: 'B', grams: 80, calories: 400, protein: 30, carbs: 40, fat: 12 }
      ]
    }
    const kept = parseFoodAnalysis(JSON.stringify(far))
    expect(kept.items[0]).toMatchObject({ kcal: 100, grams: 100 })
    expect(kept.items[0].ingredients).toBeUndefined()
  })

  it('keeps up to 20 ingredients', () => {
    const ingredients = []
    for (let i = 1; i <= 24; i++) ingredients.push({ name: 'Food ' + i, grams: 10, calories: 10, protein: 1, carbs: 1, fat: 0 })
    const parsed = parseFoodAnalysis(JSON.stringify({ name: 'Plate', calories: 200, ingredients }))
    expect(parsed.items[0].ingredients).toHaveLength(20)
    expect(parsed.items[0].kcal).toBe(200)
    expect(parsed.items[0].grams).toBe(200)
  })

  it('accepts a list of meals and omits an empty ingredient list', () => {
    const list = [
      { name: 'Egg', calories: 70, protein: 6, carbs: 0.5, fat: 5, serving_size_grams: 50, ingredients: [] },
      { name: 'Toast', kcal: 80, protein: 3, carbs: 14, fat: 1, grams: 30 },
      { name: '' }
    ]
    const parsed = parseFoodAnalysis(JSON.stringify(list))
    expect(parsed.items.map(i => i.name)).toEqual(['Egg', 'Toast'])
    expect(parsed.items[0].ingredients).toBeUndefined()
    expect(parsed.items[1]).toMatchObject({ grams: 30, servingQty: 1, servingUnit: 'serving' })
  })

  it('picks the model unit and keeps its other units as grams per unit', () => {
    const pizza = {
      name: 'Pizza', calories: 570, protein: 24, carbs: 66, fat: 22, serving_size_grams: 210,
      serving_quantity: 2, serving_unit: 'slices',
      unit_options: [{ unit: 'slice', quantity: 2, grams_per_unit: 105 }, { unit: 'piece', grams_per_unit: 0 }, { unit: 'grams', grams_per_unit: 1 }]
    }
    const parsed = parseFoodAnalysis(JSON.stringify(pizza)).items[0]
    expect(parsed).toMatchObject({ grams: 210, servingQty: 2, servingUnit: 'slice', units: [{ unit: 'slice', g: 105 }] })

    const soup = { name: 'Soup', calories: 120, serving_quantity: '2', serving_unit: ' Cup ', serving_size_grams: 480 }
    expect(parseFoodAnalysis(JSON.stringify(soup)).items[0]).toMatchObject({ grams: 480, servingQty: 2, servingUnit: 'cup', units: [{ unit: 'cup', g: 240 }] })

    const weighed = { name: 'Rice', calories: 260, serving_quantity: 200, serving_unit: 'g' }
    expect(parseFoodAnalysis(JSON.stringify(weighed)).items[0]).toMatchObject({ grams: 200, servingQty: 200, servingUnit: 'g' })
    const milk = { name: 'Milk', calories: 150, serving_quantity: 250, serving_unit: 'ml' }
    expect(parseFoodAnalysis(JSON.stringify(milk)).items[0]).toMatchObject({ grams: 250, servingQty: 250, servingUnit: 'ml', units: [{ unit: 'ml', g: 1 }] })
  })

  it('re-expresses an amount whose count disagrees with its weight', () => {
    // 3 slices of 30 g is 90 g, but the model says 120 g: the weight wins, the count follows.
    const bread = { name: 'Bread', calories: 300, serving_size_grams: 120, serving_quantity: 3, serving_unit: 'slice', unit_options: [{ unit: 'slice', grams_per_unit: 30 }] }
    expect(parseFoodAnalysis(JSON.stringify(bread)).items[0]).toMatchObject({ grams: 120, servingQty: 4, servingUnit: 'slice' })
  })

  it('reads past a thinking block and stray brackets', () => {
    const text = '<think>maybe [1] {x}</think>Sure [approx]: ' + JSON.stringify(egg)
    expect(parseFoodAnalysis(text).items[0].name).toBe('Egg')
  })

  it('closes an answer the token limit cut off at its last complete value', () => {
    const full = JSON.stringify({
      name: 'Plate', calories: 500, protein: 30, carbs: 50, fat: 15, serving_size_grams: 400,
      ingredients: [
        { name: 'Chicken', grams: 150, calories: 250, protein: 25, carbs: 0, fat: 8 },
        { name: 'Rice', grams: 200, calories: 250, protein: 5, carbs: 50, fat: 7 },
        { name: 'Salad', grams: 50, calories: 20, protein: 1, carbs: 3, fat: 0 }
      ]
    })
    const cut = full.slice(0, full.indexOf('"Salad"') + 20)
    const parsed = parseFoodAnalysis('```json\n' + cut)
    expect(parsed.ok).toBe(true)
    // Salad was cut before its numbers, so it is not a row.
    expect(parsed.items[0].ingredients.map(r => r.name)).toEqual(['Chicken', 'Rice'])
    expect(parsed.items[0].kcal).toBe(500)
    expect(parsed.items[0].grams).toBe(350)
  })
})
