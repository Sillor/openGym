// The day diary. A photo is the first action; typing a meal always works, with or without a model.
// When the instance coach is on, the photo or a short description is sent to /api/nutrition/analyze
// and the sheet opens with the estimate, ready to correct. The photo kept on the meal is a hash,
// never the bytes that were sent.

import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtDate, fmtNum, isoOf, todayISO, uid } from '../lib/format.js'
import { cleanMeal, dayTotals, mealFromTime, nutritionOf, profileTargets, MEALS } from '../lib/nutrition.js'
import { analyzeFood, foodImageFromFile } from '../lib/food-analyze.js'
import { coachAvailable } from '../lib/coach.js'
import { useMediaPicker } from '../components/CustomMediaField.jsx'
import { useMediaUrl } from '../components/CustomMedia.jsx'
import { mediaStore } from '../lib/media-store.js'
import { confirmSheet } from '../sheets.jsx'
import { openNutritionSetup } from './NutritionSettings.jsx'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, SelectRow, TextField } from '../components/ui.jsx'

const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' }

let setupOffered = false

function shiftISO(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return isoOf(dt)
}

function chooseImage(capture) {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    if (capture) input.setAttribute('capture', 'environment')
    input.addEventListener('change', () => resolve((input.files && input.files[0]) || null), { once: true })
    input.click()
  })
}

function MealThumb({ media }) {
  const file = Array.isArray(media) ? media[0] : null
  const shot = useMediaUrl(file && file.kind !== 'video' ? file : file?.poster || null)
  if (!file) return null
  if (shot.url) return <img className="thumb" alt="" src={shot.url} />
  return <div className="thumb thumb-x"><Icon name="camera" /></div>
}

function MacroLine({ label, value, target, color }) {
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0
  return <div>
    <div className="row between small" style={{ marginBottom: 4 }}>
      <span>{label}</span>
      <span className="muted">{fmtNum(value)}{target > 0 ? ' / ' + fmtNum(target) : ''} g</span>
    </div>
    <div style={{ height: 5, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
      <div style={{ width: pct + '%', height: '100%', background: color }} />
    </div>
  </div>
}

function fillOf(entry, fill) {
  if (entry) return entry
  return fill || {}
}

function MealSheet({ day, entry, source, media: initialMedia, fill, close }) {
  const update = useStore(s => s.update)
  const seed = fillOf(entry, fill)
  const [name, setName] = useState(entry?.name || seed.name || '')
  const [kcal, setKcal] = useState(entry ? entry.kcal : seed.kcal ?? null)
  const [protein, setProtein] = useState(entry ? entry.protein : seed.protein ?? null)
  const [carbs, setCarbs] = useState(entry ? entry.carbs : seed.carbs ?? null)
  const [fat, setFat] = useState(entry ? entry.fat : seed.fat ?? null)
  const [grams, setGrams] = useState(entry ? (entry.grams ?? null) : (seed.grams ?? null))
  const [meal, setMeal] = useState(entry?.meal || mealFromTime(new Date()))
  const [note, setNote] = useState(entry?.note || '')
  const [media, setMedia] = useState(initialMedia || entry?.media || [])
  const picker = useMediaPicker()

  useEffect(() => {
    const hashes = media.flatMap(m => [m?.hash, m?.poster?.hash]).filter(Boolean)
    if (!hashes.length) return undefined
    return mediaStore.hold(hashes)
  }, [media])

  const addPhoto = async capture => {
    if (media.length >= 3) return
    if (!picker.canAdd) {
      if (picker.note) useUI.getState().toast(picker.note)
      return
    }
    const file = await chooseImage(capture)
    if (!file) return
    const got = await picker.pick(file)
    if (got) setMedia(list => [...list, got].slice(0, 3))
  }

  const save = () => {
    const numbersChanged = !!entry && (
      kcal !== entry.kcal || protein !== entry.protein || carbs !== entry.carbs || fat !== entry.fat || grams !== (entry.grams ?? null)
    )
    const next = cleanMeal({
      ...entry,
      name, kcal, protein, carbs, fat, grams, meal, note, media,
      d: day,
      id: entry?.id || uid(),
      source: entry?.source || source || 'manual',
      edited: !!(entry?.edited || numbersChanged),
    }, { day })
    if (!next) { useUI.getState().toast(t('Name the meal')); return }
    update(s => {
      const list = Array.isArray(s.foodLog) ? s.foodLog : []
      const without = list.filter(e => e && e.id !== next.id)
      s.foodLog = [...without, next]
    })
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

  return <>
    <h3 style={{ marginTop: 0 }}>{entry ? t('Edit meal') : t('Add a meal')}</h3>
    <div className="measure-form" style={{ marginBottom: 12 }}>
      <label className="measure-field" style={{ gridColumn: '1 / -1' }}>
        <span>{t('Name')}</span>
        <TextField aria-label={t('Name')} value={name} onChange={e => setName(e.target.value)} placeholder={t('Oats and berries')} />
      </label>
      <Num label={t('Calories')} unit="kcal" value={kcal} onChange={setKcal} />
      <Num label={t('Protein')} unit="g" value={protein} onChange={setProtein} />
      <Num label={t('Carbs')} unit="g" value={carbs} onChange={setCarbs} />
      <Num label={t('Fat')} unit="g" value={fat} onChange={setFat} />
      <Num label={t('Grams')} unit="g" value={grams} onChange={setGrams} />
    </div>
    <SelectRow icon="sun" iconTint="var(--yellow)" title={t('Meal')} value={meal} onChange={setMeal}
      options={MEALS.map(value => ({ value, label: t(MEAL_LABEL[value]) }))} />
    <label className="measure-field" style={{ display: 'block', margin: '12px 0' }}>
      <span>{t('Note')}</span>
      <TextField aria-label={t('Note')} value={note} onChange={e => setNote(e.target.value)} />
    </label>
    {media.length > 0 && <div className="row" style={{ gap: 8, marginBottom: 12 }}>
      {media.map((m, i) => <MealThumb key={m.hash || i} media={[m]} />)}
    </div>}
    {media.length < 3 && <div className="row" style={{ gap: 8, marginBottom: 12 }}>
      <Button icon="camera" onClick={() => addPhoto(true)} disabled={picker.busy}>{t('Photo')}</Button>
      <Button icon="image" onClick={() => addPhoto(false)} disabled={picker.busy}>{t('Gallery')}</Button>
    </div>}
    <Button variant="primary" onClick={save} disabled={picker.busy}>{t('Save')}</Button>
    {entry && <div style={{ height: 8 }} />}
    {entry && <Button variant="danger" onClick={remove}>{t('Delete')}</Button>}
  </>
}

function Num({ label, value, unit, onChange }) {
  return <label className="measure-field">
    <span>{label}</span>
    <span className="measure-input">
      <NumberField nullable aria-label={label} value={value ?? null} onChange={onChange} />
      {unit && <i>{unit}</i>}
    </span>
  </label>
}

export function openMealSheet(opts) {
  useUI.getState().openSheet(close => <MealSheet {...opts} close={close} />)
}

function serverCoach() {
  const { user, config, coachLocal } = useStore.getState()
  return coachAvailable(config, user, { mobile: false, coachMode: coachLocal?.mode }) && !!(user && config?.coach?.enabled)
}

function analysisNote(error, photo) {
  if (error === 'cap') return t('Today’s read limit is used up. Type the meal instead.')
  if (error === 'parse') return photo ? t('That photo could not be read. Type the meal instead.') : t('That description could not be read. Type the meal instead.')
  if (error === 'auth') return t('Sign in, and turn the coach on, to read a meal. You can still type it.')
  return photo ? t('The coach can’t read this photo. Type the meal instead.') : t('The coach can’t read that. Type the meal instead.')
}

async function readMeal({ text, images, photo }) {
  if (!serverCoach()) {
    useUI.getState().toast(t('Turn the coach on to read a meal. You can still type it.'))
    return null
  }
  useUI.getState().toast(photo ? t('Reading the photo…') : t('Reading that…'))
  const out = await analyzeFood({ text, images })
  if (!out.ok) { useUI.getState().toast(analysisNote(out.error, photo)); return null }
  return out.item
}

export default function Nutrition() {
  const nav = useNavigate()
  const location = useLocation()
  const S = useStore(s => s.S)
  const [day, setDay] = useState(todayISO())
  const [desc, setDesc] = useState('')
  const [reading, setReading] = useState(false)
  const picker = useMediaPicker()
  const once = useRef(false)

  const shoot = async (capture, forDay) => {
    if (!picker.canAdd) {
      if (picker.note) useUI.getState().toast(picker.note)
      openMealSheet({ day: forDay, source: 'manual' })
      return
    }
    const file = await chooseImage(capture)
    if (!file) return
    const got = await picker.pick(file)
    let fill = null
    if (serverCoach()) {
      setReading(true)
      try {
        const image = await foodImageFromFile(file)
        fill = await readMeal({ images: [image], text: desc, photo: true })
      } catch {
        useUI.getState().toast(t('That photo could not be read. Type the meal instead.'))
      } finally { setReading(false) }
    } else {
      useUI.getState().toast(t('Turn the coach on to read a photo. You can still type the meal.'))
    }
    openMealSheet({ day: forDay, source: got ? 'photo' : 'manual', media: got ? [got] : [], fill })
  }

  const estimate = async () => {
    const text = desc.trim()
    if (!text) { openMealSheet({ day, source: 'manual' }); return }
    setReading(true)
    let fill = null
    try { fill = await readMeal({ text, photo: false }) }
    finally { setReading(false) }
    openMealSheet({ day, source: fill ? 'text' : 'manual', fill: fill || { name: text } })
    if (fill) setDesc('')
  }

  useEffect(() => {
    if (once.current) return
    once.current = true
    const q = new URLSearchParams(location.search)
    if (q.get('capture') === '1' || q.get('gallery') === '1') {
      nav('/nutrition', { replace: true })
      shoot(q.get('capture') === '1', todayISO())
      return
    }
    if (!setupOffered && nutritionOf(S).heightCm == null) {
      setupOffered = true
      openNutritionSetup()
    }
    // The camera opens once, from the URL this page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totals = dayTotals(S.foodLog, day)
  const targets = profileTargets(S).targets
  const left = targets ? targets.kcal - totals.kcal : null
  const hero = left == null ? totals.kcal : Math.abs(left)
  const label = left == null ? t('kcal eaten') : left >= 0 ? t('kcal left') : t('kcal over')
  const groups = MEALS.map(meal => ({
    meal,
    rows: (S.foodLog || []).filter(e => e && e.d === day && (e.meal || 'snack') === meal).sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0)),
  })).filter(g => g.rows.length)

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1 }} />
      <button className="iconbtn" onClick={() => setDay(d => shiftISO(d, -1))} aria-label={t('Previous day')}><Icon name="chevronLeft" /></button>
      <div style={{ textAlign: 'center' }}>
        <input type="date" aria-label={t('Date')} value={day} onChange={e => { if (e.target.value) setDay(e.target.value) }}
          style={{ background: 'transparent', color: 'inherit', border: 0, font: 'inherit', fontWeight: 650, textAlign: 'center' }} />
      </div>
      <button className="iconbtn" onClick={() => setDay(d => shiftISO(d, 1))} aria-label={t('Next day')}><Icon name="chevronRight" /></button>
    </div>

    <div className="card">
      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
        <div className="big" style={left != null && left < 0 ? { color: 'var(--red)' } : undefined}>{fmtNum(hero)}</div>
        <span className="muted">{label}</span>
      </div>
      <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
        <MacroLine label={t('Protein')} value={totals.protein} target={targets?.protein || 0} color="var(--blue)" />
        <MacroLine label={t('Carbs')} value={totals.carbs} target={targets?.carbs || 0} color="var(--orange)" />
        <MacroLine label={t('Fat')} value={totals.fat} target={targets?.fat || 0} color="var(--green)" />
      </div>
      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <Button variant="primary" icon="camera" onClick={() => shoot(true, day)} disabled={picker.busy || reading}>{t('Photo')}</Button>
        <Button icon="image" onClick={() => shoot(false, day)} disabled={picker.busy || reading}>{t('Gallery')}</Button>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'stretch' }}>
        <TextField aria-label={t('Describe a meal')} value={desc} placeholder={t('2 eggs and toast')} onChange={e => setDesc(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') estimate() }} />
        <Button onClick={estimate} disabled={reading}>{t('Estimate')}</Button>
      </div>
      <div style={{ height: 8 }} />
      <Button onClick={() => openMealSheet({ day, source: 'manual' })}>{t('Add manually')}</Button>
    </div>

    {!groups.length && <div className="card">
      <div className="muted small">{t('Nothing logged this day. A photo is the fastest way in.')}</div>
    </div>}

    {groups.map(g => <div key={g.meal} style={{ marginTop: 16 }}>
      <h4 className="sec">{t(MEAL_LABEL[g.meal])}</h4>
      <div className="card" style={{ padding: 0 }}>
        {g.rows.map(e => <button key={e.id} type="button" className="lrow" style={{ width: '100%', background: 'none', border: 0, color: 'inherit', textAlign: 'start' }}
          onClick={() => openMealSheet({ day, entry: e })}>
          <MealThumb media={e.media} />
          <span className="lrow-t" style={{ flex: 1 }}>{e.name}</span>
          <span className="muted small">{fmtNum(e.kcal)} kcal</span>
        </button>)}
      </div>
    </div>)}
  </div>
}
