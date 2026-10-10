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
      items: [{ name: 'Egg', kcal: 70, protein: 6.3, carbs: 0.4, fat: 4.8, grams: 50 }]
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
    expect(ok.items[0].ingredients).toEqual([
      { name: 'Chicken', kcal: 200, protein: 25, carbs: 0, fat: 8, grams: 150 },
      { name: 'Rice', kcal: 100, protein: 5, carbs: 20, fat: 2, grams: 100 }
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
    expect(parsed.items[1].grams).toBe(30)
  })
})
