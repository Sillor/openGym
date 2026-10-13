import { useMemo } from 'react'
import { t, exerciseNameFor } from '../../lib/i18n.js'
import { resolveExercises } from '../../lib/coach-chat.js'
import { exerciseDetailSheet } from '../../sheets.jsx'
import { Thumb } from '../Media.jsx'
import { Button } from '../ui.jsx'

/**
 * Exercises the Coach pointed at, as a row to swipe through: picture, name, target muscle. A tap
 * opens the exercise's own sheet. "Add to routine…" asks the Coach to fit one in, which comes
 * back as a change to confirm — the card itself never edits the plan.
 */
export default function ExerciseCards({ card, onAdd }) {
  const list = useMemo(() => resolveExercises(card.ids), [card.ids])
  if (!list.length) return null
  return <div className="xcards">
    {!!card.note && <div className="xcards-note">{card.note}</div>}
    <div className="xcards-row">
      {list.map(ex => <button key={ex.id} className="xcard" onClick={() => exerciseDetailSheet(ex)}>
        <Thumb ex={ex} />
        <span className="xcard-n">{exerciseNameFor(ex)}</span>
        {!!(ex.tg || ex.bp) && <span className="xcard-m">{t(ex.tg || ex.bp)}</span>}
      </button>)}
    </div>
    {onAdd && <Button size="sm" variant="tinted" icon="plus" onClick={() => onAdd(list)}>{t('Add to routine…')}</Button>}
  </div>
}
