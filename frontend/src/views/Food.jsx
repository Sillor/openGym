// The food diary, a tab of its own. The week across the top, the day's calories and macros as
// Cal AI-style cards, then what was eaten, meal by meal. The + button is the way in: a photo, a
// description, a barcode, or the numbers by hand. A photo or a description is read in the
// background (components/food/reads.js) and its review opens when the answer is in.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { dateLocale } from '../lib/i18n.js'
import { fmtNum, todayISO, uid, weekStartOf } from '../lib/format.js'
import { cleanMeal, dayTotals, nutritionOf, profileTargets, MEALS } from '../lib/nutrition.js'
import { useMediaPicker } from '../components/CustomMediaField.jsx'
import { openNutritionSetup } from './NutritionSettings.jsx'
import Icon from '../components/Icon.jsx'
import DayStrip, { shiftISO } from '../components/food/DayStrip.jsx'
import SummaryCards from '../components/food/SummaryCards.jsx'
import MealCard, { PendingCard } from '../components/food/MealCard.jsx'
import { mealLabel, openMealSheet } from '../components/food/MealSheet.jsx'
import { addPhoto, openAddSheet } from '../components/food/AddFood.jsx'
import { dropRead, retryRead, useFoodReads } from '../components/food/reads.js'
import '../food.css'

const RECENT_MEALS = 6
const MODE_KEY = 'gym_food_mode'

let setupOffered = false

function recentDistinct(log) {
  const rows = (log || []).filter(e => e && e.name && e.id)
  rows.sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0) || String(b.d).localeCompare(String(a.d)))
  const seen = new Set()
  const out = []
  for (const e of rows) {
    const key = e.name.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(e)
    if (out.length >= RECENT_MEALS) break
  }
  return out
}

function dayTitle(day) {
  const today = todayISO()
  if (day === today) return t('Today')
  if (day === shiftISO(today, -1)) return t('Yesterday')
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })
}

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'eaten' ? 'eaten' : 'left' } catch { return 'left' }
}

export default function Food() {
  const nav = useNavigate()
  const location = useLocation()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const [day, setDay] = useState(todayISO())
  const [mode, setMode] = useState(readMode)
  const picker = useMediaPicker()
  const reads = useFoodReads(s => s.reads)
  const sheetsOpen = useUI(s => s.sheets.length)
  const once = useRef(false)
  const shown = useRef(new Set())

  const log = S.foodLog
  const kcalByDay = useMemo(() => {
    const out = {}
    for (const e of log || []) if (e && e.d) out[e.d] = (out[e.d] || 0) + (Number(e.kcal) || 0)
    return out
  }, [log])
  const totals = dayTotals(log, day)
  const targets = profileTargets(S).targets
  const groups = MEALS.map(meal => {
    const rows = (log || []).filter(e => e && e.d === day && (e.meal || 'snack') === meal)
      .sort((a, b) => (Number(a.at || a.t) || 0) - (Number(b.at || b.t) || 0))
    return { meal, rows, kcal: rows.reduce((n, e) => n + (Number(e.kcal) || 0), 0) }
  }).filter(g => g.rows.length)
  const pending = reads.filter(r => r.day === day)

  const toggleMode = () => setMode(m => {
    const next = m === 'left' ? 'eaten' : 'left'
    try { localStorage.setItem(MODE_KEY, next) } catch { /* only a preference */ }
    return next
  })

  const openRead = r => openMealSheet({
    day: r.day, source: r.source, media: r.media, fill: r.result, image: r.image, context: r.text,
    onSaved: () => dropRead(r.id),
  })

  // A read that has just finished opens its review, unless something else is on screen; then
  // its card waits with "Review" until it is tapped.
  useEffect(() => {
    if (sheetsOpen) return
    const ready = reads.find(r => r.status === 'ready' && !shown.current.has(r.id))
    if (!ready) return
    shown.current.add(ready.id)
    if (ready.day !== day) setDay(ready.day)
    openRead(ready)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reads, sheetsOpen])

  const logCopy = entry => {
    const next = cleanMeal({ ...entry, id: uid(), d: day, t: Date.now(), at: Date.now() }, { day })
    if (!next) return
    update(s => { s.foodLog = [...(Array.isArray(s.foodLog) ? s.foodLog : []), next] })
    useUI.getState().toast(t('Logged {0}', next.name), {
      action: t('Undo'),
      onAction: () => update(s => { s.foodLog = (s.foodLog || []).filter(e => e && e.id !== next.id) }),
    })
  }

  const photo = (capture, forDay = day) => addPhoto({ capture, day: forDay, picker })
  const add = () => openAddSheet({ day, onPhoto: capture => photo(capture), recent: recentDistinct(log), onLogAgain: logCopy })

  useEffect(() => {
    if (once.current) return
    once.current = true
    const q = new URLSearchParams(location.search)
    const capture = q.get('capture') === '1'
    const gallery = q.get('gallery') === '1'
    const needsHeight = () => nutritionOf(useStore.getState().S).heightCm == null
    if (capture || gallery) {
      nav('/food', { replace: true })
      const go = () => photo(capture, todayISO())
      if (needsHeight()) {
        setupOffered = true
        openNutritionSetup(go)
      } else go()
      return
    }
    if (!setupOffered && needsHeight()) {
      setupOffered = true
      openNutritionSetup()
    }
    // The camera opens once, from the URL this page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="fd">
    <div className="hdr fd-hdr">
      <div><h1>{t('Food')}</h1><div className="sub">{dayTitle(day)}</div></div>
      <div className="fd-hdr-acts">
        {day !== todayISO() && <button type="button" className="fd-today" onClick={() => setDay(todayISO())}>{t('Today')}</button>}
        <button type="button" className="iconbtn" aria-label={t('Nutrition settings')} onClick={() => nav('/settings/nutrition')}><Icon name="slider" /></button>
      </div>
    </div>

    <DayStrip day={day} onPick={setDay} kcalByDay={kcalByDay} target={targets?.kcal || 0} weekStart={weekStartOf(S)} />

    <SummaryCards totals={totals} targets={targets} mode={mode} onToggle={toggleMode} onSetTarget={() => nav('/settings/nutrition')} />

    <div className="fd-log">
      {!!pending.length && <div className="fd-group">
        {pending.map(r => <PendingCard key={r.id} read={r}
          onOpen={() => openRead(r)}
          onRetry={() => retryRead(r.id)}
          onDismiss={() => dropRead(r.id)}
          onManual={() => { dropRead(r.id); openMealSheet({ day: r.day, source: r.media.length ? 'photo' : 'manual', media: r.media, fill: { name: r.text } }) }} />)}
      </div>}

      {groups.map(g => <section key={g.meal} className="fd-group">
        <div className="fd-group-h"><h2>{mealLabel(g.meal)}</h2><span>{fmtNum(g.kcal)} kcal</span></div>
        {g.rows.map(e => <MealCard key={e.id} entry={e} onOpen={() => openMealSheet({ day, entry: e })} />)}
      </section>)}

      {!groups.length && !pending.length && <div className="fd-empty">
        <span className="fd-empty-ic"><Icon name="fork" /></span>
        <h2>{day === todayISO() ? t('Nothing logged yet today') : t('Nothing logged this day')}</h2>
        <p>{t('Snap a photo of your meal and the coach works out the calories and macros.')}</p>
        <button type="button" className="fd-empty-btn" onClick={() => photo(true)}><Icon name="camera" />{t('Scan food')}</button>
      </div>}
    </div>

    <button type="button" className="fd-fab" aria-label={t('Add food')} onClick={add}><Icon name="plus" /></button>
  </div>
}
