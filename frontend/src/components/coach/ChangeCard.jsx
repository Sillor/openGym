import { useMemo, useState } from 'react'
import { t } from '../../lib/i18n.js'
import { changeTitle, changeValues } from '../../lib/coach.js'
import { readChangeCard, applyLabel, isDestructive } from '../../lib/coach-chat.js'
import Icon from '../Icon.jsx'
import { Button, Check } from '../ui.jsx'

/**
 * One change, before and after, with the reason under it. A change that takes something away
 * says so in red; one the plan has moved past is greyed with the reason it cannot be applied.
 */
export function ChangeRow({ c, S, stale, badge, children }) {
  const vals = changeValues(c, S)
  const removes = isDestructive(c)
  return <div className={'pcard-chg' + (stale ? ' stale' : '') + (c.status === 'rejected' ? ' declined' : '') + (removes ? ' removes' : '')}>
    <div className="grow">
      <div className="pcard-chg-t">{removes && <Icon name="trash" />}{changeTitle(c, S)}{c.routineName ? <span className="dim" style={{ fontWeight: 400 }}> · {c.routineName}</span> : null}</div>
      {vals && <div className="pcard-chg-v"><span className="tag">{vals.before}</span><Icon name="chevronRight" style={{ fontSize: 12, color: 'var(--label-3)' }} /><span className="tag acc">{vals.after}</span></div>}
      {!!c.why && <div className="pcard-chg-w">{c.why}</div>}
      {removes && !stale && !badge && <div className="pcard-chg-rm">{t('Removes it from your plan.')}</div>}
      {stale && <div className="pcard-chg-stale">{t('Doesn’t match your plan any more, so it can’t be applied.')}</div>}
    </div>
    {badge}
    {children}
  </div>
}

/**
 * A change-set the Coach proposed in the chat. Every row that can still be applied starts ticked;
 * the button names the verb and the count, and "Not now" turns the whole card down. An outdated
 * card — the conversation has moved on — is drawn greyed with no buttons.
 */
export default function ChangeCard({ pending, card, S, outdated, onApply, onDecline }) {
  const { proposal, usable, title } = useMemo(() => readChangeCard(pending, card, S), [pending, card, S])
  const [on, setOn] = useState(() => new Set(usable.map(c => c.id)))
  const toggle = id => setOn(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const ids = [...on].filter(id => usable.some(c => c.id === id))
  const pick = usable.length > 1 && !outdated
  return <div className={'pcard ccard' + (outdated ? ' outdated' : '')}>
    <div className="pcard-hd">
      <div className="pcard-eyebrow">{outdated ? t('Outdated') : t('Proposed change')}</div>
      <h2 className="pcard-h">{title}</h2>
      {!!card.summary && <p className="pcard-sum">{card.summary}</p>}
      {outdated && <p className="pcard-sum">{t('The conversation has moved on since this. Ask again if you still want it.')}</p>}
      {!outdated && proposal.planMoved && <p className="pcard-sum" style={{ fontSize: 13, color: 'var(--yellow)' }}>
        {t('Your plan changed since the Coach looked at it. Suggestions that no longer match are greyed out. Ask for a fresh review to see them again.')}
      </p>}
    </div>
    {proposal.changes.map(c => {
      const stale = c.status === 'stale'
      return <ChangeRow key={c.id} c={c} S={S} stale={stale}>
        {pick && !stale && <Check checked={on.has(c.id)} onChange={() => toggle(c.id)} label={changeTitle(c, S)} />}
      </ChangeRow>
    })}
    {!outdated && <div className="pcard-ft">
      <Button variant="primary" icon="check" disabled={!ids.length} onClick={() => onApply(proposal, ids)}>{applyLabel(ids.length)}</Button>
      <Button onClick={() => onDecline(proposal)}>{t('Not now')}</Button>
    </div>}
  </div>
}
