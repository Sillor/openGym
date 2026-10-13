// Ways in: the + button's sheet, a photo with an optional note, a description, a barcode. A photo
// or a description goes to the coach in the background (reads.js) and this sheet closes, so the
// diary stays usable; the review opens when the answer is in.

import { useEffect, useRef, useState } from 'react'
import { useUI } from '../../store/useUI.js'
import { t } from '../../lib/i18n.js'
import { fmtNum } from '../../lib/format.js'
import { lookupFoodBarcode, normalizeBarcode } from '../../lib/open-food-facts.js'
import { foodImageFromFile } from '../../lib/food-analyze.js'
import { MOBILE } from '../../lib/mobile.js'
import { importCodeFromImage, scanCode } from '../../lib/scan.js'
import { useMediaUrl } from '../CustomMedia.jsx'
import Icon from '../Icon.jsx'
import { Button, TextArea, TextField } from '../ui.jsx'
import { openMealSheet } from './MealSheet.jsx'
import { serverCoach } from './coach-food.js'
import { startRead } from './reads.js'

const NOTE_MAX = 1000
// Product codes only. Gym check-in keeps its own QR detector in lib/scan-web.js.
const FOOD_BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']

export function chooseImage(capture) {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    if (capture) input.setAttribute('capture', 'environment')
    input.addEventListener('change', () => resolve((input.files && input.files[0]) || null), { once: true })
    input.click()
  })
}

/* ---------------------------------------------------------------- + sheet -- */

function AddSheet({ day, onPhoto, recent, onLogAgain, close }) {
  const coach = serverCoach()
  const go = fn => () => { close(); fn() }
  const tiles = [
    { icon: 'camera', label: t('Scan food'), sub: coach ? t('Take a photo') : t('Photo only, coach is off'), run: () => onPhoto(true) },
    { icon: 'image', label: t('From photos'), sub: t('Pick a picture'), run: () => onPhoto(false) },
    { icon: 'pencil', label: t('Describe'), sub: t('Type what you ate'), run: () => openDescribe(day), off: !coach },
    { icon: 'qr', label: t('Barcode'), sub: t('Packaged food'), run: () => openBarcode(day) },
  ]
  return <div className="fa">
    <div className="fa-grid">
      {tiles.filter(x => !x.off).map(x => <button key={x.label} type="button" className="fa-tile" onClick={go(x.run)}>
        <span className="fa-tile-ic"><Icon name={x.icon} /></span>
        <span className="fa-tile-t">{x.label}</span>
        <span className="fa-tile-s">{x.sub}</span>
      </button>)}
    </div>
    <button type="button" className="fa-row" onClick={go(() => openMealSheet({ day, source: 'manual' }))}>
      <span className="fa-row-ic"><Icon name="plus" /></span>
      <span className="fa-row-t">{t('Enter it yourself')}</span>
      <Icon name="chevronRight" className="fm-chev" />
    </button>
    {!!recent.length && <>
      <div className="fa-sec">{t('Log again')}</div>
      <div className="fa-recent">
        {recent.map(e => <button key={e.id} type="button" className="fa-row" onClick={go(() => onLogAgain(e))}>
          <span className="fa-row-t">{e.name}</span>
          <span className="fa-row-k">{fmtNum(e.kcal)} kcal</span>
          <Icon name="plusCircle" className="fa-row-plus" />
        </button>)}
      </div>
    </>}
  </div>
}

export function openAddSheet(opts) {
  useUI.getState().openSheet(close => <AddSheet {...opts} close={close} />)
}

/* ---------------------------------------------------------------- photo + note -- */

function PhotoNote({ day, media, image, close }) {
  const [note, setNote] = useState('')
  const file = Array.isArray(media) ? media[0] : null
  const shot = useMediaUrl(file || null)
  const analyze = () => {
    startRead({ day, image, media, text: note.trim() })
    close()
  }
  return <div className="fp">
    <div className="fp-photo">
      {shot.url ? <img alt="" src={shot.url} /> : <div className="fm-hero-ph"><Icon name="image" /></div>}
      <button type="button" className="fm-circle" aria-label={t('Close')} onClick={close}><Icon name="xmark" /></button>
    </div>
    <label className="fp-lbl" htmlFor="fp-note">{t('Anything the photo doesn’t show?')}</label>
    <TextArea id="fp-note" aria-label={t('Anything the photo doesn’t show?')} rows={3} maxLength={NOTE_MAX} value={note}
      placeholder={t('Cooked in 1 tbsp butter, about 200 g of rice, oat milk')}
      onChange={e => setNote(e.target.value)} />
    <div className="fp-count">{note.length}/{NOTE_MAX}</div>
    <Button variant="primary" icon="sparkles" onClick={analyze}>{t('Analyze')}</Button>
  </div>
}

/**
 * A photo for `day`: pick or shoot it, keep it on the meal, and send a small copy to the coach.
 * Without the coach the photo still lands on a meal you fill in yourself.
 */
export async function addPhoto({ capture, day, picker }) {
  if (!picker.canAdd) {
    if (picker.note) useUI.getState().toast(picker.note)
    openMealSheet({ day, source: 'manual' })
    return
  }
  const file = await chooseImage(capture)
  if (!file) return
  const got = await picker.pick(file)
  const media = got ? [got] : []
  if (!serverCoach()) {
    useUI.getState().toast(t('Turn the coach on to read a photo. You can still fill it in.'))
    openMealSheet({ day, source: got ? 'photo' : 'manual', media })
    return
  }
  let image = null
  try { image = await foodImageFromFile(file) }
  catch {
    useUI.getState().toast(t('That photo could not be opened. Fill the meal in instead.'))
    openMealSheet({ day, source: got ? 'photo' : 'manual', media })
    return
  }
  useUI.getState().openSheet(close => <PhotoNote day={day} media={media} image={image} close={close} />)
}

/* ---------------------------------------------------------------- describe -- */

function Describe({ day, close }) {
  const [text, setText] = useState('')
  const go = () => {
    const s = text.trim()
    if (!s) return
    startRead({ day, text: s })
    close()
  }
  return <div className="fp">
    <h3>{t('Describe your meal')}</h3>
    <TextArea aria-label={t('Describe your meal')} rows={4} maxLength={NOTE_MAX} value={text} autoFocus
      placeholder={t('2 eggs, 2 slices of toast with butter, a latte with oat milk')}
      onChange={e => setText(e.target.value)} />
    <div className="fp-count">{text.length}/{NOTE_MAX}</div>
    <Button variant="primary" icon="sparkles" onClick={go} disabled={!text.trim()}>{t('Analyze')}</Button>
  </div>
}

export function openDescribe(day) {
  useUI.getState().openSheet(close => <Describe day={day} close={close} />)
}

/* ---------------------------------------------------------------- barcode -- */

function foodBarcodeDetector() {
  if (typeof globalThis.BarcodeDetector !== 'function') return null
  try { return new globalThis.BarcodeDetector({ formats: FOOD_BARCODE_FORMATS }) }
  catch { return null }
}

async function barcodeFromImage(file) {
  const det = foodBarcodeDetector()
  if (!det || !file || typeof createImageBitmap !== 'function') return null
  let bmp
  try { bmp = await createImageBitmap(file) }
  catch { return null }
  try {
    const found = await det.detect(bmp)
    const hit = found && found.find(b => b && b.rawValue)
    return hit ? String(hit.rawValue) : null
  } catch { return null }
  finally { if (bmp && bmp.close) bmp.close() }
}

function scanErrorMessage(e) {
  const m = String(e && e.message)
  if (m === 'permission-denied') return t('Camera permission is needed to scan. Enable it in Settings.')
  if (m === 'unsupported') return t('Scanning is not available on this device.')
  return t('Could not start the scanner')
}

// Browser camera for a product code. Check-in keeps CameraScan, which asks for a QR only.
function FoodBarcodeScan({ onFound, onCancel }) {
  const videoRef = useRef(null)
  const onFoundRef = useRef(onFound)
  const [error, setError] = useState(null)
  onFoundRef.current = onFound

  useEffect(() => {
    let stream = null, timer = null, done = false
    const stop = () => {
      done = true
      if (timer) clearTimeout(timer)
      if (stream) stream.getTracks().forEach(tr => tr.stop())
    }
    ;(async () => {
      const det = foodBarcodeDetector()
      if (!det || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setError('unavailable'); return }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      } catch (e) {
        setError(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'unavailable')
        return
      }
      if (done) { stream.getTracks().forEach(tr => tr.stop()); return }
      const v = videoRef.current
      if (!v) return
      v.srcObject = stream
      try { await v.play() } catch { /* the loop waits for frames */ }
      const tick = async () => {
        if (done) return
        if (v.readyState >= 2) {
          try {
            const found = await det.detect(v)
            const hit = found && found.find(b => b && b.rawValue)
            if (hit && !done) { stop(); onFoundRef.current(String(hit.rawValue)); return }
          } catch { /* keep trying */ }
        }
        timer = setTimeout(tick, 150)
      }
      tick()
    })()
    return stop
  }, [])

  return <>
    <h3>{t('Scan')}</h3>
    {error
      ? <div className="muted small" style={{ marginBottom: 16, lineHeight: 1.5 }}>
          {error === 'denied'
            ? t('Camera access was denied. Allow it in your browser and try again.')
            : t('No camera available here. Import a photo or type the code instead.')}
        </div>
      : <>
          <div className="cam-wrap">
            <video ref={videoRef} playsInline muted autoPlay />
            <div className="cam-frame" aria-hidden="true" />
          </div>
          <div className="muted small" style={{ textAlign: 'center', margin: '12px 0 16px' }}>{t('Point the camera at the barcode')}</div>
        </>}
    <Button variant="tinted" onClick={onCancel}>{t('Cancel')}</Button>
  </>
}

function BarcodeSheet({ day, close }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)
  const alive = useRef(true)
  useEffect(() => {
    // Set here, not only initially: StrictMode runs the cleanup once on mount, and that
    // must not leave the sheet thinking it is gone.
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const lookup = async raw => {
    const text = String(raw ?? '').trim()
    if (!text) return false
    setBusy(true)
    let opened = false
    try {
      const out = await lookupFoodBarcode(text)
      if (!alive.current) return false
      if (!out.ok && out.error === 'invalid') {
        useUI.getState().toast(t('Type the digits on the barcode.'))
        return false
      }
      if (!out.ok && out.error === 'network') {
        useUI.getState().toast(t('The product lookup didn’t answer. Try again.'))
      }
      const fill = out.ok
        ? out.item
        : { name: normalizeBarcode(text) || text, kcal: 0, protein: 0, carbs: 0, fat: 0, grams: null }
      opened = true
      close()
      openMealSheet({ day, source: 'barcode', fill })
      return true
    } finally {
      if (alive.current && !opened) setBusy(false)
    }
  }

  const scan = async () => {
    if (MOBILE) {
      setBusy(true)
      let opened = false
      try {
        const found = await scanCode()
        if (found?.value) { setCode(found.value); opened = await lookup(found.value) }
      } catch (e) {
        useUI.getState().toast(scanErrorMessage(e))
      } finally { if (alive.current && !opened) setBusy(false) }
      return
    }
    if (!foodBarcodeDetector()) {
      useUI.getState().toast(t('This browser can’t scan a barcode. Type the digits instead.'))
      return
    }
    useUI.getState().openSheet(closeCam => <FoodBarcodeScan
      onCancel={closeCam}
      onFound={value => { closeCam(); setCode(value); lookup(value) }} />)
  }

  const onFile = async ev => {
    const file = ev.target.files && ev.target.files[0]
    ev.target.value = ''
    if (!file) return
    if (!MOBILE && !foodBarcodeDetector()) {
      useUI.getState().toast(t('This browser can’t scan a barcode. Type the digits instead.'))
      return
    }
    setBusy(true)
    let opened = false
    try {
      let value = null
      if (MOBILE) {
        const found = await importCodeFromImage(file)
        value = found && found.value
      } else value = await barcodeFromImage(file)
      if (!value) { useUI.getState().toast(t('No barcode found in that photo.')); return }
      setCode(value)
      opened = await lookup(value)
    } catch {
      useUI.getState().toast(t('Could not read that image'))
    } finally { if (alive.current && !opened) setBusy(false) }
  }

  return <div className="fp">
    <h3>{t('Barcode')}</h3>
    <p className="fx-sub">{t('Type the digits, or scan them.')}</p>
    <div className="fb-row">
      <TextField aria-label={t('Barcode')} value={code} inputMode="numeric" placeholder="3017620422003"
        onChange={e => setCode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') lookup(code) }} />
      <Button variant="primary" onClick={() => lookup(code)} disabled={busy || !code.trim()}>{t('Look up')}</Button>
    </div>
    <div className="fm-actions">
      <Button variant="tinted" icon="camera" onClick={scan} disabled={busy}>{t('Scan')}</Button>
      <Button variant="tinted" icon="image" onClick={() => fileRef.current?.click()} disabled={busy}>{t('Photo')}</Button>
    </div>
    <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
  </div>
}

export function openBarcode(day) {
  useUI.getState().openSheet(close => <BarcodeSheet day={day} close={close} />)
}
