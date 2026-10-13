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
const FOOD_TOKEN_CAP = 16384;
const REASONING_FLOOR = 8192;
const CALL_TIMEOUT_MS = 120000;
const MAX_TEXT = 8000;
const MAX_B64 = 3500000;
const MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
const CAP_FILE = 'nutrition-analyze.json';

const SPECS = { openai: openaiSpec, compatible: compatibleSpec, gemini: geminiSpec, anthropic: anthropicSpec };

const COMPACT_NOTE = '\n\nIMPORTANT: The previous response did not contain a complete answer. Return only the requested compact JSON object, with no reasoning, explanation, or markdown.';

const SCHEMA = '{"name":"...","serving_quantity":1,"serving_unit":"serving","calories":0,"protein":0.0,"carbs":0.0,"fat":0.0,"serving_size_grams":0.0,"ingredients":[]}';
const INGREDIENT = '{"name":"...","quantity":1,"unit":"g","calories":0,"protein":0.0,"carbs":0.0,"fat":0.0,"grams":0.0}';

/** Image prompt, ported from Fud AI's multi-photo / single-photo analysis. Schema is the diary's. */
export function imageFoodPrompt(description) {
  let prompt = [
    'Analyze these food images together as one meal logging request. They may show different angles of the same food, separate ingredients, kitchen-scale readings, packaging, or nutrition labels.',
    'Use every image once. Do not double-count the same food shown from multiple angles. When separate ingredients are shown, combine their nutrition into one meal total. Read visible scale weights and nutrition labels when available; prefer those measurements over visual portion estimates.',
    'Treat the photos as multiple views of the same item unless there are clearly separate foods.',
    'Respond ONLY with JSON for this one meal:',
    SCHEMA,
    'serving_quantity is a number. serving_unit is a short unit: g, ml, cup, tbsp, piece, slice, or serving. Pick a unit that fits the food: ml or cup for a liquid, piece or slice for something countable, grams when it was weighed.',
    'Calories are integers. Protein/carbs/fat are decimal gram values when needed. serving_size_grams is the estimated weight in grams of the serving shown.',
    `ingredients is required and holds at most 8 foods. Return each clearly separate food once using ${INGREDIENT}. Include grams when the weight is known. Ingredient grams and macros must describe the full meal and add up approximately to the meal totals. Do not list salt, pepper, oil spray, or similar seasonings. Return [] only when a reliable breakdown is not possible.`,
    'Give your best estimate for the visible food amount shown in the image. For whole/mostly-whole cakes, pizzas, pies, loaves, or similar foods, estimate the total visible item/remaining item weight rather than defaulting to one slice.'
  ].join('\n');
  const note = typeof description === 'string' ? description.trim() : '';
  if (note) prompt += `\n\nAdditional context from the user about this complete meal: ${note}\nApply this note to the full image set.`;
  return prompt;
}

/** Text prompt, ported from Fud AI's analyzeText. Schema is the diary's. */
export function textFoodPrompt(description) {
  return [
    `Estimate the nutritional content for: ${description}`,
    "Parse any quantities, brands, and multiple items from the text. If a brand is mentioned, use that brand's known nutritional data. If multiple items are described, sum up the total nutrition.",
    'Respond ONLY with JSON for this one meal:',
    SCHEMA,
    'serving_quantity is a number. serving_unit is a short unit: g, ml, cup, tbsp, piece, slice, or serving. Pick a unit that fits the food: ml or cup for a liquid, piece or slice for something countable, grams when it was weighed.',
    'Calories are integers. Protein/carbs/fat are decimal gram values when needed. serving_size_grams is the estimated total weight in grams.',
    `ingredients is required and holds at most 8 foods. For a meal with multiple meaningful foods, return each food once using ${INGREDIENT}. Include grams when the weight is known. Ingredient grams and macros must describe the analyzed amount and add up approximately to the meal totals. Do not list salt, pepper, oil spray, or similar seasonings. Return [] for a single simple food or when a reliable breakdown is not possible.`
  ].join('\n');
}

function isReasoningModel(model) {
  const id = String(model || '').trim();
  return /^gpt-5/.test(id) || /^gpt-6/.test(id) || /^o\d/.test(id);
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

/** One retry after finish_reason "length": compact-JSON note, budget doubled, never past 16384. */
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
    obj[key] = Math.min(FOOD_TOKEN_CAP, obj[key] * 2);
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

/**
 * One analysis for a signed-in profile. `fetchImpl` is a test seam; production uses the Coach's
 * long-timeout fetch. Returns `{ status, body }` and never writes the image bytes.
 */
export async function analyzeNutrition({ uid, body, fetchImpl } = {}) {
  const images = normalizeImages(body && body.images);
  if (images.error) return { status: 400, body: { error: 'bad request' } };
  const text = typeof (body && body.text) === 'string' ? body.text.trim().slice(0, MAX_TEXT) : '';
  if (!text && !images.list.length) return { status: 400, body: { error: 'bad request' } };

  if (!cfgStore.isEnabled() || !cfgStore.isConnected()) return { status: 503, body: { error: 'provider' } };
  const cfg = cfgStore.load();
  const adapter = adapterFor(cfg.provider);
  if (!adapter) return { status: 503, body: { error: 'provider' } };
  const cred = cfgStore.credentialFor(uid);
  if (!cred.ok) return { status: 503, body: { error: 'provider' } };

  // A spawned CLI has no vision channel. Do not hand it the photos, and do not spend a slot.
  if (images.list.length && adapter.spawns !== false) return { status: 400, body: { error: 'provider' } };
  if (adapter.spawns !== false && !canDropPrivileges().ok) return { status: 503, body: { error: 'provider' } };
  const model = cfgStore.modelFor(cfg);
  if (adapter.spawns === false && !model) return { status: 503, body: { error: 'provider' } };

  if (!takeNutritionSlot(uid)) return { status: 429, body: { error: 'cap' } };
  cfgStore.bindInstanceCredential(uid);

  const prompt = images.list.length ? imageFoodPrompt(text) : textFoodPrompt(text);
  const maxTokens = Math.min(FOOD_TOKEN_CAP, Math.max(256, cfg.maxOutputTokens || 2048));
  let raw;
  try {
    raw = adapter.spawns === false
      ? await callHttp({ provider: cfg.provider, cfg, cred, model, prompt, images: images.list, maxTokens, fetchImpl })
      : await callCli({ adapter, cfg, cred, model, prompt });
  } catch {
    return { status: 502, body: { error: 'provider' } };
  }
  if (!raw) return { status: 502, body: { error: 'provider' } };
  const parsed = parseFoodAnalysis(raw);
  if (!parsed.ok) return { status: 422, body: { error: 'parse' } };
  return { status: 200, body: parsed };
}

async function callHttp({ provider, cfg, cred, model, prompt, images, maxTokens, fetchImpl }) {
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
  let read = await postOnce(fetch, spec, base, model, key, cfg, provider, reqBody);
  if (read && read.truncated && !read.error) {
    reqBody = retryFoodBody(reqBody);
    read = await postOnce(fetch, spec, base, model, key, cfg, provider, reqBody);
    if (read && read.truncated) return null;
  }
  if (!read || read.error || !read.text) return null;
  return read.text;
}

async function postOnce(fetchImpl, spec, base, model, key, cfg, provider, body) {
  const res = await fetchImpl(endpointUrl(base, spec.path(model)), {
    method: 'POST',
    headers: { ...extraHeadersFor(provider, cfg), 'content-type': 'application/json', ...spec.headers(key || '') },
    body: JSON.stringify(body)
  });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { return { error: 'bad response' }; }
  if (!res.ok) return { error: 'provider' };
  try { return spec.readText(data); }
  catch { return { error: 'bad response' }; }
}

async function callCli({ adapter, cfg, cred, model, prompt }) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'food-'));
  try {
    const env = cfgStore.jobEnv(jobDir, cred);
    const result = await adapter.invoke({ prompt, cfg, jobDir, env, model, timeoutMs: CALL_TIMEOUT_MS });
    if (!result || result.code !== 0 || !result.text) return null;
    return result.text;
  } finally {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}
