import { useNavigate } from 'react-router-dom'
import { t } from '../lib/i18n.js'
import MuscleExplorer from '../components/MuscleExplorer.jsx'
import { exerciseDetailSheet, addToRoutineSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { useCoachTab } from '../components/TabBar.jsx'

export default function Muscles() {
  const nav = useNavigate()
  // Back the way you came: the library page, or Plan's Exercises view where the Coach has the
  // library's tab. Opened from a link with nothing behind it, it goes up to whichever holds it.
  const home = useCoachTab() ? '/plan?view=exercises' : '/library'
  const back = () => {
    if ((window.history.state?.idx || 0) > 0) nav(-1)
    else nav(home, { replace: true })
  }
  return <>
    <div className="hdr"><button className="iconbtn" onClick={back} aria-label={t('Exercises')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('Explore muscles')}</h1><div className="sub">{t('Choose a muscle to see exercises that train it.')}</div></div></div>

    <MuscleExplorer onDetail={exerciseDetailSheet} onPlan={addToRoutineSheet} />
  </>
}
