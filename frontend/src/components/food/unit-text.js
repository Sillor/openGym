// Unit names on screen. Symbols (g, ml, oz…) never change; counted things are translated and
// take a plural. A unit the model made up ("taco", "bowl" in a language with no entry) is shown
// as it came, with an English plural, since that is the language the model wrote it in.

import { formatQty } from '../../lib/food-units.js'
import { fmtNum } from '../../lib/format.js'
import { t } from '../../lib/i18n.js'

const SYMBOLS = new Set(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl oz', 'tsp', 'tbsp'])

const NAMES = {
  serving: () => [t('serving'), t('servings')],
  piece: () => [t('piece'), t('pieces')],
  slice: () => [t('slice'), t('slices')],
  cup: () => [t('cup'), t('cups')],
  bowl: () => [t('bowl'), t('bowls')],
  plate: () => [t('plate'), t('plates')],
  can: () => [t('can'), t('cans')],
  bottle: () => [t('bottle'), t('bottles')],
  glass: () => [t('glass'), t('glasses')],
  packet: () => [t('packet'), t('packets')],
}

export function unitText(unit, qty = 1) {
  const u = unit || 'serving'
  if (SYMBOLS.has(u)) return u
  const one = Math.abs((Number(qty) || 1) - 1) < 0.001 || (Number(qty) > 0 && Number(qty) < 1)
  const names = NAMES[u]
  if (names) return names()[one ? 0 : 1]
  if (one) return u
  return /(s|x|ch|sh)$/.test(u) ? u + 'es' : u + 's'
}

const decimalSep = () => {
  const s = fmtNum(1.5)
  return s.includes(',') ? ',' : '.'
}

/** "150 g", "1½ slices", "2 cups". */
export function amountText(qty, unit) {
  const q = formatQty(qty, unit, decimalSep())
  return q ? `${q} ${unitText(unit, qty)}` : unitText(unit, 1)
}

export { decimalSep }
