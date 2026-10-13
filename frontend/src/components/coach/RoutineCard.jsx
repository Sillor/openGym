import { useMemo, useState } from 'react'
import { t, tn } from '../../lib/i18n.js'
import { weekStartOf } from '../../lib/format.js'
import { speedUnitOf } from '../../lib/speed.js'
import { glyphOf } from '../../lib/glyphs.js'
import { cardProposal } from '../../lib/coach-chat.js'
import Icon from '../Icon.jsx'
import { Button, Switch } from '../ui.jsx'
import { WeekStrip, RoutineBlock } from './PlanParts.jsx'

/**
 * New routines the Coach proposed in the chat: the week they would fill, each routine with its
 * exercises, and "Create routine". They arrive as new routines, like an imported plan; the week
 * only moves when the switch says so.
 */
export default function RoutineCard({ pending, card, S, outdated, onCreate, onDecline }) {
  const b = card.bundle
  const [tab, setTab] = useState(0)
  const [schedule, setSchedule] = useState(true)
  const r = b.routines[Math.min(tab, b.routines.length - 1)]
  const weekDays = useMemo(() => new Set(Object.keys(b.week || {}).map(Number)), [b])
  const n = b.routines.length
  return <div className={'pcard rcard' + (outdated ? ' outdated' : '')}>
    <div className="pcard-hd">
      <div className="pcard-eyebrow">{outdated ? t('Outdated') : tn('{0} routine', '{0} routines', n)}</div>
      <h2 className="pcard-h">{card.title || b.name || t('Coach plan')}</h2>
      {!!(card.summary || b.summary) && <p className="pcard-sum">{card.summary || b.summary}</p>}
      {outdated && <p className="pcard-sum">{t('The conversation has moved on since this. Ask again if you still want it.')}</p>}
    </div>

    {weekDays.size > 0 && <WeekStrip days={weekDays} ws={weekStartOf(S)} />}

    {n > 1 && <div className="pcard-tabs" role="tablist">
      {b.routines.map((x, i) => <button key={x.id || i} role="tab" aria-selected={i === tab} className={'pcard-tab' + (i === tab ? ' on' : '')} onClick={() => setTab(i)}><Icon name={glyphOf(x.emoji)} />{x.name}</button>)}
    </div>}

    {r && <RoutineBlock r={r} unit={S.unit} speedUnit={speedUnitOf(S)} thumbs />}

    {!outdated && weekDays.size > 0 && <div className="pcard-row">
      <span className="lrow-m"><span className="lrow-t">{t('Use this weekly schedule')}</span><span className="lrow-s">{t('Replaces your current week. Days this plan leaves empty become rest days.')}</span></span>
      <Switch checked={schedule} onChange={setSchedule} aria-label={t('Use this weekly schedule')} />
    </div>}
    {!outdated && <div className="pcard-ft">
      <Button variant="primary" icon="plus" onClick={() => onCreate(cardProposal(pending, card), { schedule: schedule && weekDays.size > 0 })}>
        {tn('Create routine', 'Create {0} routines', n)}
      </Button>
      <Button onClick={() => onDecline(cardProposal(pending, card))}>{t('Not now')}</Button>
    </div>}
  </div>
}
