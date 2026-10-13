/* The chat job: the route, the separate daily cap, and job.step while a tool is in flight. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempData, writeState, sampleState } from './helpers.mjs';

const DIR = tempData();
const cfg = await import('../coach/config.js');
const jobs = await import('../coach/jobs.js');
const { coachRoutes } = await import('../coach/routes.js');
const { forcePrivilegeVerdict } = await import('../coach/adapters/spawn.js');

cfg.save({ enabled: true, provider: 'fixture' });
forcePrivilegeVerdict({ ok: true, dropped: false, why: 'pinned by the test suite' });

async function settle(uid, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = jobs.status(uid);
    if (!s.job) return s;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('job never finished');
}

function harness(uid) {
  const routes = coachRoutes({
    json: (res, status, body) => { res.status = status; res.body = body; },
    readBody: async req => req.body || {},
    readSession: () => ({ id: uid, admin: true }),
    requireAdmin: () => true
  });
  const call = async (key, body) => { const res = {}; await routes[key]({ body }, res); return res; };
  return { call, routes };
}

test('POST /api/coach/chat queues a chat job; empty message is 400', async () => {
  const uid = 'u-chat-route';
  writeState(DIR, uid, sampleState());
  const { call } = harness(uid);
  const empty = await call('POST /api/coach/chat', { message: '   ' });
  assert.equal(empty.status, 400);

  const r = await call('POST /api/coach/chat', { message: 'How did last week go?', lang: 'en' });
  assert.equal(r.status, 202);
  assert.ok(r.body.job.id);
  assert.equal(jobs.status(uid).job.kind, 'chat');
  const s = await settle(uid);
  assert.equal(s.last.outcome, 'chat');
  assert.equal(s.last.jobId, r.body.job.id);
  assert.ok(s.last.reply);
  assert.ok(s.last.cards.some(c => c.type === 'exercises'), 'the fixture shows the plan\'s exercises');
  assert.equal(s.pending, null, 'informational cards do not become a proposal');
});

test('the same refusals as /api/coach/plan: 409 busy, 429 cap, 403 consent', async () => {
  const uid = 'u-chat-refusals';
  writeState(DIR, uid, sampleState({ coach: {} }));
  const { call } = harness(uid);
  const consent = await call('POST /api/coach/chat', { message: 'hi' });
  assert.equal(consent.status, 403);
  assert.equal(consent.body.code, 'consent');

  writeState(DIR, uid, sampleState());
  cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 0, chatDaily: 1 } });
  try {
    const first = await call('POST /api/coach/chat', { message: 'hi' });
    assert.equal(first.status, 202);
    assert.throws(() => jobs.enqueue(uid, { kind: 'chat', note: 'again' }), e => e.code === 'busy');
    await settle(uid);
    const cap = await call('POST /api/coach/chat', { message: 'again' });
    assert.equal(cap.status, 429);
    assert.equal(cap.body.code, 'cap');
  } finally {
    cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 0, chatDaily: 200 } });
  }
});

test('chatDaily is counted separately from perProfileDaily', async () => {
  const uid = 'u-chat-cap';
  writeState(DIR, uid, sampleState());
  cfg.save({ caps: { perProfileDaily: 1, instanceDaily: 0, chatDaily: 1 } });
  try {
    jobs.enqueue(uid, { kind: 'chat', note: 'How did last week go?' });
    await settle(uid);
    const cap = jobs.capState(uid);
    assert.equal(cap.used, 0, 'a chat does not spend the plan/review allowance');
    assert.equal(cap.chatUsed, 1);
    assert.equal(cap.chatLimit, 1);
    assert.throws(() => jobs.enqueue(uid, { kind: 'chat', note: 'again' }), e => e.code === 'cap');
    assert.doesNotThrow(() => jobs.enqueue(uid, { kind: 'review' }), 'the review slot is still free');
    await settle(uid);
    assert.equal(jobs.capState(uid).used, 1);
  } finally {
    cfg.save({ caps: { perProfileDaily: 10, instanceDaily: 0, chatDaily: 200 } });
  }
});

test('a chat that proposes a change becomes pending; resolve accepts kind chat', async () => {
  const uid = 'u-chat-pending';
  writeState(DIR, uid, sampleState());
  jobs.enqueue(uid, { kind: 'chat', note: 'Swap an exercise, add a set' });
  const s = await settle(uid);
  assert.equal(s.last.outcome, 'chat');
  assert.equal(s.pending.kind, 'chat');
  assert.equal(s.pending.jobId, s.last.jobId);
  assert.ok(s.pending.cards.some(c => c.type === 'changes'));
  assert.equal(s.last.cards.some(c => c.type === 'changes'), false, 'actionable cards live on pending');
  const done = jobs.resolvePending(uid, { accepted: [s.pending.cards[0].id] });
  assert.equal(done.ok, true);
  assert.equal(jobs.status(uid).pending, null);
});

test('a later chat supersedes an older chat pending and leaves other kinds alone', async () => {
  const uid = 'u-chat-supersede';
  writeState(DIR, uid, sampleState());
  jobs.enqueue(uid, { kind: 'review' });
  const review = await settle(uid);
  assert.equal(review.pending.kind, 'review');

  jobs.enqueue(uid, { kind: 'chat', note: 'How did last week go?' });
  const chat = await settle(uid);
  assert.equal(chat.pending.kind, 'review', 'an informational chat does not steal a waiting review');
  assert.equal(chat.last.outcome, 'chat');

  jobs.resolvePending(uid, { dismissed: true });
  jobs.enqueue(uid, { kind: 'chat', note: 'Add a set please' });
  const first = await settle(uid);
  assert.equal(first.pending.kind, 'chat');
  const firstId = first.pending.jobId;

  jobs.enqueue(uid, { kind: 'chat', note: 'How did last week go?' });
  const second = await settle(uid);
  assert.equal(second.pending.jobId, firstId, 'a later chat with no proposal keeps the open card');
  assert.notEqual(second.last.jobId, firstId);
});

test('GET /api/coach/status exposes job.step from the closed English list while a tool runs', async () => {
  const held = [], seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { seen.push(JSON.parse(body || '{}')); held.push(res); });
    res.on('close', () => { const i = held.indexOf(res); if (i >= 0) held.splice(i, 1); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const until = async n => {
    const t = Date.now() + 15000;
    while (held.length !== n && Date.now() < t) await new Promise(r => setTimeout(r, 25));
    assert.equal(held.length, n, `${n} request(s) with the provider`);
  };
  const answer = body => {
    for (const res of held.splice(0)) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    }
  };
  const uid = 'u-chat-step';
  writeState(DIR, uid, sampleState());
  cfg.save({
    enabled: true, provider: 'compatible',
    providerOptions: { compatible: { baseUrl: `http://127.0.0.1:${server.address().port}` } },
    models: { compatible: 'local-model' }
  });
  try {
    jobs.enqueue(uid, { kind: 'chat', note: 'How did last week go?' });
    await until(1);
    assert.equal('response_format' in seen[0], false, 'chat does not use the JSON-mode single-shot path');
    assert.ok(Array.isArray(seen[0].tools) && seen[0].tools.length, 'native tool declarations went out');
    answer({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_workout_history', arguments: '{}' } }]
        }
      }]
    });
    await until(1);
    assert.equal(jobs.status(uid).job.kind, 'chat');
    assert.equal(jobs.status(uid).job.step, 'Reading your workout history');
    answer({ choices: [{ finish_reason: 'stop', message: { content: 'Last week looked solid.' } }] });
    const s = await settle(uid);
    assert.equal(s.last.outcome, 'chat');
    assert.equal(s.last.reply, 'Last week looked solid.');
  } finally {
    cfg.save({ provider: 'fixture' });
    server.close();
    server.closeAllConnections();
  }
});
