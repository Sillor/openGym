// One meal, reviewed or edited, laid out like Cal AI's nutrition screen: the photo on top, the
// name, how much, calories, the three macros, and what is in it. Every number is a tap away.
// An ingredient opens as a page inside the same sheet. "Fix results" sends the meal as it is
// now, grams and all, with one sentence of correction; the answer replaces the meal and can be
// undone.
//
// Grams are the truth. A portion change scales from the meal as it was when the change began
// (lib/nutrition.js resize), so typing 1, 15, 150 never compounds; a unit change only
// re-expresses the same food.

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store/useStore.js'
import { useUI } from '../../store/useUI.js'
import { t } from '../../lib/i18n.js'
import { fmtNum, uid } from '../../lib/format.js'
import { changeUnit, cleanMeal, mealFromTime, resize, setMealTotal, withIngredients, MEALS } from '../../lib/nutrition.js'
import { analyzeFood, combineFoodItems, fixPrevious } from '../../lib/food-analyze.js'
import { useMediaUrl } from '../CustomMedia.jsx'
import { mediaStore } from '../../lib/media-store.js'
import { confirmSheet, menuSheet } from '../../sheets.jsx'
import Icon from '../Icon.jsx'
import { Button, NumberField, TextArea } from '../ui.jsx'
import PortionControl from './PortionControl.jsx'
import { MACROS } from './SummaryCards.jsx'
import { foodsFrom } from './reads.js'
import { readError, serverCoach } from './coach-food.js'
import { amountText } from './unit-text.js'

export const mealLabel = meal => ({
  breakfast: t('Breakfast'), lunch: t('Lunch'), dinner: t('Dinner'), snack: t('Snack'),
})[meal] || t('Snack')

const NOTE_MAX = 1000

function draftOf({ entry, fill, source, media, day }) {
  const seed = entry || fill || {}
  const name = String(seed.name || '')
  const clean = cleanMeal({ ...seed, name: name.trim() || 'meal', d: day }, { day })
  return {
    ...clean,
    id: entry?.id,
    name,
    meal: entry?.meal || mealFromTime(new Date()),
    media: media || entry?.media || [],
    source: entry?.source || source || 'manual',
    note: entry?.note || '',
    edited: !!entry?.edited,
    t: entry?.t || null,
    at: entry?.at || entry?.t || null,
    ingredients: clean.ingredients || [],
  }
}

const blankLine = () => ({ name: '', kcal: 0, protein: 0, carbs: 0, fat: 0, grams: null, qty: 1, unit: 'serving', units: [] })

/** The meal itself as one line, so adding a first ingredient does not lose what it already had. */
function selfLine(d) {
  return {
    name: d.name.trim() || t('Meal'), kcal: d.kcal, protein: d.protein, carbs: d.carbs, fat: d.fat,
    grams: d.grams, qty: d.servingQty, unit: d.servingUnit, units: d.units || [],
  }
}

function timeOf(ts) {
  const d = ts ? new Date(ts) : new Date()
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function Hero({ media, children }) {
  const file = Array.isArray(media) ? media[0] : null
  const shot = useMediaUrl(file && file.kind !== 'video' ? file : file?.poster || null)
  return <div className="fm-hero">
    {shot.url ? <img alt="" src={shot.url} /> : <div className="fm-hero-ph"><Icon name="image" /></div>}
    <div className="fm-hero-bar">{children}</div>
  </div>
}

/* ---------------------------------------------------------------- value editor -- */

function EditValueSheet({ title, unit, icon, color, value, onDone, close }) {
  const [v, setV] = useState(value)
  return <div className="fv">
    <div className="fv-head">
      <span className="fv-ic" style={{ color }}><Icon name={icon} /></span>
      <h3>{title}</h3>
    </div>
    <div className="fv-field">
      <NumberField autoFocus aria-label={title} value={v} decimal={unit !== 'kcal'} onChange={n => setV(n)}
        onKeyDown={e => { if (e.key === 'Enter') { onDone(v); close() } }} />
      <span className="fv-unit">{unit}</span>
    </div>
    <div className="fm-actions">
      <Button variant="tinted" onClick={close}>{t('Cancel')}</Button>
      <Button variant="primary" onClick={() => { onDone(v); close() }}>{t('Done')}</Button>
    </div>
  </div>
}

function editValue(opts) {
  useUI.getState().openSheet(close => <EditValueSheet {...opts} close={close} />)
}

/* ---------------------------------------------------------------- fix results -- */

const FIX_HINTS = [
  () => t('The portion was bigger'),
  () => t('The portion was smaller'),
  () => t('There was no sauce'),
  () => t('It was cooked in oil'),
]

function FixSheet({ onSend, close }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const text = note.trim()
  const send = async () => {
    if (!text || busy) return
    setBusy(true)
    setError(null)
    const out = await onSend(text)
    if (!alive.current) return
    setBusy(false)
    if (out.ok) close()
    else setError(out.error)
  }
  return <div className="fx">
    <div className="fv-head">
      <span className="fv-ic fx-ic"><Icon name="sparkles" /></span>
      <h3>{t('Fix results')}</h3>
    </div>
    <p className="fx-sub">{t('Say what is off. The coach changes only that and keeps the rest.')}</p>
    <TextArea aria-label={t('What needs fixing')} rows={3} maxLength={NOTE_MAX} value={note} autoFocus
      placeholder={t('The rice was 200 g, not 100. No dressing.')}
      onChange={e => setNote(e.target.value)} disabled={busy}
      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }} />
    <div className="fx-hints" data-nodrag>
      {FIX_HINTS.map((h, i) => <button key={i} type="button" className="fx-hint" disabled={busy}
        onClick={() => setNote(n => (n.trim() ? n.trim() + '. ' : '') + h())}>{h()}</button>)}
    </div>
    {error && <div className="fd-err" role="alert">{readError(error, { fix: true })}</div>}
    <div className="fm-actions">
      <Button variant="tinted" onClick={close}>{t('Cancel')}</Button>
      <Button variant="primary" icon={busy ? null : 'sparkles'} onClick={send} disabled={!text || busy}>
        {busy ? t('Updating…') : error ? t('Try again') : t('Update')}
      </Button>
    </div>
  </div>
}

/* ---------------------------------------------------------------- ingredient -- */

function DescribeLine({ onAdd, close }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const go = async () => {
    const s = text.trim()
    if (!s || busy) return
    setBusy(true)
    setError(null)
    const out = await analyzeFood({ text: s })
    setBusy(false)
    const foods = foodsFrom(out)
    if (!foods.length) { setError(out.error || 'parse'); return }
    const meal = combineFoodItems(foods)
    const lines = meal.ingredients?.length ? meal.ingredients : [{
      name: meal.name, kcal: meal.kcal, protein: meal.protein, carbs: meal.carbs, fat: meal.fat,
      grams: meal.grams, qty: meal.servingQty, unit: meal.servingUnit, units: meal.units || [],
    }]
    onAdd(lines)
    close()
  }
  return <div className="fx">
    <h3>{t('Add an ingredient')}</h3>
    <TextArea aria-label={t('Ingredient')} rows={2} maxLength={300} value={text} autoFocus disabled={busy}
      placeholder={t('1 tbsp olive oil')} onChange={e => setText(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go() } }} />
    {error && <div className="fd-err" role="alert">{readError(error)}</div>}
    <div className="fm-actions">
      <Button variant="tinted" onClick={close}>{t('Cancel')}</Button>
      <Button variant="primary" onClick={go} disabled={!text.trim() || busy}>{busy ? t('Reading…') : t('Add')}</Button>
    </div>
  </div>
}

function IngredientPage({ row, onChange, onRemove, onBack }) {
  const base = useRef(null)
  const set = fields => { base.current = null; onChange({ ...row, ...fields }) }
  return <div className="fm fm-page">
    <div className="fm-nav">
      <button type="button" className="fm-navbtn" onClick={onBack}><Icon name="chevronLeft" /><span>{t('Meal')}</span></button>
      <span className="fm-nav-t">{t('Ingredient')}</span>
      <button type="button" className="fm-navbtn danger" aria-label={t('Remove')} onClick={onRemove}><Icon name="trash" /></button>
    </div>
    <div className="fm-body">
      <input className="fm-name" aria-label={t('Ingredient')} value={row.name} placeholder={t('Ingredient name')}
        onChange={e => onChange({ ...row, name: e.target.value })} />
      <PortionControl item={row} label={t('Amount')}
        onQty={(q, u) => { if (!base.current) base.current = row; onChange(resize(base.current, q, u)) }}
        onUnit={u => { base.current = null; onChange(changeUnit(row, u)) }} />
      <div className="fm-list">
        {[['kcal', t('Calories'), 'kcal', 'flame', 'var(--fd-kcal)'], ...MACROS.map(m => [m.key, m.label(), 'g', m.icon, m.color])].map(([key, label, unit, icon, color]) => (
          <label key={key} className="fm-li">
            <span className="fm-li-ic" style={{ color }}><Icon name={icon} /></span>
            <span className="fm-li-t">{label}</span>
            <NumberField aria-label={label} decimal={key !== 'kcal'} value={row[key]} onChange={v => set({ [key]: v ?? 0 })} />
            <span className="fm-li-u">{unit}</span>
          </label>
        ))}
      </div>
      <p className="fm-hint">{t('Calories and macros are for the amount above. Changing the amount scales them.')}</p>
    </div>
    <div className="fm-foot">
      <Button variant="primary" onClick={onBack}>{t('Done')}</Button>
    </div>
  </div>
}

/* ---------------------------------------------------------------- the sheet -- */

function MealSheet({ day, entry, fill, source, media, image, context, onSaved, close, lock }) {
  const update = useStore(s => s.update)
  const [draft, setDraftRaw] = useState(() => draftOf({ entry, fill, source, media, day }))
  const [page, setPage] = useState(null)
  const initial = useRef(JSON.stringify(draft))
  const draftRef = useRef(draft)
  const portionBase = useRef(null)
  const imageRef = useRef(image || null)
  const alive = useRef(true)
  const lockRef = useRef(lock)
  draftRef.current = draft
  lockRef.current = lock
  const dirty = JSON.stringify(draft) !== initial.current
  const fresh = !entry

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  // Unsaved changes hold the sheet: a stray swipe must not throw a corrected meal away.
  useEffect(() => { lockRef.current?.(dirty) }, [dirty])
  useEffect(() => {
    const hashes = draft.media.flatMap(m => [m?.hash, m?.poster?.hash]).filter(Boolean)
    if (!hashes.length) return undefined
    return mediaStore.hold(hashes)
  }, [draft.media])

  const setDraft = (fn, { portion = false } = {}) => {
    if (!portion) portionBase.current = null
    setDraftRaw(fn)
  }

  const edit = fields => setDraft(d => ({ ...d, ...fields, edited: true }))

  const leave = () => {
    if (!dirty) { close(); return }
    confirmSheet({
      title: fresh ? t('Discard this meal?') : t('Discard your changes?'),
      confirmText: t('Discard'),
      danger: true,
      onConfirm: close,
    })
  }

  const save = () => {
    const name = draft.name.trim()
    if (!name) { useUI.getState().toast(t('Name the meal')); return }
    const now = Date.now()
    const next = cleanMeal({ ...draft, name, id: entry?.id || uid(), d: day, t: entry?.t || now, at: draft.at || now }, { day })
    if (!next) return
    update(s => {
      const list = Array.isArray(s.foodLog) ? s.foodLog : []
      s.foodLog = entry ? list.map(e => (e && e.id === entry.id ? next : e)) : [...list, next]
    })
    onSaved?.(next)
    close()
  }

  const logAgain = () => {
    const next = cleanMeal({ ...draft, name: draft.name.trim() || entry.name, id: uid(), d: day, t: Date.now(), at: Date.now() }, { day })
    if (!next) return
    update(s => { s.foodLog = [...(Array.isArray(s.foodLog) ? s.foodLog : []), next] })
    useUI.getState().toast(t('Logged again'))
    close()
  }

  const remove = () => confirmSheet({
    title: t('Delete this meal?'),
    message: entry.name,
    confirmText: t('Delete'),
    danger: true,
    onConfirm: () => {
      update(s => { s.foodLog = (s.foodLog || []).filter(e => e && e.id !== entry.id) })
      close()
    },
  })

  const more = () => menuSheet({
    items: [
      entry && { icon: 'repeat', label: t('Log again'), onClick: logAgain },
      entry && { icon: 'trash', label: t('Delete'), danger: true, onClick: remove },
      !entry && { icon: 'trash', label: t('Discard'), danger: true, onClick: close },
    ],
  })

  const pickMeal = () => menuSheet({
    title: t('Meal'),
    items: MEALS.map(m => ({ label: mealLabel(m), on: draft.meal === m, onClick: () => setDraft(d => ({ ...d, meal: m })) })),
  })

  /* --- numbers --- */
  const onPortion = (q, u) => {
    if (!portionBase.current) portionBase.current = draftRef.current
    const base = portionBase.current
    setDraft(() => ({ ...resize(base, q, u), edited: true }), { portion: true })
  }
  const onUnit = u => setDraft(d => changeUnit(d, u))
  const editTotal = (key, label, unit, icon, color) => editValue({
    title: label, unit, icon, color, value: draft[key],
    onDone: v => setDraft(d => ({ ...setMealTotal(d, key, v ?? 0), edited: true })),
  })

  /* --- ingredients --- */
  const lines = draft.ingredients || []
  const setLines = (list, extra = {}) => setDraft(d => {
    if (!list.length) return { ...d, ingredients: [], kcal: 0, protein: 0, carbs: 0, fat: 0, edited: true, ...extra }
    return { ...withIngredients(d, list), edited: true, ...extra }
  })
  const changeLine = (i, row) => setLines(lines.map((r, k) => (k === i ? row : r)))
  const removeLine = i => { setPage(null); setLines(lines.filter((_, k) => k !== i)) }
  const appendLines = rows => {
    const start = !lines.length && (draft.kcal > 0 || draft.protein > 0 || draft.carbs > 0 || draft.fat > 0) ? [selfLine(draft)] : lines
    setLines([...start, ...rows].slice(0, 20))
    return start.length
  }
  const addLine = () => {
    const manual = () => { const at = appendLines([blankLine()]); setPage({ index: at }) }
    if (!serverCoach()) { manual(); return }
    menuSheet({
      title: t('Add an ingredient'),
      items: [
        { icon: 'sparkles', label: t('Describe it'), sub: t('The coach fills in the numbers'), onClick: () => useUI.getState().openSheet(c => <DescribeLine onAdd={appendLines} close={c} />) },
        { icon: 'pencil', label: t('Enter it yourself'), onClick: manual },
      ],
    })
  }

  /* --- fix results --- */
  const sendFix = async note => {
    const before = draftRef.current
    const out = await analyzeFood({
      fix: { previous: fixPrevious(before), note, ...(context ? { context } : {}) },
      ...(imageRef.current ? { images: [imageRef.current] } : {}),
    })
    if (!alive.current) return { ok: true }
    const meal = combineFoodItems(foodsFrom(out))
    if (!meal) return { ok: false, error: out.error || 'parse' }
    const clean = cleanMeal({ ...meal, d: day }, { day })
    if (!clean) return { ok: false, error: 'parse' }
    setDraft(d => ({
      ...d,
      name: clean.name || d.name,
      kcal: clean.kcal, protein: clean.protein, carbs: clean.carbs, fat: clean.fat,
      grams: clean.grams, servingQty: clean.servingQty, servingUnit: clean.servingUnit, units: clean.units,
      ingredients: clean.ingredients || [],
    }))
    useUI.getState().toast(t('Meal updated'), { action: t('Undo'), onAction: () => { if (alive.current) setDraft(() => before) } })
    return { ok: true }
  }
  const openFix = () => {
    if (!serverCoach()) { useUI.getState().toast(t('Turn the coach on to fix a meal. You can still edit every number.')); return }
    useUI.getState().openSheet(c => <FixSheet onSend={sendFix} close={c} />)
  }

  if (page && lines[page.index]) {
    return <IngredientPage row={lines[page.index]}
      onChange={row => changeLine(page.index, row)}
      onRemove={() => removeLine(page.index)}
      onBack={() => setPage(null)} />
  }

  const photo = draft.media.length > 0
  const bar = <>
    <button type="button" className="fm-circle" aria-label={t('Close')} onClick={leave}><Icon name="xmark" /></button>
    <button type="button" className="fm-circle" aria-label={t('More')} onClick={more}><Icon name="more" /></button>
  </>

  return <div className={'fm' + (photo ? ' fm-photo' : '')}>
    {photo ? <Hero media={draft.media}>{bar}</Hero> : <div className="fm-top">{bar}</div>}
    <div className="fm-body">
      <div className="fm-meta">
        <button type="button" className="fm-pill" onClick={pickMeal}>{mealLabel(draft.meal)}<Icon name="chevronDown" /></button>
        <span className="fm-time">{timeOf(draft.at)}</span>
      </div>
      <input className="fm-name" aria-label={t('Name')} value={draft.name} placeholder={t('Meal name')}
        onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
      <PortionControl item={draft} label={t('Portion')} onQty={onPortion} onUnit={onUnit} />

      <button type="button" className="fd-card fm-kcal" aria-label={t('Calories') + ' ' + fmtNum(draft.kcal || 0)} onClick={() => editTotal('kcal', t('Calories'), 'kcal', 'flame', 'var(--fd-kcal)')}>
        <span className="fm-kcal-ic"><Icon name="flame" /></span>
        <span className="fm-kcal-t">
          <span className="fm-cap">{t('Calories')}</span>
          <span className="fm-kcal-n">{fmtNum(draft.kcal || 0)}</span>
        </span>
        <Icon name="pencil" className="fm-edit" />
      </button>
      <div className="fm-macros">
        {MACROS.map(m => <button key={m.key} type="button" className="fd-card fm-macro" aria-label={m.label()}
          onClick={() => editTotal(m.key, m.label(), 'g', m.icon, m.color)}>
          <span className="fm-cap"><Icon name={m.icon} style={{ color: m.color }} />{m.label()}</span>
          <span className="fm-macro-n">{fmtNum(draft[m.key] || 0)}<small>g</small></span>
        </button>)}
      </div>

      <div className="fm-sec">
        <h4>{t('Ingredients')}</h4>
        <button type="button" className="fm-add" onClick={addLine}><Icon name="plus" />{t('Add')}</button>
      </div>
      {lines.length
        ? <div className="fm-ings">
            {lines.map((row, i) => <button key={i} type="button" className="fm-ing" onClick={() => setPage({ index: i })}>
              <span className="fm-ing-main">
                <span className="fm-ing-name">{row.name || t('Ingredient')}</span>
                <span className="fm-ing-sub">
                  <span>{amountText(row.qty, row.unit)}</span>
                  <i style={{ background: 'var(--fd-protein)' }} />{fmtNum(row.protein || 0)}
                  <i style={{ background: 'var(--fd-carbs)' }} />{fmtNum(row.carbs || 0)}
                  <i style={{ background: 'var(--fd-fat)' }} />{fmtNum(row.fat || 0)}
                </span>
              </span>
              <span className="fm-ing-kcal">{fmtNum(row.kcal || 0)}<small>kcal</small></span>
              <Icon name="chevronRight" className="fm-chev" />
            </button>)}
          </div>
        : <p className="fm-hint">{t('Add what is in it to adjust each part on its own.')}</p>}
    </div>
    <div className="fm-foot fm-actions">
      <Button variant="tinted" icon="sparkles" onClick={openFix}>{t('Fix results')}</Button>
      <Button variant="primary" onClick={save}>{fresh ? t('Log') : t('Done')}</Button>
    </div>
  </div>
}

/** Open a meal: `entry` to edit a saved one, `fill` for a new one with numbers, neither for a blank. */
export function openMealSheet(opts) {
  let handle = null
  handle = useUI.getState().openSheet(close => <MealSheet {...opts} close={close} lock={v => handle?.lock(v)} />)
  return handle
}

