// The chat with the Coach, on the client side: what a reply carries and what deciding on it does.
//
// A chat turn ends with a reply and a list of cards (api/coach/core/agent.js). Two kinds only
// inform — exercises to look at, the food diary drawn against its targets — and are kept in the
// thread with the reply. Two kinds propose — a change-set, new routines — and are not: they live
// in the server's single pending slot until they are decided, exactly like a review or a plan,
// so two devices can never disagree about what is still open. Deciding writes a receipt into
// the thread, and once every proposing card of a reply has one, the slot is resolved.
//
// Everything here is pure over the state or the status poll, like lib/coach.js, so the parts
// that decide what a tap applies are tested without a browser.

import { EXIDX, canonicalExId } from './exercises.js'
import { markStale, applicable, changeTitle } from './coach.js'
import { t, tn } from './i18n.js'

export const INFO_CARDS = ['exercises', 'nutrition']
export const ACTION_CARDS = ['changes', 'routines']

// What the Coach is doing while a chat job runs. The server names its step in English from a
// fixed list; each one is a literal t() call so check-source-strings sees every key. A step
// the app has no line for shows nothing rather than untranslated English.
const STEPS = {
  'Reading your workout history': () => t('Reading your workout history'),
  'Checking your exercise progress': () => t('Checking your exercise progress'),
  'Searching the exercise library': () => t('Searching the exercise library'),
  'Checking your food diary': () => t('Checking your food diary'),
  'Checking your body metrics': () => t('Checking your body metrics'),
  'Looking at your routine': () => t('Looking at your routine'),
  'Checking a proposal': () => t('Checking a proposal'),
  'Writing a reply': () => t('Writing a reply')
}
export const stepText = step => (Object.hasOwn(STEPS, step) ? STEPS[step]() : null)

/* ============================ cards ============================ */

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const ids = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [])

/**
 * The cards of a reply that this app can draw, cleaned to the fields it reads. A card of an
 * unknown type, or one with nothing in it, is dropped rather than drawn empty: the validators
 * on the server are the security boundary, this only keeps a bad day from rendering as a blank box.
 */
export function cleanCards(cards, types) {
  const out = []
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || typeof c !== 'object' || !c.id || !types.includes(c.type)) continue
    if (c.type === 'exercises') {
      const list = ids(c.ids)
      if (list.length) out.push({ id: String(c.id), type: 'exercises', ids: list.slice(0, 12), ...(c.note ? { note: String(c.note).slice(0, 400) } : {}) })
    } else if (c.type === 'nutrition') {
      const days = (Array.isArray(c.days) ? c.days : []).filter(d => d && d.d).slice(-14)
        .map(d => ({ d: String(d.d), kcal: num(d.kcal), protein: num(d.protein), carbs: num(d.carbs), fat: num(d.fat) }))
      const tg = c.targets && typeof c.targets === 'object' ? c.targets : null
      out.push({
        id: String(c.id), type: 'nutrition', summary: String(c.summary || '').slice(0, 600), days,
        targets: tg ? { kcal: num(tg.kcal), protein: num(tg.protein), carbs: num(tg.carbs), fat: num(tg.fat) } : null
      })
    } else if (c.type === 'changes') {
      if (Array.isArray(c.changes) && c.changes.length) out.push(c)
    } else if (c.type === 'routines') {
      if (Array.isArray(c.bundle?.routines) && c.bundle.routines.length) out.push(c)
    }
  }
  return out
}

/** The id a card is applied, logged and undone under — one per card, not per reply. */
export const proposalIdOf = (jobId, cardId) => `${jobId}:${cardId}`

/**
 * A proposing card in the shape lib/coach.js applies: a change-set for applyChangeSet, a created
 * plan for applyCreatedPlan. The log entry it leaves is then the same as a review's or a plan's,
 * so the history sheet, the recap and Undo need nothing of their own.
 */
export function cardProposal(pending, card) {
  const base = { id: proposalIdOf(pending?.jobId, card.id), createdAt: pending?.createdAt || null, iteration: 1 }
  if (card.type === 'routines') {
    return { ...base, kind: 'create', summary: card.summary || card.bundle?.summary || '', bundle: card.bundle }
  }
  return {
    ...base, kind: 'review', summary: card.summary || card.title || '',
    planHash: card.planHash || pending?.planHash || null,
    changes: card.changes || [], notes: [], evidence: null
  }
}

/** A change that takes something away. Drawn as such on the card, so nobody removes by accident. */
export const isDestructive = c => c?.type === 'remove-exercise' || c?.type === 'remove-routine' ||
  (c?.type === 'week' && (c.after == null || c.after === 'rest') && [].concat(c.before ?? []).filter(x => x && x !== 'rest').length > 0)

/**
 * A change card read against the plan as it is now: which rows can still be applied, which are
 * ticked to begin with (all of the ones that can), and the title — the Coach's own, or for a
 * single change the change itself ("Swap Barbell Row for Dumbbell Row").
 */
export function readChangeCard(pending, card, S) {
  const marked = markStale(cardProposal(pending, card), S)
  const usable = applicable(marked)
  const title = card.title || (marked.changes.length === 1 ? changeTitle(marked.changes[0], S) : tn('{0} suggestion', '{0} suggestions', marked.changes.length))
  return { proposal: marked, usable, title }
}

/** The primary button's words: the verb and the count, never a bare "OK". */
export const applyLabel = n => (n ? tn('Apply {0} change', 'Apply {0} changes', n) : t('Apply nothing'))

/** Exercises a card names, resolved against the catalogue and your own; an unknown id is dropped. */
export const resolveExercises = ids => (ids || []).map(id => EXIDX[canonicalExId(id)]).filter(Boolean)

/**
 * The food diary on a nutrition card, averaged over the days it lists: each macro against its
 * target, as a share the bar can draw (capped at 1.5 so one big day cannot flatten the rest).
 */
export function nutritionRead(card) {
  const days = card?.days || []
  const keys = ['kcal', 'protein', 'carbs', 'fat']
  const avg = {}
  for (const k of keys) avg[k] = days.length ? Math.round(days.reduce((n, d) => n + num(d[k]), 0) / days.length) : 0
  const tg = card?.targets
  const rows = keys.map(k => {
    const target = tg && tg[k] > 0 ? tg[k] : null
    return { key: k, avg: avg[k], target, share: target ? Math.min(1.5, avg[k] / target) : null }
  })
  return { days: days.length, rows }
}

/* ============================ the thread ============================ */

const coachOf = S => S?.coach || {}
const lastIdOf = last => last?.jobId || last?.id || null

/**
 * The reply a finished chat job leaves, as the thread line to append — or null when there is
 * none, it is already in the thread, or it was written before the chat was cleared.
 *
 * Read from the last outcome first and the pending slot second: a reply with a proposal is in
 * both, and either one on its own is enough. Appended once per job, by whichever device sees it
 * first; the jobId on the line is what the next poll recognises.
 */
export function chatReply(S, last, pending) {
  const src = last?.outcome === 'chat' && lastIdOf(last) ? { ...last, jobId: lastIdOf(last) }
    : pending?.kind === 'chat' && pending.jobId ? { ...pending, at: pending.createdAt } : null
  if (!src) return null
  const c = coachOf(S)
  if ((c.chat || []).some(m => m.kind === 'chat' && m.jobId === src.jobId)) return null
  if (c.chatClearedAt && (Number(src.at) || 0) <= c.chatClearedAt) return null
  const cards = cleanCards(src.cards, INFO_CARDS)
  const text = String(src.reply || '').trim()
  if (!text && !cards.length && !(pending?.kind === 'chat' && pending.jobId === src.jobId)) return null
  return { role: 'coach', kind: 'chat', text, jobId: src.jobId, ...(cards.length ? { cards } : {}) }
}

/** The receipt a decided card left in the thread, if it has one. */
export const receiptOf = (S, jobId, cardId) =>
  (coachOf(S).chat || []).find(m => m.jobId === jobId && m.cardId === cardId && (m.kind === 'applied' || m.kind === 'dismissed')) || null

/** The proposing cards of a chat pending, cleaned. */
export const pendingCards = pending => (pending?.kind === 'chat' ? cleanCards(pending.cards, ACTION_CARDS) : [])

/**
 * What to tell the server once the last card of a reply is decided, or null while one is still
 * open. The cards that were applied, by id; nothing applied is a dismissal.
 */
export function resolution(S, pending) {
  const cards = pendingCards(pending)
  if (!cards.length) return null
  const receipts = cards.map(c => receiptOf(S, pending.jobId, c.id))
  if (receipts.some(r => !r)) return null
  const accepted = cards.filter((c, i) => receipts[i].kind === 'applied').map(c => c.id)
  return accepted.length ? { accepted } : { dismissed: true }
}

/**
 * A chat proposal the conversation has moved past: a later reply from the Coach is already in
 * the thread. It is drawn greyed and cannot be applied — what it proposed was read against a
 * conversation that has since gone on, and the newer reply is the one to answer.
 */
export function isOutdated(S, pending) {
  if (pending?.kind !== 'chat') return false
  const chat = coachOf(S).chat || []
  const at = chat.findIndex(m => m.kind === 'chat' && m.jobId === pending.jobId)
  const created = Number(pending.createdAt) || 0
  // A later explanation does not retire the card. Only a later message that itself carries
  // a replacement proposal does — otherwise asking for an edit would grey the workout out.
  return chat.some((m, i) => m.role === 'coach' && m.kind === 'chat' && m.jobId && m.jobId !== pending.jobId &&
    (at >= 0 ? i > at : (Number(m.at) || 0) > created) &&
    (m.cards || []).some(c => c && (c.type === 'routines' || c.type === 'changes')))
}

/** Whether Undo on a receipt would undo that card: only the latest snapshot can be put back. */
export function canUndoReceipt(S, m) {
  if (m?.kind !== 'applied' || !m.proposalId) return false
  const snaps = coachOf(S).snapshots || []
  return snaps.length > 0 && snaps[snaps.length - 1].proposalId === m.proposalId
}

/** Whether the thread has anything in it yet besides the questionnaire. */
export const chatEmpty = S => !(coachOf(S).chat || []).some(m => m.kind !== 'intake')

/* ============================ the Coach's words ============================ */

/**
 * Light formatting for a reply, and nothing more: paragraphs, `- ` / `* ` / `• ` / `1. `
 * lists, line breaks and **bold**. Anything else is text. Returns blocks the view maps to
 * elements, so no HTML from the model ever reaches the page.
 */
export function parseCoachText(text) {
  const blocks = []
  let cur = null
  const push = b => { blocks.push(b); cur = b }
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const bullet = /^\s*(?:[-*•])\s+(.*)$/.exec(line)
    const numbered = /^\s*\d{1,2}[.)]\s+(.*)$/.exec(line)
    if (!line.trim()) { cur = null; continue }
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol'
      if (cur?.type !== type) push({ type, items: [] })
      cur.items.push(inline((bullet || numbered)[1]))
    } else {
      if (cur?.type !== 'p') push({ type: 'p', lines: [] })
      cur.lines.push(inline(line))
    }
  }
  return blocks
}

/** `**bold**` runs within a line; an unmatched pair of stars stays as typed. */
function inline(s) {
  const out = []
  const re = /\*\*(.+?)\*\*/g
  let at = 0, m
  while ((m = re.exec(s))) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) })
    out.push({ text: m[1], b: true })
    at = m.index + m[0].length
  }
  if (at < s.length) out.push({ text: s.slice(at) })
  return out
}
