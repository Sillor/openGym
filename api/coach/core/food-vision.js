/* Photo / text food analysis. Not the training Coach.
 *
 * The HTTP body is built here and never goes through the adapters' `body()` — that one always
 * attaches the Coach system prompt and a training schema. CLI providers (Claude, Codex, the
 * fixture) only accept a prompt string and cannot see a photo; text-only still uses their
 * existing invoke, because that is the only way those providers already answer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../../durable.js';
import { fetchFor } from '../node-fetch.js';
import * as cfgStore from '../config.js';
import { adapterFor } from '../adapters/index.js';
import { canDropPrivileges } from '../adapters/spawn.js';
import { openaiSpec } from './adapters/openai.js';
import { geminiSpec } from './adapters/gemini.js';
import { anthropicSpec } from './adapters/anthropic.js';
import { compatibleSpec } from './adapters/compatible.js';
import { endpointUrl } from './adapters/http.js';
import { HTTP_PROVIDERS, baseUrlFor, extraHeadersFor } from './providers.js';
import { parseFoodAnalysis } from './food-json.js';

export const MAX_FOOD_IMAGES = 3;
// The retry's ceiling. Higher would be refused outright by models whose output tops out here.
const FOOD_TOKEN_CAP = 16384;
// The first call's range: enough for a plate of twenty ingredients, low enough that the retry
// after a cut-off answer has real room to grow into.
const FIRST_FLOOR = 4096;
const FIRST_CAP = 8192;
const REASONING_FLOOR = 8192;
const CALL_TIMEOUT_MS = 120000;
// Both tries together. The browser waits 170 s (frontend/src/lib/food-analyze.js).
const DEADLINE_MS = 150000;
const MAX_TEXT = 8000;
const MAX_FIX_NOTE = 2000;
const MAX_PREVIOUS = 16000;
const MAX_B64 = 3500000;
const MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const CAP_FILE = 'nutrition-analyze.json';

const SPECS = { openai: openaiSpec, compatible: compatibleSpec, gemini: geminiSpec, anthropic: anthropicSpec };

const COMPACT_NOTE = '\n\nIMPORTANT: The previous response did not contain a complete answer. Return only the requested compact JSON object, with no reasoning, explanation, or markdown.';

const SCHEMA = '{"name":"...","serving_quantity":1,"serving_unit":"serving","serving_size_grams":0,"unit_options":[],"calories":0,"protein":0.0,"carbs":0.0,"fat":0.0,"ingredients":[]}';
const INGREDIENT = '{"name":"...","quantity":0,"unit":"...","grams":0,"unit_options":[],"calories":0,"protein":0.0,"carbs":0.0,"fat":0.0}';

const UNIT_RULES = [
  'Amounts: unit / serving_unit is how a person would count this food. Use slice or piece for something countable (pizza slice, egg, cookie, banana), ml, cup or fl oz for a drink or soup, tbsp or tsp for a spread, sauce or oil, can, bottle or packet for packaged food, and g for food without a natural unit (meat, rice, pasta, salad) or that was weighed. Only use a count (slice, piece...) that is stated, visible, or clearly implied; never invent one.',
  'quantity / serving_quantity is how many of that unit. grams / serving_size_grams is the total weight in grams of that amount; always estimate it, also for drinks. unit_options may list other natural units as {"unit":"slice","grams_per_unit":0}; quantity times grams_per_unit equals the weight. For a whole plate, serving_unit is serving (1) or bowl/plate.',
  'Calories are integers. Protein/carbs/fat are grams, with one decimal when needed.'
].join('\n');

const INGREDIENT_RULES = `ingredients lists each separate food once (at most 15) as ${INGREDIENT}, each with its own natural unit and weight. Their calories and macros describe the amount eaten and add up to the meal totals. Include cooking oil, butter, sauces and dressings that add calories; skip salt, pepper, spray oil and other negligible seasonings.`;

const JSON_ONLY = 'Respond ONLY with compact JSON for this one meal, no reasoning, no markdown:';

/** Image prompt, ported from Fud AI's multi-photo / single-photo analysis. Schema is the diary's. */
export function imageFoodPrompt(description) {
  let prompt = [
    'Analyze these food images together as one meal logging request. They may show different angles of the same food, separate ingredients, kitchen-scale readings, packaging, or nutrition labels.',
    'Use every image once. Do not double-count the same food shown from multiple angles. When separate ingredients are shown, combine their nutrition into one meal total. Read visible scale weights and nutrition labels when available; prefer those measurements over visual portion estimates.',
    'Give your best estimate for the visible food amount. For whole/mostly-whole cakes, pizzas, pies, loaves, or similar foods, estimate the total visible item rather than defaulting to one slice.',
    JSON_ONLY,
    SCHEMA,
    UNIT_RULES,
    `${INGREDIENT_RULES} Return [] only for a single simple food or when a reliable breakdown is not possible.`
  ].join('\n');
  const note = typeof description === 'string' ? description.trim() : '';
  if (note) prompt += `\n\nThe user describes this meal (trust their amounts, brands and ingredients over what the photo suggests):\n${note}`;
  return prompt;
}

/** Text prompt, ported from Fud AI's analyzeText. Schema is the diary's. */
export function textFoodPrompt(description) {
  return [
    `Estimate the nutritional content of this meal:\n${description}`,
    "Parse every quantity, brand, and food in the text. If a brand is mentioned, use that brand's known nutritional data. Several foods are one meal: list each as an ingredient and total them.",
    JSON_ONLY,
    SCHEMA,
    UNIT_RULES,
    `${INGREDIENT_RULES} Return [] for a single simple food.`
  ].join('\n');
}

/**
 * A correction of an earlier estimate. The model sees its previous answer as JSON — grams and
 * all — and the user's sentence, and returns the whole meal again with only that changed.
 */
export function correctionFoodPrompt({ previous, note, context, photo } = {}) {
  const lines = [
    'You estimated this meal earlier. Your previous answer, as JSON:',
    JSON.stringify(previous),
  ];
  if (context) lines.push(`The user's original description: ${context}`);
  if (photo) lines.push('The meal photo is attached again for reference.');
  lines.push(
    `The user's correction: ${note}`,
    'Apply the correction. Change only what it affects and keep every other food, amount and number exactly as it was. Add a food the user says is missing; remove one they say is not there. When an amount changes, scale that food\'s calories and macros with it, and keep the meal totals equal to the sum of the ingredients.',
    JSON_ONLY,
    SCHEMA,
    UNIT_RULES,
    INGREDIENT_RULES
  );
  return lines.join('\n');
}

function isReasoningModel(model) {
  const id = String(model || '').trim();
  return /^gpt-5/.test(id) || /^gpt-6/.test(id) || /^o\d/.test(id);
}

/** A model that spends output tokens thinking before it answers, whatever the provider. */
function thinks(model) {
  const id = String(model || '').trim().toLowerCase().replace(/^.*\//, '');
  return isReasoningModel(id) || /gemini-(2\.5|3)/.test(id) || /qwen3|deepseek-r1|(^|-)r1(-|$)|reasoner|thinking|magistral|gpt-oss/.test(id);
}

function imageList(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const im of images) {
    if (!im || typeof im.base64 !== 'string' || !im.base64) continue;
    out.push({ mime: im.mime || 'image/jpeg', base64: im.base64 });
    if (out.length === MAX_FOOD_IMAGES) break;
  }
  return out;
}

/** Chat Completions body. Images are `{ mime, base64 }`, at most three, as data URLs. */
export function openaiFoodBody({ model, prompt, images, maxTokens } = {}) {
  const imgs = imageList(images);
  const content = imgs.length
    ? [
      { type: 'text', text: String(prompt ?? '') },
      ...imgs.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` } }))
    ]
    : String(prompt ?? '');
  const reasoning = isReasoningModel(model);
  const requested = Number(maxTokens);
  const budget = Number.isFinite(requested) && requested > 0 ? requested : (reasoning ? REASONING_FLOOR : 2048);
  const body = {
    model,
    messages: [{ role: 'user', content }],
    max_completion_tokens: reasoning ? Math.max(REASONING_FLOOR, budget) : budget
  };
  if (reasoning) body.reasoning_effort = 'low';
  return body;
}

export function geminiFoodParts({ prompt, images } = {}) {
  const parts = [{ text: String(prompt ?? '') }];
  for (const im of imageList(images)) parts.push({ inlineData: { mimeType: im.mime, data: im.base64 } });
  return parts;
}

export function anthropicFoodContent({ prompt, images } = {}) {
  const content = [{ type: 'text', text: String(prompt ?? '') }];
  for (const im of imageList(images)) {
    content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.base64 } });
  }
  return content;
}

/** One retry after finish_reason "length": compact-JSON note, budget doubled (at least 8192), never past 16384. */
export function retryFoodBody(body) {
  const next = JSON.parse(JSON.stringify(body));
  bumpBudget(next);
  const budget = budgetOf(next);
  annotate(next, COMPACT_NOTE + (budget ? ` Keep the complete response under ${budget} tokens.` : ''));
  return next;
}

function bumpBudget(body) {
  const apply = (obj, key) => {
    if (!obj || typeof obj[key] !== 'number' || !Number.isFinite(obj[key])) return false;
    obj[key] = Math.min(FOOD_TOKEN_CAP, Math.max(REASONING_FLOOR, obj[key] * 2));
    return true;
  };
  if (apply(body, 'max_completion_tokens')) return;
  if (apply(body, 'max_tokens')) return;
  if (apply(body, 'maxOutputTokens')) return;
  apply(body.generationConfig, 'maxOutputTokens');
}

function budgetOf(body) {
  if (typeof body.max_completion_tokens === 'number') return body.max_completion_tokens;
  if (typeof body.max_tokens === 'number') return body.max_tokens;
  if (typeof body.maxOutputTokens === 'number') return body.maxOutputTokens;
  if (body.generationConfig && typeof body.generationConfig.maxOutputTokens === 'number') return body.generationConfig.maxOutputTokens;
  return null;
}

function annotate(body, note) {
  const msg = Array.isArray(body.messages) ? body.messages.find(m => m && m.role === 'user') : null;
  if (msg) appendContent(msg, note);
  const parts = body.contents && body.contents[0] && body.contents[0].parts;
  if (Array.isArray(parts)) appendText(parts, note);
}

function appendContent(msg, note) {
  if (typeof msg.content === 'string') { msg.content += note; return; }
  if (Array.isArray(msg.content)) appendText(msg.content, note);
}

function appendText(parts, note) {
  const part = parts.find(p => p && typeof p.text === 'string' && (p.type === 'text' || p.type == null));
  if (part) part.text += note;
  else parts.unshift({ type: 'text', text: note.trim() });
}

function buildFoodBody(provider, opts) {
  if (thinks(opts.model)) opts = { ...opts, maxTokens: Math.max(REASONING_FLOOR, Number(opts.maxTokens) || 0) };
  if (provider === 'gemini') {
    return {
      contents: [{ role: 'user', parts: geminiFoodParts(opts) }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: opts.maxTokens }
    };
  }
  if (provider === 'anthropic') {
    return {
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [{ role: 'user', content: anthropicFoodContent(opts) }]
    };
  }
  const body = openaiFoodBody(opts);
  // Ollama and the other compatible servers speak max_tokens, and reject reasoning_effort.
  if (provider === 'compatible') {
    body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
    delete body.reasoning_effort;
  }
  return body;
}

/* ---------- daily cap ---------- */
// Counts only. A photo never lands in this file, in coach.json, or in a user's state.

let slots = null;

export function nutritionAnalyzeLimit() {
  const raw = process.env.NUTRITION_ANALYZE_CAP;
  if (raw == null || String(raw).trim() === '') return 50;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 50;
  return Math.floor(n);
}

function slotBag() {
  if (slots) return slots;
  slots = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR || '/data', CAP_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v === 'object' && typeof v.date === 'string' && Number.isInteger(v.count)) slots[k] = { date: v.date, count: v.count };
      }
    }
  } catch { /* first day, or a file that does not parse */ }
  return slots;
}

function persistSlots() {
  try {
    atomicWrite(path.join(process.env.DATA_DIR || '/data', CAP_FILE), JSON.stringify(slotBag()), 0o600);
  } catch { /* the in-memory count still bounds this process */ }
}

/** Test seam. An empty bag, not a reload — the next take overwrites the file. */
export function resetNutritionSlots() { slots = Object.create(null); }

export function takeNutritionSlot(uid) {
  const limit = nutritionAnalyzeLimit();
  const date = new Date().toISOString().slice(0, 10);
  const bag = slotBag();
  const key = String(uid || '').slice(0, 80);
  const prev = bag[key];
  const used = prev && prev.date === date ? prev.count : 0;
  if (used >= limit) return false;
  bag[key] = { date, count: used + 1 };
  persistSlots();
  return true;
}

function normalizeImages(raw) {
  if (raw == null) return { list: [] };
  if (!Array.isArray(raw) || raw.length > MAX_FOOD_IMAGES) return { error: true };
  const list = [];
  for (const im of raw) {
    if (!im || typeof im !== 'object' || Array.isArray(im)) return { error: true };
    let mime = typeof im.mime === 'string' ? im.mime.toLowerCase().split(';')[0].trim() : '';
    if (mime === 'image/jpg') mime = 'image/jpeg';
    if (!MIME.has(mime)) return { error: true };
    if (typeof im.base64 !== 'string') return { error: true };
    const base64 = im.base64.replace(/\s+/g, '');
    if (!base64 || base64.length > MAX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { error: true };
    list.push({ mime, base64 });
  }
  return { list };
}

function readFix(raw) {
  if (raw == null) return { fix: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'bad request' };
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (!note) return { error: 'bad request' };
  if (note.length > MAX_FIX_NOTE) return { error: 'too long' };
  const previous = raw.previous;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return { error: 'bad request' };
  if (JSON.stringify(previous).length > MAX_PREVIOUS) return { error: 'too long' };
  const context = typeof raw.context === 'string' ? raw.context.trim() : '';
  if (context.length > MAX_TEXT) return { error: 'too long' };
  return { fix: { previous, note, context } };
}

// The instance log the admin card reads: counts and outcomes only, never what was eaten.
function logFood({ uid, trigger, started, outcome, errorClass, detail }) {
  try {
    cfgStore.logJob({
      at: new Date().toISOString(), uid, kind: 'food', trigger, outcome,
      errorClass: errorClass || null, ms: Date.now() - started, detail: detail || null
    });
  } catch { /* the log is a convenience; the answer still goes out */ }
}

/** A provider's own error, with anything quoted cut out: it can echo the request. */
function providerDetail(read) {
  if (!read) return null;
  const parts = [read.status ? 'HTTP ' + read.status : null, read.message ? String(read.message).replace(/"[^"]*"/g, '"…"') : null].filter(Boolean);
  return parts.length ? parts.join(': ').slice(0, 300) : null;
}

/**
 * One analysis for a signed-in profile. `fetchImpl` is a test seam; production uses the Coach's
 * long-timeout fetch. Returns `{ status, body }` and never writes the image bytes. `fix` makes
 * it a correction of an earlier answer instead of a fresh read.
 */
export async function analyzeNutrition({ uid, body, fetchImpl, deadlineMs = DEADLINE_MS } = {}) {
  const images = normalizeImages(body && body.images);
  if (images.error) return { status: 400, body: { error: 'bad request' } };
  const rawText = typeof (body && body.text) === 'string' ? body.text.trim() : '';
  if (rawText.length > MAX_TEXT) return { status: 400, body: { error: 'too long' } };
  const fixed = readFix(body && body.fix);
  if (fixed.error) return { status: 400, body: { error: fixed.error } };
  const fix = fixed.fix;
  const text = rawText;
  if (!fix && !text && !images.list.length) return { status: 400, body: { error: 'bad request' } };

  if (!cfgStore.isEnabled() || !cfgStore.isConnected()) return { status: 503, body: { error: 'provider' } };
  const cfg = cfgStore.load();
  const adapter = adapterFor(cfg.provider);
  if (!adapter) return { status: 503, body: { error: 'provider' } };
  const cred = cfgStore.credentialFor(uid);
  if (!cred.ok) return { status: 503, body: { error: 'provider' } };

  // A spawned CLI has no vision channel. Do not hand it the photos, and do not spend a slot.
  // A correction carries the previous answer in words, so it can go without the photo.
  let photos = images.list;
  if (photos.length && adapter.spawns !== false) {
    if (!fix) return { status: 400, body: { error: 'provider' } };
    photos = [];
  }
  if (adapter.spawns !== false && !canDropPrivileges().ok) return { status: 503, body: { error: 'provider' } };
  const model = cfgStore.modelFor(cfg);
  if (adapter.spawns === false && !model) return { status: 503, body: { error: 'provider' } };

  if (!takeNutritionSlot(uid)) return { status: 429, body: { error: 'cap' } };
  cfgStore.bindInstanceCredential(uid);

  const trigger = fix ? 'fix' : photos.length ? 'photo' : 'text';
  const started = Date.now();
  const prompt = fix
    ? correctionFoodPrompt({ ...fix, context: fix.context || text, photo: photos.length > 0 })
    : photos.length ? imageFoodPrompt(text) : textFoodPrompt(text);
  const maxTokens = Math.min(FIRST_CAP, Math.max(FIRST_FLOOR, cfg.maxOutputTokens || FIRST_FLOOR));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deadlineMs);
  let read;
  try {
    read = adapter.spawns === false
      ? await callHttp({ provider: cfg.provider, cfg, cred, model, prompt, images: photos, maxTokens, fetchImpl, signal: ctl.signal })
      : await callCli({ adapter, cfg, cred, model, prompt });
  } catch (e) {
    const late = ctl.signal.aborted;
    logFood({ uid, trigger, started, outcome: 'failed', errorClass: late ? 'timeout' : 'provider', detail: late ? null : providerDetail({ message: e && e.message }) });
    return late ? { status: 504, body: { error: 'timeout' } } : { status: 502, body: { error: 'provider' } };
  } finally {
    clearTimeout(timer);
  }
  if (!read || !read.text) {
    logFood({ uid, trigger, started, outcome: 'failed', errorClass: (read && read.errorClass) || 'provider', detail: providerDetail(read) });
    return { status: 502, body: { error: 'provider' } };
  }
  const parsed = parseFoodAnalysis(read.text);
  if (!parsed.ok) {
    logFood({ uid, trigger, started, outcome: 'failed', errorClass: read.truncated ? 'truncated' : 'parse' });
    return { status: 422, body: { error: 'parse' } };
  }
  logFood({ uid, trigger, started, outcome: 'ready', detail: read.truncated ? 'cut off; closed at the last complete food' : null });
  return { status: 200, body: parsed };
}

async function callHttp({ provider, cfg, cred, model, prompt, images, maxTokens, fetchImpl, signal }) {
  const spec = SPECS[provider];
  const meta = HTTP_PROVIDERS[provider];
  if (!spec || !meta || !model) return null;
  const env = cfgStore.jobEnv(os.tmpdir(), cred);
  const key = (env && env[meta.apiKeyEnv]) || null;
  if (!key && !meta.keyOptional) return null;
  const base = baseUrlFor(provider, cfg);
  if (!base) return null;
  const fetch = fetchImpl || fetchFor(CALL_TIMEOUT_MS);
  let reqBody = buildFoodBody(provider, { model, prompt, images, maxTokens });
  const first = await postOnce(fetch, spec, base, model, key, cfg, provider, reqBody, signal);
  if (!first.truncated || first.error) return first;
  reqBody = retryFoodBody(reqBody);
  let second;
  try { second = await postOnce(fetch, spec, base, model, key, cfg, provider, reqBody, signal); }
  catch (e) { if (signal && signal.aborted) throw e; second = { error: 'provider' }; }
  if (!second.error && !second.truncated && second.text) return second;
  // Cut off twice, or the bigger retry was refused: the longer partial answer still holds
  // every food it finished, and the parser closes it there.
  const best = [first, second].filter(r => r && r.text).sort((a, b) => b.text.length - a.text.length)[0];
  return best ? { text: best.text, truncated: true } : second;
}

async function postOnce(fetchImpl, spec, base, model, key, cfg, provider, body, signal) {
  const res = await fetchImpl(endpointUrl(base, spec.path(model)), {
    method: 'POST',
    headers: { ...extraHeadersFor(provider, cfg), 'content-type': 'application/json', ...spec.headers(key || '') },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { return { error: 'bad response', errorClass: 'provider', status: res.status }; }
  if (!res.ok) {
    const err = data && (data.error || data.message);
    const message = typeof err === 'string' ? err : err && typeof err.message === 'string' ? err.message : null;
    return { error: 'provider', errorClass: 'provider', status: res.status, message };
  }
  try {
    const read = spec.readText(data);
    // Gemini reports a cut-off answer with no text; the parts it did write are still there.
    if (read && read.truncated && !read.text && provider === 'gemini') read.text = geminiPartial(data);
    if (read && read.error) return { ...read, errorClass: 'provider', message: read.error };
    return read || { error: 'bad response' };
  } catch { return { error: 'bad response', errorClass: 'provider' }; }
}

function geminiPartial(data) {
  const cand = (data && data.candidates || [])[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  return parts.filter(p => p && !p.thought).map(p => p.text || '').join('');
}

async function callCli({ adapter, cfg, cred, model, prompt }) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'food-'));
  try {
    const env = cfgStore.jobEnv(jobDir, cred);
    const result = await adapter.invoke({ prompt, cfg, jobDir, env, model, timeoutMs: CALL_TIMEOUT_MS });
    if (!result || result.code !== 0 || !result.text) return { error: 'provider', errorClass: 'provider' };
    return { text: result.text };
  } finally {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}
