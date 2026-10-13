import { useMemo } from 'react'
import { t, tn } from '../../lib/i18n.js'
import { fmtNum } from '../../lib/format.js'
import { nutritionRead } from '../../lib/coach-chat.js'
import { Button } from '../ui.jsx'

const LABEL = { kcal: () => t('Calories'), protein: () => t('Protein'), carbs: () => t('Carbs'), fat: () => t('Fat') }

/**
 * The food diary the Coach read, drawn against the targets: a daily average per macro, the bar
 * marked where the target sits. "Update targets" asks the Coach for new ones, which come back as
 * a change to confirm.
 */
export default function NutritionCard({ card, onUpdate }) {
  const r = useMemo(() => nutritionRead(card), [card])
  return <div className="pcard ncard">
    <div className="pcard-hd">
      <div className="pcard-eyebrow">{t('Food diary')}</div>
      {!!card.summary && <p className="pcard-sum" style={{ marginTop: 0 }}>{card.summary}</p>}
    </div>
    {r.days > 0 && <div className="ncard-rows">
      <div className="ncard-cap">{tn('Daily average over {0} day', 'Daily average over {0} days', r.days)}</div>
      {r.rows.map(x => {
        const unit = x.key === 'kcal' ? 'kcal' : 'g'
        const label = LABEL[x.key]()
        return <div key={x.key} className="ncard-row">
          <span className="ncard-l">{label}</span>
          <span className="ncard-bar" role="meter" aria-label={label} aria-valuenow={x.avg} aria-valuemin={0} aria-valuemax={x.target || undefined}>
            <i style={{ width: (x.share == null ? 0 : Math.round(x.share / 1.5 * 100)) + '%' }} className={x.share != null && x.share < 0.9 ? 'low' : x.share > 1.1 ? 'high' : ''} />
            {x.target != null && <b aria-hidden="true" />}
          </span>
          <span className="ncard-v">{fmtNum(x.avg)}{x.target != null ? ` / ${fmtNum(x.target)}` : ''} {unit}</span>
        </div>
      })}
    </div>}
    {onUpdate && <div className="pcard-ft">
      <Button variant="tinted" icon="sparkles" onClick={onUpdate}>{t('Update targets')}</Button>
    </div>}
  </div>
}
