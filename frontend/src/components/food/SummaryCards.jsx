// The day at a glance, laid out like Cal AI: one wide card for calories, three square ones for
// protein, carbs and fat, each with its own ring. A tap on any of them flips every card between
// what is left and what was eaten. Without a target the cards count what was eaten and say how
// to get one.

import { fmtNum } from '../../lib/format.js'
import { t } from '../../lib/i18n.js'
import Icon from '../Icon.jsx'
import ProgressRing from './ProgressRing.jsx'

export const MACROS = [
  { key: 'protein', label: () => t('Protein'), icon: 'drumstick', color: 'var(--fd-protein)' },
  { key: 'carbs', label: () => t('Carbs'), icon: 'wheat', color: 'var(--fd-carbs)' },
  { key: 'fat', label: () => t('Fat'), icon: 'drop', color: 'var(--fd-fat)' },
]

function macroCaption(label, mode, over) {
  if (mode === 'eaten') return t('{0} eaten', label)
  return over ? t('{0} over', label) : t('{0} left', label)
}

export default function SummaryCards({ totals, targets, mode, onToggle, onSetTarget }) {
  const has = !!targets && targets.kcal > 0
  const shown = has ? mode : 'eaten'
  const kcalLeft = has ? targets.kcal - totals.kcal : 0
  const kcalOver = has && kcalLeft < 0
  const kcalValue = shown === 'eaten' ? totals.kcal : Math.abs(kcalLeft)
  const kcalCaption = shown === 'eaten' ? t('Calories eaten') : kcalOver ? t('Calories over') : t('Calories left')

  return (
    <div className="fd-summary">
      <button type="button" className="fd-card fd-kcal-card" onClick={has ? onToggle : onSetTarget}
        aria-label={fmtNum(kcalValue) + ' ' + kcalCaption}>
        <span className="fd-kcal-text">
          <span className={'fd-kcal-num' + (shown !== 'eaten' && kcalOver ? ' over' : '')}>{fmtNum(kcalValue)}</span>
          <span className="fd-kcal-cap">{kcalCaption}</span>
          {has
            ? <span className="fd-kcal-sub">{t('{0} of {1} kcal', fmtNum(totals.kcal), fmtNum(targets.kcal))}</span>
            : <span className="fd-kcal-sub fd-link">{t('Set a daily target')}</span>}
        </span>
        <ProgressRing pct={has ? totals.kcal / targets.kcal : 0} size={92} stroke={9} color="var(--fd-kcal)" over={kcalOver}>
          <Icon name="flame" className="fd-kcal-ic" />
        </ProgressRing>
      </button>
      <div className="fd-macros">
        {MACROS.map(m => {
          const value = Number(totals[m.key]) || 0
          const target = has ? Number(targets[m.key]) || 0 : 0
          const left = target - value
          const over = target > 0 && left < 0
          const num = shown === 'eaten' || !(target > 0) ? value : Math.abs(left)
          return (
            <button key={m.key} type="button" className="fd-card fd-macro-card" onClick={has ? onToggle : onSetTarget}
              aria-label={fmtNum(num) + ' g ' + macroCaption(m.label(), shown, over)}>
              <span className={'fd-macro-num' + (over && shown !== 'eaten' ? ' over' : '')}>{fmtNum(Math.round(num))}<small>g</small></span>
              <span className="fd-macro-cap">{macroCaption(m.label(), target > 0 ? shown : 'eaten', over)}</span>
              <ProgressRing pct={target > 0 ? value / target : 0} size={58} stroke={6} color={m.color} over={over}>
                <Icon name={m.icon} style={{ color: m.color }} />
              </ProgressRing>
            </button>
          )
        })}
      </div>
    </div>
  )
}
