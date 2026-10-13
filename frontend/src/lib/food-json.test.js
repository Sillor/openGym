import { describe, expect, it } from 'vitest'
import { parseFoodAnalysis } from './food-json.js'

const egg = {
  name: 'Egg',
  calories: 70.4,
  protein: 6.26,
  carbs: 0.44,
  fat: 4.76,
  serving_size_grams: 50
}

describe('parseFoodAnalysis', () => {
  it('reads a fenced JSON object and rounds kcal and macros', () => {
    const text = 'Here is the meal:\n```json\n' + JSON.stringify(egg) + '\n```\nHope that helps.'
    expect(parseFoodAnalysis(text)).toEqual({
      ok: true,
      items: [{ name: 'Egg', kcal: 70, protein: 6.3, carbs: 0.4, fat: 4.8, grams: 50, servingQty: 1, servingUnit: 'serving' }]
    })
    const bare = '```\n' + JSON.stringify({ ...egg, calories: 70.6, protein: '6.24' }) + '\n```'
    const again = parseFoodAnalysis(bare)
    expect(again.ok).toBe(true)
    expect(again.items[0].kcal).toBe(71)
    expect(again.items[0].protein).toBe(6.2)
  })

  it('rejects a meal that is missing a required field', () => {
    expect(parseFoodAnalysis('{"name":"Oats","calories":150}')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"calories":70,"protein":6,"carbs":1,"fat":5,"serving_size_grams":50}')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"name":"   ","calories":70,"protein":6,"carbs":1,"fat":5,"serving_size_grams":50}')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"name":"Egg","kcal":70,"protein":6,"carbs":1,"fat":5}')).toEqual({ ok: false })
  })

  it('rejects prose, broken JSON, and nonsense numbers', () => {
    expect(parseFoodAnalysis('not food')).toEqual({ ok: false })
    expect(parseFoodAnalysis('')).toEqual({ ok: false })
    expect(parseFoodAnalysis('```json\nhello\n```')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"name":"X","calories":-5,"protein":0,"carbs":0,"fat":0,"serving_size_grams":10}')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"name":"X","calories":1,"protein":0,"carbs":0,"fat":0,"serving_size_grams":0}')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"name":"X","calories":1,"protein":"lots","carbs":0,"fat":0,"serving_size_grams":10}')).toEqual({ ok: false })
    expect(parseFoodAnalysis('{"name":"X","calories":1,"protein":0,"carbs":0,"fat":0,"grams":10,"ingredients":[{}] }')).toEqual({ ok: false })
  })

  it('keeps an ingredient list only when it adds up to the meal', () => {
    const plate = {
      name: 'Plate',
      calories: 310,
      protein: 30,
      carbs: 20,
      fat: 10,
      serving_size_grams: 250,
      sugar: 1,
      ingredients: [
        { name: 'Chicken', grams: 150, calories: 200, protein: 25, carbs: 0, fat: 8 },
        { name: 'Rice', grams: 100, calories: 100, protein: 5, carbs: 20, fat: 2 }
      ]
    }
    const ok = parseFoodAnalysis(JSON.stringify(plate))
    expect(ok.ok).toBe(true)
    expect(ok.items[0].kcal).toBe(300)
    expect(ok.items[0].protein).toBe(30)
    expect(ok.items[0].carbs).toBe(20)
    expect(ok.items[0].fat).toBe(10)
    expect(ok.items[0].grams).toBe(250)
    expect(ok.items[0].servingQty).toBe(1)
    expect(ok.items[0].servingUnit).toBe('serving')
    expect(ok.items[0].ingredients).toEqual([
      { name: 'Chicken', kcal: 200, protein: 25, carbs: 0, fat: 8, grams: 150, qty: 1, unit: 'serving' },
      { name: 'Rice', kcal: 100, protein: 5, carbs: 20, fat: 2, grams: 100, qty: 1, unit: 'serving' }
    ])
    expect(ok.items[0].sugar).toBeUndefined()

    const mismatch = {
      ...plate,
      calories: 100,
      protein: 10,
      carbs: 10,
      fat: 2,
      serving_size_grams: 100,
      ingredients: [
        { name: 'A', grams: 80, calories: 400, protein: 30, carbs: 40, fat: 12 },
        { name: 'B', grams: 80, calories: 400, protein: 30, carbs: 40, fat: 12 }
      ]
    }
    expect(parseFoodAnalysis(JSON.stringify(mismatch))).toEqual({ ok: false })

    const gramsOff = {
      name: 'Plate',
      calories: 200,
      protein: 20,
      carbs: 20,
      fat: 4,
      serving_size_grams: 50,
      ingredients: [
        { name: 'A', grams: 100, calories: 100, protein: 10, carbs: 10, fat: 2 },
        { name: 'B', grams: 100, calories: 100, protein: 10, carbs: 10, fat: 2 }
      ]
    }
    expect(parseFoodAnalysis(JSON.stringify(gramsOff))).toEqual({ ok: false })
  })

  it('accepts a list of meals and omits an empty ingredient list', () => {
    const list = [
      { name: 'Egg', calories: 70, protein: 6, carbs: 0.5, fat: 5, serving_size_grams: 50, ingredients: [] },
      { name: 'Toast', kcal: 80, protein: 3, carbs: 14, fat: 1, grams: 30 }
    ]
    const parsed = parseFoodAnalysis(JSON.stringify(list))
    expect(parsed.ok).toBe(true)
    expect(parsed.items.map(i => i.name)).toEqual(['Egg', 'Toast'])
    expect(parsed.items[0].ingredients).toBeUndefined()
    expect(parsed.items[0].servingQty).toBe(1)
    expect(parsed.items[0].servingUnit).toBe('serving')
    expect(parsed.items[1].grams).toBe(30)
    expect(parsed.items[1].servingQty).toBe(1)
    expect(parsed.items[1].servingUnit).toBe('serving')
  })

  it('keeps the first 8 ingredients when the model returns 12', () => {
    const ingredients = []
    for (let i = 1; i <= 12; i++) {
      ingredients.push({ name: 'Food ' + i, grams: 10, calories: 10, protein: 1, carbs: 1, fat: 0, quantity: i, unit: 'g' })
    }
    const meal = {
      name: 'Plate',
      calories: 80,
      protein: 8,
      carbs: 8,
      fat: 0,
      serving_size_grams: 80,
      ingredients
    }
    const parsed = parseFoodAnalysis(JSON.stringify(meal))
    expect(parsed.ok).toBe(true)
    expect(parsed.items[0].ingredients).toHaveLength(8)
    expect(parsed.items[0].ingredients.map(row => row.name)).toEqual([
      'Food 1', 'Food 2', 'Food 3', 'Food 4', 'Food 5', 'Food 6', 'Food 7', 'Food 8'
    ])
    expect(parsed.items[0].kcal).toBe(80)
    expect(parsed.items[0].grams).toBe(80)
  })

  it('round-trips serving_quantity and serving_unit', () => {
    const meal = {
      name: 'Soup',
      serving_quantity: '2',
      serving_unit: ' Cup ',
      calories: 120,
      protein: 4,
      carbs: 18,
      fat: 3,
      serving_size_grams: 480,
      ingredients: [
        { name: 'Broth', quantity: 400, unit: 'ml', calories: 40, protein: 2, carbs: 4, fat: 1, grams: 400 },
        { name: 'Noodles', quantity: 1, unit: 'piece', calories: 80, protein: 2, carbs: 14, fat: 2, grams: 80 }
      ]
    }
    expect(parseFoodAnalysis(JSON.stringify(meal))).toEqual({
      ok: true,
      items: [{
        name: 'Soup',
        kcal: 120,
        protein: 4,
        carbs: 18,
        fat: 3,
        grams: 480,
        servingQty: 2,
        servingUnit: 'cup',
        ingredients: [
          { name: 'Broth', kcal: 40, protein: 2, carbs: 4, fat: 1, grams: 400, qty: 400, unit: 'ml' },
          { name: 'Noodles', kcal: 80, protein: 2, carbs: 14, fat: 2, grams: 80, qty: 1, unit: 'piece' }
        ]
      }]
    })
  })
})
