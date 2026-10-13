import { t, tn } from '../../lib/i18n.js'
import { DAYS, weekOrder } from '../../lib/format.js'
import { exLine } from '../../lib/history.js'
import { EXIDX } from '../../lib/exercises.js'
import { exName } from '../../lib/coach.js'
import { glyphOf } from '../../lib/glyphs.js'
import Icon from '../Icon.jsx'
import { Thumb } from '../Media.jsx'

// The pieces a proposed plan is drawn from, shared by the plan card, the chat's routine card and
// the read-only proposal sheet.

// In the order the week is set to start on (Settings), like the Plan's own week.
export const WeekStrip = ({ days, ws }) => <div className="pcard-week">
  {weekOrder(ws).map(d => <div key={d} className={'pcard-wd' + (days.has(d) ? ' on' : '')}>{t(DAYS[d])}</div>)}
</div>

export const RoutineBlock = ({ r, unit, speedUnit, thumbs }) => <div className="pcard-rt">
  <div className="pcard-rt-h"><b><Icon name={glyphOf(r.emoji)} />{r.name}</b><span>{tn('{0} exercise', '{0} exercises', r.ex.length)}</span></div>
  {!!r.why && <div className="pcard-why">{r.why}</div>}
  {r.ex.map((e, i) => <div key={i} className={'pcard-ex' + (thumbs ? ' thumbed' : '')}>
    {thumbs && (EXIDX[e.id] ? <Thumb ex={EXIDX[e.id]} /> : <div className="thumb thumb-x"><Icon name="dumbbell" /></div>)}
    <div className="grow">
      <div className="pcard-ex-r"><span className="pcard-ex-n">{exName(e.id)}</span><span className="pcard-ex-l">{exLine(e, unit, speedUnit)}</span></div>
      {!!e.why && <div className="pcard-ex-w">{e.why}</div>}
    </div>
  </div>)}
</div>
