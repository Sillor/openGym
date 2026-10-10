// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { todayISO } from '../lib/format.js'
import Modals from '../components/Modals.jsx'
import Nutrition from './Nutrition.jsx'

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
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))

let host, root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useUI.setState({ sheets: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

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

  it('saves a meal typed into the sheet', () => {
    const day = todayISO()
    useStore.setState(s => ({
      S: { ...s.S, nutrition: { ...s.S.nutrition, heightCm: 180 }, foodLog: [] },
    }))
    useUI.setState({ sheets: [] })
    act(() => root.render(<><Nutrition /><Modals /></>))
    const add = [...host.querySelectorAll('button')].find(b => b.textContent === 'Add manually')
    act(() => add.click())
    const name = document.body.querySelector('[aria-label="Name"]')
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    act(() => {
      proto.set.call(name, 'Toast')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'Save')
    act(() => save.click())
    const saved = useStore.getState().S.foodLog
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ name: 'Toast', d: day, source: 'manual', kcal: 0 })
  })
})
