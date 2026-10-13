// Settings → Nutrition, and the short sheet the diary opens the first time height is missing.
// Numbers stay in the profile (cm, kg/week). What you type follows the weight unit, the same
// way body measurements do.

import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { fmtNum } from '../lib/format.js'
import { emptyNutrition, nutritionOf, profileTargets, targetExplain, weeklyCalorieNudge, weeklyFromUnit, weeklyInUnit } from '../lib/nutrition.js'
import { fromMeasurementDisplay, measurementUnit, toMeasurementDisplay } from '../lib/measurements.js'
import { Section, Row, SelectRow, NumberField, TextField, Button } from '../components/ui.jsx'

const ACTIVITIES = [
  ['sedentary', 'Sedentary', 'Desk work, little other activity.'],
  ['light', 'Lightly active', 'On your feet, or easy exercise a few days a week.'],
  ['moderate', 'Moderately active', 'Training most days.'],
  ['active', 'Active', 'Hard training most days.'],
  ['veryActive', 'Very active', 'Hard training, and an active job.'],
  ['extraActive', 'Extra active', 'Very hard training, or a physical job on top of it.'],
]

const GOALS = [
  ['', 'Automatic', 'From your goal weight, or from what you told the coach.'],
  ['lose', 'Lose weight', ''],
  ['maintain', 'Maintain', ''],
  ['gain', 'Gain weight', ''],
]

function patchNutrition(update, patch) {
  update(s => {
    s.nutrition = { ...emptyNutrition(), ...(s.nutrition || {}), ...patch }
  })
}

function explain(S) {
  const x = targetExplain(S)
  const unit = S.unit === 'lb' ? 'lb' : 'kg'
  if (!x.ok) {
    if (x.missing === 'weight') return t('Log a weigh-in on Home and a calorie target can be set from it.')
    if (x.missing === 'height') return t('Add your height to set a calorie target.')
    if (x.missing === 'birthday') return t('Add your birthday to set a calorie target. A body-fat measurement works instead.')
    return t('Add your height and birthday to set a calorie target.')
  }
  const kcal = fmtNum(x.kcal)
  if (x.customKcal) return t('{0} kcal, the target you set.', kcal)
  const rate = fmtNum(weeklyInUnit(x.weeklyKg, unit) ?? 0)
  const h = fmtNum(toMeasurementDisplay(x.heightCm, unit) ?? 0)
  const hUnit = measurementUnit(unit)
  if (x.method === 'katch') {
    if (x.goal === 'lose') return t('{0} kcal, from your last weigh-in and body fat, and a loss of {1} {2} a week.', kcal, rate, unit)
    if (x.goal === 'gain') return t('{0} kcal, from your last weigh-in and body fat, and a gain of {1} {2} a week.', kcal, rate, unit)
    return t('{0} kcal, from your last weigh-in and body fat, to keep your weight.', kcal)
  }
  if (x.goal === 'lose') return t('{0} kcal, from your last weigh-in, {1} {2}, and a loss of {3} {4} a week.', kcal, h, hUnit, rate, unit)
  if (x.goal === 'gain') return t('{0} kcal, from your last weigh-in, {1} {2}, and a gain of {3} {4} a week.', kcal, h, hUnit, rate, unit)
  return t('{0} kcal, from your last weigh-in and {1} {2}, to keep your weight.', kcal, h, hUnit)
}

function goalHint(S) {
  const n = nutritionOf(S)
  if (n.goal) return null
  const r = profileTargets(S)
  if (r.goalSource === 'targetW') return t('Right now that follows your goal weight.')
  if (r.goalSource === 'coach') return t('Right now that follows what you told the coach.')
  return t('Right now that keeps your weight, until you choose.')
}

function Num({ label, value, unit, onChange, placeholder }) {
  return <label className="measure-field">
    <span>{label}</span>
    <span className="measure-input">
      <NumberField nullable aria-label={label} value={value} placeholder={placeholder} onChange={onChange} />
      {unit && <i>{unit}</i>}
    </span>
  </label>
}

function ListField({ label, values, onChange, placeholder }) {
  const [draft, setDraft] = useState(null)
  const shown = draft ?? (values || []).join(', ')
  return <label className="measure-field" style={{ gridColumn: '1 / -1' }}>
    <span>{label}</span>
    <TextField aria-label={label} value={shown} placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        const raw = (draft ?? shown).split(',').map(s => s.trim()).filter(Boolean)
        onChange(raw)
        setDraft(null)
      }} />
  </label>
}

function BirthdayField({ value, onChange }) {
  return <label className="measure-field">
    <span>{t('Birthday')}</span>
    <span className="measure-input">
      <input type="date" aria-label={t('Birthday')} value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        style={{ width: '100%', background: 'transparent', color: 'inherit', border: 0, font: 'inherit' }} />
    </span>
  </label>
}

// Hide one proposal until the weigh-ins, the diary, or the target inputs change.
function nudgeSignature(S, proposal) {
  const n = S?.nutrition || {}
  const food = (S?.foodLog || []).filter(e => e && e.d).map(e => e.d).sort().join(',')
  const weights = (S?.bodyweight || []).filter(e => e && e.d).map(e => e.d + ':' + e.w).sort().join(',')
  const fat = (S?.measurements || []).filter(e => e && e.bodyFat > 0).map(e => e.d + ':' + e.bodyFat).sort().join(',')
  const raw = [
    n.heightCm, n.birthday, n.sex, n.activity, n.goal, n.weeklyKg,
    n.customKcal, n.customProtein, n.customCarbs, n.customFat,
    S?.unit, S?.targetW, S?.coach?.profile?.goal,
    food, weights, fat,
  ].join('|')
  let h = 5381
  for (let i = 0; i < raw.length; i++) h = Math.imul(33, h) ^ raw.charCodeAt(i)
  return proposal.kcal + ':' + (h >>> 0).toString(36)
}

function CalorieNudge() {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const proposal = weeklyCalorieNudge(S)
  if (!proposal.proposed) return null
  const sig = nudgeSignature(S, proposal)
  if ((S.nutrition || {}).nudgeDismissed === sig) return null
  return <Section>
    <div style={{ padding: '12px 16px 14px' }}>
      <div className="small" style={{ marginBottom: 10, lineHeight: 1.45 }}>{proposal.reason}</div>
      <div className="btn-row">
        <Button variant="primary" onClick={() => patchNutrition(update, { customKcal: proposal.kcal })}>{t('Accept')}</Button>
        <Button onClick={() => patchNutrition(update, { nudgeDismissed: sig })}>{t('Dismiss')}</Button>
      </div>
    </div>
  </Section>
}

export function NutritionFields({ essentials = false }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const n = S.nutrition || {}
  const clean = nutritionOf(S)
  const unit = S.unit === 'lb' ? 'lb' : 'kg'
  const hUnit = measurementUnit(unit)
  const set = patch => patchNutrition(update, patch)
  const goal = clean.goal || ''
  const moving = (goal || profileTargets(S).goal) !== 'maintain'
  const x = targetExplain(S)

  return <>
    <Section footer={<>
      {explain(S)}
      {x.ok && x.sexAssumed ? ' ' + t('Sex isn’t set, so this sits midway between the male and female formulas.') : ''}
      {x.ok && <><br />{t('{0} g protein · {1} g carbs · {2} g fat', x.protein, x.carbs, x.fat)}</>}
    </>}>
      <Row icon="flame" iconTint="var(--orange)" title={t('Daily target')}
        value={x.ok ? t('{0} kcal', fmtNum(x.kcal)) : t('Not set')} />
    </Section>

    <Section title={t('About you')}>
      <div className="measure-form" style={{ margin: '4px 16px 14px' }}>
        <Num label={t('Height')} unit={hUnit}
          value={n.heightCm == null ? null : toMeasurementDisplay(n.heightCm, unit)}
          onChange={v => set({ heightCm: v == null ? null : fromMeasurementDisplay(v, unit) })} />
        <BirthdayField value={n.birthday || ''} onChange={birthday => set({ birthday })} />
      </div>
      <SelectRow icon="person" iconTint="var(--teal)" title={t('Sex')}
        value={clean.sex || ''}
        onChange={v => set({ sex: v || null })}
        options={[
          { value: '', label: t('Not set'), subtitle: t('Uses a midpoint between the two formulas.') },
          { value: 'male', label: t('Male') },
          { value: 'female', label: t('Female') },
        ]} />
      <SelectRow icon="figureRun" iconTint="var(--green)" title={t('Activity')}
        value={clean.activity}
        onChange={v => set({ activity: v })}
        options={ACTIVITIES.map(([value, label, subtitle]) => ({ value, label: t(label), subtitle: t(subtitle) }))} />
    </Section>

    <Section title={t('Goal')} footer={goalHint(S)}>
      <SelectRow icon="target" iconTint="var(--yellow)" title={t('Goal')}
        value={goal}
        onChange={v => set({ goal: v || null })}
        options={GOALS.map(([value, label, subtitle]) => ({ value, label: t(label), subtitle: subtitle ? t(subtitle) : null }))} />
      {moving && <div className="measure-form" style={{ margin: '4px 16px 14px' }}>
        <Num label={t('Weekly change')} unit={unit} placeholder="0.5"
          value={n.weeklyKg == null ? null : weeklyInUnit(n.weeklyKg, unit)}
          onChange={v => set({ weeklyKg: weeklyFromUnit(v, unit) })} />
      </div>}
    </Section>

    {!essentials && <>
      <CalorieNudge />
      <Section title={t('Your own numbers')} footer={t('Leave a field empty to use the formula.')}>
        <div className="measure-form" style={{ margin: '4px 16px 14px' }}>
          <Num label={t('Calories')} unit="kcal" value={n.customKcal ?? null} onChange={v => set({ customKcal: v == null ? null : Math.round(v) })} />
          <Num label={t('Protein')} unit="g" value={n.customProtein ?? null} onChange={v => set({ customProtein: v == null ? null : Math.round(v) })} />
          <Num label={t('Carbs')} unit="g" value={n.customCarbs ?? null} onChange={v => set({ customCarbs: v == null ? null : Math.round(v) })} />
          <Num label={t('Fat')} unit="g" value={n.customFat ?? null} onChange={v => set({ customFat: v == null ? null : Math.round(v) })} />
        </div>
      </Section>
      <Section title={t('Food preferences')} footer={t('The coach uses these when it suggests meals.')}>
        <div className="measure-form" style={{ margin: '4px 16px 14px' }}>
          <ListField label={t('Foods you like')} values={n.likes} placeholder={t('oats, rice, chicken')} onChange={likes => set({ likes })} />
          <ListField label={t('Foods you avoid')} values={n.dislikes} placeholder={t('mushrooms')} onChange={dislikes => set({ dislikes })} />
          <ListField label={t("Won't eat")} values={n.wontEat} placeholder={t('pork')} onChange={wontEat => set({ wontEat })} />
          <label className="measure-field" style={{ gridColumn: '1 / -1' }}>
            <span>{t('Note')}</span>
            <textarea className="field area" aria-label={t('Note')} value={n.note || ''}
              onChange={e => set({ note: e.target.value })} />
          </label>
        </div>
      </Section>
    </>}
  </>
}

export default function NutritionSettings() {
  return <NutritionFields />
}

function NutritionSetup({ close, onDone }) {
  return <>
    <h3 style={{ marginTop: 0 }}>{t('Set your calorie target')}</h3>
    <NutritionFields essentials />
    <Button variant="primary" onClick={() => { onDone?.(); close() }}>{t('Done')}</Button>
    <div style={{ height: 8 }} />
    <Button onClick={close}>{t('Skip')}</Button>
  </>
}

/** The short version of this page. `onDone` runs from Done; Skip only closes, so a meal can still be typed. */
export function openNutritionSetup(onDone) {
  useUI.getState().openSheet(close => <NutritionSetup close={close} onDone={onDone} />)
}
