import { describe, expect, it, vi } from 'vitest'
import { lookupFoodBarcode, normalizeBarcode } from './open-food-facts.js'

const URL_3017620422003 = 'https://world.openfoodfacts.org/api/v2/product/3017620422003.json?fields=product_name,brands,nutriments,serving_size,serving_quantity'

function okJson(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('normalizeBarcode', () => {
  it('keeps a product code and rejects a code that is not digits', () => {
    expect(normalizeBarcode(' 3017 6204 22003 ')).toBe('3017620422003')
    expect(normalizeBarcode('01234567')).toBe('01234567')
    expect(normalizeBarcode('abc')).toBeNull()
    expect(normalizeBarcode('12ab34')).toBeNull()
    expect(normalizeBarcode('3017620422003x')).toBeNull()
    expect(normalizeBarcode('12345')).toBeNull()
    expect(normalizeBarcode('123456789012345')).toBeNull()
  })
})

describe('lookupFoodBarcode', () => {
  it('reads a known product per serving', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okJson({
        status: 1,
        product: {
          product_name: 'Nutella',
          brands: 'Ferrero',
          serving_size: '15 g',
          serving_quantity: 15,
          nutriments: {
            'energy-kcal_serving': 81,
            'energy-kcal_100g': 539,
            proteins_serving: 0.9,
            proteins_100g: 6.3,
            carbohydrates_serving: 8.6,
            carbohydrates_100g: 57.5,
            fat_serving: 4.6,
            fat_100g: 30.9,
          },
        },
      }))
      .mockResolvedValueOnce(okJson({
        status: 1,
        product: {
          product_name: 'Oats',
          brands: 'Mill',
          serving_quantity: '50',
          nutriments: {
            'energy-kcal_100g': 200,
            proteins_100g: 10,
            carbohydrates_100g: 30,
            fat_100g: 4,
          },
        },
      }))

    const serving = await lookupFoodBarcode(' 3017620422003 ', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(URL_3017620422003, {
      method: 'GET',
      headers: { 'User-Agent': 'openGym/1.4 (self-hosted food diary)' },
    })
    expect(serving).toEqual({
      ok: true,
      item: { name: 'Ferrero Nutella', kcal: 81, protein: 0.9, carbs: 8.6, fat: 4.6, grams: 15 },
    })
    expect(Object.keys(serving.item).sort()).toEqual(['carbs', 'fat', 'grams', 'kcal', 'name', 'protein'])

    const scaled = await lookupFoodBarcode('3017620422003', { fetchImpl })
    expect(scaled).toEqual({
      ok: true,
      item: { name: 'Mill Oats', kcal: 100, protein: 5, carbs: 15, fat: 2, grams: 50 },
    })
  })

  it('reads a known product per 100 g when it has no serving', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      status: 1,
      product: {
        product_name: 'Whole milk',
        brands: 'Dairy',
        serving_size: '1 piece',
        nutriments: {
          'energy-kcal_serving': 10,
          'energy-kcal_100g': 64,
          proteins_serving: 1,
          proteins_100g: 3.2,
          carbohydrates_serving: 1,
          carbohydrates_100g: 4.8,
          fat_serving: 1,
          fat_100g: 3.6,
        },
      },
    }))
    const out = await lookupFoodBarcode('00412345678903', { fetchImpl })
    expect(out).toEqual({
      ok: true,
      item: { name: 'Dairy Whole milk', kcal: 64, protein: 3.2, carbs: 4.8, fat: 3.6, grams: 100 },
    })
  })

  it('uses a gram serving size when the quantity is absent', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      status: 1,
      product: {
        product_name: 'Yogurt',
        serving_size: '40 g',
        nutriments: {
          'energy-kcal_100g': 250,
          proteins_100g: 10,
          carbohydrates_100g: 20,
          fat_100g: 5,
        },
      },
    }))
    expect(await lookupFoodBarcode('4006381333931', { fetchImpl })).toEqual({
      ok: true,
      item: { name: 'Yogurt', kcal: 100, protein: 4, carbs: 8, fat: 2, grams: 40 },
    })
  })

  it('reports an unknown code as missing', async () => {
    const fetchImpl = vi.fn(async () => okJson({ status: 0, status_verbose: 'product not found' }))
    expect(await lookupFoodBarcode('0000000000000', { fetchImpl })).toEqual({ ok: false, error: 'missing' })
  })

  it('reports a product without nutriments as missing', async () => {
    const fetchImpl = vi.fn(async () => okJson({
      status: 1,
      product: { product_name: 'Empty', nutriments: {} },
    }))
    expect(await lookupFoodBarcode('3017620422003', { fetchImpl })).toEqual({ ok: false, error: 'missing' })
  })

  it('rejects a code that is not digits', async () => {
    const fetchImpl = vi.fn()
    expect(await lookupFoodBarcode('abc', { fetchImpl })).toEqual({ ok: false, error: 'invalid' })
    expect(await lookupFoodBarcode('12ab34', { fetchImpl })).toEqual({ ok: false, error: 'invalid' })
    expect(await lookupFoodBarcode('12345', { fetchImpl })).toEqual({ ok: false, error: 'invalid' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a failed request as network', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })
    expect(await lookupFoodBarcode('3017620422003', { fetchImpl })).toEqual({ ok: false, error: 'network' })
  })
})
