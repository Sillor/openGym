import { describe, expect, it } from 'vitest'
import { amountOf, cleanUnits, formatQty, gramsPer, parseQty, qtyIn, stepQty, unitOptions } from './food-units.js'

describe('cleanUnits', () => {
  it('keeps named units with a positive weight, once each, never plain grams', () => {
    expect(cleanUnits([{ unit: 'Slices', g: 30 }, { unit: 'slice', g: 40 }, { unit: 'grams', g: 1 }, { unit: 'cup', g: 0 }, null, { unit: 'bowl', g: 350.456 }]))
      .toEqual([{ unit: 'slice', g: 30 }, { unit: 'bowl', g: 350.46 }])
    expect(cleanUnits('nope')).toEqual([])
  })
})

describe('amountOf and unit options', () => {
  const rice = { grams: 150, qty: 0.75, unit: 'cup', units: [{ unit: 'cup', g: 200 }] }

  it('reads a meal and an ingredient the same way', () => {
    expect(amountOf({ grams: 300, servingQty: 2, servingUnit: 'slice', units: [] })).toEqual({ grams: 300, units: [], unit: 'slice', qty: 2 })
    expect(amountOf({ grams: null, qty: 0 })).toEqual({ grams: null, units: [], unit: 'serving', qty: null })
  })

  it('lists the picked unit first, then the model units, then grams, then volumes for a liquid', () => {
    expect(unitOptions(rice).map(o => o.unit)).toEqual(['cup', 'g', 'ml', 'tbsp'])
    expect(gramsPer(rice, 'ml')).toBeCloseTo(200 / 240, 5)
    const pizza = { grams: 210, servingQty: 2, servingUnit: 'slice', units: [{ unit: 'slice', g: 105 }, { unit: 'pizza', g: 840 }] }
    expect(unitOptions(pizza)).toEqual([{ unit: 'slice', g: 105 }, { unit: 'pizza', g: 840 }, { unit: 'g', g: 1 }])
    const milk = { grams: 250, qty: 250, unit: 'ml', units: [] }
    expect(unitOptions(milk).map(o => o.unit)).toEqual(['ml', 'g', 'cup', 'tbsp'])
  })

  it('offers only the count when nothing says what it weighs', () => {
    expect(unitOptions({ grams: null, qty: 2, unit: 'piece', units: [] })).toEqual([{ unit: 'piece', g: null }])
  })

  it('re-reads the amount in another unit', () => {
    expect(qtyIn(rice, 'g')).toBe(150)
    expect(qtyIn(rice, 'tbsp')).toBe(12)
    expect(qtyIn({ grams: null, qty: 3, unit: 'piece', units: [] }, 'g')).toBe(3)
  })
})

describe('formatQty and parseQty', () => {
  it('shows grams whole and counts as fractions', () => {
    expect(formatQty(149.6, 'g')).toBe('150')
    expect(formatQty(7.25, 'ml')).toBe('7.3')
    expect(formatQty(1.5, 'slice')).toBe('1½')
    expect(formatQty(0.25, 'cup')).toBe('¼')
    expect(formatQty(2.667, 'piece')).toBe('2⅔')
    expect(formatQty(1.37, 'serving', ',')).toBe('1,37')
    expect(formatQty(2, 'oz')).toBe('2')
    expect(formatQty(1.5, 'oz')).toBe('1.5')
    expect(formatQty(0, 'g')).toBe('')
  })
  it('reads what people type', () => {
    expect(parseQty('1,5')).toBe(1.5)
    expect(parseQty('1 1/2')).toBe(1.5)
    expect(parseQty('½')).toBe(0.5)
    expect(parseQty('1½')).toBe(1.5)
    expect(parseQty('3/4')).toBe(0.75)
    expect(parseQty('')).toBe(null)
    expect(parseQty('0')).toBe(null)
    expect(parseQty('abc')).toBe(null)
  })
})

describe('stepQty', () => {
  it('moves on a grid that suits the unit and never reaches 0', () => {
    expect(stepQty(150, 'g', 1)).toBe(160)
    expect(stepQty(153, 'g', -1)).toBe(150)
    expect(stepQty(5, 'g', -1)).toBe(5)
    expect(stepQty(1, 'serving', 1)).toBe(1.5)
    expect(stepQty(1, 'serving', -1)).toBe(0.75)
    expect(stepQty(0.25, 'serving', -1)).toBe(0.25)
    expect(stepQty(0.75, 'cup', 1)).toBe(1)
    expect(stepQty(250, 'ml', 1)).toBe(275)
  })
})
