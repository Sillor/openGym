import { useEffect, useState } from 'react'
import { nativeKeyboardHeight, NATIVE_KEYBOARD_EVENT } from './native-keyboard.js'

/* Whether the soft keyboard is up, for a screen that hides the tab bar meanwhile (the Coach chat,
   App.jsx): with the bar between them, the composer would ride a tab bar's height above the keys.
   Three ways the keyboard shows itself:
   - Android 15 passes the height it covers as --native-kb (lib/native-keyboard.js);
   - iOS and Chrome shrink the visual viewport and leave the layout viewport alone;
   - older Android WebViews resize the window itself, so innerHeight drops below the tallest
     it has been at this width.
   The last two also need a text field with focus: a pinch-zoom shrinks the visual viewport too,
   and a rotated phone is shorter without any keyboard. */
const SHRINK = 120   // px — taller than any browser chrome that comes and goes, shorter than a keyboard

const isField = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))

export function keyboardOpen(win, tallest = 0) {
  if (!win?.document) return false
  if (nativeKeyboardHeight(win.document) > 0) return true
  if (!isField(win.document.activeElement)) return false
  const vv = win.visualViewport
  const visualBottom = vv ? (vv.offsetTop || 0) + (vv.height || win.innerHeight) : win.innerHeight
  return win.innerHeight - visualBottom > SHRINK || tallest - win.innerHeight > SHRINK
}

export function useKeyboardOpen(enabled = true, win = typeof window !== 'undefined' ? window : null) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!enabled || !win?.addEventListener) { setOpen(false); return }
    let tallest = win.innerHeight, width = win.innerWidth, timer = 0
    const check = () => {
      // A new width is a rotation (or a resized desktop window): its height is the new baseline.
      if (win.innerWidth !== width) { width = win.innerWidth; tallest = win.innerHeight }
      tallest = Math.max(tallest, win.innerHeight)
      setOpen(keyboardOpen(win, tallest))
    }
    // focusout fires while the field still has focus, so look once it has moved on.
    const later = () => { clearTimeout(timer); timer = setTimeout(check, 0) }
    const vv = win.visualViewport
    check()
    win.addEventListener('resize', check)
    win.addEventListener(NATIVE_KEYBOARD_EVENT, check)
    vv?.addEventListener('resize', check)
    win.document.addEventListener('focusin', later)
    win.document.addEventListener('focusout', later)
    return () => {
      clearTimeout(timer)
      win.removeEventListener('resize', check)
      win.removeEventListener(NATIVE_KEYBOARD_EVENT, check)
      vv?.removeEventListener('resize', check)
      win.document.removeEventListener('focusin', later)
      win.document.removeEventListener('focusout', later)
    }
  }, [enabled, win])
  return enabled && open
}
