// The Android app's first-launch card ("How do you want to use openGym?") showed the tab bar under
// it, and a tap on a tab changed the route behind the card and stacked history entries for back to
// walk through. Shell is not rendered in a test, so this reads the condition from the source.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8')

describe('the tab bar', () => {
  it('stays away from the first-launch onboarding', () => {
    const cond = app.match(/const noTabs = ([^\n]+)/)?.[1] || ''
    expect(cond).toContain('needsMobileOnboarding')
    expect(app).toMatch(/\{!noTabs && <TabBar /)
  })

  // The Coach is a tab now (components/TabBar.jsx): its chat keeps the bar, with the composer on
  // top of it, and gives the bar up only while the keyboard is open (lib/keyboard-open.js).
  it('stays on the Coach chat, except while the keyboard is up', () => {
    const cond = app.match(/const noTabs = ([^\n]+)/)?.[1] || ''
    expect(cond).not.toMatch(/=== '\/coach' \|\|/)
    expect(cond).toContain('(onChat && typing)')
    expect(app).toContain("const onChat = loc.pathname === '/coach'")
    expect(app).toContain('const typing = useKeyboardOpen(onChat)')
  })

  it('tells the stylesheet when the chat has the bar under it, for the composer to sit on', () => {
    expect(app).toContain('const chatTabs = onChat && !noTabs && !!authed')
    expect(app).toContain("document.body.classList.toggle('coach-tabbar', chatTabs)")
    const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
    expect(css).toContain('--tabbar-h:calc(58px + var(--sab));')
    expect(css).toMatch(/@media \(min-width:1000px\)\{[\s\S]*?:root\{--tabbar-h:78px\}/)
  })
})
