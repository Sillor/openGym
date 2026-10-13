// How much: − / amount / + and the unit it is counted in. The unit menu offers the ways this
// food can be shown (slice, g, ml…) and switching re-expresses the same food — calories stay.
// Typing takes "1,5", "1 1/2" or "½". A food counted in something other than grams shows what
// that weighs underneath.

import { useState } from 'react'
import { amountOf, formatQty, parseQty, stepQty, unitOptions } from '../../lib/food-units.js'
import { fmtNum } from '../../lib/format.js'
import { t } from '../../lib/i18n.js'
import { menuSheet } from '../../sheets.jsx'
import Icon from '../Icon.jsx'
import { amountText, decimalSep, unitText } from './unit-text.js'

export default function PortionControl({ item, onQty, onUnit, label }) {
  const a = amountOf(item)
  const qty = a.qty || 1
  const unit = a.unit
  const [draft, setDraft] = useState(null)
  const options = unitOptions(item)

  const commit = text => {
    const n = parseQty(text)
    if (n) onQty(n, unit)
  }
  const pickUnit = () => menuSheet({
    title: t('Count it in'),
    items: options.map(o => ({
      label: unitText(o.unit, 1),
      sub: o.g && o.unit !== 'g' ? '1 ' + unitText(o.unit, 1) + ' ≈ ' + fmtNum(Math.round(o.g * 10) / 10) + ' g' : undefined,
      on: o.unit === unit,
      onClick: () => { if (o.unit !== unit) onUnit(o.unit) },
    })),
  })

  return (
    <div className="fd-portion">
      {label && <span className="fd-portion-lbl">{label}</span>}
      <div className="fd-portion-row">
        <div className="fd-stepper">
          <button type="button" aria-label={t('Decrease')} onClick={() => onQty(stepQty(qty, unit, -1), unit)}><Icon name="minus" /></button>
          <input
            className="fd-qty" type="text" inputMode="decimal" aria-label={t('Amount')}
            value={draft ?? formatQty(qty, unit, decimalSep())}
            onFocus={e => { setDraft(formatQty(qty, unit, decimalSep())); requestAnimationFrame(() => e.target.select()) }}
            onChange={e => { setDraft(e.target.value); commit(e.target.value) }}
            onBlur={() => setDraft(null)}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
          <button type="button" aria-label={t('Increase')} onClick={() => onQty(stepQty(qty, unit, 1), unit)}><Icon name="plus" /></button>
        </div>
        <button type="button" className="fd-unit" onClick={options.length > 1 ? pickUnit : undefined} disabled={options.length < 2}
          aria-label={t('Unit') + ': ' + unitText(unit, qty)}>
          <span>{unitText(unit, qty)}</span>
          {options.length > 1 && <Icon name="chevronsUpDown" />}
        </button>
      </div>
      {a.grams && unit !== 'g' && <span className="fd-portion-g">≈ {amountText(a.grams, 'g')}</span>}
    </div>
  )
}
