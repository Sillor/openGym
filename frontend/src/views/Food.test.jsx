// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { todayISO } from '../lib/format.js'
import Modals from '../components/Modals.jsx'
import Food from './Food.jsx'
import { openMealSheet } from '../components/food/MealSheet.jsx'
import { startRead, useFoodReads } from '../components/food/reads.js'

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ search: '', pathname: '/food' }),
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
vi.mock('../lib/api.js', () => ({ api: vi.fn() }))

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  api.mockReset()
  useUI.setState({ sheets: [] })
  useFoodReads.setState({ reads: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

function typeInto(el, value) {
  const proto = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value')
  act(() => {
    proto.set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const all = () => [...document.body.querySelectorAll('button, [role="button"], .item')]
const tap = text => {
  const el = all().find(b => b.textContent.trim() === text) || all().find(b => b.getAttribute('aria-label') === text)
  if (!el) throw new Error('no button ' + text)
  act(() => el.click())
}
const q = sel => document.body.querySelector(sel)
const pick = text => {
  const el = [...document.body.querySelectorAll('.menu-item')].find(i => i.querySelector('.tt')?.textContent === text)
  if (!el) throw new Error('no menu item ' + text)
  act(() => el.click())
}
const kcalShown = () => q('.fm-kcal-n').textContent

function setup(foodLog = [], extra = {}) {
  useStore.setState(s => ({
    S: { ...s.S, nutrition: { ...s.S.nutrition, heightCm: 180 }, foodLog },
    ...extra,
  }))
  act(() => root.render(<><Food /><Modals /></>))
}

const coachOn = { user: { id: 'u', name: 'A' }, config: { coach: { enabled: true } } }

describe('food diary', () => {
  it('lists a meal under its meal with calories and macros', () => {
    const day = todayISO()
    setup([{ id: 'm1', d: day, t: 1, name: 'Oats', kcal: 300, protein: 12, carbs: 40, fat: 6, meal: 'breakfast', source: 'manual', media: [] }])
    expect(host.textContent).toContain('Oats')
    expect(host.textContent).toContain('300 kcal')
    expect(host.querySelector('.fd-group-h').textContent).toContain('Breakfast')
    expect(host.querySelector('.fc-macros').textContent).toBe('12g40g6g')
  })

  it('logs a meal entered by hand from the + sheet', () => {
    setup()
    tap('Add food')
    tap('Enter it yourself')
    typeInto(q('[aria-label="Name"]'), 'Toast')
    act(() => q('.fm-kcal').click())
    typeInto(q('.fv input'), '180')
    tap('Done')
    tap('Log')
    expect(useStore.getState().S.foodLog[0]).toMatchObject({ name: 'Toast', d: todayISO(), source: 'manual', kcal: 180, edited: true })
  })

  it('scales a portion from the meal it started as, and a unit change keeps the calories', () => {
    const day = todayISO()
    setup([{ id: 'm1', d: day, t: 1, name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 100, servingQty: 1, servingUnit: 'serving', meal: 'lunch', source: 'manual', media: [] }])
    act(() => host.querySelector('.fc').click())
    const amount = q('.fd-qty')
    act(() => amount.focus())
    typeInto(amount, '1')
    typeInto(amount, '2')
    expect(kcalShown()).toBe('400')
    act(() => amount.blur())
    expect(q('.fd-portion-g').textContent).toBe('≈ 200 g')
    act(() => q('.fd-unit').click())
    pick('g')
    expect(q('.fd-qty').value).toBe('200')
    expect(kcalShown()).toBe('400')
    tap('Increase')
    expect(q('.fd-qty').value).toBe('210')
    expect(kcalShown()).toBe('420')
    tap('Done')
    expect(useStore.getState().S.foodLog[0]).toMatchObject({ grams: 210, servingQty: 210, servingUnit: 'g', kcal: 420, edited: true })
  })

  it('edits an ingredient by amount, keeps a cleared number as 0, and keeps every line', () => {
    const day = todayISO()
    const lines = Array.from({ length: 12 }, (_, i) => ({ name: 'Bit ' + i, kcal: 10, protein: 1, carbs: 1, fat: 0, grams: 10, qty: 10, unit: 'g', units: [] }))
    lines[1] = { name: 'Beans', kcal: 80, protein: 6, carbs: 14, fat: 0.5, grams: 50, qty: 50, unit: 'g', units: [] }
    setup([{ id: 'm1', d: day, t: 1, name: 'Bowl', kcal: 1, grams: 160, servingQty: 1, servingUnit: 'bowl', units: [{ unit: 'bowl', g: 160 }], meal: 'lunch', source: 'photo', media: [], ingredients: lines }])
    act(() => host.querySelector('.fc').click())
    expect(document.body.querySelectorAll('.fm-ing')).toHaveLength(12)
    expect(kcalShown()).toBe('190')
    act(() => document.body.querySelectorAll('.fm-ing')[1].click())
    const amount = q('.fd-qty')
    act(() => amount.focus())
    typeInto(amount, '100')
    act(() => amount.blur())
    typeInto(q('[aria-label="Fat"]'), '')
    tap('Done')
    expect(kcalShown()).toBe('270')
    expect(document.body.querySelectorAll('.fm-ing')[1].textContent).toContain('100 g')
    tap('Done')
    const saved = useStore.getState().S.foodLog[0]
    expect(saved.ingredients).toHaveLength(12)
    expect(saved.ingredients[1]).toMatchObject({ name: 'Beans', grams: 100, qty: 100, kcal: 160, protein: 12, fat: 0 })
    // The bowl holds more now; it is still one bowl.
    expect(saved).toMatchObject({ kcal: 270, grams: 210, servingQty: 1, servingUnit: 'bowl' })
  })

  it('removes an ingredient and the total follows', () => {
    const day = todayISO()
    setup([{
      id: 'm1', d: day, t: 1, name: 'Bowl', kcal: 280, grams: 200, meal: 'lunch', source: 'photo', media: [],
      ingredients: [
        { name: 'Rice', kcal: 200, protein: 4, carbs: 40, fat: 1, grams: 150 },
        { name: 'Beans', kcal: 80, protein: 6, carbs: 14, fat: 0.5, grams: 50 },
      ],
    }])
    act(() => host.querySelector('.fc').click())
    expect(document.body.querySelectorAll('.fm-ing')[0].textContent).toContain('150 g')
    act(() => document.body.querySelectorAll('.fm-ing')[1].click())
    tap('Remove')
    expect(kcalShown()).toBe('200')
    tap('Done')
    expect(useStore.getState().S.foodLog[0]).toMatchObject({ kcal: 200, grams: 150, edited: true })
  })

  it('fixes results with the meal as it is now, and can undo the fix', async () => {
    const day = todayISO()
    setup([{
      id: 'm1', d: day, t: 1, name: 'Rice bowl', kcal: 130, grams: 100, meal: 'lunch', source: 'text', media: [],
      ingredients: [{ name: 'Rice', kcal: 130, protein: 3, carbs: 28, fat: 0.3, grams: 100, qty: 100, unit: 'g', units: [] }],
    }], coachOn)
    act(() => host.querySelector('.fc').click())
    tap('Fix results')
    typeInto(q('[aria-label="What needs fixing"]'), 'the rice was 200 g, not 100')
    api.mockResolvedValueOnce({ ok: true, items: [{
      name: 'Rice bowl', kcal: 260, protein: 6, carbs: 56, fat: 0.6, grams: 200, servingQty: 1, servingUnit: 'serving',
      ingredients: [{ name: 'Rice', kcal: 260, protein: 6, carbs: 56, fat: 0.6, grams: 200, qty: 200, unit: 'g' }],
    }] })
    await act(async () => { tap('Update') })
    const sent = JSON.parse(api.mock.calls.at(-1)[1].body)
    expect(sent.fix.note).toBe('the rice was 200 g, not 100')
    expect(sent.fix.previous.ingredients[0]).toMatchObject({ name: 'Rice', grams: 100, quantity: 100, unit: 'g', calories: 130 })
    expect(sent.text).toBeUndefined()
    expect(q('.fx')).toBeNull()
    expect(kcalShown()).toBe('260')
    expect(useUI.getState().toastAction.label).toBe('Undo')
    act(() => useUI.getState().runToastAction())
    expect(kcalShown()).toBe('130')
  })

  it('keeps the fix sheet open with a reason when the fix fails', async () => {
    const day = todayISO()
    setup([{ id: 'm1', d: day, t: 1, name: 'Rice', kcal: 130, meal: 'lunch', source: 'text', media: [] }], coachOn)
    act(() => host.querySelector('.fc').click())
    tap('Fix results')
    typeInto(q('[aria-label="What needs fixing"]'), 'more rice')
    api.mockRejectedValueOnce(Object.assign(new Error('late'), { code: 'timeout' }))
    await act(async () => { tap('Update') })
    expect(q('.fx .fd-err').textContent).toContain('took too long')
    api.mockResolvedValueOnce({ ok: true, items: [{ name: 'Rice', kcal: 200 }] })
    await act(async () => { tap('Try again') })
    expect(kcalShown()).toBe('200')
  })

  it('reads a photo in the background and opens its review when it is in', async () => {
    setup([], coachOn)
    const image = { mime: 'image/jpeg', base64: 'not-in-the-log' }
    let answer
    api.mockReturnValueOnce(new Promise(res => { answer = res }))
    await act(async () => { startRead({ day: todayISO(), image, media: [{ hash: 'h1' }], text: 'cooked in butter' }) })
    expect(host.textContent).toContain('Analyzing…')
    expect(JSON.parse(api.mock.calls.at(-1)[1].body)).toEqual({ images: [image], text: 'cooked in butter' })
    await act(async () => { answer({ ok: true, items: [{ name: 'Eggs', kcal: 140, protein: 12, carbs: 1, fat: 10, grams: 100 }, { name: 'Toast', kcal: 80, grams: 30 }] }) })
    expect(q('.fm-name').value).toBe('Eggs, Toast')
    expect(document.body.querySelectorAll('.fm-ing')).toHaveLength(2)
    tap('Log')
    const saved = useStore.getState().S.foodLog
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ name: 'Eggs, Toast', kcal: 220, source: 'photo', media: [{ hash: 'h1' }] })
    expect(useFoodReads.getState().reads).toHaveLength(0)
    expect(JSON.stringify(useStore.getState().S)).not.toContain('not-in-the-log')
  })

  it('shows a failed read with its reason and tries again', async () => {
    setup([], coachOn)
    api.mockRejectedValueOnce(Object.assign(new Error('cap'), { status: 429, data: { error: 'cap' } }))
    await act(async () => { startRead({ day: todayISO(), text: 'two eggs' }) })
    expect(host.querySelector('.fc-failed').textContent).toContain('read limit')
    api.mockResolvedValueOnce({ ok: true, items: [{ name: 'Eggs', kcal: 140 }] })
    await act(async () => { tap('Try again') })
    expect(q('.fm-name').value).toBe('Eggs')
  })

  it('asks before discarding changes to a meal', () => {
    const day = todayISO()
    setup([{ id: 'm1', d: day, t: 1, name: 'Oats', kcal: 300, meal: 'breakfast', source: 'manual', media: [] }])
    act(() => host.querySelector('.fc').click())
    typeInto(q('[aria-label="Name"]'), 'Porridge')
    tap('Close')
    expect(document.body.textContent).toContain('Discard your changes?')
  })

  it('logs a meal again from its menu, keeping the original', () => {
    const day = todayISO()
    setup([{ id: 'm1', d: day, t: 1, name: 'Oats', kcal: 300, meal: 'breakfast', source: 'manual', media: [] }])
    act(() => host.querySelector('.fc').click())
    tap('More')
    pick('Log again')
    const saved = useStore.getState().S.foodLog
    expect(saved).toHaveLength(2)
    expect(saved[1]).toMatchObject({ name: 'Oats', d: day, kcal: 300 })
    expect(saved[1].id).not.toBe('m1')
  })

  it('opens a barcode meal with its serving to pick from', () => {
    const day = todayISO()
    setup()
    act(() => { openMealSheet({ day, source: 'barcode', fill: { name: 'Cola', kcal: 139, grams: 330, servingQty: 1, servingUnit: 'serving', units: [{ unit: 'serving', g: 330 }, { unit: 'ml', g: 1 }] } }) })
    act(() => q('.fd-unit').click())
    pick('ml')
    expect(q('.fd-qty').value).toBe('330')
    tap('Log')
    expect(useStore.getState().S.foodLog[0]).toMatchObject({ name: 'Cola', source: 'barcode', kcal: 139, servingQty: 330, servingUnit: 'ml' })
  })
})
