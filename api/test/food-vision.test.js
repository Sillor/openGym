/* Food-analysis request bodies, and the one call that sends them.
 *
 * The training Coach's chat body is a different function. These tests pin the food call:
 * gpt-4o stays a plain completion, gpt-5 / o-series get a reasoning budget, a length
 * cutoff is retried once, and a photo never lands in DATA_DIR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempData } from './helpers.mjs';

const DIR = tempData();
const food = await import('../coach/core/food-vision.js');
const cfg = await import('../coach/config.js');
const { parseFoodAnalysis } = await import('../coach/core/food-json.js');
const {
  openaiFoodBody, retryFoodBody, geminiFoodParts, anthropicFoodContent,
  imageFoodPrompt, textFoodPrompt, analyzeNutrition, resetNutritionSlots, takeNutritionSlot
} = food;

const PHOTO = 'aGVsbG8tZm9vZC1waG90bw==';
const PHOTO_2 = 'cmV0cnktcGhvdG8tYnl0ZXM=';
const EGG = { name: 'Egg', calories: 70, protein: 6, carbs: 0.5, fat: 5, serving_size_grams: 50 };

function openaiAnswer(obj, finish = 'stop') {
  return { status: 200, body: { choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: finish }] } };
}
function fakeFetch(answers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const a = answers[Math.min(calls.length, answers.length) - 1];
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => JSON.stringify(a.body) };
  };
  f.calls = calls;
  return f;
}
function treeHas(dir, needle) {
  const buf = Buffer.from(needle);
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { if (treeHas(p, needle)) return true; }
    else if (fs.readFileSync(p).includes(buf)) return true;
  }
  return false;
}
function enable(provider, model, token = 'sk-test') {
  cfg.save({
    enabled: true,
    provider,
    authMode: 'instance',
    models: { [provider]: model },
    maxOutputTokens: 1024,
    auth: { [provider]: { type: 'apikey', data: cfg.encrypt({ token }) } },
    providerOptions: {}
  });
}

test('gpt-4o body is multipart chat completions without reasoning fields', () => {
  const body = openaiFoodBody({
    model: 'gpt-4o',
    prompt: 'Analyze',
    images: [{ mime: 'image/jpeg', base64: 'abc' }, { mime: 'image/png', base64: 'def' }],
    maxTokens: 1024
  });
  assert.equal(body.model, 'gpt-4o');
  assert.equal(body.max_completion_tokens, 1024);
  assert.equal('reasoning_effort' in body, false);
  assert.equal('temperature' in body, false);
  assert.equal('response_format' in body, false);
  assert.deepEqual(body.messages.map(m => m.role), ['user']);
  assert.equal(body.messages[0].content[0].text, 'Analyze');
  assert.equal(body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,abc');
  assert.equal(body.messages[0].content[2].image_url.url, 'data:image/png;base64,def');

  const textOnly = openaiFoodBody({ model: 'gpt-4o-mini', prompt: 'two eggs', images: [], maxTokens: 512 });
  assert.equal(textOnly.messages[0].content, 'two eggs');
  assert.equal('temperature' in textOnly, false);
});

test('gpt-5, gpt-6, and o-series raise the budget and set reasoning_effort low', () => {
  for (const model of ['gpt-5', 'gpt-5.4-mini', 'gpt-6', 'o1', 'o3-mini', 'o4']) {
    const body = openaiFoodBody({ model, prompt: 'x', maxTokens: 100 });
    assert.ok(body.max_completion_tokens >= 8192, model);
    assert.equal(body.reasoning_effort, 'low', model);
    assert.equal('temperature' in body, false, model);
  }
  const plain = openaiFoodBody({ model: 'gpt-4.1', prompt: 'x', maxTokens: 100 });
  assert.equal(plain.max_completion_tokens, 100);
  assert.equal('reasoning_effort' in plain, false);
  const kept = openaiFoodBody({ model: 'gpt-5', prompt: 'x', maxTokens: 9000 });
  assert.equal(kept.max_completion_tokens, 9000);
});

test('length retry doubles, caps at 16384, and does not mutate the original body', () => {
  const body = openaiFoodBody({ model: 'gpt-5', prompt: 'meal', maxTokens: 8192 });
  const retry = retryFoodBody(body);
  assert.equal(retry.max_completion_tokens, 16384);
  assert.equal(retry.reasoning_effort, 'low');
  assert.equal('temperature' in retry, false);
  assert.match(retry.messages[0].content, /compact JSON/);
  assert.equal(body.max_completion_tokens, 8192);
  assert.equal(body.messages[0].content, 'meal');

  assert.equal(retryFoodBody(retry).max_completion_tokens, 16384);
  assert.equal(retryFoodBody(openaiFoodBody({ model: 'o3', prompt: 'meal', maxTokens: 9000 })).max_completion_tokens, 16384);

  const small = openaiFoodBody({
    model: 'gpt-4o',
    prompt: 'meal',
    images: [{ mime: 'image/png', base64: 'xx' }],
    maxTokens: 1000
  });
  const again = retryFoodBody(small);
  assert.equal(again.max_completion_tokens, 2000);
  assert.match(again.messages[0].content.find(p => p.type === 'text').text, /compact JSON/);
  assert.equal(again.messages[0].content.find(p => p.type === 'image_url').image_url.url, 'data:image/png;base64,xx');
  assert.equal(small.messages[0].content.find(p => p.type === 'text').text, 'meal');
});

test('at most three images, and the gemini and anthropic parts carry the same bytes', () => {
  const images = [1, 2, 3, 4].map(i => ({ mime: 'image/jpeg', base64: String(i) }));
  const body = openaiFoodBody({ model: 'gpt-4o', prompt: 'p', images, maxTokens: 100 });
  assert.equal(body.messages[0].content.filter(p => p.type === 'image_url').length, 3);

  const parts = geminiFoodParts({ prompt: 'p', images });
  assert.equal(parts[0].text, 'p');
  assert.equal(parts.length, 4);
  assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/jpeg', data: '1' } });

  const content = anthropicFoodContent({ prompt: 'p', images });
  assert.equal(content[0].type, 'text');
  assert.equal(content.length, 4);
  assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '1' } });

  const gemini = {
    contents: [{ role: 'user', parts: geminiFoodParts({ prompt: 'p', images: [] }) }],
    generationConfig: { maxOutputTokens: 9000 }
  };
  const retried = retryFoodBody(gemini);
  assert.equal(retried.generationConfig.maxOutputTokens, 16384);
  assert.match(retried.contents[0].parts[0].text, /compact JSON/);
});

test('prompts ask for the diary schema', () => {
  for (const prompt of [imageFoodPrompt('extra cheese'), textFoodPrompt('two eggs')]) {
    assert.match(prompt, /Respond ONLY with JSON/);
    assert.match(prompt, /serving_size_grams/);
    assert.match(prompt, /"ingredients":\[\]/);
    assert.equal(prompt.includes('vitamin_a'), false);
    assert.equal(prompt.includes('unit_options'), false);
    assert.equal(prompt.includes('You are the openGym Coach'), false);
  }
  assert.match(imageFoodPrompt('extra cheese'), /extra cheese/);
  assert.match(textFoodPrompt('two eggs'), /two eggs/);
  assert.equal(imageFoodPrompt('').includes('Additional context'), false);
});

test('the browser parser stays in lockstep with the API parser', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const rest = file => {
    const src = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
    return src.slice(src.indexOf('\n') + 1);
  };
  assert.equal(rest('api/coach/core/food-json.js'), rest('frontend/src/lib/food-json.js'));
  const text = '```json\n{"name":"Egg","calories":70.6,"protein":6.24,"carbs":0.5,"fat":5,"serving_size_grams":50}\n```';
  assert.deepEqual(parseFoodAnalysis(text), {
    ok: true,
    items: [{ name: 'Egg', kcal: 71, protein: 6.2, carbs: 0.5, fat: 5, grams: 50, servingQty: 1, servingUnit: 'serving' }]
  });
  assert.deepEqual(parseFoodAnalysis('nope'), { ok: false });
});

test('analyze uses the coach key, retries a short answer once, and does not store the photo', async () => {
  const boom = async () => { throw new Error('provider was called'); };
  assert.deepEqual(await analyzeNutrition({ uid: 'u', body: {}, fetchImpl: boom }), { status: 400, body: { error: 'bad request' } });
  const tooMany = [1, 2, 3, 4].map(() => ({ mime: 'image/jpeg', base64: PHOTO }));
  assert.deepEqual(await analyzeNutrition({ uid: 'u', body: { images: tooMany }, fetchImpl: boom }), { status: 400, body: { error: 'bad request' } });
  assert.deepEqual(await analyzeNutrition({ uid: 'u', body: { text: 'egg' }, fetchImpl: boom }), { status: 503, body: { error: 'provider' } });

  enable('openai', 'gpt-4o');
  const seen = fakeFetch([openaiAnswer(EGG)]);
  const out = await analyzeNutrition({
    uid: 'u1',
    body: { text: 'one egg', images: [{ mime: 'image/jpeg', base64: PHOTO }] },
    fetchImpl: seen
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, items: [{ name: 'Egg', kcal: 70, protein: 6, carbs: 0.5, fat: 5, grams: 50, servingQty: 1, servingUnit: 'serving' }] });
  const sent = seen.calls[0];
  assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(sent.headers.authorization, 'Bearer sk-test');
  assert.equal(sent.body.model, 'gpt-4o');
  assert.equal(sent.body.max_completion_tokens, 1024);
  assert.equal('reasoning_effort' in sent.body, false);
  assert.equal('temperature' in sent.body, false);
  assert.equal(JSON.stringify(sent.body).includes('You are the openGym Coach'), false);
  assert.equal(sent.body.messages.length, 1);
  assert.equal(sent.body.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,' + PHOTO);
  assert.equal(treeHas(DIR, PHOTO), false);

  enable('openai', 'gpt-5');
  const retried = fakeFetch([
    openaiAnswer({ calories: 1 }, 'length'),
    openaiAnswer(EGG, 'stop')
  ]);
  const second = await analyzeNutrition({
    uid: 'u2',
    body: { images: [{ mime: 'image/png', base64: PHOTO_2 }] },
    fetchImpl: retried
  });
  assert.equal(second.status, 200);
  assert.equal(retried.calls.length, 2);
  assert.ok(retried.calls[0].body.max_completion_tokens >= 8192);
  assert.equal(retried.calls[0].body.reasoning_effort, 'low');
  assert.equal('temperature' in retried.calls[0].body, false);
  assert.equal(retried.calls[1].body.max_completion_tokens, 16384);
  assert.equal(retried.calls[1].body.reasoning_effort, 'low');
  assert.match(retried.calls[1].body.messages[0].content[0].text, /compact JSON/);
  assert.equal(retried.calls[1].body.messages[0].content[1].image_url.url, 'data:image/png;base64,' + PHOTO_2);
  assert.equal(treeHas(DIR, PHOTO_2), false);

  enable('claude', 'claude-x', 'sk-ant-test');
  const cli = await analyzeNutrition({
    uid: 'u3',
    body: { text: 'apple', images: [{ mime: 'image/jpeg', base64: PHOTO }] },
    fetchImpl: boom
  });
  assert.deepEqual(cli, { status: 400, body: { error: 'provider' } });

  process.env.NUTRITION_ANALYZE_CAP = '1';
  resetNutritionSlots();
  enable('openai', 'gpt-4o');
  const capped = fakeFetch([openaiAnswer(EGG), openaiAnswer(EGG)]);
  const first = await analyzeNutrition({ uid: 'cap', body: { text: 'egg' }, fetchImpl: capped });
  const over = await analyzeNutrition({ uid: 'cap', body: { text: 'egg again' }, fetchImpl: capped });
  assert.equal(first.status, 200);
  assert.deepEqual(over, { status: 429, body: { error: 'cap' } });
  assert.equal(capped.calls.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(DIR, 'nutrition-analyze.json'), 'utf8'));
  assert.equal(saved.cap.count, 1);
  assert.deepEqual(Object.keys(saved.cap).sort(), ['count', 'date']);
  assert.equal(takeNutritionSlot('other'), true);
  delete process.env.NUTRITION_ANALYZE_CAP;
});
