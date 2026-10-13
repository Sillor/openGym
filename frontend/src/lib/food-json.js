// Keep in lockstep with api/coach/core/food-json.js. The browser diary cannot import the API.
// Fence stripping follows Fud AI FoodAnalysis.kt; see NOTICE.md.
//
// A model answer is read generously: one bad ingredient row is skipped, not fatal; a unit the
// list does not know is normalised ("slices" → slice, "tablespoon" → tbsp) or kept as a short
// word; an answer cut off mid-JSON is closed at its last complete value. Grams are the truth
// when they are known; the unit is how the amount is shown.

const MAX_ITEMS = 12;
const MAX_INGREDIENTS = 20;
const MAX_UNITS = 5;
const MAX_KCAL = 20000;
const MAX_MACRO = 2000;
const MAX_GRAMS = 20000;
// A breakdown this far from the meal it claims to describe is a different meal.
const SUM_TOLERANCE = 0.4;

/** Grams in one unit of mass. */
export const MASS_G = { g: 1, kg: 1000, oz: 28.35, lb: 453.6 };
/** Millilitres in one unit of volume. */
export const VOLUME_ML = { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 240, 'fl oz': 29.57 };

const ALIASES = {
  g: 'g', gr: 'g', grs: 'g', gram: 'g', grams: 'g', gramm: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ozs: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', mls: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', cc: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l', ltr: 'l',
  tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  'fl oz': 'fl oz', floz: 'fl oz', 'fl. oz': 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', item: 'piece', items: 'piece', whole: 'piece',
  slice: 'slice', slices: 'slice',
  serving: 'serving', servings: 'serving', portion: 'serving', portions: 'serving', serve: 'serving'
};

/** A unit the diary can show: a known name, or a short word ("bowl", "taco"). Null when unusable. */
export function normalizeUnit(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(ALIASES, s)) return ALIASES[s];
  if (s.length > 16 || !/^\p{L}[\p{L} ]*$/u.test(s)) return null;
  if (/(ss|ch|sh|x)es$/.test(s)) return s.slice(0, -2);
  if (/[^s]s$/.test(s) && s.length > 3) return s.slice(0, -1);
  return s;
}

/** Model text → `{ ok:true, items }` or `{ ok:false }`. One meal object, or a list of them. */
export function parseFoodAnalysis(text) {
  const value = extractFoodValue(text);
  const foods = foodsOf(value);
  if (!foods || foods.length === 0) return { ok: false };
  const items = [];
  for (const food of foods.slice(0, MAX_ITEMS)) {
    const item = mealOf(food);
    if (item) items.push(item);
  }
  if (!items.length) return { ok: false };
  return { ok: true, items };
}

/* ---------- finding the JSON ---------- */

function extractFoodValue(text) {
  const cleaned = stripFences(stripThinking(text));
  const whole = tryParse(cleaned);
  if (whole !== undefined && whole !== null && typeof whole === 'object') return whole;
  const starts = [];
  for (let i = 0; i < cleaned.length && starts.length < 20; i++) {
    if (cleaned[i] === '{' || cleaned[i] === '[') starts.push(i);
  }
  for (const start of starts) {
    const slice = sliceBalanced(cleaned, start);
    // Never closes: an answer cut off by the token limit. Close it at its last complete value,
    // before any of the complete objects nested inside it can pass for the meal.
    const value = slice == null ? repairTruncated(cleaned.slice(start)) : tryParse(slice);
    if (value !== undefined && foodsOf(value)) return value;
  }
  return null;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

function stripThinking(text) {
  return String(text ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
}

function stripFences(text) {
  let cleaned = String(text ?? '').replace(/^﻿/, '').trim();
  const lower = cleaned.toLowerCase();
  const jsonAt = lower.indexOf('```json');
  const anyAt = cleaned.indexOf('```');
  const openFence = jsonAt >= 0 ? jsonAt : anyAt;
  if (openFence >= 0) {
    const isJson = lower.startsWith('```json', openFence);
    cleaned = cleaned.slice(openFence + (isJson ? 7 : 3));
    const closeFence = cleaned.lastIndexOf('```');
    if (closeFence >= 0) cleaned = cleaned.slice(0, closeFence);
  }
  return cleaned.trim();
}

/** The balanced value starting at `start`, or null when it never closes. */
function sliceBalanced(s, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Close a cut-off JSON value at the last point where a value was complete: after a closing
 * bracket, or just before a comma. Tries the latest such point first, then earlier ones.
 */
function repairTruncated(s) {
  const safe = [];
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (!stack.length) break;
      safe.push({ end: i + 1, closers: stack.slice().reverse().join('') });
    } else if (ch === ',') {
      safe.push({ end: i, closers: stack.slice().reverse().join('') });
    }
  }
  for (let k = safe.length - 1, tries = 0; k >= 0 && tries < 40; k--, tries++) {
    const value = tryParse(s.slice(0, safe[k].end) + safe[k].closers);
    if (value !== undefined) return value;
  }
  return undefined;
}

function foodsOf(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  if (isFood(value)) return [value];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.meals)) return value.meals;
  if (Array.isArray(value.foods)) return value.foods;
  return null;
}

function isFood(o) {
  return typeof o.name === 'string'
    && ['calories', 'kcal', 'ingredients', 'protein'].some(k => Object.prototype.hasOwnProperty.call(o, k));
}

/* ---------- one meal ---------- */

function mealOf(food) {
  if (!food || typeof food !== 'object' || Array.isArray(food)) return null;
  const name = cleanName(food.name);
  if (!name) return null;
  const header = nutritionOf(food);
  const ingredients = ingredientsOf(food.ingredients);
  let totals = header;
  let rows = ingredients;
  if (ingredients.length) {
    const sum = sumOf(ingredients);
    if (!header || agrees(sum, header)) totals = sum;
    else rows = [];
  }
  if (!totals) return null;
  const knownRows = rows.length && rows.every(r => r.grams > 0);
  const headerGrams = positive(finite(food, 'serving_size_grams', 'grams', 'total_grams'));
  const amount = amountOf(food, {
    grams: knownRows ? round1(rows.reduce((n, r) => n + r.grams, 0)) : headerGrams,
    qtyKeys: ['serving_quantity', 'servingQty', 'quantity'],
    unitKeys: ['serving_unit', 'servingUnit', 'unit'],
    fallbackUnit: 'serving'
  });
  const item = {
    name,
    ...totals,
    grams: amount.grams,
    servingQty: amount.qty,
    servingUnit: amount.unit
  };
  if (amount.units.length) item.units = amount.units;
  if (rows.length) item.ingredients = rows;
  return item;
}

function ingredientsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_INGREDIENTS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = cleanName(item.name);
    const row = nutritionOf(item);
    if (!name || !row) continue;
    const amount = amountOf(item, {
      grams: positive(finite(item, 'grams', 'serving_size_grams', 'weight_g')),
      qtyKeys: ['quantity', 'qty', 'serving_quantity'],
      unitKeys: ['unit', 'serving_unit'],
      fallbackUnit: 'g'
    });
    const line = { name, ...row, grams: amount.grams, qty: amount.qty, unit: amount.unit };
    if (amount.units.length) line.units = amount.units;
    out.push(line);
  }
  return out;
}

/** Calories and macros. A missing macro is 0; missing calories come from the macros. */
function nutritionOf(obj) {
  const kcal = finite(obj, 'calories', 'kcal', 'energy_kcal');
  const protein = finite(obj, 'protein', 'protein_g');
  const carbs = finite(obj, 'carbs', 'carbohydrates', 'carbs_g');
  const fat = finite(obj, 'fat', 'fat_g');
  if (kcal == null && protein == null && carbs == null && fat == null) return null;
  const p = protein ?? 0, c = carbs ?? 0, f = fat ?? 0;
  const k = kcal ?? (p * 4 + c * 4 + f * 9);
  const out = { kcal: Math.round(k), protein: round1(p), carbs: round1(c), fat: round1(f) };
  if (!(out.kcal >= 0) || out.kcal > MAX_KCAL) return null;
  if ([out.protein, out.carbs, out.fat].some(n => !(n >= 0) || n > MAX_MACRO)) return null;
  return out;
}

function sumOf(list) {
  const raw = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const item of list) {
    raw.kcal += item.kcal;
    raw.protein += item.protein;
    raw.carbs += item.carbs;
    raw.fat += item.fat;
  }
  return { kcal: Math.round(raw.kcal), protein: round1(raw.protein), carbs: round1(raw.carbs), fat: round1(raw.fat) };
}

function agrees(sum, header) {
  const tol = Math.max(30, header.kcal * SUM_TOLERANCE);
  return Math.abs(sum.kcal - header.kcal) <= tol;
}

/**
 * How much, and in which unit. `grams` is the known weight or null. The picked unit comes from
 * `serving_unit`/`unit`; `unit_options` adds other ways to show the same amount. A count unit
 * with a known weight gets grams-per-unit, so switching units re-expresses the same food.
 */
function amountOf(obj, { grams, qtyKeys, unitKeys, fallbackUnit }) {
  const pickedUnit = normalizeUnit(firstString(obj, unitKeys));
  const pickedQty = positive(numberOf(obj, qtyKeys));
  const units = [];
  const add = (unit, g) => {
    if (!unit || unit === 'g' || units.some(u => u.unit === unit) || units.length >= MAX_UNITS) return;
    if (!(g > 0) || g > MAX_GRAMS) return;
    units.push({ unit, g: round2(g) });
  };
  const options = Array.isArray(obj.unit_options) ? obj.unit_options : Array.isArray(obj.units) ? obj.units : [];
  const listed = [];
  for (const opt of options) {
    if (!opt || typeof opt !== 'object') continue;
    const unit = normalizeUnit(opt.unit);
    if (!unit) continue;
    let g = positive(numberOf(opt, ['grams_per_unit', 'g', 'gramsPerUnit']));
    const q = positive(numberOf(opt, ['quantity', 'qty']));
    if (!g && q && grams > 0) g = grams / q;
    if (!g && MASS_G[unit]) g = MASS_G[unit];
    if (g) listed.push({ unit, g, q });
  }

  let total = grams > 0 ? grams : null;
  // No gram field, but the amount still says what it weighs: "150 g", "2 slices of 30 g", "250 ml".
  if (!total && pickedUnit && pickedQty) {
    const match = listed.find(o => o.unit === pickedUnit);
    if (MASS_G[pickedUnit]) total = pickedQty * MASS_G[pickedUnit];
    else if (match) total = pickedQty * match.g;
    else if (VOLUME_ML[pickedUnit]) total = pickedQty * VOLUME_ML[pickedUnit];
  }
  if (!total) {
    const counted = listed.find(o => o.q);
    if (counted) total = counted.q * counted.g;
  }
  total = total > 0 && total <= MAX_GRAMS ? round1(total) : null;

  if (pickedUnit && !MASS_G[pickedUnit]) {
    const per = listed.find(o => o.unit === pickedUnit)?.g
      ?? (total && pickedQty ? total / pickedQty : null)
      ?? VOLUME_ML[pickedUnit];
    add(pickedUnit, per);
  }
  for (const o of listed) add(o.unit, o.g);
  // A whole meal reads as servings, the way a plate is counted, unless it was weighed.
  if (fallbackUnit === 'serving' && total && !units.length && !(pickedUnit && MASS_G[pickedUnit])) {
    add('serving', total / (pickedQty || 1));
  }

  let unit = pickedUnit && ((MASS_G[pickedUnit] && total) || units.some(u => u.unit === pickedUnit)) ? pickedUnit : null;
  if (!unit) unit = units.length ? units[0].unit : (total ? 'g' : 'serving');
  let qty;
  if (total && unit === 'g') qty = total;
  else if (total && MASS_G[unit]) qty = total / MASS_G[unit];
  else {
    const per = units.find(u => u.unit === unit);
    qty = total && per ? total / per.g : (pickedQty || 1);
  }
  return { grams: total, qty: round3(qty), unit, units };
}

/* ---------- small readers ---------- */

function cleanName(v) {
  return typeof v === 'string' ? v.trim().slice(0, 120) : '';
}

function firstString(obj, keys) {
  for (const key of keys) {
    if (typeof obj[key] === 'string' && obj[key].trim()) return obj[key];
  }
  return null;
}

function numberOf(obj, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const n = toNumber(obj[key]);
    if (n != null) return n;
  }
  return null;
}

function finite(obj, ...keys) {
  return numberOf(obj, keys);
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(',', '.').replace(/\s*(kcal|g|ml)$/i, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function positive(n) {
  return typeof n === 'number' && n > 0 ? n : null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
