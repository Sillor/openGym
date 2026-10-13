// @vitest-environment happy-dom
// The Coach chat keeps the tab bar, except while the keyboard is up (App.jsx): then the composer
// has the bottom of the screen to itself, right above the keys. Each platform shows the keyboard
// its own way — Android 15 as --native-kb, iOS and Chrome as a shorter visual viewport, older
// Android WebViews as a shorter window — and none of them may hide the bar for a pinch-zoom, a
// rotation, or a desktop window someone made smaller.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { keyboardOpen, useKeyboardOpen } from './keyboard-open.js'
import { NATIVE_KEYBOARD_EVENT } from './native-keyboard.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// A window to steer by hand: its sizes, its visual viewport and its listeners.
function fakeWindow({ innerHeight = 800, innerWidth = 400, vvHeight = innerHeight } = {}) {
  const listeners = new Map()
  const target = () => {
    const own = new Map()
    listeners.set(own, true)
    return {
      own,
      addEventListener: (type, fn) => own.set(type, [...(own.get(type) || []), fn]),
      removeEventListener: (type, fn) => own.set(type, (own.get(type) || []).filter(f => f !== fn)),
      fire: type => (own.get(type) || []).forEach(fn => fn({ type })),
    }
  }
  const win = target()
  const doc = target()
  const html = document.createElement('html')
  doc.documentElement = html
  doc.activeElement = null
  win.document = doc
  win.innerHeight = innerHeight
  win.innerWidth = innerWidth
  win.visualViewport = { ...target(), height: vvHeight, offsetTop: 0 }
  return win
}
const field = () => document.createElement('textarea')

describe('keyboardOpen', () => {
  it('is open whenever Android 15 passes a keyboard height, focus or not', () => {
    const win = fakeWindow()
    expect(keyboardOpen(win)).toBe(false)
    win.document.documentElement.style.setProperty('--native-kb', '320px')
    expect(keyboardOpen(win)).toBe(true)
  })

  it('reads a shrunk visual viewport as the keyboard only while a text field has focus', () => {
    const win = fakeWindow({ vvHeight: 460 })
    expect(keyboardOpen(win)).toBe(false)          // a pinch-zoom shrinks it too
    win.document.activeElement = field()
    expect(keyboardOpen(win)).toBe(true)
    win.document.activeElement = document.createElement('button')
    expect(keyboardOpen(win)).toBe(false)
  })

  it('reads a window shorter than its tallest as the keyboard on WebViews that resize', () => {
    const win = fakeWindow({ innerHeight: 470 })
    win.document.activeElement = field()
    expect(keyboardOpen(win, 800)).toBe(true)
    expect(keyboardOpen(win, 520)).toBe(false)     // browser chrome coming and going is not a keyboard
  })

  it('is closed with a field focused and the screen at full height (a hardware keyboard, a desktop)', () => {
    const win = fakeWindow()
    win.document.activeElement = field()
    expect(keyboardOpen(win, 800)).toBe(false)
  })
})

describe('useKeyboardOpen', () => {
  let host, root
  afterEach(() => { act(() => root?.unmount()); host?.remove() })
  const seen = []
  function Probe({ enabled, win }) {
    seen.push(useKeyboardOpen(enabled, win))
    return null
  }
  const mount = (win, enabled = true) => {
    host = document.createElement('div')
    root = createRoot(host)
    act(() => root.render(<Probe enabled={enabled} win={win} />))
  }
  const last = () => seen.at(-1)

  it('follows the keyboard up and down through the viewport, focus and native events', async () => {
    const win = fakeWindow()
    mount(win)
    expect(last()).toBe(false)
    win.document.activeElement = field()
    win.visualViewport.height = 450
    act(() => win.visualViewport.fire('resize'))
    expect(last()).toBe(true)
    // the keyboard goes as the field loses focus
    win.document.activeElement = null
    win.visualViewport.height = 800
    await act(async () => { win.document.fire('focusout'); await new Promise(r => setTimeout(r, 5)) })
    expect(last()).toBe(false)
    win.document.documentElement.style.setProperty('--native-kb', '300px')
    act(() => win.fire(NATIVE_KEYBOARD_EVENT))
    expect(last()).toBe(true)
  })

  it('takes a rotation’s height as the new baseline rather than a keyboard', () => {
    const win = fakeWindow()
    mount(win)
    win.document.activeElement = field()
    win.innerWidth = 800; win.innerHeight = 400; win.visualViewport.height = 400
    act(() => win.fire('resize'))
    expect(last()).toBe(false)
    win.innerHeight = 200; win.visualViewport.height = 200
    act(() => win.fire('resize'))
    expect(last()).toBe(true)
  })

  it('stays closed and listens to nothing while switched off', () => {
    const win = fakeWindow()
    win.document.documentElement.style.setProperty('--native-kb', '300px')
    mount(win, false)
    expect(last()).toBe(false)
    expect([...win.own.values()].flat()).toHaveLength(0)
  })
})
