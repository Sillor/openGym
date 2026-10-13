// One logged meal in the diary, as a Cal AI card: the photo, the name and the time, calories,
// and the three macros. A meal still being read shows its photo under a progress ring instead.

import { useEffect, useState } from 'react'
import { fmtNum } from '../../lib/format.js'
import { t } from '../../lib/i18n.js'
import { useMediaUrl } from '../CustomMedia.jsx'
import Icon from '../Icon.jsx'
import { Button } from '../ui.jsx'
import ProgressRing from './ProgressRing.jsx'
import { readError } from './coach-food.js'

const SOURCE_ICON = { photo: 'camera', text: 'pencil', barcode: 'qr', manual: 'fork' }

function Thumb({ media, source, children }) {
  const file = Array.isArray(media) ? media[0] : null
  const shot = useMediaUrl(file && file.kind !== 'video' ? file : file?.poster || null)
  return <span className="fc-thumb">
    {shot.url ? <img alt="" src={shot.url} /> : <Icon name={SOURCE_ICON[source] || 'fork'} />}
    {children}
  </span>
}

function timeOf(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function MacroChips({ protein, carbs, fat }) {
  return <span className="fc-macros">
    <span><Icon name="drumstick" style={{ color: 'var(--fd-protein)' }} />{fmtNum(Math.round(protein || 0))}g</span>
    <span><Icon name="wheat" style={{ color: 'var(--fd-carbs)' }} />{fmtNum(Math.round(carbs || 0))}g</span>
    <span><Icon name="drop" style={{ color: 'var(--fd-fat)' }} />{fmtNum(Math.round(fat || 0))}g</span>
  </span>
}

export default function MealCard({ entry, onOpen }) {
  return <button type="button" className="fd-card fc" onClick={onOpen}>
    <Thumb media={entry.media} source={entry.source} />
    <span className="fc-main">
      <span className="fc-top">
        <span className="fc-name">{entry.name}</span>
        <span className="fc-time">{timeOf(entry.at || entry.t)}</span>
      </span>
      <span className="fc-kcal"><Icon name="flame" />{fmtNum(entry.kcal)} kcal</span>
      <MacroChips protein={entry.protein} carbs={entry.carbs} fat={entry.fat} />
    </span>
  </button>
}

// The wait is not measured, so the ring eases toward 95% over about half a minute: it moves,
// it never claims to be done, and a fast answer simply cuts it short.
function useProgress(started, running) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    const id = setInterval(() => setNow(Date.now()), 400)
    return () => clearInterval(id)
  }, [running])
  const s = Math.max(0, (now - (started || now)) / 1000)
  return Math.min(0.95, 1 - Math.exp(-s / 10))
}

export function PendingCard({ read, onOpen, onRetry, onDismiss, onManual }) {
  const reading = read.status === 'reading'
  const pct = useProgress(read.started, reading)
  if (read.status === 'failed') {
    return <div className="fd-card fc fc-failed" role="alert">
      <Thumb media={read.media} source={read.source}><span className="fc-veil"><Icon name="warning" /></span></Thumb>
      <span className="fc-main">
        <span className="fc-top"><span className="fc-name">{read.text || t('Meal photo')}</span>
          <button type="button" className="fc-x" aria-label={t('Dismiss')} onClick={onDismiss}><Icon name="xmark" /></button></span>
        <span className="fc-err">{readError(read.error, { photo: !!read.image })}</span>
        <span className="fc-acts">
          <Button size="xs" variant="tinted" icon="reset" onClick={onRetry}>{t('Try again')}</Button>
          <Button size="xs" variant="plain" onClick={onManual}>{t('Fill in')}</Button>
        </span>
      </span>
    </div>
  }
  if (read.status === 'ready') {
    const m = read.result
    return <button type="button" className="fd-card fc fc-ready" onClick={onOpen}>
      <Thumb media={read.media} source={read.source} />
      <span className="fc-main">
        <span className="fc-top"><span className="fc-name">{m.name}</span><span className="fc-badge">{t('Review')}</span></span>
        <span className="fc-kcal"><Icon name="flame" />{fmtNum(m.kcal)} kcal</span>
        <MacroChips protein={m.protein} carbs={m.carbs} fat={m.fat} />
      </span>
    </button>
  }
  return <div className="fd-card fc fc-reading" aria-busy="true">
    <Thumb media={read.media} source={read.source}>
      <span className="fc-veil"><ProgressRing pct={pct} size={40} stroke={4} color="#fff"><b>{Math.round(pct * 100)}%</b></ProgressRing></span>
    </Thumb>
    <span className="fc-main">
      <span className="fc-name">{t('Analyzing…')}</span>
      <span className="fc-skel" style={{ width: '70%' }} />
      <span className="fc-skel" style={{ width: '45%' }} />
    </span>
  </div>
}
