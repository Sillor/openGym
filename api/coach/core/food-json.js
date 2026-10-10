// Keep in lockstep with frontend/src/lib/food-json.js. The browser diary cannot import this file.
// Fence stripping follows Fud AI FoodAnalysis.kt; see NOTICE.md.

const MAX_ITEMS = 12;
const MAX_INGREDIENTS = 20;
const MAX_KCAL = 20000;
const MAX_MACRO = 2000;
const MAX_GRAMS = 20000;

/** Model text → `{ ok:true, items }` or `{ ok:false }`. One meal object, or a list of them. */
export function parseFoodAnalysis(text) {
  let value;
  try { value = JSON.parse(extractFoodJson(text)); }
  catch { return { ok: false }; }
  const foods = foodsOf(value);
  if (!foods || foods.length === 0 || foods.length > MAX_ITEMS) return { ok: false };
  const items = [];
  for (const food of foods) {
    const item = mealOf(food);
    if (!item) return { ok: false };
    items.push(item);
  }
  return { ok: true, items };
}

function extractFoodJson(text) {
  const cleaned = stripFences(text);
  const brace = cleaned.indexOf('{');
  const bracket = cleaned.indexOf('[');
  let start = -1;
  if (brace < 0) start = bracket;
  else if (bracket < 0) start = brace;
  else start = Math.min(brace, bracket);
  if (start < 0) return cleaned;
  return sliceBalanced(cleaned, start);
}

function stripFences(text) {
  let cleaned = String(text ?? '').replace(/^\uFEFF/, '').trim();
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
  return s.slice(start);
}

function foodsOf(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  if (isFood(value)) return [value];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.meals)) return value.meals;
  return null;
}

function isFood(o) {
  return typeof o.name === 'string'
    && (Object.prototype.hasOwnProperty.call(o, 'calories') || Object.prototype.hasOwnProperty.call(o, 'kcal'));
}

function mealOf(food) {
  if (!food || typeof food !== 'object' || Array.isArray(food)) return null;
  const name = typeof food.name === 'string' ? food.name.trim().slice(0, 120) : '';
  if (!name) return null;
  const header = rounded({
    kcal: finite(food, 'calories', 'kcal'),
    protein: finite(food, 'protein'),
    carbs: finite(food, 'carbs'),
    fat: finite(food, 'fat'),
    grams: finite(food, 'serving_size_grams', 'grams')
  });
  if (!header) return null;
  const ingredients = ingredientsOf(food.ingredients);
  if (!ingredients) return null;
  if (!ingredients.length) return { name, ...header };
  const sum = sumOf(ingredients);
  // A breakdown that does not add up to the meal is junk, not a second opinion.
  if (!sum || !close(sum, header)) return null;
  return { name, ...sum, ingredients };
}

function ingredientsOf(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_INGREDIENTS) return null;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 120) : '';
    const row = rounded({
      kcal: finite(item, 'calories', 'kcal'),
      protein: finite(item, 'protein'),
      carbs: finite(item, 'carbs'),
      fat: finite(item, 'fat'),
      grams: finite(item, 'grams', 'serving_size_grams')
    });
    if (!name || !row) return null;
    out.push({ name, ...row });
  }
  return out;
}

function sumOf(list) {
  const raw = { kcal: 0, protein: 0, carbs: 0, fat: 0, grams: 0 };
  for (const item of list) {
    raw.kcal += item.kcal;
    raw.protein += item.protein;
    raw.carbs += item.carbs;
    raw.fat += item.fat;
    raw.grams += item.grams;
  }
  return rounded(raw);
}

function close(sum, header) {
  return near(sum.kcal, header.kcal, 5)
    && near(sum.protein, header.protein, 1)
    && near(sum.carbs, header.carbs, 1)
    && near(sum.fat, header.fat, 1)
    && near(sum.grams, header.grams, 5);
}

function near(sum, total, floor) {
  const tol = Math.max(floor, Math.abs(total) * 0.15);
  return Math.abs(sum - total) <= tol + 1e-6;
}

function finite(obj, ...keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const v = obj[key];
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  return null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function rounded(raw) {
  if (raw.kcal == null || raw.protein == null || raw.carbs == null || raw.fat == null || raw.grams == null) return null;
  const kcal = Math.round(raw.kcal);
  const protein = round1(raw.protein);
  const carbs = round1(raw.carbs);
  const fat = round1(raw.fat);
  const grams = round1(raw.grams);
  if (!Number.isInteger(kcal) || kcal < 0 || kcal > MAX_KCAL) return null;
  if ([protein, carbs, fat].some(n => n < 0 || n > MAX_MACRO)) return null;
  if (!(grams > 0) || grams > MAX_GRAMS) return null;
  return { kcal, protein, carbs, fat, grams };
}
