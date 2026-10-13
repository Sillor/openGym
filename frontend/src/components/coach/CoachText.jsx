import { Fragment, createElement, useMemo } from 'react'
import { parseCoachText } from '../../lib/coach-chat.js'

// A reply in the Coach's words, with the little formatting a chat needs: paragraphs, lists,
// line breaks, bold. Parsed into blocks (lib/coach-chat.js) and built as elements, so nothing
// the model writes is ever read as HTML.
export default function CoachText({ text }) {
  const blocks = useMemo(() => parseCoachText(text), [text])
  return <div className="ctext">
    {blocks.map((b, i) => b.type === 'p'
      ? <p key={i}>{b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}<Runs runs={l} /></Fragment>)}</p>
      : createElement(b.type, { key: i }, b.items.map((it, j) => <li key={j}><Runs runs={it} /></li>)))}
  </div>
}

const Runs = ({ runs }) => runs.map((r, i) => r.b ? <b key={i}>{r.text}</b> : <Fragment key={i}>{r.text}</Fragment>)
