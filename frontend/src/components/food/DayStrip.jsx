// The week the open day sits in, one pill per day with a small calorie ring, like the date row
// at the top of Cal AI and Apple Fitness. Swipe sideways for the week before or after; a tap
// opens that day.

import { useRef } from 'react'
import { isoOf, startOfWeek, todayISO } from '../../lib/format.js'
import { dateLocale, t } from '../../lib/i18n.js'
import ProgressRing from './ProgressRing.jsx'

export function shiftISO(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return isoOf(dt)
}

export default function DayStrip({ day, onPick, kcalByDay, target, weekStart }) {
  const start = isoOf(startOfWeek(day, weekStart))
  const today = todayISO()
  const swipe = useRef(null)
  let fmt
  try { fmt = new Intl.DateTimeFormat(dateLocale(), { weekday: 'short' }) } catch { fmt = null }
  const days = Array.from({ length: 7 }, (_, i) => shiftISO(start, i))

  const down = e => { swipe.current = { x: e.clientX, y: e.clientY } }
  const up = e => {
    const s = swipe.current
    swipe.current = null
    if (!s) return
    const dx = e.clientX - s.x, dy = e.clientY - s.y
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) onPick(shiftISO(day, dx < 0 ? 7 : -7))
  }

  return (
    <div className="fd-week" role="tablist" aria-label={t('Week')} data-nodrag
      onPointerDown={down} onPointerUp={up} onPointerCancel={() => { swipe.current = null }}>
      {days.map(iso => {
        const [y, m, d] = iso.split('-').map(Number)
        const date = new Date(y, m - 1, d)
        const kcal = kcalByDay[iso] || 0
        const pct = target > 0 ? kcal / target : 0
        const label = fmt ? fmt.format(date) : ''
        return (
          <button key={iso} type="button" role="tab" aria-selected={iso === day}
            className={'fd-wday' + (iso === day ? ' on' : '') + (iso === today ? ' today' : '') + (iso > today ? ' later' : '')}
            aria-label={date.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}
            onClick={() => onPick(iso)}>
            <span className="fd-wday-n">{label.replace(/\.$/, '')}</span>
            <ProgressRing pct={pct} size={36} stroke={3} over={pct > 1.05} color="var(--label)">
              <span className="fd-wday-d">{d}</span>
            </ProgressRing>
          </button>
        )
      })}
    </div>
  )
}
