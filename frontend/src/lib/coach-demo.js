// The Coach, in the demo build.
//
// The GitHub Pages demo has no backend at all, so there is nothing to run a CLI and nothing
// to poll. Rather than hide the feature there — it is the most interesting thing the app
// does — the demo answers the same calls locally with a canned proposal.
//
// It is built from the demo profile's actual routines rather than hard-coded, so every id
// resolves, the before/after values are real, and applying it exercises exactly the same
// code path as a live instance: validate, snapshot, apply, log, revert. What is faked is the
// provider, not the feature.
//
// Nothing here ships in a self-hosted bundle: every entry point is behind DEMO, which Vite
// replaces at build time.

import { EXIDX, EXDB } from './exercises.js'
import { modeOf, workoutVolume, workoutAt } from './history.js'
import { isWarmupRow } from './workout-model.js'
import { best1RM } from './onerm.js'
import { fmtNum } from './format.js'
import { planHash, exTitle } from './coach.js'
import { INFO_CARDS } from './coach-chat.js'
import { dayTotals, profileTargets } from './nutrition.js'
import { t } from './i18n.js'
import { DATA_CATEGORIES } from '../../../api/coach/core/categories.js'

const DELAY = 2200      // long enough to see "the Coach is thinking…", short enough to forgive

let pending = null
let job = null
let timer = null
let lastError = null    // the last job that ended without a proposal, in the server's shape
let last = null         // the last chat reply, in the server's shape (status.last)
let chats = 0           // chat jobs started, so every reply has an id of its own

const iso = d => d.toISOString().slice(0, 10)

/** The routine the canned review aims at: the first with two exercises, one to swap and one to cut a set from. */
const reviewable = S => (S.routines || []).find(r => (r.ex || []).length >= 2)

/** A change-set that reads like a real one, aimed at whatever the demo profile actually has. */
function buildReview(S) {
  const routine = reviewable(S)
  if (!routine) return null
  const reps = (routine.ex || []).filter(e => modeOf(e) === 'reps')
  const first = reps[0] || routine.ex[0]
  // Anything but `first`: the two changes below swap `first` away and re-set `second`, so the
  // same entry in both aborts the whole change-set on apply (`missing target`). `reps[1]` was
  // not enough — a routine whose only rep-mode exercise sits at index 1 landed on it twice.
  const second = reps.find(e => e !== first) || routine.ex.find(e => e !== first)
  const other = (S.routines || []).find(r => r.id !== routine.id)

  // Something plausible that is *not* in this routine, from the same body part as the first
  // exercise — a swap the reader can believe rather than a random pick out of 1,324.
  const bp = EXIDX[first.id]?.bp
  const swapTo = EXDB.find(e => e.bp === bp && e.eq === 'dumbbell' && !(routine.ex || []).some(x => x.id === e.id))
    || EXDB.find(e => e.bp === bp && !(routine.ex || []).some(x => x.id === e.id))

  const sessions = (S.workouts || []).slice(-9)
  const changes = []
  if (swapTo) changes.push({
    id: 'd1', type: 'swap-exercise', target: { routineId: routine.id, exId: first.id },
    before: EXIDX[first.id]?.n || first.id, after: { id: swapTo.id, name: swapTo.n },
    why: t('Every top set on this one came in at RPE 9.5 or above for three sessions and the weight has not moved. Swapping the movement for four weeks usually breaks that stall faster than grinding the same one.')
  })
  if (second) changes.push({
    id: 'd2', type: 'sets', target: { routineId: routine.id, exId: second.id },
    before: second.sets ?? 3, after: Math.max(1, (second.sets ?? 3) - 1),
    why: t('Sessions have been running about fifteen minutes over. This is the accessory with the least to lose from one set fewer.')
  })
  if (other) changes.push({
    id: 'd3', type: 'week', target: { weekday: 6 }, before: null, after: other.id,
    why: t('You have moved this session to Saturday three weeks running. Better the plan says so than that you keep overriding it.')
  })

  return {
    id: 'demo-review', kind: 'review', createdAt: Date.now(), expiresAt: Date.now() + 864e5,
    planHash: planHash(S), iteration: 1,
    summary: t('Three things worth changing, and one worth knowing about. Everything else is working: the squat and the pulls are both progressing on schedule.'),
    evidence: { from: sessions[0]?.d || iso(new Date(Date.now() - 28 * 864e5)), to: sessions.at(-1)?.d || iso(new Date()), sessions: sessions.length || 9 },
    changes,
    notes: [t('Body weight has been flat for four weeks while the goal is to gain. That’s a kitchen problem, not a training one. The plan isn’t what’s holding it back.')]
  }
}

/** A small, honest starter plan for the demo's creation flow. */
function buildPlan(S, intake) {
  const pick = (bp, eq) => EXDB.find(e => e.bp === bp && (!eq || e.eq === eq)) || EXDB.find(e => e.bp === bp)
  const days = intake?.preferredDays?.length ? intake.preferredDays.slice(0, 3) : [1, 3, 5]
  const eq = (intake?.equipment || [])[0] || null
  const mk = (id, name, sets, reps, why) => ({ id, sets, reps, mode: 'reps', why })
  const routines = [
    {
      id: 'dr1', name: t('Full body A'), emoji: '💪', prog: 'linear',
      why: t('The two big lower-body and pressing patterns first, while you are fresh.'),
      ex: [
        mk(pick('upper legs', eq)?.id, null, 3, 8, t('The main lower-body driver, where most of the strength comes from.')),
        mk(pick('chest', eq)?.id, null, 3, 10, t('Horizontal pressing, the other half of the session.')),
        mk(pick('back', eq)?.id, null, 3, 10, t('A pull for every press, so the shoulders stay balanced.'))
      ].filter(e => e.id)
    },
    {
      id: 'dr2', name: t('Full body B'), emoji: '🏋️', prog: 'linear',
      why: t('The same patterns, different variations: enough overlap to progress, enough difference to stay fresh.'),
      ex: [
        mk(pick('upper legs', eq)?.id, null, 3, 10, t('Same pattern, higher reps than day A.')),
        mk(pick('shoulders', eq)?.id, null, 3, 10, t('Vertical pressing.')),
        mk(pick('upper arms', eq)?.id, null, 3, 12, t('Direct arm work, since you asked for it.'))
      ].filter(e => e.id)
    }
  ]
  const week = {}
  days.forEach((d, i) => { week[d] = routines[i % routines.length].id })
  return {
    id: 'demo-plan', kind: 'create', createdAt: Date.now(), expiresAt: Date.now() + 864e5, iteration: 1,
    planHash: planHash(S),
    summary: t('A two-day rotation across three sessions a week, built around the equipment you listed. Compounds first, one pull for every press, and enough overlap between the days that nothing goes two weeks without being trained.'),
    bundle: {
      opengym_plan: 1, name: t('Coach plan'),
      summary: t('A two-day rotation across three sessions a week, built around the equipment you listed. Compounds first, one pull for every press, and enough overlap between the days that nothing goes two weeks without being trained.'),
      basedOn: (S.workouts || []).length ? t('Based on the training already in this demo profile.') : t('No training history yet, so starting conservatively.'),
      week, routines, customEx: []
    }
  }
}

/** One session, read back with its own numbers — no plan changes, just what a coach would say after. */
function buildDebrief(S, workoutId) {
  const all = (S.workouts || []).filter(w => w && w.d)
  const w = all.find(x => x.id === workoutId) || all[all.length - 1]
  if (!w) return null
  // workoutVolume() reads `w.entries` and `e.sets` without a guard; every other line here
  // tolerates both being absent. A workout carrying a date and nothing else therefore threw
  // inside the timer below, where at the time nothing caught it — the job stayed 'running'
  // for ever and every later request answered 409.
  const entries = (w.entries || []).map(en => ({ ...en, sets: en.sets || [] }))
  const done = entries.reduce((n, en) => n + en.sets.filter(s => s.done && !isWarmupRow(s)).length, 0)
  const planned = entries.reduce((n, en) => n + en.sets.filter(s => !isWarmupRow(s)).length, 0)
  const vol = Math.round(Number.isFinite(w.vol) ? w.vol : workoutVolume({ ...w, entries }))
  const prs = (w.prs || []).length
  const minutes = w.end && w.start ? Math.round((w.end - w.start) / 60000) : null
  const complete = planned > 0 && done >= planned
  const score = complete ? (prs ? 9 : 8) : 7
  const highlights = [
    complete ? t('Every planned set done: {0} of {1}.', done, planned) : t('{0} of {1} planned sets done.', done, planned),
    t('{0} {1} moved in total.', fmtNum(vol), S.unit)
  ]
  if (prs) highlights.push(t('{0} new personal records.', prs))
  const watch = minutes && minutes > 80 ? [t('{0} minutes is long. Rest periods may be creeping up.', minutes)] : [t('Top sets logged without an effort rating; add RIR so the next review can read how hard they were.')]
  const nextTime = [complete ? t('Add the next load step on the main lift.') : t('Repeat the same loads and get every set.'), t('Keep the session under an hour and a quarter.')]
  return {
    id: 'demo-debrief', kind: 'debrief', createdAt: Date.now(), expiresAt: Date.now() + 864e5,
    planHash: planHash(S), iteration: 1,
    workout: { id: w.id, d: w.d, name: w.name || null, minutes, vol, sets: done, prs },
    summary: complete
      ? t('A clean session: everything on the sheet got done and the loads held. This is exactly what progress looks like from the inside: unremarkable, repeated.')
      : t('Most of the work got done. One or two sets fell short, which is fine once. It only becomes a signal if the same sets miss next time.'),
    score, highlights, watch, nextTime
  }
}

/** What "the room" would say on a busy instance — five people, plausible medians, your real bests. */
export function demoCohort(S) {
  const since = Date.now() - 56 * 864e5
  const you = Math.round((S.workouts || []).filter(w => workoutAt(w) > since).length / 8 * 10) / 10
  const ids = [...new Set((S.routines || []).flatMap(r => (r.ex || []).map(e => e.id)))].slice(0, 5)
  const exercises = ids.map(id => {
    const b = best1RM(S, id)
    const mine = b ? Math.round(b.est * 10) / 10 : null
    return { id, name: EXIDX[id]?.n || id, people: 4, median: mine ? Math.round(mine * 0.92) : 60, you: mine }
  })
  return { ok: true, enabled: true, sharing: true, people: 5, minPeople: 3, unit: S.unit, sessionsPerWeek: { median: 3, you }, exercises, rankPct: 62 }
}

/* ---------------- a chat turn ---------------- */

const DIARY_DAYS = 7
const iso0 = n => iso(new Date(Date.now() - n * 864e5))
const has = (msg, re, ...chips) => re.test(String(msg || '').toLowerCase()) || chips.includes(String(msg || '').trim())

/** The food diary of the last week as the server's tool reads it; a plausible one when the demo profile has none. */
function diaryDays(S) {
  const log = S.foodLog || []
  const days = []
  for (let i = DIARY_DAYS - 1; i >= 0; i--) {
    const d = iso0(i)
    const tot = dayTotals(log, d)
    if (tot.meals) days.push({ d, kcal: tot.kcal, protein: tot.protein, carbs: tot.carbs, fat: tot.fat })
  }
  if (days.length) return days
  const kcal = [2310, 2480, 2150, 2620, 2390, 2700, 2240]
  const protein = [118, 132, 104, 141, 126, 110, 121]
  return kcal.map((k, i) => ({ d: iso0(DIARY_DAYS - 1 - i), kcal: k, protein: protein[i], carbs: Math.round(k * 0.48 / 4), fat: Math.round(k * 0.27 / 9) }))
}

/** The targets the diary is read against: the profile's own when it has them, else a plausible set. */
function diaryTargets(S) {
  let tg = null
  try { tg = profileTargets(S).targets } catch { tg = null }
  return tg && tg.kcal > 0
    ? { kcal: tg.kcal, protein: tg.protein, carbs: tg.carbs, fat: tg.fat }
    : { kcal: 2500, protein: 150, carbs: 290, fat: 80 }
}

function chatNutrition(S) {
  const days = diaryDays(S)
  const targets = diaryTargets(S)
  const avg = Math.round(days.reduce((n, d) => n + d.protein, 0) / days.length)
  const after = { kcal: targets.kcal, protein: Math.round(targets.protein + 20), carbs: Math.max(0, Math.round(targets.carbs - 20)), fat: targets.fat }
  return {
    steps: ['Checking your food diary', 'Checking your body metrics', 'Checking a proposal', 'Writing a reply'],
    reply: t('Calories are close to target, but protein is short: **{0} g a day** on average against **{1} g**.\n\nThe easy fixes:\n- a protein source at breakfast\n- a shake or skyr after training\n\nIf you want the target itself to say so, I have put a new one below.', avg, targets.protein),
    cards: [
      { id: 'n1', type: 'nutrition', summary: t('Your last {0} days against your targets.', days.length), days, targets },
      { id: 'c1', type: 'changes', title: t('Update your calorie and macro targets'), changes: [
        { id: 'nt', type: 'nutrition-targets', target: {}, before: targets, after, why: t('More protein for the same calories, taken from carbohydrate, so the scale is not affected.') }
      ] }
    ]
  }
}

function chatRoutine(S) {
  const prof = S.coach?.profile || {}
  const plan = buildPlan(S, { equipment: prof.equipment || [], preferredDays: [1, 3, 5] })
  return {
    steps: ['Looking at your routine', 'Searching the exercise library', 'Checking a proposal', 'Writing a reply'],
    reply: t('Here is a **3-day full-body** setup: two sessions that alternate across Monday, Wednesday and Friday. Compounds first, one pull for every press.\n\nCreate it and your current routines stay as they are.'),
    cards: [{ id: 'r1', type: 'routines', title: t('Create a 3-day full-body plan'), summary: plan.summary, bundle: plan.bundle }]
  }
}

function chatSwap(S) {
  const routine = reviewable(S)
  if (!routine) return chatRoutine(S)
  const first = routine.ex[0]
  const bp = EXIDX[first.id]?.bp
  const picks = EXDB.filter(e => e.bp === bp && e.id !== first.id && !(routine.ex || []).some(x => x.id === e.id)).slice(0, 4)
  if (!picks.length) return chatDefault(S)
  return {
    steps: ['Looking at your routine', 'Checking your exercise progress', 'Searching the exercise library', 'Checking a proposal', 'Writing a reply'],
    reply: t('**{0}** has stalled for three sessions. A different movement for the same muscles usually gets things moving again. A few options are below; I would start with the first one.', exTitle(first.id)),
    cards: [
      { id: 'e1', type: 'exercises', ids: picks.map(e => e.id), note: t('Same muscles, different movement.') },
      { id: 'c1', type: 'changes', title: t('Replace {0} in {1}', exTitle(first.id), routine.name), changes: [
        { id: 's1', type: 'swap-exercise', target: { routineId: routine.id, exId: first.id }, before: EXIDX[first.id]?.n || first.id, after: { id: picks[0].id, name: picks[0].n },
          why: t('Same muscles, different movement. Sets and reps stay as they are.') }
      ] }
    ]
  }
}

function chatReview(S) {
  const review = buildReview(S)
  if (!review) return chatRoutine(S)
  const routine = reviewable(S)
  const extra = (routine.ex || []).length > 2 ? routine.ex[routine.ex.length - 1] : null
  const changes = [...review.changes]
  // A removal, so the demo shows how a change that takes something away is drawn.
  if (extra && !changes.some(c => c.target?.exId === extra.id)) changes.push({
    id: 'd4', type: 'remove-exercise', target: { routineId: routine.id, exId: extra.id }, before: null, after: null,
    why: t('It overlaps with the work before it and sessions are running long.')
  })
  return {
    steps: ['Reading your workout history', 'Checking your exercise progress', 'Checking a proposal', 'Writing a reply'],
    reply: t('Your last week, in short:\n- the squat and the pulls are moving\n- one press has stalled\n- sessions are running about fifteen minutes long\n\nThese are the changes I would make. Untick any you want to keep as they are.'),
    cards: [{ id: 'c1', type: 'changes', summary: review.summary, changes }]
  }
}

function chatAdd(S, message) {
  const routine = (S.routines || [])[0]
  if (!routine) return chatRoutine(S)
  const msg = String(message || '').toLowerCase()
  const named = EXDB.find(e => e.n && e.n.length > 4 && msg.includes(e.n.toLowerCase()) && !(routine.ex || []).some(x => x.id === e.id))
  const pick = named || EXDB.find(e => e.bp === 'back' && !(routine.ex || []).some(x => x.id === e.id))
  return {
    steps: ['Looking at your routine', 'Checking a proposal', 'Writing a reply'],
    reply: t('It fits best at the end of **{0}**, for three sets of ten.', routine.name),
    cards: [{ id: 'c1', type: 'changes', title: t('Add {0} to {1}', exTitle(pick.id), routine.name), changes: [
      { id: 'a1', type: 'add-exercise', target: { routineId: routine.id }, before: null, after: { id: pick.id, sets: 3, reps: 10, mode: 'reps' }, why: t('Three sets of ten at the end of the session.') }
    ] }]
  }
}

function chatDefault(S) {
  const ids = [...new Set((S.routines || []).flatMap(r => (r.ex || []).map(e => e.id)))].filter(id => EXIDX[id]).slice(0, 4)
  return {
    steps: ['Reading your workout history', 'Writing a reply'],
    reply: t('This is the demo, so I answer a few kinds of question:\n- **review** my last week\n- **build** me a routine\n- **swap** an exercise\n- how is my **protein**\n\nOn a real instance you can ask me anything about your training or your food.'),
    cards: ids.length ? [{ id: 'e1', type: 'exercises', ids, note: t('What your plan is built on right now.') }] : []
  }
}

/** A canned chat answer, picked by what was asked. Between them the answers show every card type. */
function buildChat(S, message) {
  if (has(message, /protein|calor|kcal|macro|food|eat|diet|nutrition|target/, t('How is my protein?'), t('Suggest new calorie and macro targets for me.'))) return chatNutrition(S)
  if (has(message, /^add |\badd\b/)) return chatAdd(S, message)
  if (has(message, /swap|replace|instead|alternative/, t('Swap an exercise'))) return chatSwap(S)
  if (has(message, /routine|plan|program|split|build/, t('Build me a 3-day routine'))) return chatRoutine(S)
  if (has(message, /review|week|progress|change/, t('Review my last week'))) return chatReview(S)
  return chatDefault(S)
}

/* ---------------- the API surface the demo stands in for ---------------- */

export const demoStatus = () => {
  // A chat job says what it is doing, the way the server's tool loop does: one step after another
  // across the wait, the last one held.
  if (job?.steps) job.step = job.steps[Math.min(job.steps.length - 1, Math.floor((Date.now() - job.startedAt) / (DELAY / job.steps.length)))]
  return { job, pending, cap: { used: 0, limit: 0 }, lastError, last }
}

function start(kind, make, steps) {
  if (job) throw Object.assign(new Error(t('The Coach is already thinking about your training.')), { status: 409 })
  job = { id: kind === 'chat' ? 'demo-chat-' + (++chats) : 'demo-' + kind, kind, state: 'running', startedAt: Date.now(), ...(steps ? { steps, step: steps[0] } : {}) }
  lastError = null
  clearTimeout(timer)
  // A builder that throws still has to end the job: left uncaught, one throw kept `job` at
  // 'running' for ever and every later request answered 409 until the page was reloaded. The
  // failure is recorded the way the server and the phone record theirs, so the chat's
  // job-ended effect writes the same error line it would for them. `nostate` because the only
  // thing a builder can trip over is the shape of the profile's own data.
  timer = setTimeout(() => {
    try { pending = make(pending) }
    catch (e) { lastError = { errorClass: 'nostate', detail: String(e && e.message || e) } }
    finally { job = null }
  }, DELAY)
  return { job }
}

/**
 * The chat job, as the server finishes one: the reply and its informational cards become the
 * last outcome; proposing cards become the pending proposal. A reply without one leaves an older
 * proposal where it is, and the chat draws that one as outdated.
 */
export const demoChat = (S, message) => {
  // Built up front, for the steps; a throw is handed to the timer so it ends the job like any other.
  let answer = null, failed = null
  try { answer = buildChat(S, message) } catch (e) { failed = e }
  const { job: started } = start('chat', prev => {
    if (failed) throw failed
    const at = Date.now()
    const info = answer.cards.filter(c => INFO_CARDS.includes(c.type))
    const acts = answer.cards.filter(c => !INFO_CARDS.includes(c.type))
    last = { outcome: 'chat', jobId: started.id, at, reply: answer.reply, cards: info }
    return acts.length ? { kind: 'chat', jobId: started.id, createdAt: at, planHash: planHash(S), reply: answer.reply, cards: acts } : prev
  }, answer ? answer.steps : ['Writing a reply'])
  return { job: started }
}
export const demoReview = S => {
  // Refused before the job starts, the way demoDebrief refuses with no workout: without a
  // two-exercise routine buildReview has nothing to aim at, and a job that runs the whole wait
  // and ends with neither a proposal nor an error reads as the Coach ignoring you.
  if (!reviewable(S)) throw Object.assign(new Error(t('There’s no routine to review yet. Build one with at least two exercises first.')), { status: 409, code: 'noroutine' })
  return start('review', () => buildReview(S))
}
export const demoPlan = (S, intake) => start('create', () => buildPlan(S, intake))
// A refine re-reads the saved answers, as the server's payload does when a refine carries no
// intake of its own (`opts.intake || coach.profile`). Built from nothing, every revised plan
// went back to Mon/Wed/Fri whatever days were chosen at intake.
export const demoRefine = S => start('create', () => {
  const p = buildPlan(S, S.coach?.profile || null)
  return { ...p, iteration: (pending?.iteration || 1) + 1, summary: t('Revised as you asked. Everything you did not question is exactly as it was.') + ' ' + p.summary }
})
export const demoDebrief = (S, workoutId) => {
  if (!(S.workouts || []).some(w => w && w.d)) throw Object.assign(new Error(t('There’s no workout to look at yet. Log one first.')), { status: 409, code: 'noworkout' })
  return start('debrief', () => buildDebrief(S, workoutId))
}
export const demoResolve = () => { pending = null; return { ok: true } }
export const demoDisclosure = () => ({
  provider: 'demo', providerLabel: t('the configured AI provider'),
  categories: [...DATA_CATEGORIES], version: 1
})
