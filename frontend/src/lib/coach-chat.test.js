import { describe, expect, it } from 'vitest'
import {
  INFO_CARDS, ACTION_CARDS, stepText, cleanCards, proposalIdOf, cardProposal,
  isDestructive, readChangeCard, applyLabel, nutritionRead, chatReply, receiptOf,
  pendingCards, resolution, isOutdated, canUndoReceipt, chatEmpty, parseCoachText
} from './coach-chat.js'
import { CONSENT_VERSION, appendChat, applyChangeSet } from './coach.js'

const state = (over = {}) => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], bodyweight: [], exWeights: {},
  dayPlan: {}, routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0001', sets: 3, reps: 10, mode: 'reps' }] }],
  week: {},
  coach: { consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION }, log: [], snapshots: [], chat: [], timings: [], ...over.coach },
  ...over
})

describe('stepText', () => {
  it('translates the server’s fixed English steps and ignores anything else', () => {
    expect(stepText('Reading your workout history')).toBe('Reading your workout history')
    expect(stepText('Writing a reply')).toBe('Writing a reply')
    expect(stepText('Thinking really hard')).toBe(null)
    expect(stepText('')).toBe(null)
  })
})

describe('cleanCards', () => {
  it('keeps informational and proposing cards the app can draw, and drops the rest', () => {
    const cards = [
      { id: 'e1', type: 'exercises', ids: ['0001', 'nope', 3, '0002'], note: 'x' },
      { id: 'n1', type: 'nutrition', summary: 's', days: [{ d: '2026-09-01', kcal: '10', protein: 2 }], targets: { kcal: 100, protein: 20 } },
      { id: 'c1', type: 'changes', changes: [{ id: 'a', type: 'sets' }] },
      { id: 'r1', type: 'routines', bundle: { routines: [{ id: 'x', ex: [] }] } },
      { id: 'z', type: 'mystery' },
      { type: 'exercises', ids: ['0001'] },
      { id: 'empty-e', type: 'exercises', ids: [] },
      { id: 'empty-c', type: 'changes', changes: [] }
    ]
    const info = cleanCards(cards, INFO_CARDS)
    expect(info.map(c => c.id)).toEqual(['e1', 'n1'])
    expect(info[0].ids).toEqual(['0001', 'nope', '0002'])
    expect(info[1].days[0]).toEqual({ d: '2026-09-01', kcal: 10, protein: 2, carbs: 0, fat: 0 })
    expect(cleanCards(cards, ACTION_CARDS).map(c => c.id)).toEqual(['c1', 'r1'])
  })
})

describe('cardProposal / applyLabel / isDestructive', () => {
  it('names a card by job and card, as a review or a created plan', () => {
    const pending = { jobId: 'j1', createdAt: 9, planHash: 'h' }
    expect(proposalIdOf('j1', 'c1')).toBe('j1:c1')
    expect(cardProposal(pending, { id: 'c1', type: 'changes', summary: 's', changes: [1] })).toMatchObject({
      id: 'j1:c1', kind: 'review', summary: 's', planHash: 'h', iteration: 1
    })
    expect(cardProposal(pending, { id: 'r1', type: 'routines', bundle: { name: 'P' } })).toMatchObject({
      id: 'j1:r1', kind: 'create', bundle: { name: 'P' }
    })
  })
  it('names the apply button by the count, and flags a removal', () => {
    expect(applyLabel(2)).toBe('Apply 2 changes')
    expect(applyLabel(1)).toBe('Apply 1 change')
    expect(applyLabel(0)).toBe('Apply nothing')
    expect(isDestructive({ type: 'remove-exercise' })).toBe(true)
    expect(isDestructive({ type: 'sets' })).toBe(false)
    expect(isDestructive({ type: 'week', before: ['r1'], after: 'rest' })).toBe(true)
  })
})

describe('readChangeCard / nutritionRead', () => {
  it('ticks every change that still matches the plan', () => {
    const pending = { jobId: 'j1', createdAt: 1, planHash: 'h' }
    const card = { id: 'c1', type: 'changes', changes: [
      { id: 'a', type: 'sets', target: { routineId: 'r1', exId: '0001' }, before: 3, after: 4, why: 'x' }
    ] }
    const { usable, title, proposal } = readChangeCard(pending, card, state())
    expect(usable.map(c => c.id)).toEqual(['a'])
    expect(proposal.id).toBe('j1:c1')
    expect(title).toMatch(/sets/i)
  })
  it('averages the diary against its targets', () => {
    const r = nutritionRead({
      days: [{ d: 'a', kcal: 2000, protein: 100, carbs: 200, fat: 50 }, { d: 'b', kcal: 3000, protein: 200, carbs: 400, fat: 100 }],
      targets: { kcal: 2500, protein: 150, carbs: 300, fat: 75 }
    })
    expect(r.days).toBe(2)
    expect(r.rows.find(x => x.key === 'kcal')).toMatchObject({ avg: 2500, target: 2500, share: 1 })
    expect(r.rows.find(x => x.key === 'protein').avg).toBe(150)
  })
})

describe('chatReply / receipts / resolution', () => {
  it('appends a finished chat once, from last or from pending, and skips a cleared one', () => {
    const last = { outcome: 'chat', jobId: 'j1', at: 50, reply: 'Hello **there**', cards: [
      { id: 'e1', type: 'exercises', ids: ['0001'] },
      { id: 'c1', type: 'changes', changes: [{ id: 'a' }] }
    ] }
    const line = chatReply(state(), last, null)
    expect(line).toMatchObject({ role: 'coach', kind: 'chat', jobId: 'j1', text: 'Hello **there**' })
    expect(line.cards.map(c => c.type)).toEqual(['exercises'])

    const s = state()
    s.coach.chat = [{ kind: 'chat', jobId: 'j1' }]
    expect(chatReply(s, last, null)).toBe(null)

    const cleared = state()
    cleared.coach.chatClearedAt = 80
    expect(chatReply(cleared, last, null)).toBe(null)
    expect(chatReply(cleared, { ...last, at: 90 }, null)).toMatchObject({ jobId: 'j1' })
  })

  it('reads a proposing pending as the reply when last has not landed yet', () => {
    const pending = { kind: 'chat', jobId: 'j2', createdAt: 3, reply: 'Try this', cards: [
      { id: 'c1', type: 'changes', changes: [{ id: 'a', type: 'sets' }] }
    ] }
    const line = chatReply(state(), null, pending)
    expect(line).toMatchObject({ kind: 'chat', jobId: 'j2', text: 'Try this' })
    expect(line.cards).toBeUndefined()
    expect(pendingCards(pending).map(c => c.id)).toEqual(['c1'])
  })

  it('resolves the pending once every proposing card has a receipt', () => {
    const pending = { kind: 'chat', jobId: 'j1', cards: [
      { id: 'c1', type: 'changes', changes: [{ id: 'a' }] },
      { id: 'r1', type: 'routines', bundle: { routines: [{ id: 'x' }] } }
    ] }
    expect(resolution(state(), pending)).toBe(null)
    const s = state()
    s.coach.chat = [{ kind: 'applied', jobId: 'j1', cardId: 'c1' }]
    expect(resolution(s, pending)).toBe(null)
    s.coach.chat.push({ kind: 'applied', jobId: 'j1', cardId: 'r1' })
    expect(resolution(s, pending)).toEqual({ accepted: ['c1', 'r1'] })
    s.coach.chat[0].kind = 'dismissed'
    s.coach.chat[1].kind = 'dismissed'
    expect(resolution(s, pending)).toEqual({ dismissed: true })
    expect(receiptOf(s, 'j1', 'c1').kind).toBe('dismissed')
  })
})

describe('isOutdated / canUndoReceipt / chatEmpty', () => {
  it('a later explanation keeps the open proposal; a later proposal replaces it', () => {
    const s = state()
    s.coach.chat = [
      { kind: 'chat', role: 'coach', jobId: 'old', at: 1 },
      { kind: 'chat', role: 'coach', jobId: 'new', at: 2, cards: [] }
    ]
    expect(isOutdated(s, { kind: 'chat', jobId: 'old', createdAt: 1 })).toBe(false)
    s.coach.chat[1].cards = [{ type: 'routines' }]
    expect(isOutdated(s, { kind: 'chat', jobId: 'old', createdAt: 1 })).toBe(true)
    expect(isOutdated(s, { kind: 'chat', jobId: 'new', createdAt: 2 })).toBe(false)
    expect(isOutdated(s, { kind: 'review', jobId: 'old' })).toBe(false)
  })
  it('Undo only undoes the latest snapshot of that card', () => {
    const s = state()
    s.coach.snapshots = [{ proposalId: 'j1:c1' }]
    expect(canUndoReceipt(s, { kind: 'applied', proposalId: 'j1:c1' })).toBe(true)
    expect(canUndoReceipt(s, { kind: 'applied', proposalId: 'j1:other' })).toBe(false)
    expect(canUndoReceipt(s, { kind: 'dismissed', proposalId: 'j1:c1' })).toBe(false)
  })
  it('the thread is empty until something other than the questionnaire is in it', () => {
    expect(chatEmpty(state())).toBe(true)
    const s = state()
    s.coach.chat = [{ kind: 'intake' }]
    expect(chatEmpty(s)).toBe(true)
    s.coach.chat.push({ kind: 'text' })
    expect(chatEmpty(s)).toBe(false)
  })
})

describe('parseCoachText', () => {
  it('turns paragraphs, lists and **bold** into blocks, and leaves the rest as text', () => {
    const blocks = parseCoachText('Hello **there**.\n\n- one\n- two\n\n1. first\nalso this')
    expect(blocks.map(b => b.type)).toEqual(['p', 'ul', 'ol', 'p'])
    expect(blocks[0].lines[0].some(r => r.b && r.text === 'there')).toBe(true)
    expect(blocks[1].items).toHaveLength(2)
    expect(parseCoachText('plain **unclosed').some(b => b.lines?.[0].some(r => r.text.includes('**unclosed')))).toBe(true)
  })
})

describe('applying a chat card uses the same helpers as a review', () => {
  it('the proposal id is what the snapshot is stored under', () => {
    const s = state()
    const pending = { jobId: 'j1', createdAt: 1 }
    const card = { id: 'c1', type: 'changes', changes: [
      { id: 'a', type: 'sets', target: { routineId: 'r1', exId: '0001' }, before: 3, after: 4, why: 'x' }
    ] }
    const p = readChangeCard(pending, card, s).proposal
    applyChangeSet(s, p, ['a'])
    expect(s.routines[0].ex[0].sets).toBe(4)
    expect(s.coach.snapshots.at(-1).proposalId).toBe('j1:c1')
    appendChat(s, { role: 'coach', kind: 'applied', jobId: 'j1', cardId: 'c1', proposalId: 'j1:c1' })
    expect(canUndoReceipt(s, s.coach.chat.at(-1))).toBe(true)
  })
})
