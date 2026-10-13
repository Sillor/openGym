// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { todayISO } from '../lib/format.js'
import Modals from '../components/Modals.jsx'
import Nutrition, { openMealSheet } from './Nutrition.jsx'

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ search: '', pathname: '/nutrition' }),
}))
vi.mock('../components/CustomMediaField.jsx', () => ({
  useMediaPicker: () => ({ pick: vi.fn(), busy: false, canAdd: true, note: null }),
}))
vi.mock('../components/CustomMedia.jsx', () => ({
  useMediaUrl: () => ({ url: null, status: 'none' }),
}))
vi.mock('../lib/media-store.js', () => ({
  mediaStore: { hold: () => () => {} },
}))
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn(), menuSheet: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn() }))

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  api.mockReset()
  useUI.setState({ sheets: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

function typeInto(el, value) {
  const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  act(() => {
    proto.set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonNamed(text, rootEl = document.body) {
  return [...rootEl.querySelectorAll('button')].find(b => b.textContent === text)
}

describe('nutrition diary', () => {
  it('lists a meal logged today and the calories eaten', () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: {
        ...s.S,
        nutrition: { ...s.S.nutrition, heightCm: 180 },
        foodLog: [{ id: 'm1', d: day, t: 1, name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 6, meal: 'breakfast', source: 'manual', media: [] }],
      },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    expect(host.textContent).toContain('Oats')
    expect(host.textContent).toContain('300 kcal')
    expect(host.textContent).toContain('Breakfast')
  })

  it('saves a meal typed into the sheet', async () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: { ...s.S, nutrition: { ...s.S.nutrition, heightCm: 180 }, foodLog: [] },
    }))
    useUI.setState({ sheets: [] })
    act(() => root.render(<><Nutrition /><Modals /></>))
    typeInto(host.querySelector('[aria-label="Describe a meal"]'), 'Toast')
    await act(async () => { buttonNamed('Type', host).click() })
    act(() => buttonNamed('Done').click())
    const saved = useStore.getState().S.foodLog
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ name: 'Toast', d: day, source: 'manual', kcal: 0 })
  })

  it('does nothing when Type is empty', () => {
    useStore.setState(s => ({
      S: { ...s.S, nutrition: { ...s.S.nutrition, heightCm: 180 }, foodLog: [] },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    act(() => buttonNamed('Type').click())
    expect(document.body.querySelector('[aria-label="Name"]')).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })

  it('copies a recent meal onto the open day with a new id', () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: {
        ...s.S,
        nutrition: { ...s.S.nutrition, heightCm: 180 },
        foodLog: [
          { id: 'old', d: '2020-01-01', t: 1, name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 6, meal: 'breakfast', source: 'manual', media: [] },
          { id: 'older', d: '2019-01-01', t: 1, name: 'Oats', kcal: 100, protein: 1, carbs: 1, fat: 1, meal: 'breakfast', source: 'manual', media: [] },
        ],
      },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    const again = [...host.querySelectorAll('button')].filter(b => b.textContent === 'Log again')
    expect(again).toHaveLength(1)
    act(() => again[0].click())
    const saved = useStore.getState().S.foodLog
    expect(saved).toHaveLength(3)
    const copy = saved.find(e => e.id !== 'old' && e.id !== 'older')
    expect(copy).toMatchObject({ name: 'Oats', d: day, kcal: 300 })
    expect(copy.id).not.toBe('old')
  })

  it('logs the open meal again from the sheet, keeping the original', () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: {
        ...s.S,
        nutrition: { ...s.S.nutrition, heightCm: 180 },
        foodLog: [{ id: 'm1', d: day, t: 1, name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 6, meal: 'breakfast', source: 'manual', media: [] }],
      },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    act(() => [...host.querySelectorAll('button.lrow')].find(b => b.textContent.includes('Oats')).click())
    act(() => buttonNamed('Oats').click())
    typeInto(document.body.querySelector('[aria-label="Name"]'), 'Porridge')
    const again = [...document.body.querySelectorAll('button')].filter(b => b.textContent === 'Log again')
    act(() => again.at(-1).click())
    const saved = useStore.getState().S.foodLog
    expect(saved.find(e => e.id === 'm1').name).toBe('Oats')
    const copy = saved.find(e => e.id !== 'm1')
    expect(copy).toMatchObject({ name: 'Porridge', d: day, kcal: 300 })
    expect(copy.id).not.toBe('m1')
  })

  it('marks a typed calorie as edited', async () => {
    useStore.setState(s => ({
      S: { ...s.S, nutrition: { ...s.S.nutrition, heightCm: 180 }, foodLog: [] },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    typeInto(host.querySelector('[aria-label="Describe a meal"]'), 'Toast')
    await act(async () => { buttonNamed('Type', host).click() })
    act(() => document.body.querySelector('[aria-label="Calories"]').click())
    typeInto(document.body.querySelector('[aria-label="Calories"]'), '180')
    act(() => buttonNamed('Done').click())
    expect(useStore.getState().S.foodLog[0]).toMatchObject({ name: 'Toast', kcal: 180, edited: true })
  })

  it('scales a later serving change from the typed calories', () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: {
        ...s.S,
        nutrition: { ...s.S.nutrition, heightCm: 180 },
        foodLog: [{ id: 'm1', d: day, t: 1, name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 100, meal: 'lunch', source: 'manual', media: [] }],
      },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    act(() => [...host.querySelectorAll('button.lrow')].find(b => b.textContent.includes('Rice')).click())
    act(() => document.body.querySelector('[aria-label="Calories"]').click())
    typeInto(document.body.querySelector('[aria-label="Calories"]'), '100')
    act(() => buttonNamed('1 serving').click())
    typeInto(document.body.querySelector('[aria-label="Servings"]'), '2')
    expect(document.body.querySelector('[aria-label="Calories"]').textContent).toBe('200')
    act(() => buttonNamed('Done').click())
    expect(useStore.getState().S.foodLog[0]).toMatchObject({ servingQty: 2, kcal: 200, edited: true })
  })

  it('opens an ingredient as its own screen and scales it from its own grams', () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: {
        ...s.S,
        nutrition: { ...s.S.nutrition, heightCm: 180 },
        foodLog: [{
          id: 'm1', d: day, t: 1, name: 'Bowl', kcal: 280, protein: 10, carbs: 54, fat: 1.5, grams: 200, meal: 'lunch', source: 'manual', media: [],
          ingredients: [
            { name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150 },
            { name: 'Beans', kcal: 80, protein: 6, carbs: 14, fat: 0.5, grams: 50 },
          ],
        }],
      },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    act(() => [...host.querySelectorAll('button.lrow')].find(b => b.textContent.includes('Bowl')).click())
    const rows = [...document.body.querySelectorAll('button.nut-ing')]
    expect(rows).toHaveLength(2)
    expect(rows[1].textContent).toContain('Beans · 80 kcal')
    expect(rows[1].textContent).toContain('50 g')
    expect(document.body.querySelector('.nut-review-foot').textContent).toContain('Fix results')
    act(() => rows[1].click())
    expect(document.body.querySelector('.nut-review-foot')).toBeNull()
    expect(document.body.querySelector('.nut-review-photo')).toBeNull()
    expect(document.body.querySelectorAll('button.nut-ing')).toHaveLength(0)
    expect(document.body.querySelectorAll('[aria-label="Ingredient"]')).toHaveLength(1)
    typeInto(document.body.querySelector('[aria-label="Ingredient calories"]'), '40')
    act(() => document.body.querySelector('[aria-label="Back"]').click())
    expect(document.body.querySelector('[aria-label="Calories"]').textContent).toBe('240')
    expect(document.body.querySelector('.nut-review-foot').textContent).toContain('Fix results')
    expect([...document.body.querySelectorAll('button.nut-ing')].some(b => b.textContent.includes('Beans · 40 kcal'))).toBe(true)
  })

  it('updates the total when an ingredient line is removed', () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: {
        ...s.S,
        nutrition: { ...s.S.nutrition, heightCm: 180 },
        foodLog: [{
          id: 'm1', d: day, t: 1, name: 'Bowl', kcal: 280, protein: 10, carbs: 54, fat: 1.5, grams: 200, meal: 'lunch', source: 'photo', media: [],
          ingredients: [
            { name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150 },
            { name: 'Beans', kcal: 80, protein: 6, carbs: 14, fat: 0.5, grams: 50 },
          ],
        }],
      },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    act(() => [...host.querySelectorAll('button.lrow')].find(b => b.textContent.includes('Bowl')).click())
    act(() => [...document.body.querySelectorAll('button.nut-ing')].find(b => b.textContent.includes('Beans')).click())
    act(() => buttonNamed('Remove').click())
    expect(document.body.querySelector('[aria-label="Calories"]').textContent).toBe('200')
    act(() => buttonNamed('Done').click())
    const saved = useStore.getState().S.foodLog[0]
    expect(saved.ingredients).toEqual([{ name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150, qty: 1, unit: 'serving' }])
    expect(saved).toMatchObject({ kcal: 200, edited: true })
  })

  it('opens several foods as one meal, and still opens one meal when that is all the model returned', async () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: { ...s.S, nutrition: { ...s.S.nutrition, heightCm: 180 }, foodLog: [] },
      user: { id: 'u', name: 'A' },
      config: { coach: { enabled: true } },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    api.mockResolvedValueOnce({
      ok: true,
      items: [
        { name: 'Eggs', kcal: 140, protein: 12, carbs: 1, fat: 10, grams: 100 },
        { name: 'Toast', kcal: 80, protein: 3, carbs: 14, fat: 1, grams: 30 },
      ],
    })
    typeInto(host.querySelector('[aria-label="Describe a meal"]'), 'eggs and toast')
    await act(async () => { buttonNamed('Type', host).click() })
    expect(document.body.querySelectorAll('.nut-review')).toHaveLength(1)
    expect(document.body.querySelector('.nut-title').textContent).toBe('Eggs, Toast')
    expect(document.body.querySelectorAll('.nut-ing')).toHaveLength(2)
    const sent = JSON.parse(api.mock.calls.at(-1)[1].body)
    expect(sent).toEqual({ text: 'eggs and toast' })

    useUI.setState({ sheets: [] })
    api.mockResolvedValueOnce({
      ok: true,
      items: [{
        name: 'Bowl', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150,
        ingredients: [{ name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150 }],
      }],
    })
    typeInto(host.querySelector('[aria-label="Describe a meal"]'), 'a bowl of rice')
    await act(async () => { buttonNamed('Type', host).click() })
    expect(document.body.querySelectorAll('.nut-review')).toHaveLength(1)
    expect(document.body.querySelector('.nut-title').textContent).toBe('Bowl')
    expect(document.body.querySelector('.nut-ing').textContent).toContain('Rice')
    expect(day).toBe(todayISO())
  })

  it('does not read a photo until Estimate, then retries a failed read without storing the bytes', async () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: { ...s.S, nutrition: { ...s.S.nutrition, heightCm: 180 }, foodLog: [] },
    }))
    act(() => root.render(<><Nutrition /><Modals /></>))
    const image = { mime: 'image/jpeg', base64: 'not-in-the-log' }
    await act(async () => {
      openMealSheet({ day, source: 'photo', media: [{ hash: 'h1' }], image, context: 'broth' })
    })
    expect(api).not.toHaveBeenCalled()
    expect(document.body.querySelector('[aria-label="Anything to add?"]').value).toBe('broth')
    expect(buttonNamed('Estimate')).toBeTruthy()
    expect(document.body.querySelector('.nut-review-foot').textContent).not.toContain('Fix results')
    expect(document.body.querySelector('[aria-label="Close"]')).toBeTruthy()

    api.mockResolvedValueOnce({ ok: false })
    await act(async () => { buttonNamed('Estimate').click() })
    expect(document.body.textContent).toContain('Retry')
    expect(JSON.stringify(useStore.getState().S)).not.toContain('not-in-the-log')
    const sent = JSON.parse(api.mock.calls.at(-1)[1].body)
    expect(sent).toEqual({ images: [image], text: 'broth' })

    api.mockResolvedValueOnce({ ok: true, items: [{ name: 'Soup', kcal: 120, protein: 6, carbs: 10, fat: 4, grams: 250 }] })
    await act(async () => { buttonNamed('Retry').click() })
    expect(document.body.querySelector('.nut-title').textContent).toBe('Soup')
    expect(JSON.stringify(useStore.getState().S)).not.toContain('not-in-the-log')
  })

  it('opens a missing barcode as an empty meal named with the code', async () => {
    const day = todayISO()
    const prev = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }))
    try {
      useStore.setState(s => ({
        S: { ...s.S, nutrition: { ...s.S.nutrition, heightCm: 180 }, foodLog: [] },
      }))
      act(() => root.render(<><Nutrition /><Modals /></>))
      act(() => buttonNamed('Barcode', host).click())
      typeInto(document.body.querySelector('[aria-label="Barcode"]'), 'abc')
      await act(async () => { buttonNamed('Look up').click() })
      expect(document.body.querySelector('[aria-label="Name"]')).toBeNull()
      expect(globalThis.fetch).not.toHaveBeenCalled()

      typeInto(document.body.querySelector('[aria-label="Barcode"]'), '3017620422003')
      await act(async () => { buttonNamed('Look up').click() })
      expect(document.body.querySelector('.nut-title').textContent).toBe('3017620422003')
      expect(document.body.querySelector('[aria-label="Calories"]').textContent).toBe('')
      act(() => buttonNamed('Done').click())
      expect(useStore.getState().S.foodLog[0]).toMatchObject({ name: '3017620422003', d: day, source: 'barcode', kcal: 0, media: [] })
    } finally { globalThis.fetch = prev }
  })
})
