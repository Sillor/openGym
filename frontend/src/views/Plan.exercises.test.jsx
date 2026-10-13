// @vitest-environment happy-dom
// Plan → Exercises: the library moved into Plan when the Coach took its tab (components/TabBar.jsx).
// It is the same Library as /library, embedded: Plan's header is the page's, so the library's own
// title goes and its count and "By muscle" stay. The view is remembered per device like the other
// two, and a link can ask for it (/plan?view=exercises) without overriding a later choice.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Plan, { PLAN_VIEW_KEY } from './Plan.jsx'
import { EXDB } from '../lib/exercises.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = { S: null, nav: null }
  state.snapshot = () => ({
    S: state.S,
    user: null,
    update: mut => {
      const next = structuredClone(state.S)
      mut(next)
      state.S = next
    },
  })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => (selector ? selector(mocks.snapshot()) : mocks.snapshot())
  useStore.getState = mocks.snapshot
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), syncReminder: vi.fn() }))
vi.mock('../sheets.jsx', () => ({
  starterPlanSheet: vi.fn(), dayAssignSheet: vi.fn(), menuSheet: vi.fn(), confirmSheet: vi.fn(),
  planHasRoutines: () => false, exportPlanFile: vi.fn(), printWholePlan: vi.fn(), importPlanFile: vi.fn(),
  exerciseDetailSheet: vi.fn(), addToRoutineSheet: vi.fn(), customExSheet: vi.fn(),
}))

let host, root
beforeEach(() => {
  localStorage.removeItem(PLAN_VIEW_KEY)
  window.location.hash = ''
  mocks.nav = vi.fn()
  mocks.S = {
    unit: 'kg', lang: 'en', workouts: [], exWeights: {}, week: {}, dayPlan: {}, customEx: [], equipProfiles: [], activeEquipId: null,
    routines: [{ id: 'r1', name: 'Push', emoji: null, ex: [] }],
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  window.location.hash = ''
})

const mount = () => act(() => root.render(<Plan />))
const remount = () => {
  act(() => root.unmount())
  root = createRoot(host)
  mount()
}
const segments = () => [...host.querySelectorAll('.plan-views button')]
const pick = label => act(() => segments().find(b => b.textContent === label).click())
const current = () => host.querySelector('.plan-views button.on')?.textContent
const library = () => host.querySelector('.search input')

describe('Plan — the Exercises view', () => {
  it('is the third segment, after Schedule and Routines', () => {
    mount()
    expect(segments().map(b => b.textContent)).toEqual(['Schedule', 'Routines', 'Exercises'])
    expect(current()).toBe('Schedule')
    expect(library()).toBeNull()
  })

  it('embeds the library under Plan’s own header, with its count and "By muscle" but not its title', () => {
    mount()
    pick('Exercises')
    expect(library()).not.toBeNull()
    expect([...host.querySelectorAll('h1')].map(h => h.textContent)).toEqual(['Plan'])
    expect(host.querySelector('.lib-bar .lib-count').textContent).toBe(`${EXDB.length} exercises with animations`)
    const byMuscle = [...host.querySelectorAll('.lib-bar button')].find(b => b.textContent.includes('By muscle'))
    act(() => byMuscle.click())
    expect(mocks.nav).toHaveBeenCalledWith('/muscles')
    // the routines and the week are elsewhere
    expect(host.querySelector('.plan-day')).toBeNull()
    expect(host.querySelector('.plan-routines')).toBeNull()
  })

  it('comes back next time, like the other two views', () => {
    mount()
    pick('Exercises')
    expect(localStorage.getItem(PLAN_VIEW_KEY)).toBe('exercises')
    remount()
    expect(current()).toBe('Exercises')
    expect(library()).not.toBeNull()
    pick('Routines')
    remount()
    expect(current()).toBe('Routines')
    expect(library()).toBeNull()
  })

  it('opens on a linked view, which gives way as soon as you pick another', () => {
    localStorage.setItem(PLAN_VIEW_KEY, 'routines')
    window.location.hash = '#/plan?view=exercises'
    mount()
    expect(current()).toBe('Exercises')
    expect(mocks.nav).not.toHaveBeenCalled()
    pick('Schedule')
    expect(mocks.nav).toHaveBeenCalledWith('/plan', { replace: true })
    expect(localStorage.getItem(PLAN_VIEW_KEY)).toBe('schedule')
  })

  it('ignores a view it does not have, and switching without a link leaves the URL alone', () => {
    window.location.hash = '#/plan?view=nonsense'
    mount()
    expect(current()).toBe('Schedule')
    window.location.hash = '#/plan'
    pick('Exercises')
    expect(mocks.nav).not.toHaveBeenCalled()
  })
})
