// Today's food on Home: calories left beside their ring, and the three macros as small rings,
// the same picture as the top of the Food tab. A tap opens the diary; the camera button reads a
// meal straight away.

import { dayTotals, profileTargets } from '../../lib/nutrition.js'
import { fmtNum, todayISO } from '../../lib/format.js'
import { t } from '../../lib/i18n.js'
import Icon from '../Icon.jsx'
import ProgressRing from './ProgressRing.jsx'
import { MACROS } from './SummaryCards.jsx'
import '../../food.css'

export default function HomeFoodCard({ S, onOpen, onPhoto }) {
  const totals = dayTotals(S.foodLog, todayISO())
  const targets = profileTargets(S).targets
  const has = !!targets && targets.kcal > 0
  const left = has ? targets.kcal - totals.kcal : null
  const hero = left == null ? totals.kcal : Math.abs(left)
  const caption = left == null ? t('Calories eaten') : left >= 0 ? t('Calories left') : t('Calories over')
  return <div className="card fh">
    <button type="button" className="fh-main" onClick={onOpen}>
      <span className="fh-text">
        <span className="fh-title">{t('Food')}<Icon name="chevronRight" /></span>
        <span className={'fh-num' + (left != null && left < 0 ? ' over' : '')}>{fmtNum(hero)}</span>
        <span className="fh-cap">{caption}</span>
      </span>
      <ProgressRing pct={has ? totals.kcal / targets.kcal : 0} size={76} stroke={8} color="var(--fd-kcal)" over={left != null && left < 0}>
        <Icon name="flame" className="fd-kcal-ic" />
      </ProgressRing>
    </button>
    <div className="fh-macros">
      {MACROS.map(m => {
        const target = has ? Number(targets[m.key]) || 0 : 0
        const value = Number(totals[m.key]) || 0
        return <button key={m.key} type="button" className="fh-macro" onClick={onOpen}>
          <ProgressRing pct={target > 0 ? value / target : 0} size={34} stroke={4} color={m.color} over={target > 0 && value > target}>
            <Icon name={m.icon} style={{ color: m.color }} />
          </ProgressRing>
          <span className="fh-macro-t"><b>{fmtNum(Math.round(value))}{target > 0 ? <small>/{fmtNum(target)}g</small> : <small>g</small>}</b><span>{m.label()}</span></span>
        </button>
      })}
      <button type="button" className="fh-cam" aria-label={t('Scan food')} onClick={onPhoto}><Icon name="camera" /></button>
    </div>
  </div>
}
