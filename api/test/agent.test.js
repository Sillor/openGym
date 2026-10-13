/* The chat loop, driven with a fake adapter: native tool calling, the round limit, a
 * validator error the model is allowed to fix, and the JSON protocol for providers that
 * have no tools on the wire. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleState } from './helpers.mjs';
import { runChat, MAX_ROUNDS } from '../coach/core/agent.js';
import { SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT } from '../coach/core/system-prompt.js';

const today = '2026-07-20';
const S = () => sampleState();

function nativeAdapter(script) {
  let i = 0;
  const seen = [];
  return {
    nativeTools: true,
    invokeChat: async (opts) => {
      seen.push(opts);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      const r = typeof step === 'function' ? await step(opts, i - 1) : step;
      return { code: 0, text: r.text || '', calls: r.calls || [], stderr: '' };
    },
    seen
  };
}

function jsonAdapter(script) {
  let i = 0;
  const seen = [];
  return {
    invoke: async (opts) => {
      seen.push(opts);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      const r = typeof step === 'function' ? await step(opts, i - 1) : step;
      return { code: 0, text: typeof r === 'string' ? r : JSON.stringify(r), stderr: '' };
    },
    seen
  };
}

const run = (adapter, message = 'How did last week go?', extra = {}) =>
  runChat({ adapter, cfg: {}, S: extra.S || S(), message, today, timeoutMs: 5000, ...extra });

test('the chat prefix mentions tools; the plan/review prefix still does not', () => {
  assert.match(SYSTEM_PROMPT, /no tools/);
  assert.doesNotMatch(CHAT_SYSTEM_PROMPT, /no tools/);
  assert.match(CHAT_SYSTEM_PROMPT, /tools you are given/);
});

test('native tool round trip: a read, then a reply, and the next turn sees the tool result', async () => {
  const steps = [];
  const ad = nativeAdapter([
    { calls: [{ id: 'call_1', name: 'get_workout_history', args: { days: 14 } }] },
    (opts) => {
      const tool = opts.messages.find(m => m.role === 'tool');
      assert.ok(tool, 'the tool result is a role message, not a new prompt');
      assert.equal(tool.id, 'call_1');
      assert.match(tool.content, /"ok":true/);
      assert.equal(opts.preamble, CHAT_SYSTEM_PROMPT);
      assert.ok(opts.tools.some(t => t.name === 'get_workout_history'));
      return { text: 'Last week you hit every set.' };
    }
  ]);
  const r = await run(ad, 'How did last week go?', { onStep: s => steps.push(s) });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'Last week you hit every set.');
  assert.deepEqual(r.tools, ['get_workout_history']);
  assert.ok(steps.includes('Reading your workout history'));
  assert.equal(r.cards.length, 0);
});

test('the round limit forces a final answer that may not call a tool', async () => {
  let finals = 0;
  const steps = [];
  const ad = nativeAdapter([(opts) => {
    if (opts.final) {
      finals++;
      return { text: 'Stopping here.' };
    }
    return { calls: [{ id: 'c', name: 'get_workout_history', args: {} }] };
  }]);
  const r = await run(ad, 'How did last week go?', { onStep: s => steps.push(s) });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'Stopping here.');
  assert.equal(finals, 1);
  assert.equal(r.rounds, MAX_ROUNDS);
  assert.equal(r.tools.length, MAX_ROUNDS);
  assert.ok(steps.includes('Writing a reply'));
});

test('a validation error is handed back and the model can repair the proposal', async () => {
  const ad = nativeAdapter([
    { calls: [{ id: 'c1', name: 'propose_changes', args: { title: 'Nope', changes: [] } }] },
    (opts) => {
      const tool = opts.messages.find(m => m.role === 'tool');
      assert.match(tool.content, /non-empty array/);
      return {
        calls: [{
          id: 'c2', name: 'propose_changes',
          args: {
            title: 'Add one set',
            changes: [{ id: 'c1', type: 'sets', target: { routineId: 'r1', exId: '0001' }, after: 4, why: 'You asked.' }]
          }
        }]
      };
    },
    { text: 'Here is the extra set — confirm it below.' }
  ]);
  const r = await run(ad, 'Add a set to sit-ups');
  assert.equal(r.ok, true);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].type, 'changes');
  assert.equal(r.cards[0].changes[0].after, 4);
  assert.match(r.reply, /extra set/);
});

test('JSON fallback: {"tool","args"} then {"reply"} over plain invoke', async () => {
  const ad = jsonAdapter([
    (opts) => {
      assert.match(opts.prompt, /"tool"/);
      assert.match(opts.prompt, /get_workout_history/);
      assert.equal(opts.preamble, CHAT_SYSTEM_PROMPT);
      return { tool: 'get_workout_history', args: { days: 7 } };
    },
    (opts) => {
      assert.match(opts.prompt, /Tool result/);
      return { reply: 'Looked it up.' };
    }
  ]);
  const r = await run(ad);
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'Looked it up.');
  assert.deepEqual(r.tools, ['get_workout_history']);
});

test('library searches cannot use up every round before a program is proposed', async () => {
  const ad = jsonAdapter([
    (opts) => {
      if (opts.prompt.includes('Do not call another tool') || opts.prompt.includes('shown to them')) {
        return { reply: 'Here is the program — confirm it below.' };
      }
      if (opts.prompt.includes('already searched')) {
        return {
          tool: 'propose_routines',
          args: {
            title: '3-day strength',
            summary: 'A simple return-to-training week.',
            routines: [{
              id: 'r1', name: 'Full body', prog: 'linear', why: 'They asked for a strength program.',
              ex: [{ id: '0001', sets: 3, mode: 'reps', reps: 5, prog: 'linear', why: 'The main lift.' }]
            }]
          }
        };
      }
      return { tool: 'search_exercises', args: { query: 'squat' } };
    }
  ]);
  const r = await run(ad, 'Write me a 3 day routine');
  assert.equal(r.ok, true);
  assert.equal(r.cards.filter(c => c.type === 'routines').length, 1);
  assert.ok(r.tools.filter(t => t === 'search_exercises').length <= 4);
  assert.match(r.reply, /confirm it below/);
});

test('a compatible server that refuses tools drops to the JSON protocol mid-job', async () => {
  let chatCalls = 0;
  const ad = {
    nativeTools: true,
    invokeChat: async () => {
      chatCalls++;
      return { code: 1, text: '', stderr: '400 this model does not support tools', toolsUnsupported: true };
    },
    invoke: async () => ({ code: 0, text: JSON.stringify({ reply: 'Fell back.' }), stderr: '' })
  };
  const r = await run(ad);
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'Fell back.');
  assert.equal(chatCalls, 1);
});

test('chat history honours chatClearedAt and slices long lines', async () => {
  const st = sampleState({
    coach: {
      ...sampleState().coach,
      chatClearedAt: 2000,
      chat: [
        { role: 'user', kind: 'text', text: 'old', t: 1000 },
        { role: 'user', kind: 'text', text: 'kept', t: 3000 },
        { role: 'coach', kind: 'text', text: 'x'.repeat(2000), t: 4000 }
      ]
    }
  });
  const ad = nativeAdapter([(opts) => {
    const users = opts.messages.filter(m => m.role === 'user').map(m => m.content);
    const joined = users.join('\n');
    assert.ok(!joined.includes('old'), 'cleared lines are gone');
    assert.match(joined, /kept/);
    assert.ok(!joined.includes('x'.repeat(1501)), 'history lines are sliced to 1500');
    return { text: 'Noted.' };
  }]);
  const r = await run(ad, 'and now this', { S: st });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'Noted.');
});
