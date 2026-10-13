import { describe, expect, it } from 'vitest'
import { exportFoodDiary, foodDiaryCsv, importFudDiary } from './food-export.js'

const HASH = 'ab'.repeat(32)
const B64 = 'data:image/jpeg;base64,' + 'A'.repeat(300)
const T = Date.UTC(2026, 7, 5, 16, 0, 0)

function meal(over = {}) {
  return {
    id: 'a', d: '2026-08-05', t: T, name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 8,
    grams: 80, meal: 'breakfast', source: 'text', note: 'honey',
    media: [{ hash: HASH, kind: 'image', mime: 'image/jpeg', data: B64 }],
    edited: false, photo: B64, imageFilename: 'meal.jpg',
    ...over,
  }
}

describe('exportFoodDiary', () => {
  const today = '2026-08-10'
  const log = [
    meal({ id: 'old', d: '2026-07-01' }),
    meal({ id: 'edge', d: '2026-08-04' }),
    meal({ id: 'y', d: '2026-08-09' }),
    meal({ id: 'now', d: '2026-08-10', note: 'today' }),
    meal({ id: 'future', d: '2026-08-12' }),
  ]

  it('writes an openGym document for the local days in the window', () => {
    const doc = exportFoodDiary(log, { range: 'today', today })
    expect(doc).toMatchObject({ app: 'openGym', format_version: 1, from: '2026-08-10', to: '2026-08-10' })
    expect(doc.entries.map(e => e.id)).toEqual(['now'])
    expect(doc.entries[0]).toMatchObject({
      d: '2026-08-10', name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 8, grams: 80,
      meal: 'breakfast', source: 'text', note: 'today', edited: false,
    })
    expect(doc.entries[0].media).toEqual([{ hash: HASH, kind: 'image', mime: 'image/jpeg' }])
    const json = JSON.stringify(doc)
    expect(json).not.toContain('data:image')
    expect(json).not.toContain('base64')
    expect(json).not.toContain('meal.jpg')
    expect(json).toContain(HASH)
  })

  it('keeps seven and thirty local days, inclusive, and every day for all', () => {
    expect(exportFoodDiary(log, { range: '7', today })).toMatchObject({
      from: '2026-08-04', to: '2026-08-10',
    })
    expect(exportFoodDiary(log, { range: '7', today }).entries.map(e => e.id)).toEqual(['edge', 'y', 'now'])
    expect(exportFoodDiary(log, { range: '30', today })).toMatchObject({ from: '2026-07-12', to: '2026-08-10' })
    expect(exportFoodDiary(log, { range: '30', today }).entries.map(e => e.id)).toEqual(['edge', 'y', 'now'])
    const all = exportFoodDiary(log, { range: 'all', today })
    expect(all.from).toBe('2026-07-01')
    expect(all.to).toBe('2026-08-12')
    expect(all.entries.map(e => e.id)).toEqual(['old', 'edge', 'y', 'now', 'future'])
    expect(exportFoodDiary([], { range: 'all', today })).toMatchObject({ from: today, to: today, entries: [] })
  })

  it('includes ingredients in JSON, strips base64, and leaves them off a meal that has none', () => {
    const lined = meal({
      ingredients: [
        { name: 'rolled oats', kcal: 150, protein: 5, carbs: 27, fat: 3, grams: 40, image: B64, imageFilename: 'oats.jpg' },
        { name: B64, kcal: 80, protein: 4, carbs: 6, fat: 4, grams: 20 },
      ],
    })
    const doc = exportFoodDiary([lined], { range: 'all', today: '2026-08-05' })
    expect(doc.entries[0].ingredients).toEqual([
      { name: 'rolled oats', kcal: 150, protein: 5, carbs: 27, fat: 3, grams: 40 },
      { kcal: 80, protein: 4, carbs: 6, fat: 4, grams: 20 },
    ])
    const json = JSON.stringify(doc)
    expect(json).not.toContain('data:image')
    expect(json).not.toContain('base64')
    expect(json).not.toContain('oats.jpg')
    expect(exportFoodDiary([meal()], { range: 'all', today: '2026-08-05' }).entries[0].ingredients).toBeUndefined()
    const plain = exportFoodDiary([meal()], { range: 'all', today: '2026-08-05' })
    expect(foodDiaryCsv(doc)).toBe(foodDiaryCsv(plain))
  })

  it('includes the serving and an ingredient amount in JSON, and leaves them off the CSV', () => {
    const lined = meal({
      servingQty: 1,
      servingUnit: 'cup',
      ingredients: [
        { name: 'milk', kcal: 150, protein: 8, carbs: 12, fat: 8, grams: 240, qty: 1, unit: 'cup' },
      ],
    })
    const doc = exportFoodDiary([lined], { range: 'all', today: '2026-08-05' })
    expect(doc.entries[0].servingQty).toBe(1)
    expect(doc.entries[0].servingUnit).toBe('cup')
    expect(doc.entries[0].ingredients).toEqual([
      { name: 'milk', kcal: 150, protein: 8, carbs: 12, fat: 8, grams: 240, qty: 1, unit: 'cup' },
    ])
    const csv = foodDiaryCsv(doc)
    expect(csv.split('\n')[0]).toBe('date,time,meal,name,grams,kcal,protein,carbs,fat,note')
    expect(csv).not.toContain('servingQty')
    expect(csv).not.toContain('cup')
  })
})

describe('foodDiaryCsv', () => {
  it('uses the fixed header, UTC time from toISOString, and no media hash', () => {
    const doc = exportFoodDiary([meal()], { range: 'all', today: '2026-08-05' })
    const csv = foodDiaryCsv(doc)
    const lines = csv.replace(/\n$/, '').split('\n')
    expect(lines[0]).toBe('date,time,meal,name,grams,kcal,protein,carbs,fat,note')
    expect(lines[1].split(',')).toEqual([
      '2026-08-05', '2026-08-05T16:00:00.000Z', 'breakfast', 'Oats', '80', '300', '12', '40', '8', 'honey',
    ])
    expect(csv).not.toContain(HASH)
    expect(csv).not.toContain('meal.jpg')
    expect(csv).not.toContain('base64')
  })

  it('quotes a comma in the name and leaves an empty grams cell', () => {
    const doc = exportFoodDiary([meal({ name: 'Rice, bowl', grams: null, note: 'say "hi"' })], { range: 'today', today: '2026-08-05' })
    const row = foodDiaryCsv(doc).replace(/\n$/, '').split('\n')[1]
    expect(row).toContain('"Rice, bowl"')
    expect(row).toContain('"say ""hi"""')
    expect(row).toContain(',,300,')
  })
})

const fud15 = {
  export: {
    app: 'Fud AI',
    format_version: '1.5',
    date_range: { start: '2026-08-05', end: '2026-08-05' },
  },
  days: [{
    date: '2026-08-05',
    meals: [
      {
        type: 'lunch',
        items: [{
          entry_id: 'keep-me-not',
          name: 'Rice bowl',
          quantity_g: 250,
          calories: 500,
          protein_g: 20,
          carbs_g: 70,
          fat_g: 12,
          time: '12:30',
          source: 'ai_estimated',
          note: 'leftovers',
          imageFilename: 'meal.jpg',
          image: 'data:image/jpeg;base64,' + 'B'.repeat(80),
          ingredients: [
            { name: 'rice', quantity_g: 200, calories: 260, protein_g: 5, carbs_g: 56, fat_g: 1, imageFilename: 'rice.jpg' },
            { name: '', quantity_g: 10, calories: 40, protein_g: 1, carbs_g: 2, fat_g: 1 },
            { name: 'oil', quantity_g: 0, calories: 90, protein_g: 0, carbs_g: 0, fat_g: 10, imageFilename: 'oil.jpg' },
          ],
        }],
      },
      {
        type: 'other',
        items: [{
          name: 'Yogurt',
          quantity_g: null,
          calories: 120,
          protein_g: 10,
          carbs_g: 8,
          fat_g: 4,
          time: '12:00',
          source: 'manually_edited',
        }],
      },
    ],
  }],
}

describe('importFudDiary', () => {
  it('reads a Fud AI 1.5 diary as manual meals with new ids and no photos', () => {
    let n = 0
    const out = importFudDiary(JSON.stringify(fud15), () => 'm' + (++n))
    expect(out.ok).toBe(true)
    expect(out.entries).toHaveLength(2)
    expect(out.entries.map(e => e.id)).toEqual(['m1', 'm2'])
    const rice = out.entries[0]
    expect(rice).toMatchObject({
      d: '2026-08-05', name: 'Rice bowl', kcal: 260, protein: 5, carbs: 56, fat: 1,
      grams: 250, meal: 'lunch', source: 'manual', note: 'leftovers', media: [], edited: false,
    })
    expect(rice.ingredients).toEqual([
      { name: 'rice', kcal: 260, protein: 5, carbs: 56, fat: 1, grams: 200, qty: 1, unit: 'serving' },
    ])
    const at = new Date(rice.t)
    expect(at.getFullYear()).toBe(2026)
    expect(at.getMonth()).toBe(7)
    expect(at.getDate()).toBe(5)
    expect(at.getHours()).toBe(12)
    expect(at.getMinutes()).toBe(30)
    expect(out.entries[1]).toMatchObject({ name: 'Yogurt', meal: 'snack', grams: null, kcal: 120, source: 'manual', media: [] })
    expect(out.entries[1].ingredients).toBeUndefined()
    const json = JSON.stringify(out.entries)
    expect(json).not.toContain('meal.jpg')
    expect(json).not.toContain('rice.jpg')
    expect(json).not.toContain('oil.jpg')
    expect(json).not.toContain('keep-me-not')
    expect(json).not.toContain('base64')
    expect(json).toContain('rice')
    expect(json).not.toContain('oil')
  })

  it('rejects a different format_version', () => {
    const bad = { ...fud15, export: { ...fud15.export, format_version: '2.0' } }
    expect(importFudDiary(bad)).toEqual({ ok: false, error: 'This food diary format is not supported.' })
    const older = { ...fud15, export: { ...fud15.export, format_version: '1.3' } }
    expect(importFudDiary(older).ok).toBe(false)
    expect(importFudDiary('{').ok).toBe(false)
    expect(importFudDiary({ app: 'openGym', format_version: 1, entries: [] }).ok).toBe(false)
  })
})
