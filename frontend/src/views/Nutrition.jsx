// The day diary. A sentence is context for a photo or for Type. A photo waits for Estimate
// before the model sees it. Photo, Type, and Barcode each open one review. Several foods
// from a read become that meal's ingredients. The photo kept on the meal is a hash. The
// bytes sent to the coach live only in the sheet that is reading them.

import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtNum, isoOf, todayISO, uid } from '../lib/format.js'
import { cleanMeal, convertServingUnit, dayTotals, mealFromTime, nutritionOf, profileTargets, scaleToServings, MEALS } from '../lib/nutrition.js'
import { analyzeFood, combineFoodItems, foodImageFromFile } from '../lib/food-analyze.js'
import { lookupFoodBarcode, normalizeBarcode } from '../lib/open-food-facts.js'
import { coachAvailable } from '../lib/coach.js'
import { MOBILE } from '../lib/mobile.js'
import { importCodeFromImage, scanCode } from '../lib/scan.js'
import { useMediaPicker } from '../components/CustomMediaField.jsx'
import { useMediaUrl } from '../components/CustomMedia.jsx'
import { mediaStore } from '../lib/media-store.js'
import { confirmSheet, menuSheet } from '../sheets.jsx'
import { openNutritionSetup } from './NutritionSettings.jsx'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, Section, SelectRow, TextField } from '../components/ui.jsx'

const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' }
const SERVING_UNITS = ['g', 'ml', 'cup', 'tbsp', 'piece', 'slice', 'serving']
const LIQUID_ML = { ml: 1, tbsp: 15, cup: 240 }
const LABEL_UNITS = new Set(['g', 'piece', 'slice', 'serving'])
// Product codes only. Gym check-in keeps its own QR detector in lib/scan-web.js.
const FOOD_BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']
const RECENT_MEALS = 5

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

function lineTotals(list) {
  let kcal = 0, protein = 0, carbs = 0, fat = 0
  for (const item of list || []) {
    kcal += Number(item.kcal) || 0
    protein += Number(item.protein) || 0
    carbs += Number(item.carbs) || 0
    fat += Number(item.fat) || 0
  }
  return {
    kcal: Math.round(kcal),
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fat: Math.round(fat * 10) / 10,
  }
}

function foodsFrom(out) {
  if (!out?.ok) return []
  if (Array.isArray(out.items) && out.items.length) return out.items.filter(i => i && i.name)
  if (out.item && out.item.name) return [out.item]
  return []
}

function draftOf({ entry, fill, source, media }) {
  const seed = entry || fill || {}
  const ingredients = Array.isArray(seed.ingredients) && seed.ingredients.length
    ? seed.ingredients.slice(0, 8).map(row => ({ ...row }))
    : null
  return {
    name: seed.name || '',
    kcal: entry ? entry.kcal : (seed.kcal ?? null),
    protein: entry ? entry.protein : (seed.protein ?? null),
    carbs: entry ? entry.carbs : (seed.carbs ?? null),
    fat: entry ? entry.fat : (seed.fat ?? null),
    grams: entry ? (entry.grams ?? null) : (seed.grams ?? null),
    servingQty: Number(seed.servingQty) > 0 ? Number(seed.servingQty) : 1,
    servingUnit: seed.servingUnit || 'serving',
    meal: entry?.meal || mealFromTime(new Date()),
    note: entry?.note || '',
    media: media || entry?.media || [],
    ingredients,
    edited: !!entry?.edited,
    source: entry?.source || source || 'manual',
  }
}

function applyItem(d, item) {
  const ingredients = Array.isArray(item.ingredients) && item.ingredients.length
    ? item.ingredients.slice(0, 8).map(row => ({ ...row }))
    : null
  const totals = ingredients ? lineTotals(ingredients) : {
    kcal: item.kcal ?? null,
    protein: item.protein ?? null,
    carbs: item.carbs ?? null,
    fat: item.fat ?? null,
  }
  return {
    ...d,
    name: item.name || d.name,
    ...totals,
    grams: item.grams ?? d.grams ?? null,
    servingQty: Number(item.servingQty) > 0 ? Number(item.servingQty) : (Number(d.servingQty) > 0 ? Number(d.servingQty) : 1),
    servingUnit: item.servingUnit || d.servingUnit || 'serving',
    ingredients,
    edited: false,
  }
}

function servingLabel(qty, unit) {
  const n = Number(qty) > 0 ? Number(qty) : 1
  return `${fmtNum(n)} ${unit || 'serving'}`
}

function amountOf(row) {
  if (row?.unit) return servingLabel(row.qty, row.unit)
  if (Number(row?.grams) > 0) return `${fmtNum(row.grams)} g`
  return '1 serving'
}

function applyServingUnit(entry, unit) {
  const converted = convertServingUnit(entry, unit)
  if (converted !== entry) return converted
  if (LABEL_UNITS.has(unit)) return { ...entry, servingUnit: unit }
  return entry
}

function convertLineUnit(row, unit) {
  if (!row || row.unit === unit) return row
  const from = LIQUID_ML[row.unit] ? row.unit : null
  const to = LIQUID_ML[unit] ? unit : null
  if (from && to && Number(row.qty) > 0) {
    return { ...row, qty: Number(row.qty) * LIQUID_ML[from] / LIQUID_ML[to], unit: to }
  }
  if (LABEL_UNITS.has(unit)) return { ...row, unit }
  return row
}

function mealBrief(d) {
  const kcal = d.kcal == null || d.kcal === '' ? '' : `${Math.round(Number(d.kcal) || 0)} kcal`
  const head = [d.name, servingLabel(d.servingQty, d.servingUnit), kcal].filter(Boolean).join(', ')
  const lines = (d.ingredients || []).slice(0, 8).map(row => (
    [row.name, amountOf(row), row.kcal == null ? '' : `${Math.round(Number(row.kcal) || 0)} kcal`].filter(Boolean).join(', ')
  ))
  return [head, ...lines].filter(Boolean).join('\n')
}

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

function foodBarcodeDetector() {
  if (typeof globalThis.BarcodeDetector !== 'function') return null
  try { return new globalThis.BarcodeDetector({ formats: FOOD_BARCODE_FORMATS }) }
  catch { return null }
}

async function barcodeFromImage(file) {
  const det = foodBarcodeDetector()
  if (!det || !file || typeof createImageBitmap !== 'function') return null
  let bmp
  try { bmp = await createImageBitmap(file) }
  catch { return null }
  try {
    const found = await det.detect(bmp)
    const hit = found && found.find(b => b && b.rawValue)
    return hit ? String(hit.rawValue) : null
  } catch { return null }
  finally { if (bmp && bmp.close) bmp.close() }
}

function scanErrorMessage(e) {
  const m = String(e && e.message)
  if (m === 'permission-denied') return t('Camera permission is needed to scan. Enable it in Settings.')
  if (m === 'unsupported') return t('Scanning is not available on this device.')
  return t('Could not start the scanner')
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

function ReviewPhoto({ media, onClose }) {
  const file = Array.isArray(media) ? media[0] : null
  const shot = useMediaUrl(file && file.kind !== 'video' ? file : file?.poster || null)
  if (!file) return null
  return <div className="nut-review-photo">
    {shot.url ? <img alt="" src={shot.url} /> : <div className="nut-review-ph" />}
    <button type="button" className="iconbtn" aria-label={t('Close')} onClick={onClose}><Icon name="xmark" /></button>
  </div>
}

function MealSheet({ day, entry, source, media: initialMedia, fill, image, context, pause, onReading, close }) {
  const update = useStore(s => s.update)
  const [draft, setDraft] = useState(() => draftOf({ entry, fill, source, media: initialMedia }))
  const [busy, setBusy] = useState(false)
  const [fail, setFail] = useState(null)
  const [focus, setFocus] = useState(null)
  const [fixOn, setFixOn] = useState(false)
  const [fix, setFix] = useState('')
  const [paused, setPaused] = useState(() => !!(image || pause))
  const [note, setNote] = useState(() => context || '')
  const draftRef = useRef(draft)
  const servingBase = useRef(null)
  const ingBase = useRef(null)
  const imageRef = useRef(image || null)
  const contextRef = useRef(context || '')
  const onReadingRef = useRef(onReading)
  const alive = useRef(true)
  draftRef.current = draft
  onReadingRef.current = onReading

  useEffect(() => {
    const hashes = draft.media.flatMap(m => [m?.hash, m?.poster?.hash]).filter(Boolean)
    if (!hashes.length) return undefined
    return mediaStore.hold(hashes)
  }, [draft.media])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; onReadingRef.current?.(false) }
  }, [])

  const takeEstimate = meal => {
    setDraft(d => applyItem(d, meal))
    setFocus(null)
    setFail(null)
  }

  const readImage = async () => {
    const bytes = imageRef.current
    if (!bytes) return
    setBusy(true)
    setFail(null)
    onReadingRef.current?.(true)
    try {
      const hint = String(contextRef.current || '').trim()
      const out = await analyzeFood(hint ? { images: [bytes], text: hint } : { images: [bytes] })
      if (!alive.current) return
      const meal = combineFoodItems(foodsFrom(out))
      if (!meal) { setFail((out && out.error) || 'provider'); return }
      takeEstimate(meal)
    } finally {
      onReadingRef.current?.(false)
      if (alive.current) setBusy(false)
    }
  }

  const estimatePhoto = async () => {
    if (busy) return
    const sentence = note.trim()
    contextRef.current = sentence
    if (!imageRef.current) {
      setPaused(false)
      if (sentence) setDraft(d => (d.name ? d : { ...d, name: sentence }))
      return
    }
    setPaused(false)
    await readImage()
  }

  const onMacro = (key, value) => setDraft(d => {
    const list = d.ingredients
    if (!list?.length) return { ...d, [key]: value, edited: true }
    const from = Number(d[key]) || 0
    const to = value == null ? 0 : Number(value)
    const round = key === 'kcal' ? n => Math.round(n) : n => Math.round(n * 10) / 10
    const ingredients = !(from > 0)
      ? list.map((row, i) => ({ ...row, [key]: i === 0 ? round(to) : 0 }))
      : list.map(row => ({ ...row, [key]: round((Number(row[key]) || 0) * (to / from)) }))
    return { ...d, ingredients, ...lineTotals(ingredients), edited: true }
  })

  const openServing = () => {
    servingBase.current = draftRef.current
    setFocus('serving')
  }

  const onServingQty = qty => setDraft(() => {
    const base = servingBase.current || draftRef.current
    const to = Number(qty)
    if (!(to > 0)) return base
    const fromEntry = { ...base, servingQty: Number(base.servingQty) > 0 ? Number(base.servingQty) : 1 }
    const scaled = scaleToServings(fromEntry, to)
    if (scaled === fromEntry) return { ...fromEntry, servingQty: to, edited: true }
    return { ...scaled, edited: true }
  })

  const onServingUnit = unit => setDraft(d => {
    const next = applyServingUnit(d, unit)
    servingBase.current = next
    return next
  })

  const openIng = index => {
    ingBase.current = draftRef.current.ingredients?.[index] || null
    setFocus('ing:' + index)
  }

  const onIngQty = (index, qty) => setDraft(d => {
    const baseRow = ingBase.current || (d.ingredients || [])[index]
    const to = Number(qty)
    if (!baseRow || !(to > 0)) return d
    const from = Number(baseRow.qty)
    let row = { ...baseRow, qty: to }
    if (from > 0) {
      const f = to / from
      row = {
        ...baseRow,
        qty: to,
        kcal: Math.round((Number(baseRow.kcal) || 0) * f),
        protein: Math.round((Number(baseRow.protein) || 0) * f * 10) / 10,
        carbs: Math.round((Number(baseRow.carbs) || 0) * f * 10) / 10,
        fat: Math.round((Number(baseRow.fat) || 0) * f * 10) / 10,
      }
      if (Number(baseRow.grams) > 0) row.grams = Number(baseRow.grams) * f
    }
    const ingredients = (d.ingredients || []).map((item, i) => i === index ? row : item)
    return { ...d, ingredients, ...lineTotals(ingredients), edited: true }
  })

  const onIngNum = (index, key, value) => setDraft(d => {
    const ingredients = (d.ingredients || []).map((row, i) => i === index ? { ...row, [key]: value } : row)
    ingBase.current = ingredients[index]
    return { ...d, ingredients, ...lineTotals(ingredients), edited: true }
  })

  const onIngName = (index, name) => setDraft(d => {
    const ingredients = (d.ingredients || []).map((row, i) => i === index ? { ...row, name } : row)
    if (ingBase.current) ingBase.current = { ...ingBase.current, name }
    return { ...d, ingredients }
  })

  const onIngUnit = (index, unit) => setDraft(d => {
    const cur = (d.ingredients || [])[index]
    const row = convertLineUnit(cur, unit)
    if (!row || row === cur) return d
    const ingredients = d.ingredients.map((item, i) => i === index ? row : item)
    ingBase.current = row
    return { ...d, ingredients }
  })

  const removeIngredient = index => {
    setFocus(cur => (cur === 'ing:' + index ? null : cur))
    setDraft(d => {
    const ingredients = (d.ingredients || []).filter((_, i) => i !== index)
    const cleaned = cleanMeal({
      ...d,
      name: d.name.trim() || 'Meal',
      ingredients,
      edited: true,
      ...(ingredients.length ? {} : { kcal: 0, protein: 0, carbs: 0, fat: 0 }),
    }, { day })
    if (!cleaned) return { ...d, ingredients: ingredients.length ? ingredients : null, edited: true }
    return {
      ...d,
      kcal: cleaned.kcal,
      protein: cleaned.protein,
      carbs: cleaned.carbs,
      fat: cleaned.fat,
      grams: cleaned.grams,
      servingQty: cleaned.servingQty,
      servingUnit: cleaned.servingUnit,
      ingredients: cleaned.ingredients || null,
      edited: true,
    }
  })
  }

  const storeMeal = (fields, { add } = {}) => {
    const numbersChanged = !!entry && (
      fields.kcal !== entry.kcal || fields.protein !== entry.protein || fields.carbs !== entry.carbs
      || fields.fat !== entry.fat || fields.grams !== (entry.grams ?? null)
    )
    const next = cleanMeal({
      ...fields,
      d: day,
      edited: !!(fields.edited || entry?.edited || numbersChanged),
    }, { day })
    if (!next) { useUI.getState().toast(t('Name the meal')); return false }
    update(s => {
      const list = Array.isArray(s.foodLog) ? s.foodLog : []
      s.foodLog = add ? [...list, next] : [...list.filter(e => e && e.id !== next.id), next]
    })
    return true
  }

  const save = () => {
    if (storeMeal({ ...draft, id: entry?.id || uid() })) close()
  }

  const logAgain = () => {
    if (storeMeal({ ...draft, id: uid(), t: Date.now() }, { add: true })) close()
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

  const sendFix = async () => {
    const sentence = fix.trim()
    if (!sentence || busy) return
    if (!serverCoach()) {
      useUI.getState().toast(t('Turn the coach on to read a meal. You can still type it.'))
      return
    }
    setBusy(true)
    setFail(null)
    onReadingRef.current?.(true)
    try {
      const brief = mealBrief(draftRef.current)
      const text = brief ? `${sentence}\n${brief}` : sentence
      const bytes = imageRef.current
      const out = await analyzeFood(bytes ? { text, images: [bytes] } : { text })
      if (!alive.current) return
      const meal = combineFoodItems(foodsFrom(out))
      if (!meal) { setFail((out && out.error) || 'provider'); return }
      takeEstimate(meal)
      setFix('')
      setFixOn(false)
    } finally {
      onReadingRef.current?.(false)
      if (alive.current) setBusy(false)
    }
  }

  const lines = (draft.ingredients || []).slice(0, 8)
  const showKcal = draft.kcal == null || draft.kcal === '' ? '' : fmtNum(draft.kcal)
  const ingMatch = typeof focus === 'string' && focus.startsWith('ing:') ? Number(focus.slice(4)) : NaN
  const ingIndex = Number.isInteger(ingMatch) && lines[ingMatch] ? ingMatch : null
  const ingRow = ingIndex == null ? null : lines[ingIndex]

  if (paused) {
    return <div className="nut-review">
      <ReviewPhoto media={draft.media} onClose={close} />
      <div className="nut-review-body">
        {busy && <div className="muted small" style={{ marginBottom: 12 }}>{t('Reading the photo…')}</div>}
        <div className="nut-field">
          <span className="nut-lbl">{t('Anything to add?')}</span>
          <TextField aria-label={t('Anything to add?')} value={note} onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') estimatePhoto() }} />
        </div>
      </div>
      <div className="nut-review-foot">
        <Button variant="primary" onClick={estimatePhoto} disabled={busy}>{t('Estimate')}</Button>
      </div>
    </div>
  }

  if (ingRow) {
    return <div className="nut-review nut-ing-view">
      <div className="nut-review-body">
        <button type="button" className="iconbtn nut-back" aria-label={t('Back')} onClick={() => setFocus(null)}><Icon name="chevronLeft" /></button>
        <TextField aria-label={t('Ingredient')} value={ingRow.name} onChange={e => onIngName(ingIndex, e.target.value)} />
        <div className="nut-field">
          <span className="nut-lbl">{t('Amount')}</span>
          <NumberField aria-label={t('Amount')} nullable value={ingRow.qty ?? null} onChange={v => onIngQty(ingIndex, v)} />
          <div className="chips">
            {SERVING_UNITS.map(unit => <button type="button" key={unit} className={'chip nocap' + (ingRow.unit === unit ? ' on' : '')} onClick={() => onIngUnit(ingIndex, unit)}>{unit}</button>)}
          </div>
        </div>
        {[['kcal', 'Calories', 'Ingredient calories'], ['protein', 'Protein', 'Protein'], ['carbs', 'Carbs', 'Carbs'], ['fat', 'Fat', 'Fat']].map(([key, label, aria]) => (
          <div key={key} className="nut-field">
            <span className="nut-lbl">{t(label)}</span>
            <NumberField aria-label={t(aria)} nullable value={ingRow[key]} onChange={v => onIngNum(ingIndex, key, v)} />
          </div>
        ))}
        <Button variant="danger" className="nut-ing-remove" onClick={() => removeIngredient(ingIndex)}>{t('Remove')}</Button>
      </div>
    </div>
  }

  return <div className="nut-review">
    <ReviewPhoto media={draft.media} onClose={close} />
    <div className="nut-review-body">
      {busy && <div className="muted small" style={{ marginBottom: 12 }}>{t('Reading the photo…')}</div>}
      {fail && <div className="muted small" style={{ marginBottom: 12 }}>{analysisNote(fail, !!imageRef.current)}</div>}
      {fail && !draft.name && (draft.kcal == null || draft.kcal === '') && <div style={{ marginBottom: 12 }}><Button onClick={readImage} disabled={busy}>{t('Retry')}</Button></div>}
      {focus === 'name' || !draft.name
        ? <TextField aria-label={t('Name')} value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder={t('Oats and berries')} />
        : <button type="button" className="nut-title" onClick={() => setFocus('name')}>{draft.name}</button>}
      {focus === 'serving'
        ? <div className="nut-serving-edit">
            <span className="nut-lbl">{t('Amount')}</span>
            <NumberField aria-label={t('Servings')} nullable value={draft.servingQty} onChange={onServingQty} />
            <div className="chips">
              {SERVING_UNITS.map(unit => <button type="button" key={unit} className={'chip nocap' + (draft.servingUnit === unit ? ' on' : '')} onClick={() => onServingUnit(unit)}>{unit}</button>)}
            </div>
          </div>
        : <button type="button" className="chip nocap nut-serving" onClick={openServing}>{servingLabel(draft.servingQty, draft.servingUnit)}</button>}
      {focus === 'kcal'
        ? <NumberField aria-label={t('Calories')} nullable className="nut-kcal-input" value={draft.kcal} onChange={v => onMacro('kcal', v)} />
        : <button type="button" className="nut-kcal" onClick={() => setFocus('kcal')}>
            <span className="big" aria-label={t('Calories')}>{showKcal}</span>
            <span className="nut-kcal-u">kcal</span>
          </button>}
      <div className="nut-macros">
        {[['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].map(([key, label]) => focus === key
          ? <div key={key} className="chip nocap nut-macro nut-macro-edit">
              <NumberField aria-label={t(label)} nullable value={draft[key]} onChange={v => onMacro(key, v)} />
              <span>{t(label)}</span>
            </div>
          : <button type="button" key={key} className="chip nocap nut-macro" aria-label={t(label)} onClick={() => setFocus(key)}>
              <b>{draft[key] == null || draft[key] === '' ? '' : fmtNum(draft[key])}</b>
              <span>{t(label)}</span>
            </button>)}
      </div>
      {!!lines.length && <div className="nut-ing-list">
        {lines.map((row, i) => <button type="button" key={i} className="nut-ing" onClick={() => openIng(i)}>
          <span className="nut-ing-main">{row.name} · {fmtNum(row.kcal || 0)} kcal</span>
          <span className="nut-ing-amt">{amountOf(row)}</span>
        </button>)}
      </div>}
      <SelectRow icon="sun" iconTint="var(--yellow)" title={t('Meal')} value={draft.meal} onChange={meal => setDraft(d => ({ ...d, meal }))}
        options={MEALS.map(value => ({ value, label: t(MEAL_LABEL[value]) }))} />
      {entry && <button type="button" className="nut-quiet" onClick={logAgain}>{t('Log again')}</button>}
      {entry && <button type="button" className="nut-quiet danger" onClick={remove}>{t('Delete')}</button>}
    </div>
    <div className="nut-review-foot">
      {fixOn && <TextField aria-label={t('Correction')} value={fix} placeholder={t('200 grams of rice, not 100')}
        onChange={e => setFix(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') sendFix() }} />}
      <div className="nut-review-actions">
        <Button onClick={() => setFixOn(v => !v)} disabled={busy}>{t('Fix results')}</Button>
        <Button variant="primary" onClick={save} disabled={busy}>{t('Done')}</Button>
      </div>
    </div>
  </div>
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

// Browser camera for a product code. Check-in keeps CameraScan, which asks for a QR only.
function FoodBarcodeScan({ onFound, onCancel }) {
  const videoRef = useRef(null)
  const onFoundRef = useRef(onFound)
  const [error, setError] = useState(null)
  onFoundRef.current = onFound

  useEffect(() => {
    let stream = null, timer = null, done = false
    const stop = () => {
      done = true
      if (timer) clearTimeout(timer)
      if (stream) stream.getTracks().forEach(tr => tr.stop())
    }
    ;(async () => {
      const det = foodBarcodeDetector()
      if (!det || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setError('unavailable'); return }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      } catch (e) {
        setError(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'unavailable')
        return
      }
      if (done) { stream.getTracks().forEach(tr => tr.stop()); return }
      const v = videoRef.current
      if (!v) return
      v.srcObject = stream
      try { await v.play() } catch { /* the loop waits for frames */ }
      const tick = async () => {
        if (done) return
        if (v.readyState >= 2) {
          try {
            const found = await det.detect(v)
            const hit = found && found.find(b => b && b.rawValue)
            if (hit && !done) { stop(); onFoundRef.current(String(hit.rawValue)); return }
          } catch { /* keep trying */ }
        }
        timer = setTimeout(tick, 150)
      }
      tick()
    })()
    return stop
  }, [])

  return <>
    <h3>{t('Scan')}</h3>
    {error
      ? <div className="muted small" style={{ marginBottom: 16, lineHeight: 1.5 }}>
          {error === 'denied'
            ? t('Camera access was denied. Allow it in your browser and try again.')
            : t('No camera available here. Import a photo or type the code instead.')}
        </div>
      : <>
          <div className="cam-wrap">
            <video ref={videoRef} playsInline muted autoPlay />
            <div className="cam-frame" aria-hidden="true" />
          </div>
          <div className="muted small" style={{ textAlign: 'center', margin: '12px 0 16px' }}>{t('Point the camera at the barcode')}</div>
        </>}
    <Button variant="tinted" onClick={onCancel}>{t('Cancel')}</Button>
  </>
}

function BarcodeSheet({ day, close }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)
  const alive = useRef(true)
  useEffect(() => {
    // Set here, not only initially: StrictMode runs the cleanup once on mount, and that
    // must not leave the sheet thinking it is gone.
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const lookup = async raw => {
    const text = String(raw ?? '').trim()
    if (!text) return false
    setBusy(true)
    let opened = false
    try {
      const out = await lookupFoodBarcode(text)
      if (!alive.current) return false
      if (!out.ok && out.error === 'invalid') {
        useUI.getState().toast(t('Type the digits on the barcode.'))
        return false
      }
      if (!out.ok && out.error === 'network') {
        useUI.getState().toast(t('The product lookup didn’t answer. Try again.'))
      }
      const fill = out.ok
        ? out.item
        : { name: normalizeBarcode(text) || text, kcal: null, protein: null, carbs: null, fat: null, grams: null }
      opened = true
      close()
      openMealSheet({ day, source: 'barcode', fill })
      return true
    } finally {
      if (alive.current && !opened) setBusy(false)
    }
  }

  const scan = async () => {
    if (MOBILE) {
      setBusy(true)
      let opened = false
      try {
        const found = await scanCode()
        if (found?.value) { setCode(found.value); opened = await lookup(found.value) }
      } catch (e) {
        useUI.getState().toast(scanErrorMessage(e))
      } finally { if (alive.current && !opened) setBusy(false) }
      return
    }
    if (!foodBarcodeDetector()) {
      useUI.getState().toast(t('This browser can’t scan a barcode. Type the digits instead.'))
      return
    }
    useUI.getState().openSheet(closeCam => <FoodBarcodeScan
      onCancel={closeCam}
      onFound={value => { closeCam(); setCode(value); lookup(value) }} />)
  }

  const onFile = async ev => {
    const file = ev.target.files && ev.target.files[0]
    ev.target.value = ''
    if (!file) return
    if (!MOBILE && !foodBarcodeDetector()) {
      useUI.getState().toast(t('This browser can’t scan a barcode. Type the digits instead.'))
      return
    }
    setBusy(true)
    let opened = false
    try {
      let value = null
      if (MOBILE) {
        const found = await importCodeFromImage(file)
        value = found && found.value
      } else value = await barcodeFromImage(file)
      if (!value) { useUI.getState().toast(t('No barcode found in that photo.')); return }
      setCode(value)
      opened = await lookup(value)
    } catch {
      useUI.getState().toast(t('Could not read that image'))
    } finally { if (alive.current && !opened) setBusy(false) }
  }

  return <>
    <h3 style={{ marginTop: 0 }}>{t('Barcode')}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{t('Type the digits, or scan them.')}</div>
    <div className="btn-row" style={{ marginBottom: 12 }}>
      <TextField aria-label={t('Barcode')} value={code} inputMode="numeric" placeholder="3017620422003"
        onChange={e => setCode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') lookup(code) }} />
      <Button onClick={() => lookup(code)} disabled={busy}>{t('Look up')}</Button>
    </div>
    <div className="btn-row">
      <Button icon="camera" onClick={scan} disabled={busy}>{t('Scan')}</Button>
      <Button icon="image" onClick={() => fileRef.current?.click()} disabled={busy}>{t('Photo')}</Button>
    </div>
    <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
  </>
}

export default function Nutrition() {
  const nav = useNavigate()
  const location = useLocation()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const [day, setDay] = useState(todayISO())
  const [desc, setDesc] = useState('')
  const [reading, setReading] = useState(false)
  const picker = useMediaPicker()
  const once = useRef(false)

  const logCopy = entry => {
    const next = cleanMeal({ ...entry, id: uid(), d: day, t: Date.now() }, { day })
    if (!next) return
    update(s => {
      const list = Array.isArray(s.foodLog) ? s.foodLog : []
      s.foodLog = [...list, next]
    })
  }

  const shoot = async (capture, forDay) => {
    if (!picker.canAdd) {
      if (picker.note) useUI.getState().toast(picker.note)
      openMealSheet({ day: forDay, source: 'manual' })
      return
    }
    const file = await chooseImage(capture)
    if (!file) return
    const got = await picker.pick(file)
    let image = null
    if (serverCoach()) {
      try { image = await foodImageFromFile(file) }
      catch { useUI.getState().toast(t('That photo could not be read. Type the meal instead.')) }
    } else {
      useUI.getState().toast(t('Turn the coach on to read a photo. You can still type the meal.'))
    }
    const sentence = desc.trim()
    openMealSheet({
      day: forDay,
      source: got ? 'photo' : 'manual',
      media: got ? [got] : [],
      image,
      context: sentence,
      pause: true,
      onReading: flag => setReading(flag ? 'photo' : false),
    })
    if (sentence) setDesc('')
  }

  const askPhoto = () => menuSheet({
    title: t('Photo'),
    items: [
      { icon: 'camera', label: t('Camera'), onClick: () => shoot(true, day) },
      { icon: 'image', label: t('Library'), onClick: () => shoot(false, day) },
    ],
  })

  const estimate = async () => {
    const text = desc.trim()
    if (!text || reading) return
    if (!serverCoach()) {
      useUI.getState().toast(t('Turn the coach on to read a meal. You can still type it.'))
      openMealSheet({ day, source: 'manual', fill: { name: text } })
      setDesc('')
      return
    }
    setReading('text')
    try {
      const out = await analyzeFood({ text })
      const meal = combineFoodItems(foodsFrom(out))
      if (!meal) {
        useUI.getState().toast(analysisNote(out && out.error, false))
        openMealSheet({ day, source: 'manual', fill: { name: text } })
        return
      }
      openMealSheet({ day, source: 'text', fill: meal })
      setDesc('')
    } finally { setReading(false) }
  }

  useEffect(() => {
    if (once.current) return
    once.current = true
    const q = new URLSearchParams(location.search)
    const capture = q.get('capture') === '1'
    const gallery = q.get('gallery') === '1'
    const needsHeight = () => nutritionOf(useStore.getState().S).heightCm == null
    if (capture || gallery) {
      nav('/nutrition', { replace: true })
      const go = () => shoot(capture, todayISO())
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

  const totals = dayTotals(S.foodLog, day)
  const targets = profileTargets(S).targets
  const left = targets ? targets.kcal - totals.kcal : null
  const hero = left == null ? totals.kcal : Math.abs(left)
  const label = left == null ? t('kcal eaten') : left >= 0 ? t('kcal left') : t('kcal over')
  const groups = MEALS.map(meal => ({
    meal,
    rows: (S.foodLog || []).filter(e => e && e.d === day && (e.meal || 'snack') === meal).sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0)),
  })).filter(g => g.rows.length)
  const recent = recentDistinct(S.foodLog)

  return <div className="narrow">
    <div className="hdr nut-hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
      <div className="nut-day">
        <button className="iconbtn" onClick={() => setDay(d => shiftISO(d, -1))} aria-label={t('Previous day')}><Icon name="chevronLeft" /></button>
        <input className="nut-date" type="date" aria-label={t('Date')} value={day} onChange={e => { if (e.target.value) setDay(e.target.value) }} />
        <button className="iconbtn" onClick={() => setDay(d => shiftISO(d, 1))} aria-label={t('Next day')}><Icon name="chevronRight" /></button>
      </div>
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
      <div className="nut-entry">
        <TextField aria-label={t('Describe a meal')} value={desc} placeholder={t('200 g of rice')} onChange={e => setDesc(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') estimate() }} />
      </div>
      <div className="btn-row nut-acts">
        <Button variant="primary" icon="camera" onClick={askPhoto} disabled={picker.busy || !!reading}>{t('Photo')}</Button>
        <Button icon="pencil" onClick={estimate} disabled={!!reading}>{t('Type')}</Button>
        <Button icon="qr" onClick={() => useUI.getState().openSheet(close => <BarcodeSheet day={day} close={close} />)} disabled={!!reading}>{t('Barcode')}</Button>
      </div>
      {reading && <div className="muted small" style={{ marginTop: 8 }}>{reading === 'text' ? t('Reading that…') : t('Reading the photo…')}</div>}
    </div>

    {!groups.length && <div className="card">
      <div className="muted small">{t('Nothing logged this day. A photo is the fastest way in.')}</div>
    </div>}

    {groups.map(g => <Section key={g.meal} className="nut-meals" title={t(MEAL_LABEL[g.meal])}>
      {g.rows.map(e => <button key={e.id} type="button" className="lrow" onClick={() => openMealSheet({ day, entry: e })}>
        <MealThumb media={e.media} />
        <span className="lrow-t">{e.name}</span>
        <span className="muted small">{fmtNum(e.kcal)} kcal</span>
      </button>)}
    </Section>)}

    {!!recent.length && <Section className="nut-again" title={t('Log again')}>
      {recent.map(e => <div key={e.id} className="lrow">
        <span className="lrow-t">{e.name}</span>
        <span className="muted small">{fmtNum(e.kcal)} kcal</span>
        <Button size="sm" onClick={() => logCopy(e)}>{t('Log again')}</Button>
      </div>)}
    </Section>}
  </div>
}
