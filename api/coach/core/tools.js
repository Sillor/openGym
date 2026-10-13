/* What the Coach chat can look at, and what it can propose.
 *
 * Pure functions over the synced state, like the payload builder beside them, so the server
 * and the phone's own-key mode answer a tool call with the same bytes. Nothing here touches a
 * file or the environment; the one clock reading is the `today` the caller hands in.
 *
 * Two kinds of tool, and the line between them is the point of the module:
 *
 *   read      returns data, bounded field by field the way payload.js bounds a payload. Each
 *             one names the consent category it reads (categories.js) and answers "not shared"
 *             without looking when that category is not consented.
 *   card      changes nothing. It runs what the model proposed through the same validators a
 *             plan or a review answer goes through — validateReview, validatePlan — and on
 *             success returns a card the person confirms or declines. On failure the
 *             validator's errors go back to the model as the tool result, so it can fix the
 *             proposal inside the loop rather than burn the job.
 *
 * The validators stay the security boundary. A tool that let a proposal past them would be a
 * second, weaker gate, so there is no such tool.
 */
import { DATA_CATEGORIES } from './categories.js';
import { LIBRARY, LIB_BY_ID, libraryHas, equipmentAllows } from './library.js';
import {
  cleanPlan, cleanProfile, cleanWorkout, compactWorkout, readSession, stallCount, weighIns,
  activeEquipment, trainedIds, isWarmupSet, FULL_DETAIL_SESSIONS, ID_MAX, NAME_MAX
} from './payload.js';
import { nutritionSummary } from './nutrition.js';
import { validatePlan, validateReview } from './validate.js';
import { REVIEW_SCHEMA, CREATE_SCHEMA } from './schemas.js';

/* ---------- small readers for what the model sends ---------- */
const list = v => (Array.isArray(v) ? v : []);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const int = (v, lo, hi, def) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,6}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};
const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function shiftDay(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
const dayNumber = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
const daysBetween = (a, b) => Math.round(dayNumber(b) - dayNumber(a));

/* ---------- consent ----------
   Consent is one agreement today, so every category is on once it is given. A consent record
   that lists categories narrows it, so the day the screen offers per-category choices the
   tools already honour them. */
export function consentedCategories(S) {
  const listed = S?.coach?.consent?.categories;
  return Array.isArray(listed) ? DATA_CATEGORIES.filter(c => listed.includes(c)) : [...DATA_CATEGORIES];
}

/* ---------- what one job's tools share ---------- */

/** Best working weight per exercise: the cap validatePlan holds a new routine's loads to. */
function workingWeights(S) {
  const best = {};
  list(S.workouts).forEach(w => list(w?.entries).forEach(en => list(en?.sets).forEach(s => {
    if (s && s.done && s.w > 0 && !isWarmupSet(s)) best[en.id] = Math.max(best[en.id] || 0, s.w);
  })));
  return Object.entries(best).map(([id, best]) => ({ id, best }));
}

/**
 * Everything the tools of one chat job read from, built once. `offered` starts as what the
 * person trains and grows with every search result, because validate.js lets an exercise past
 * the equipment check when the model was shown it — and in a chat, being shown it is a search.
 */
export function toolContext(S, { today, categories } = {}) {
  const st = S || {};
  const profile = isObj(st.coach?.profile) ? cleanProfile(st.coach.profile) : null;
  const equipment = profile?.equipment?.length ? profile.equipment : cleanProfile({ equipment: activeEquipment(st) }).equipment;
  return {
    S: st,
    today: day(today) || new Date().toISOString().slice(0, 10),
    categories: new Set(categories || consentedCategories(st)),
    plan: cleanPlan(st),
    profile,
    equipment,
    customIds: list(st.customEx).filter(c => c && typeof c.id === 'string' && c.id).map(c => c.id.slice(0, ID_MAX)),
    offered: new Set(trainedIds(st, list(st.workouts))),
    workingWeights: workingWeights(st)
  };
}

/* ---------- read tools ---------- */

// Mirrors frontend/src/lib/onerm.js: Epley, and no estimate above REP_CAP reps.
const REP_CAP = 12;
const e1rm = s => (s.w > 0 && s.r > 0 && s.r <= REP_CAP ? Math.round(s.w * (1 + s.r / 30) * 10) / 10 : null);
const workSets = en => list(en?.sets).filter(s => s && typeof s === 'object' && !isWarmupSet(s));
const fmtTop = s => (s.sec != null ? s.sec + 's' : (s.w != null ? s.w + 'x' : '') + (s.r != null ? s.r : '?'))
  + (s.rir != null ? '@RIR' + s.rir : s.rpe != null ? '@RPE' + s.rpe : '');

function getWorkoutHistory(ctx, args) {
  const days = int(args.days, 1, 84, 14);
  const limit = int(args.limit, 1, 20, 8);
  const exId = str(args.exerciseId, ID_MAX);
  const from = shiftDay(ctx.today, -(days - 1));
  let all = list(ctx.S.workouts).filter(w => w && day(w.d) && day(w.d) >= from);
  if (exId) {
    all = all.filter(w => list(w.entries).some(en => en && en.id === exId))
      .map(w => ({ ...w, entries: list(w.entries).filter(en => en && en.id === exId) }));
  }
  const shown = all.slice(-limit);
  const detailFrom = Math.max(0, shown.length - FULL_DETAIL_SESSIONS);
  return {
    from, to: ctx.today,
    sessionsInRange: all.length,
    sessionsEver: list(ctx.S.workouts).length,
    workouts: shown.map((w, i) => (i >= detailFrom ? cleanWorkout(w) : compactWorkout(w)))
  };
}

function getExerciseProgress(ctx, args) {
  const id = str(args.exerciseId, ID_MAX);
  if (!id) return fail(['exerciseId is required — an id from the plan, the history or search_exercises']);
  const n = int(args.sessions, 1, 30, 12);
  const planCfg = list(ctx.S.routines).flatMap(r => list(r?.ex)).find(e => e && e.id === id);
  const rows = [];
  list(ctx.S.workouts).forEach(w => list(w?.entries).forEach(en => {
    if (!en || en.id !== id || !workSets(en).some(s => s.done)) return;
    const done = workSets(en).filter(s => s.done);
    let top = null;
    done.forEach(s => { if (!top || (s.w || 0) * (s.r || 0) + (s.sec || 0) > (top.w || 0) * (top.r || 0) + (top.sec || 0)) top = s; });
    const est = done.map(e1rm).filter(v => v != null);
    rows.push({
      d: day(w.d), sets: done.length,
      top: top ? fmtTop(top) : null,
      bestLoad: Math.max(0, ...done.map(s => (finite(s.w) || 0))) || null,
      e1rm: est.length ? Math.max(...est) : null,
      volume: Math.round(done.reduce((v, s) => v + (finite(s.w) || 0) * (finite(s.r) || 0), 0)),
      hit: readSession(en, planCfg).ok
    });
  }));
  if (!rows.length) return { id, name: LIB_BY_ID.get(id)?.n || null, sessionsLogged: 0, note: 'never logged' };
  const recent = rows.slice(-n);
  const est = recent.map(r => r.e1rm).filter(v => v != null);
  return {
    id, name: LIB_BY_ID.get(id)?.n || null, unit: ctx.S.unit === 'lb' ? 'lb' : 'kg',
    sessionsLogged: rows.length,
    bestLoad: Math.max(0, ...rows.map(r => r.bestLoad || 0)) || null,
    bestE1rm: Math.max(0, ...rows.map(r => r.e1rm || 0)) || null,
    e1rmTrend: est.length >= 2 ? { first: est[0], last: est[est.length - 1] } : null,
    stalls: stallCount(rows.map(r => ({ ok: r.hit }))),
    sessions: recent
  };
}

// The taxonomy the catalogue actually uses, so the model filters with words that match.
const BODY_PARTS = [...new Set(LIBRARY.map(e => e.bp).filter(Boolean))].sort();
const EQUIPMENT = [...new Set(LIBRARY.map(e => e.eq).filter(Boolean))].sort();

function searchExercises(ctx, args) {
  const query = (str(args.query, 80) || '').toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  const bp = (str(args.bodyPart, 40) || '').toLowerCase();
  const eq = (str(args.equipment, 40) || '').toLowerCase();
  const tg = (str(args.target, 40) || '').toLowerCase();
  const limit = int(args.limit, 1, 25, 10);
  // Their own exercises are plan data; the catalogue is nobody's.
  const customs = ctx.categories.has('plan')
    ? list(ctx.S.customEx).filter(c => c && typeof c.id === 'string' && c.id)
      .map(c => ({ id: c.id.slice(0, ID_MAX), n: typeof c.n === 'string' ? c.n.slice(0, NAME_MAX) : '', bp: typeof c.bp === 'string' ? c.bp.slice(0, 40) : '', tg: '', eq: 'custom', custom: true }))
    : [];
  // Without an explicit equipment filter the search keeps to what they own, as the plan slice does.
  const byEquipment = !eq && ctx.equipment.length > 0;
  const hits = [...customs, ...LIBRARY].filter(e => {
    const hay = `${e.n} ${e.bp} ${e.tg} ${e.eq}`.toLowerCase();
    if (tokens.length && !tokens.every(t => hay.includes(t))) return false;
    if (bp && (e.bp || '').toLowerCase() !== bp) return false;
    if (tg && (e.tg || '').toLowerCase() !== tg) return false;
    if (eq && (e.eq || '').toLowerCase() !== eq) return false;
    if (byEquipment && !e.custom && !equipmentAllows(ctx.equipment, e.id)) return false;
    return true;
  });
  // A name that holds the whole phrase beats one that merely holds its words; otherwise the
  // catalogue's own order, which puts the well-known lifts first.
  const ranked = query ? hits.map((e, i) => [e.n.toLowerCase().includes(query) ? 0 : 1, i, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(x => x[2]) : hits;
  const results = ranked.slice(0, limit).map(e => ({
    id: e.id, name: e.n, bodyPart: e.bp || null, target: e.tg || null, equipment: e.eq || null, ...(e.custom ? { custom: true } : {})
  }));
  results.forEach(e => ctx.offered.add(e.id));
  return { matches: hits.length, results, ...(byEquipment ? { filteredToTheirEquipment: ctx.equipment } : {}) };
}

const DIARY_DAYS_MAX = 14;
const DIARY_MEALS_MAX = 150;
function diaryRange(ctx, args) {
  let to = day(args.to) || ctx.today;
  let from = day(args.from) || shiftDay(to, -6);
  if (from > to) [from, to] = [to, from];
  if (daysBetween(from, to) >= DIARY_DAYS_MAX) from = shiftDay(to, -(DIARY_DAYS_MAX - 1));
  return { from, to };
}
const macros = t => (t ? { kcal: finite(t.kcal), protein: finite(t.protein), carbs: finite(t.carbs), fat: finite(t.fat) } : null);

function getFoodDiary(ctx, args) {
  const { from, to } = diaryRange(ctx, args);
  const sum = nutritionSummary(ctx.S, from, to, ctx.today);
  const r1 = n => Math.round((Number(n) || 0) * 10) / 10;
  const meals = list(ctx.S.foodLog)
    .filter(e => e && typeof e === 'object' && day(e.d) && day(e.d) >= from && day(e.d) <= to)
    .sort((a, b) => day(a.d).localeCompare(day(b.d)) || (Number(a.t) || 0) - (Number(b.t) || 0))
    // Name, meal and the four numbers. Photos, vision prompts, gram bases and notes never leave.
    .map(e => ({
      d: day(e.d), meal: ['breakfast', 'lunch', 'dinner', 'snack'].includes(e.meal) ? e.meal : 'snack',
      name: typeof e.name === 'string' ? e.name.trim().slice(0, 80) : '',
      kcal: Math.round(Math.max(0, Number(e.kcal) || 0)), protein: r1(e.protein), carbs: r1(e.carbs), fat: r1(e.fat)
    }));
  return {
    from, to,
    targets: sum.targets ? { ...macros(sum.targets), source: sum.targets.source } : null,
    days: sum.days,
    meals: meals.slice(-DIARY_MEALS_MAX),
    ...(meals.length > DIARY_MEALS_MAX ? { mealsOmitted: meals.length - DIARY_MEALS_MAX } : {}),
    ...(sum.energy ? { energy: sum.energy } : {}),
    likes: sum.likes, dislikes: sum.dislikes, wontEat: sum.wontEat, note: sum.note
  };
}

function getBodyMetrics(ctx, args) {
  const days = int(args.days, 7, 365, 90);
  const series = weighIns(ctx.S, shiftDay(ctx.today, -(days - 1)), null).slice(-120);
  const bf = list(ctx.S.measurements).filter(m => m && day(m.d) && finite(m.bodyFat) > 0 && m.bodyFat <= 100)
    .sort((a, b) => day(a.d).localeCompare(day(b.d))).at(-1);
  return {
    unit: ctx.S.unit === 'lb' ? 'lb' : 'kg',
    goal: finite(Number(ctx.S.targetW)) || null,
    latest: series.at(-1) || null,
    series,
    ...(bf ? { bodyFat: { d: day(bf.d), pct: bf.bodyFat } } : {})
  };
}

function getRoutine(ctx, args) {
  const rid = str(args.routineId, ID_MAX);
  const daysOf = id => Object.entries(ctx.plan.week).filter(([, ids]) => ids.includes(id)).map(([d]) => +d);
  if (!rid) return { routines: ctx.plan.routines.map(r => ({ ...r, weekdays: daysOf(r.id) })), week: ctx.plan.week };
  const r = ctx.plan.routines.find(x => x.id === rid);
  if (!r) return fail([`routineId "${rid}" is not in the plan — its routines are: ${ctx.plan.routines.map(x => `"${x.id}" (${x.name})`).join(', ') || '(none)'}`]);
  return { routine: { ...r, weekdays: daysOf(r.id) } };
}

/* ---------- card tools ---------- */

const TITLE_MAX = 80;
const SUMMARY_MAX = 600;

function proposeChanges(ctx, args) {
  if (!Array.isArray(args.changes) || !args.changes.length) return fail(['changes must be a non-empty array of change objects']);
  if (!ctx.categories.has('nutrition') && args.changes.some(c => c && c.type === 'nutrition-targets')) {
    return fail(['nutrition-targets is not available: this person has not shared their nutrition data with the Coach']);
  }
  const v = validateReview({ summary: args.summary, changes: args.changes }, ctx.plan,
    { customIds: ctx.customIds, equipment: ctx.equipment, offered: ctx.offered });
  if (!v.ok) return fail(v.errors);
  if (v.nochange) return fail(['every change restates the plan as it already is — nothing would change']);
  const summary = str(args.summary, SUMMARY_MAX);
  return card({ type: 'changes', title: str(args.title, TITLE_MAX) || 'Plan changes', ...(summary ? { summary } : {}), changes: v.proposal.changes });
}

function proposeRoutines(ctx, args) {
  if (!Array.isArray(args.routines) || !args.routines.length) return fail(['routines must be a non-empty array of routines']);
  const title = str(args.title, TITLE_MAX) || 'New routines';
  const v = validatePlan({
    name: title, summary: args.summary, basedOn: args.basedOn,
    routines: args.routines, week: isObj(args.week) ? args.week : {}, customEx: args.customEx
  }, { customIds: ctx.customIds, equipment: ctx.equipment, offered: ctx.offered, workingWeights: ctx.workingWeights });
  if (!v.ok) return fail(v.errors);
  const summary = str(args.summary, SUMMARY_MAX);
  return card({ type: 'routines', title, ...(summary ? { summary } : {}), bundle: v.bundle });
}

function proposeNutritionTargets(ctx, args) {
  const change = { id: 'n1', type: 'nutrition-targets', target: {}, after: { kcal: args.kcal, protein: args.protein, carbs: args.carbs, fat: args.fat }, why: args.why };
  const v = validateReview({ changes: [change] }, ctx.plan, {});
  if (!v.ok) return fail(v.errors);
  const summary = str(args.summary, SUMMARY_MAX);
  return card({ type: 'changes', title: str(args.title, TITLE_MAX) || 'Update nutrition targets', ...(summary ? { summary } : {}), changes: v.proposal.changes });
}

const SHOW_MAX = 8;
function showExercises(ctx, args) {
  const ids = [...new Set(list(args.ids).filter(x => typeof x === 'string' && x))];
  if (!ids.length || ids.length > SHOW_MAX) return fail([`ids must list 1-${SHOW_MAX} exercise ids`]);
  const unknown = ids.filter(id => !libraryHas(id) && !ctx.customIds.includes(id));
  if (unknown.length) return fail(unknown.map(id => `"${id}" is not in the exercise library — use an id from search_exercises`));
  const note = str(args.note, 300);
  return card({ type: 'exercises', ids, ...(note ? { note } : {}) });
}

function showNutrition(ctx, args) {
  const summary = str(args.summary, SUMMARY_MAX);
  if (!summary) return fail(['summary is required — one or two sentences on what the numbers say']);
  const { from, to } = diaryRange(ctx, args);
  const sum = nutritionSummary(ctx.S, from, to, ctx.today);
  // The numbers come from the diary, never from the model: the card shows what was logged.
  return card({
    type: 'nutrition', summary,
    days: sum.days.slice(-DIARY_DAYS_MAX).map(d => ({ d: d.d, kcal: d.kcal, protein: d.protein, carbs: d.carbs, fat: d.fat })),
    targets: macros(sum.targets)
  });
}

/* ---------- the catalogue ---------- */

const STR = { type: 'string' };
const INT = { type: 'integer' };
const DATE = { type: 'string', description: 'YYYY-MM-DD' };

/* `step` is what the chat's typing bubble says while the tool runs. A closed set of English
   strings, because the app translates them by their literal text (docs/dev/COACH_CHAT.md). */
export const STEP_WRITING = 'Writing a reply';
export const TOOLS = [
  {
    name: 'get_workout_history', kind: 'read', category: 'training', step: 'Reading your workout history', run: getWorkoutHistory,
    description: 'Logged sessions, oldest first. The most recent ones carry every set; older ones one line per exercise (done, target, top set).',
    parameters: { type: 'object', properties: { days: { type: 'integer', description: 'How far back, 1-84. Default 14.' }, limit: { type: 'integer', description: 'At most this many sessions, 1-20. Default 8.' }, exerciseId: { type: 'string', description: 'Only sessions with this exercise, and only its entries.' } } }
  },
  {
    name: 'get_exercise_progress', kind: 'read', category: 'training', step: 'Checking your exercise progress', run: getExerciseProgress,
    description: 'One exercise across every session it was logged: best load, estimated 1RM (Epley) and its trend, consecutive missed targets (stalls).',
    parameters: { type: 'object', properties: { exerciseId: STR, sessions: { type: 'integer', description: 'Recent sessions to list, 1-30. Default 12.' } }, required: ['exerciseId'] }
  },
  {
    name: 'search_exercises', kind: 'read', category: null, step: 'Searching the exercise library', run: searchExercises,
    description: 'The full exercise library plus their own custom exercises. Every exercise you name must come from here or from the plan. Without `equipment` it keeps to the equipment they have.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words that must all appear in the name, body part, target or equipment, e.g. "row", "romanian deadlift".' },
        bodyPart: { type: 'string', description: 'One of: ' + BODY_PARTS.join(', ') },
        equipment: { type: 'string', description: 'One of: ' + EQUIPMENT.join(', ') },
        target: { type: 'string', description: 'Target muscle, e.g. lats, glutes, pectorals, quads.' },
        limit: { type: 'integer', description: '1-25. Default 10.' }
      }
    }
  },
  {
    name: 'get_food_diary', kind: 'read', category: 'nutrition', step: 'Checking your food diary', run: getFoodDiary,
    description: 'Logged meals (name, meal, kcal and macros), daily totals, their targets and food preferences for a range of at most 14 days. Default: the last 7 days.',
    parameters: { type: 'object', properties: { from: DATE, to: DATE } }
  },
  {
    name: 'get_body_metrics', kind: 'read', category: 'bodyweight', step: 'Checking your body metrics', run: getBodyMetrics,
    description: 'Weigh-ins, goal weight and the latest body-fat reading.',
    parameters: { type: 'object', properties: { days: { type: 'integer', description: '7-365. Default 90.' } } }
  },
  {
    name: 'get_routine', kind: 'read', category: 'plan', step: 'Looking at your routine', run: getRoutine,
    description: 'One routine of the plan in full, with the weekdays it is scheduled on (0 = Sunday); without routineId, every routine and the week.',
    parameters: { type: 'object', properties: { routineId: STR } }
  },
  {
    name: 'propose_changes', kind: 'card', category: 'plan', step: 'Checking a proposal', run: proposeChanges,
    description: 'Propose changes to the plan they have. The change objects and types are exactly the review change-set (see the table in your instructions). Shown as a card they confirm or decline; nothing changes until they do.',
    parameters: { type: 'object', properties: { title: { type: 'string', description: 'The action, e.g. "Replace Barbell Row in Pull Day".' }, summary: STR, changes: REVIEW_SCHEMA.properties.changes }, required: ['title', 'changes'] }
  },
  {
    name: 'propose_routines', kind: 'card', category: 'plan', step: 'Checking a proposal', run: proposeRoutines,
    description: 'Propose whole new routines, added to their plan when they confirm. Same routine shape as a created plan; `week` (weekday → routine id from this proposal) is optional.',
    parameters: { type: 'object', properties: { title: STR, summary: STR, routines: CREATE_SCHEMA.properties.routines, week: { type: 'object' }, customEx: CREATE_SCHEMA.properties.customEx }, required: ['title', 'routines'] }
  },
  {
    name: 'propose_nutrition_targets', kind: 'card', category: 'nutrition', step: 'Checking a proposal', run: proposeNutritionTargets,
    description: 'Propose new daily calorie and macro targets (whole numbers). Shown as a card they confirm or decline.',
    parameters: { type: 'object', properties: { kcal: INT, protein: INT, carbs: INT, fat: INT, why: STR, title: STR, summary: STR }, required: ['kcal', 'protein', 'carbs', 'fat', 'why'] }
  },
  {
    name: 'show_exercises', kind: 'card', category: null, step: 'Searching the exercise library', run: showExercises,
    description: 'Show 1-8 exercises as cards with their pictures, e.g. options to choose from. Ids from search_exercises or the plan.',
    parameters: { type: 'object', properties: { ids: { type: 'array', items: STR }, note: STR }, required: ['ids'] }
  },
  {
    name: 'show_nutrition', kind: 'card', category: 'nutrition', step: 'Checking your food diary', run: showNutrition,
    description: 'Show their logged daily calories and macros against target for a range of at most 14 days (default the last 7) as a card. The numbers come from the diary; you write the summary.',
    parameters: { type: 'object', properties: { from: DATE, to: DATE, summary: STR }, required: ['summary'] }
  }
];
const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/** The cards that ask for a decision; the rest only inform. */
export const ACTIONABLE = new Set(['changes', 'routines']);
export const isActionable = c => !!c && ACTIONABLE.has(c.type);

/** What a provider with native tool calling is handed: name, description, JSON schema. */
export const toolDeclarations = () => TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));

/** The same list as text, for the JSON protocol. Built from static data, so it is identical
 *  for every job and the rules prefix stays cacheable. */
export function toolCatalogue() {
  return TOOLS.map(t => `### ${t.name}\n\n${t.description}\n\nargs: \`${JSON.stringify(t.parameters)}\``).join('\n\n');
}

export const stepFor = name => BY_NAME.get(name)?.step || null;

// A tool result is read back into the next prompt; past this it is the model's question that
// needs narrowing, not the prompt that needs growing.
export const TOOL_RESULT_MAX = 20000;

function fail(errors) { return { ok: false, errors }; }
function card(c) { return { ok: true, card: c }; }

/**
 * Run one tool call. Never throws. Returns { ok, result } for the model to read and, from a
 * card tool that passed its validator, `card` (without its id — the agent numbers them).
 */
export function runTool(ctx, name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, result: { ok: false, errors: [`unknown tool "${name}" — use one of: ${TOOLS.map(t => t.name).join(', ')}`] } };
  if (tool.category && !ctx.categories.has(tool.category)) {
    return { ok: false, result: { ok: false, errors: [`not available: this person has not shared their ${tool.category} data with the Coach`] } };
  }
  let out;
  try { out = tool.run(ctx, isObj(args) ? args : {}); } catch (e) { out = fail([`the tool failed: ${String(e && e.message || e).slice(0, 200)}`]); }
  if (out.ok === false) return { ok: false, result: out };
  if (tool.kind === 'card') return { ok: true, card: out.card, result: { ok: true } };
  const result = { ok: true, ...out };
  if (JSON.stringify(result).length > TOOL_RESULT_MAX) {
    return { ok: false, result: fail(['the result was too large — ask for fewer days, fewer sessions or a lower limit']) };
  }
  return { ok: true, result };
}
