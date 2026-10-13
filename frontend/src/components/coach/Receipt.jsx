import { t } from '../../lib/i18n.js'
import Icon from '../Icon.jsx'

/**
 * A decided chat card, folded to one line: what it was and what you did. Tapping the line opens
 * the whole proposal as it was; Undo is offered while it is still the last thing the Coach changed.
 */
export default function Receipt({ m, canUndo, onUndo, onOpen }) {
  const applied = m.kind === 'applied'
  const state = m.undone ? t('Undone') : applied ? t('Applied') : t('Declined')
  return <div className={'receipt ' + (m.undone ? 'undone' : applied ? 'yes' : 'no')}>
    <Icon name={applied && !m.undone ? 'checkCircle' : 'xmark'} />
    <button className="receipt-t" onClick={onOpen} disabled={!onOpen}>{m.title || state}</button>
    <span className="receipt-s">{state}</span>
    {canUndo && <>
      <span className="receipt-dot" aria-hidden="true">·</span>
      <button className="receipt-u" onClick={onUndo}>{t('Undo')}</button>
    </>}
  </div>
}
