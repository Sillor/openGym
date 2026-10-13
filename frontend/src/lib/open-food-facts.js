// Open Food Facts barcode lookup. No API key. The review sheet gets one row: per serving
// when the product has a serving quantity (or a serving size that reads as grams), and
// per 100 g otherwise, so grams stay the scale basis. A missing product is
// { ok:false, error:'missing' }. Product photos are not requested.

const FIELDS = 'product_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit'
const USER_AGENT = 'openGym/1.4 (self-hosted food diary)'
// energy_* on Open Food Facts is kilojoules. Same factor as the Android lookup.
const KJ_TO_KCAL = 0.23900573614

const round1 = n => Math.round(n * 10) / 10

/** Digits of a product barcode (EAN-8, UPC-A, EAN-13, GTIN-14), or null. */
export function normalizeBarcode(raw) {
  const code = String(raw ?? '').replace(/[\s-]/g, '')
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return null
  return code
}

/**
 * Look up a barcode. `{ ok:true, item }` or `{ ok:false, error }`.
 * `error` is invalid, missing, or network.
 * `item` is `{ name, kcal, protein, carbs, fat, grams, servingQty, servingUnit, units }`: one
 * serving when the label has one, otherwise 100 g (or 100 ml for a drink).
 * Pass `fetchImpl` in tests so the request stays off the network.
 */
export async function lookupFoodBarcode(code, { fetchImpl } = {}) {
  const barcode = normalizeBarcode(code)
  if (!barcode) return { ok: false, error: 'invalid' }
  const doFetch = fetchImpl || globalThis.fetch
  const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=${FIELDS}`
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
    })
    if (res.status === 404) return { ok: false, error: 'missing' }
    if (!res.ok) return { ok: false, error: 'network' }
    return itemFromBody(await res.json(), barcode)
  } catch {
    return { ok: false, error: 'network' }
  }
}

function itemFromBody(body, barcode) {
  const status = body && body.status
  const product = body && body.product
  if (status === 0 || status === '0' || !product || typeof product !== 'object') {
    return { ok: false, error: 'missing' }
  }
  const nutriments = product.nutriments
  if (!nutriments || typeof nutriments !== 'object' || Array.isArray(nutriments)) {
    return { ok: false, error: 'missing' }
  }
  const basis = servingBasis(product)
  const perServing = basis != null
  const grams = perServing ? basis : 100
  const scale = grams / 100
  const kcal = kcalOf(nutriments, perServing, scale)
  const protein = macro(nutriments, 'proteins', perServing, scale)
  const carbs = macro(nutriments, 'carbohydrates', perServing, scale)
  const fat = macro(nutriments, 'fat', perServing, scale)
  if (kcal == null && protein == null && carbs == null && fat == null) {
    return { ok: false, error: 'missing' }
  }
  // A drink is poured, not weighed: ml at about 1 g each, the way the label counts it.
  const liquid = isLiquid(product)
  const units = []
  if (perServing) units.push({ unit: 'serving', g: round1(grams) })
  if (liquid) units.push({ unit: 'ml', g: 1 })
  return {
    ok: true,
    item: {
      name: productName(product, barcode),
      kcal: Math.round(kcal || 0),
      protein: round1(protein || 0),
      carbs: round1(carbs || 0),
      fat: round1(fat || 0),
      grams: round1(grams),
      servingQty: perServing ? 1 : 100,
      servingUnit: perServing ? 'serving' : liquid ? 'ml' : 'g',
      units,
    },
  }
}

// Serving quantity wins. A size such as "40 g" is the same basis when quantity is absent.
function servingBasis(product) {
  const qty = flexibleDouble(product.serving_quantity)
  const raw = qty != null && qty > 0 ? qty : gramsFrom(product.serving_size)
  if (raw == null || !(raw > 0)) return null
  return round1(Math.max(raw, 1))
}

function isLiquid(product) {
  const unit = text(product.serving_quantity_unit).toLowerCase()
  if (unit === 'ml' || unit === 'l' || unit === 'cl') return true
  return /\d\s*(ml|cl|l|fl\.? oz)\b/i.test(text(product.serving_size))
}

function macro(nutriments, key, perServing, scale) {
  if (perServing) {
    const serving = flexibleDouble(nutriments[`${key}_serving`])
    if (serving != null) return serving
  }
  const per100 = flexibleDouble(nutriments[`${key}_100g`])
  if (per100 == null) return null
  return perServing ? per100 * scale : per100
}

function kcalOf(nutriments, perServing, scale) {
  const kcal = macro(nutriments, 'energy-kcal', perServing, scale)
  if (kcal != null) return kcal
  const kj = macro(nutriments, 'energy', perServing, scale)
  if (kj == null) return null
  return kj * KJ_TO_KCAL
}

function productName(product, barcode) {
  const primary = text(product.product_name)
  const brand = text(product.brands).split(',')[0].trim()
  let name = primary || brand || barcode
  if (primary && brand && !primary.toLowerCase().includes(brand.toLowerCase())) {
    name = `${brand} ${primary}`
  }
  return name.slice(0, 120)
}

function text(v) {
  return String(v ?? '').trim()
}

function flexibleDouble(v) {
  let n = null
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && v.trim()) n = Number(v.trim().replace(',', '.'))
  if (!Number.isFinite(n)) return null
  return n
}

function gramsFrom(servingSize) {
  if (servingSize == null) return null
  const raw = String(servingSize).toLowerCase().replace(/,/g, '.').replace(/fl\. oz/g, 'fl oz')
  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*(fl oz|kg|mg|g|oz|ml|l)/)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  switch (match[2]) {
    case 'kg': return value * 1000
    case 'mg': return value / 1000
    case 'oz': return value * 28.3495
    case 'fl oz': return value * 29.5735
    case 'ml': return value
    case 'l': return value * 1000
    default: return value
  }
}
