/* The server's copies of three tiny reading rules, pinned against the frontend's originals.
 *
 * api/coach/payload.js re-implements modeOf, isBw and isPerSide because the api container has
 * no build step in common with the frontend and does not copy frontend/ into its image. That
 * trade-off is fine; what is not fine is the copy drifting, which is exactly what happened
 * when v1.2.4 taught the app about bodyweight work and per-side reps: the server kept reading
 * every set as a loaded rep set, so a push-up progression that was working would have looked
 * like a stalled bench press with the weight left at zero.
 *
 * This test only runs under vitest, which can load both runtimes. It compares behaviour over a
 * table of configs rather than comparing source, so the two are free to be written differently
 * as long as they answer the same.
 */
import { describe, it, expect } from 'vitest'
import { modeOf as uiModeOf, isBw as uiIsBw, isPerSide as uiIsPerSide } from './history.js'
import { modeOf as srvModeOf, isBw as srvIsBw, isPerSide as srvIsPerSide } from '../../../api/coach/core/payload.js'
import { exOr } from './exercises.js'

// Real ids from the catalogue, so `eq`/`bp` are whatever the dataset actually says rather than
// whatever this test assumed. 0001 is a bodyweight sit-up; the others are looked up the same way.
const IDS = ['0001', '0025', '0043', 'no-such-exercise']

const CONFIGS = [
  {},
  { mode: 'reps' },
  { mode: 'time' },
  { mode: 'cardio' },
  { mode: 'nonsense' },
  { mode: '' },
  { bodyweight: true },
  { bodyweight: false },
  { bodyweight: true, mode: 'time' },
  { side: true },
  { side: false },
  { side: true, bodyweight: true, mode: 'reps' },
  { reps: 8, sets: 3 },
  { repsMax: 20, reps: 12 }
]

describe('server/client reading rules agree', () => {
  for (const id of IDS) {
    const ex = exOr(id)
    for (const base of CONFIGS) {
      const cfg = { ...base, id }
      const label = `${id} ${JSON.stringify(base)}`

      it(`modeOf — ${label}`, () => {
        expect(srvModeOf(cfg, ex)).toBe(uiModeOf(cfg))
      })

      it(`isBw — ${label}`, () => {
        expect(srvIsBw(cfg, ex)).toBe(uiIsBw(cfg))
      })

      it(`isPerSide — ${label}`, () => {
        expect(srvIsPerSide(cfg)).toBe(uiIsPerSide(cfg))
      })
    }
  }

  it('an explicit flag beats the catalogue, on both sides', () => {
    const bodyweightEx = exOr('0001')
    expect(uiIsBw({ id: '0001' })).toBe(true)
    expect(srvIsBw({ id: '0001' }, bodyweightEx)).toBe(true)
    // A dip done with a belt turns it off; the server must agree, or it keeps reading the
    // added load as no load.
    expect(uiIsBw({ id: '0001', bodyweight: false })).toBe(false)
    expect(srvIsBw({ id: '0001', bodyweight: false }, bodyweightEx)).toBe(false)
  })
})

// #311: the validator keeps a routine glyph only when it is one a routine can hold (or a legacy
// emoji), and the payload sends the plan's icons through the same filter. A glyph the app shows
// and the server does not know would be reset by every plan.
import { GLYPHS, KNOWN_GLYPHS, glyphOf } from './glyphs.js'
import { ICON_NAMES } from '../components/Icon.jsx'
import { ROUTINE_GLYPHS, LEGACY_ROUTINE_GLYPHS, glyphStr } from '../../../api/coach/core/glyphs.js'

describe('routine glyphs', () => {
  it('the server offers exactly the glyphs the picker offers, each a real icon', () => {
    expect([...ROUTINE_GLYPHS].sort()).toEqual([...GLYPHS].sort())
    ROUTINE_GLYPHS.forEach(g => expect(ICON_NAMES).toContain(g))
  })
  it('the server keeps every icon key a routine can hold, and the app shows each as itself', () => {
    expect([...ROUTINE_GLYPHS, ...LEGACY_ROUTINE_GLYPHS].sort()).toEqual([...KNOWN_GLYPHS].sort())
    KNOWN_GLYPHS.forEach(g => {
      expect(glyphStr(g)).toBe(g)
      expect(glyphOf(g)).toBe(g)
    })
  })
})

// The api cannot import the Vite app, so the calorie formula is copied. These pin the copy
// against profileTargets — the function the diary actually shows.
import { profileTargets } from './nutrition.js'
import { nutritionSummary } from '../../../api/coach/core/nutrition.js'

describe('server nutrition targets match the app', () => {
  const today = '2026-10-10'
  const base = (over = {}) => ({
    unit: 'kg',
    bodyweight: [{ d: '2026-10-01', w: 80, t: 1 }],
    nutrition: { heightCm: 180, birthday: '1996-01-15', sex: 'male', activity: 'moderate', goal: 'maintain' },
    foodLog: [],
    ...over,
  })
  const same = (S) => {
    const ui = profileTargets(S, today)
    const srv = nutritionSummary(S, '2026-10-01', today, today)
    expect(srv.targets.kcal).toBe(ui.targets.kcal)
    expect(srv.targets.protein).toBe(ui.targets.protein)
    expect(srv.targets.carbs).toBe(ui.targets.carbs)
    expect(srv.targets.fat).toBe(ui.targets.fat)
    return srv
  }

  it('male 30, 180cm, 80kg, moderate, maintain is 2607 / 128 / 415 / 48, inferred', () => {
    const srv = same(base())
    expect(srv.targets).toEqual({ kcal: 2607, protein: 128, carbs: 415, fat: 48, source: 'inferred' })
    expect(srv.inputs.age).toBe(30)
  })

  it('a custom calorie target is custom on both sides, and the other macros stay on the formula', () => {
    const S = base()
    S.nutrition = { ...S.nutrition, customKcal: 2200 }
    const srv = same(S)
    expect(srv.targets.source).toBe('custom')
    expect(srv.targets.kcal).toBe(2200)
    expect(srv.targets.protein).toBe(128)
  })

  it('body fat switches both sides to the same Katch numbers', () => {
    const S = base({ measurements: [{ d: '2026-10-01', bodyFat: 20, t: 1 }] })
    const srv = same(S)
    expect(profileTargets(S, today).targets.method).toBe('katch')
    expect(srv.targets.source).toBe('inferred')
  })
})
