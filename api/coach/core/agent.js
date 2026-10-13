/* The Coach chat: one message in, a reply and a few cards out, with tool calls in between.
 *
 * The plan/review/debrief jobs are one question and one JSON answer (pipeline.js). A chat is
 * a loop instead: the model reads what it needs through the read tools, proposes through the
 * card tools — whose validators are the same ones a review answer meets — and replies. The
 * loop lives in the core for the same reason the pipeline does: the phone's own-key mode runs
 * this exact code, and two copies of "what the model may do" would be two places to disagree.
 *
 * Two ways to speak to a provider, one loop:
 *
 *   native   an adapter with `invokeChat` (Chat Completions: OpenAI and every compatible
 *            endpoint) gets role messages, tool declarations and tool results on its own wire.
 *   JSON     everything else — Anthropic, Gemini, the CLI runtimes, the fixture — answers
 *            {"tool", "args"} or {"reply"} over plain `invoke`, the transcript re-sent each
 *            round. A compatible server that refuses tool declarations drops to this mid-job.
 *
 * Bounded everywhere: MAX_ROUNDS tool rounds, then one call that may not use a tool; a few
 * calls per round; tool results capped one by one and in total; the conversation cut to the
 * last HISTORY_ENTRIES lines. No file, no environment; the clock only through `now`.
 */
import { PROMPTS } from './prompts.js';
import { CHAT_SYSTEM_PROMPT } from './system-prompt.js';
import { extractJSON } from './parse.js';
import { transportFailure } from './pipeline.js';
import { LIB_BY_ID } from './library.js';
import { nutritionSummary } from './nutrition.js';
import {
  CONTRACT, MAX_PAYLOAD_CHARS, MAX_NOTE_CHARS, langTag, effortOf, readSession, stallCount, isWarmupSet
} from './payload.js';
import { toolContext, runTool, toolDeclarations, toolCatalogue, stepFor, isActionable, shiftDay, STEP_WRITING } from './tools.js';

export const MAX_ROUNDS = 6;
export const MAX_CALLS_PER_ROUND = 4;
export const HISTORY_ENTRIES = 20;
export const HISTORY_CHARS = 1500;
export const REPLY_MAX = 4000;
// What all tool results of one answer may add up to. A model that keeps asking for more after
// this has what it needs and is told to answer.
export const TOOL_BUDGET_CHARS = 120000;

const list = v => (Array.isArray(v) ? v : []);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/* ---------- memory ---------- */

const USER_KINDS = new Set(['text']);
const COACH_KINDS = new Set(['text', 'chat', 'nochange']);
const RECEIPTS = new Set(['applied', 'dismissed']);
const textOf = m => (typeof m.text === 'string' ? m.text.trim() : '');
const cardsLine = m => {
  const named = list(m.cards).slice(0, 4).filter(c => c && typeof c.type === 'string')
    .map(c => c.type.slice(0, 20) + (typeof c.title === 'string' && c.title ? ` "${c.title.slice(0, 60)}"` : ''));
  return named.length ? `[cards shown: ${named.join(', ')}]` : '';
};

/**
 * The conversation so far, as role turns, from the synced chat log: what the user typed, what
 * the Coach answered, and a one-line receipt for every card they applied or declined. Anything
 * older than `chatClearedAt` is gone, as the screen shows it. The message being answered now
 * is left out when the app already logged it — it travels as the turn itself.
 */
export function chatHistory(S, message) {
  const coach = S?.coach || {};
  const cleared = Number(coach.chatClearedAt) || 0;
  const said = typeof message === 'string' ? message.trim() : '';
  let kept = list(coach.chat).filter(m => m && typeof m === 'object'
    && (Number(m.t ?? m.at) || 0) >= cleared
    && ((m.role === 'user' && USER_KINDS.has(m.kind) && textOf(m))
      || (m.role === 'coach' && COACH_KINDS.has(m.kind) && (textOf(m) || cardsLine(m)))
      || RECEIPTS.has(m.kind)));
  const last = kept[kept.length - 1];
  if (last && last.role === 'user' && textOf(last) === said) kept = kept.slice(0, -1);
  const turns = [];
  for (const m of kept.slice(-HISTORY_ENTRIES)) {
    const t = RECEIPTS.has(m.kind)
      ? { role: 'user', content: `[${m.kind === 'applied' ? 'They applied your proposal' : 'They declined your proposal'}${textOf(m) ? ': ' + textOf(m).slice(0, 200) : ''}]` }
      : { role: m.role === 'user' ? 'user' : 'assistant', content: [textOf(m).slice(0, HISTORY_CHARS), m.role === 'coach' ? cardsLine(m) : ''].filter(Boolean).join('\n') };
    const prev = turns[turns.length - 1];
    if (prev && prev.role === t.role) prev.content += '\n\n' + t.content;
    else turns.push(t);
  }
  return turns;
}

/* ---------- the context every turn carries ---------- */

function trainingSummary(S, today) {
  const from = shiftDay(today, -13);
  const all = list(S.workouts).filter(w => w && day(w.d));
  const recent = all.filter(w => day(w.d) >= from);
  const hit = {};
  const sessions = recent.slice(-14).map(w => {
    let sets = 0;
    list(w.entries).forEach(en => {
      const work = list(en?.sets).filter(s => s && s.done && !isWarmupSet(s)).length;
      sets += work;
      const bp = LIB_BY_ID.get(en?.id)?.bp;
      if (bp && work) hit[bp] = (hit[bp] || 0) + work;
    });
    return { d: day(w.d), name: typeof w.name === 'string' ? w.name.slice(0, 80) : null, minutes: w.end && w.start ? Math.round((w.end - w.start) / 60000) : null, sets };
  });
  // The stall picture for what the plan trains, as the engine counts it — the one signal the
  // two-week window cannot show on its own.
  const planCfg = new Map();
  list(S.routines).forEach(r => list(r?.ex).forEach(e => { if (e && e.id != null) planCfg.set(e.id, e); }));
  const byEx = new Map();
  all.forEach(w => list(w.entries).forEach(en => {
    if (!en || !planCfg.has(en.id) || !list(en.sets).some(s => s && s.done)) return;
    if (!byEx.has(en.id)) byEx.set(en.id, []);
    byEx.get(en.id).push(readSession(en, planCfg.get(en.id)));
  }));
  const stalled = [...byEx].map(([id, ss]) => ({ id, name: LIB_BY_ID.get(id)?.n || null, stalls: stallCount(ss) })).filter(x => x.stalls >= 2);
  return {
    from, sessionsEver: all.length, lastSession: day(all.at(-1)?.d) || null,
    sessions, setsByBodyPart: hit, ...(stalled.length ? { stalled } : {})
  };
}

function nutritionToday(S, today) {
  const sum = nutritionSummary(S, today, today, today);
  const d = sum.days.find(x => x.d === today) || { kcal: 0, protein: 0, meals: 0 };
  return {
    kcal: d.kcal, protein: d.protein, meals: d.meals,
    targets: sum.targets ? { kcal: sum.targets.kcal, protein: sum.targets.protein } : null
  };
}

/** The compact picture every turn starts from, gated by the same categories as the tools. */
export function chatContext(S, ctx, { handle, lang } = {}) {
  const has = c => ctx.categories.has(c);
  const out = {
    coach_contract: CONTRACT,
    task: 'chat',
    meta: {
      ...(handle ? { profile: handle } : {}),
      lang: langTag(lang) || (typeof S.lang === 'string' && S.lang ? S.lang.slice(0, 16) : 'en'),
      today: ctx.today,
      ...(has('prefs') ? { unit: S.unit === 'lb' ? 'lb' : 'kg', effortScale: effortOf(S) } : {})
    },
    shared: [...ctx.categories]
  };
  if (has('profile')) out.coachProfile = ctx.profile;
  if (has('plan')) out.plan = ctx.plan;
  if (has('training')) out.training = trainingSummary(S, ctx.today);
  if (has('nutrition')) out.nutritionToday = nutritionToday(S, ctx.today);
  if (has('bodyweight')) {
    const w = list(S.bodyweight).filter(b => b && day(b.d) && Number(b.w) > 0).sort((a, b) => day(a.d).localeCompare(day(b.d))).at(-1);
    out.bodyweight = { latest: w ? { d: day(w.d), w: Number(w.w) } : null, goal: Number(S.targetW) > 0 ? Number(S.targetW) : null };
  }
  return out;
}

/** The unconfirmed card, compact, so a follow-up can revise it instead of describing a new one. */
function openProposalOf(pending) {
  const cards = list(pending?.cards).filter(c => c && (c.type === 'routines' || c.type === 'changes'));
  if (pending?.kind !== 'chat' || !cards.length) return null;
  return cards.map(c => c.type === 'routines'
    ? {
      type: 'routines', title: c.title || '',
      routines: list(c.bundle?.routines).map(r => ({
        id: r.id, name: r.name,
        ex: list(r.ex).map(e => ({ id: e.id, sets: e.sets, reps: e.reps || undefined, sec: e.sec || undefined }))
      }))
    }
    : { type: 'changes', title: c.title || '', changes: list(c.changes).map(ch => ({ id: ch.id, type: ch.type, target: ch.target, after: ch.after })) });
}

/* ---------- the two wire shapes ---------- */

// Static: the rules prefix of every chat job is the same bytes, so a prefix cache can hit.
const NATIVE_RULES = PROMPTS.chat;
const JSON_RULES = PROMPTS.chat + '\n\n---\n\n' + PROMPTS['chat-json'] + '\n\n## Tools\n\n' + toolCatalogue();
const FINAL_NATIVE = 'You have used every tool round this answer is allowed. Do not call another tool: reply to them now with what you have.';
const FINAL_JSON = 'You have used every tool round this answer is allowed. Do not call another tool: answer now with {"reply": "…"} and what you have.';
// A program written as prose is the failure the chat exists to prevent. Three library searches
// are enough to name the lifts; after that, and again once the reading rounds are spent, the
// only legal next step is a proposal card.
const SEARCH_CAP = 3;
const PROPOSE_GRACE = 2;
const PROPOSE_TOOLS = new Set(['propose_routines', 'propose_changes', 'propose_nutrition_targets']);
const PROPOSE_NOTE = 'Do not search again and do not write the program as text. Call propose_routines for a new program, or propose_changes to edit the plan they have, using exercise ids from the searches you already did.';
const REVISE_NOTE = 'They have not confirmed the open proposal in the context. If this message asks to change that program, call propose_routines or propose_changes with the full revised version now. If you are only explaining and the program should stay as proposed, answer again with the explanation.';

const contextBlock = context => '## Context\n\n```json\n' + JSON.stringify(context) + '\n```\n';
const messageBlock = message => '\n## Message\n\n' + message + '\n';

function nativeMessages({ context, history, message, rounds, finalNote }) {
  const msgs = history.map(t => ({ ...t }));
  const turn = contextBlock(context) + messageBlock(message);
  if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs[msgs.length - 1].content += '\n\n' + turn;
  else msgs.push({ role: 'user', content: turn });
  for (const r of rounds) {
    if (r.calls.length) {
      msgs.push({ role: 'assistant', content: r.text || '', calls: r.calls.map(c => ({ id: c.id, name: c.name, args: c.args })) });
      r.calls.forEach((c, k) => msgs.push({ role: 'tool', id: c.id, name: c.name, content: r.results[k] }));
    }
    if (r.note) {
      if (r.text) msgs.push({ role: 'assistant', content: r.text });
      msgs.push({ role: 'user', content: r.note });
    }
  }
  if (finalNote) msgs.push({ role: 'user', content: finalNote });
  return msgs;
}

function jsonPrompt({ context, history, message, rounds, finalNote }) {
  let p = contextBlock(context);
  if (history.length) p += '\n## Conversation so far\n\n' + history.map(t => (t.role === 'user' ? '**Them:** ' : '**You:** ') + t.content).join('\n\n') + '\n';
  p += messageBlock(message);
  rounds.forEach((r, i) => {
    p += `\n---\n\n## Round ${i + 1}\n\n`;
    r.calls.forEach((c, k) => {
      p += '### Your call\n\n```\n' + JSON.stringify({ tool: c.name, args: c.args }) + '\n```\n\n'
        + `### Tool result (${c.name})\n\n` + '```json\n' + r.results[k] + '\n```\n\n';
    });
    if (r.note) p += '### Your answer\n\n```\n' + String(r.text || '').slice(0, 2000) + '\n```\n\n' + r.note + '\n';
  });
  if (finalNote) p += '\n---\n\n' + finalNote + '\n';
  return p;
}

function parseArgs(a) {
  if (isObj(a)) return a;
  if (a == null || a === '') return {};
  if (typeof a === 'string') {
    try { const v = JSON.parse(a); return isObj(v) ? v : { __invalid: true }; } catch { return { __invalid: true }; }
  }
  return { __invalid: true };
}

/** One answer, read as tool calls, a final reply, or something to send back. */
function readTurn(r, native) {
  const text = String(r.text || '').trim();
  if (native && list(r.calls).length) {
    return { calls: r.calls.map(c => ({ id: c.id || null, name: String(c.name), args: parseArgs(c.args) })), text };
  }
  const parsed = extractJSON(text);
  const v = parsed.value;
  if (isObj(v) && typeof v.tool === 'string') return { calls: [{ id: null, name: v.tool, args: parseArgs(v.args) }], text: '' };
  if (isObj(v) && typeof v.reply === 'string') {
    return { final: true, reply: v.reply.trim(), cardIds: Array.isArray(v.cards) ? v.cards.filter(x => typeof x === 'string') : null };
  }
  if (isObj(v)) return { error: 'answer with {"tool": "<name>", "args": {…}} to use a tool, or {"reply": "…"} when you are done', text };
  if (!text) return { error: 'the answer was empty', text };
  // Plain prose with no JSON in it: a model that answered without the envelope still answered.
  return { final: true, reply: text, cardIds: null };
}

/* ---------- the loop ---------- */

/**
 * Answer one chat message.
 *
 * @param {object} opts  { adapter, cfg, S, message, handle?, lang?, model?, timeoutMs, budgetMs?,
 *                         invokeOpts?, onStep?(label), today?, now?, maxRounds? }
 * @returns {{ ok:true, reply:string, cards:object[], rounds:number, tools:string[] }
 *         | { ok:false, errorClass:string, detail?:string, errors?:string[] }}
 */
export async function runChat(opts) {
  const {
    adapter, cfg, S, message, handle, lang, model, timeoutMs, invokeOpts = {},
    onStep = () => {}, today, now = Date.now, maxRounds = MAX_ROUNDS,
    openProposal = null
  } = opts;
  const budgetMs = opts.budgetMs || (timeoutMs ? timeoutMs * 2 : Infinity);
  const said = typeof message === 'string' ? message.trim().slice(0, MAX_NOTE_CHARS) : '';
  if (!said) return { ok: false, errorClass: 'empty' };

  const ctx = toolContext(S || {}, { today });
  const context = chatContext(S || {}, ctx, { handle, lang });
  const open = openProposalOf(openProposal);
  if (open) context.openProposal = open;
  const history = chatHistory(S, said);
  const size = JSON.stringify(context).length + history.reduce((n, t) => n + t.content.length, 0) + said.length;
  if (size > MAX_PAYLOAD_CHARS) return { ok: false, errorClass: 'toolarge', detail: `payload of ${Math.round(size / 1000)}k characters` };

  let native = !!(adapter.nativeTools && typeof adapter.invokeChat === 'function');
  const declarations = toolDeclarations();
  const rounds = [];
  const cards = [];
  const cardOf = new Map();     // tool name → its card id: calling a card tool again replaces its card
  const used = [];
  let cardSeq = 0;
  let toolChars = 0;
  const started = now();

  const execute = (c, roundNo, i) => {
    const call = { ...c, id: c.id || `call_${roundNo}_${i + 1}` };
    const step = stepFor(call.name);
    if (step) onStep(step);
    used.push(call.name);
    let result;
    if (call.name === 'search_exercises' && used.filter(n => n === 'search_exercises').length > SEARCH_CAP) {
      result = { ok: false, errors: ['The library was already searched ' + SEARCH_CAP + ' times. ' + PROPOSE_NOTE] };
    } else if (call.args && call.args.__invalid) {
      call.args = {};
      result = { ok: false, errors: ['the arguments were not a JSON object'] };
    } else {
      const out = runTool(ctx, call.name, call.args);
      result = out.result;
      if (out.card) {
        const id = 'k' + (++cardSeq);
        const replaced = cardOf.get(call.name);
        if (replaced) {
          const at = cards.findIndex(k => k.id === replaced);
          if (at >= 0) cards.splice(at, 1);
        }
        cardOf.set(call.name, id);
        cards.push({ id, ...out.card });
        result = {
          ok: true, cardId: id, ...(replaced ? { replaces: replaced } : {}),
          shown: isActionable(out.card)
            ? 'shown to them as a card under your reply; nothing changes until they confirm it'
            : 'shown to them as a card under your reply'
        };
      }
    }
    let text = JSON.stringify(result);
    if (toolChars + text.length > TOOL_BUDGET_CHARS) text = JSON.stringify({ ok: false, errors: ['the reading budget for this answer is spent — answer with what you have'] });
    toolChars += text.length;
    return { call, text };
  };

  let reply = '';
  let cardIds = null;
  let nudged = false;
  for (let round = 0; ; round++) {
    if (invokeOpts.signal && invokeOpts.signal.aborted) return { ok: false, errorClass: 'cancelled' };
    const budgetHit = now() - started > budgetMs;
    const over = round >= maxRounds || budgetHit;
    // Only after the reading rounds are spent. Starting this early would block the searches
    // a new program needs; the search cap is what stops a sixth lookup before then.
    const needsProposal = used.includes('search_exercises') && !cards.some(c => isActionable(c));
    const grace = over && needsProposal && !budgetHit && round < maxRounds + PROPOSE_GRACE;
    const final = over && !grace;
    if (final) onStep(STEP_WRITING);
    const parts = { context, history, message: said, rounds, finalNote: grace ? PROPOSE_NOTE : (final ? (native ? FINAL_NATIVE : FINAL_JSON) : null) };
    let r;
    if (native) {
      r = await adapter.invokeChat({
        cfg, system: NATIVE_RULES, preamble: CHAT_SYSTEM_PROMPT, messages: nativeMessages(parts),
        tools: declarations, final, model: model || null, timeoutMs, ...invokeOpts
      });
      if (r.toolsUnsupported) { native = false; round--; continue; }
    } else {
      const prompt = jsonPrompt(parts);
      const split = adapter.spawns === false;
      r = await adapter.invoke({
        cfg,
        prompt: split ? prompt : JSON_RULES + '\n\n---\n\n' + prompt,
        ...(split ? { system: JSON_RULES } : {}),
        preamble: CHAT_SYSTEM_PROMPT, model: model || null, timeoutMs, ...invokeOpts
      });
    }
    const failed = transportFailure(r);
    if (failed) return failed;

    const turn = readTurn(r, native);
    if (turn.calls && grace) {
      const kept = turn.calls.filter(c => PROPOSE_TOOLS.has(c.name));
      if (!kept.length) {
        rounds.push({ text: turn.text || '', calls: [], results: [], note: PROPOSE_NOTE });
        continue;
      }
      turn.calls = kept;
    }
    if (!turn.calls && turn.final && grace) {
      rounds.push({ text: String(turn.reply || '').slice(0, 400), calls: [], results: [], note: PROPOSE_NOTE });
      continue;
    }
    // A follow-up that only explains would otherwise drop the card they have not confirmed.
    // One nudge asks for a revised proposal; a second prose answer is the explanation, and
    // the caller keeps the open card.
    if (!turn.calls && turn.final && open && !cards.some(c => isActionable(c)) && !nudged && !final) {
      nudged = true;
      rounds.push({ text: String(turn.reply || '').slice(0, 400), calls: [], results: [], note: REVISE_NOTE });
      continue;
    }
    if (turn.calls) {
      // A call where none was allowed: whatever text came with it is the reply.
      if (final) { reply = turn.text || ''; break; }
      const done = turn.calls.slice(0, MAX_CALLS_PER_ROUND).map((c, i) => execute(c, round + 1, i));
      rounds.push({ text: turn.text || '', calls: done.map(d => d.call), results: done.map(d => d.text) });
      continue;
    }
    if (turn.error) {
      if (final) break;
      rounds.push({ text: turn.text || '', calls: [], results: [], note: `That answer could not be used: ${turn.error}.` });
      continue;
    }
    reply = turn.reply;
    cardIds = turn.cardIds;
    break;
  }

  const shown = cardIds ? cards.filter(c => cardIds.includes(c.id)) : cards;
  reply = String(reply || '').slice(0, REPLY_MAX);
  if (!reply && !shown.length) return { ok: false, errorClass: 'unusable', errors: ['the answer had no reply'] };
  return { ok: true, reply, cards: shown, rounds: rounds.length, tools: used };
}
