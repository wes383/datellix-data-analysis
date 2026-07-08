/**
 * Deterministic test data generator for the Datellix agent eval harness.
 *
 * Generates a sales CSV dataset (~300 rows) with known schema and computes
 * exact ground-truth aggregates so the eval test cases can reference precise
 * expected values.
 *
 * Usage:
 *   node scripts/generate-test-data.mjs
 *
 * Outputs:
 *   scripts/test-data/sales.csv         — the dataset (upload as a file data source)
 *   scripts/test-data/ground-truth.json — computed aggregates (used to fill testset.ts)
 *
 * The data is deterministic (seeded PRNG) so re-running produces identical
 * output — crucial for reproducible eval runs.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "test-data");

// ============================================================
// Seeded PRNG (Linear Congruential Generator) — deterministic
// ============================================================
let _seed = 42;
function rand() {
  _seed = (_seed * 1664525 + 1013904223) % 4294967296;
  return _seed / 4294967296;
}
function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function randChoice(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function randFloat(min, max, decimals = 2) {
  const v = rand() * (max - min) + min;
  return parseFloat(v.toFixed(decimals));
}

// ============================================================
// Dimension tables
// ============================================================
const products = [
  { name: "Smartphone Pro",     category: "Electronics",     subCategory: "Phones",      basePrice: 999 },
  { name: "Laptop Air",         category: "Electronics",     subCategory: "Laptops",     basePrice: 1299 },
  { name: "Wireless Mouse",     category: "Electronics",     subCategory: "Accessories", basePrice: 29 },
  { name: "USB-C Hub",          category: "Electronics",     subCategory: "Accessories", basePrice: 49 },
  { name: "Office Chair",       category: "Furniture",       subCategory: "Chairs",      basePrice: 199 },
  { name: "Standing Desk",      category: "Furniture",       subCategory: "Tables",      basePrice: 499 },
  { name: "Wooden Bookshelf",   category: "Furniture",       subCategory: "Bookcases",   basePrice: 159 },
  { name: "Ballpoint Pen Pack", category: "Office Supplies", subCategory: "Pens",        basePrice: 12 },
  { name: "A4 Paper Ream",      category: "Office Supplies", subCategory: "Paper",       basePrice: 8 },
  { name: "3-Ring Binder",      category: "Office Supplies", subCategory: "Binders",     basePrice: 15 },
];

const regions = ["North", "South", "East", "West"];
const segments = ["Consumer", "Corporate", "Home Office"];

// ============================================================
// Generate rows
// ============================================================
const NUM_ROWS = 300;
const rows = [];

// Generate dates spread across 2023-01-01 .. 2024-12-31.
const startDate = new Date("2023-01-01");
const endDate = new Date("2024-12-31");
const daySpan = Math.round((endDate - startDate) / 86400000);

for (let i = 0; i < NUM_ROWS; i++) {
  const product = randChoice(products);
  const quantity = randInt(1, 10);

  // Sales = basePrice * quantity * (1 + up to 20% variation)
  const priceVariation = 1 + randFloat(-0.2, 0.2, 2);
  const grossSales = product.basePrice * quantity * priceVariation;

  // Discount: 0 most of the time, sometimes 5-30%
  const discountRoll = rand();
  const discount = discountRoll < 0.5 ? 0 : randChoice([0.05, 0.1, 0.15, 0.2, 0.3]);
  const sales = parseFloat((grossSales * (1 - discount)).toFixed(2));

  // Profit margin: ~15% base, but high discounts eat into it
  const margin = 0.15 + randFloat(-0.08, 0.08, 3) - discount * 0.5;
  const profit = parseFloat((sales * margin).toFixed(2));

  const dayOffset = randInt(0, daySpan);
  const orderDate = new Date(startDate);
  orderDate.setDate(orderDate.getDate() + dayOffset);
  const dateStr = orderDate.toISOString().slice(0, 10);

  rows.push({
    order_id: `ORD-${String(i + 1).padStart(4, "0")}`,
    order_date: dateStr,
    category: product.category,
    sub_category: product.subCategory,
    product_name: product.name,
    region: randChoice(regions),
    segment: randChoice(segments),
    sales: sales,
    quantity: quantity,
    discount: discount,
    profit: profit,
  });
}

// Sort by order_date for a clean time series.
rows.sort((a, b) => a.order_date.localeCompare(b.order_date));

// ============================================================
// Write CSV
// ============================================================
const columns = [
  "order_id", "order_date", "category", "sub_category",
  "product_name", "region", "segment",
  "sales", "quantity", "discount", "profit",
];

function csvEscape(val) {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const csvLines = [
  columns.join(","),
  ...rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")),
];

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "sales.csv"), csvLines.join("\n") + "\n", "utf8");
console.log(`Wrote ${rows.length} rows to ${join(OUT_DIR, "sales.csv")}`);

// ============================================================
// Compute ground truth
// ============================================================
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const round2 = (n) => parseFloat(n.toFixed(2));

// Group-by helper
function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

// --- Basic stats ---
const totalRows = rows.length;
const totalSales = round2(sum(rows.map((r) => r.sales)));
const totalProfit = round2(sum(rows.map((r) => r.profit)));
const totalQuantity = sum(rows.map((r) => r.quantity));
const avgSales = round2(totalSales / totalRows);
const avgDiscount = round2(sum(rows.map((r) => r.discount)) / totalRows);
const uniqueProducts = new Set(rows.map((r) => r.product_name)).size;

// --- By category ---
const byCategory = groupBy(rows, (r) => r.category);
const categoryStats = {};
for (const [cat, items] of byCategory) {
  categoryStats[cat] = {
    count: items.length,
    totalSales: round2(sum(items.map((r) => r.sales))),
    totalProfit: round2(sum(items.map((r) => r.profit))),
  };
}
const topCategoryBySales = Object.entries(categoryStats)
  .sort((a, b) => b[1].totalSales - a[1].totalSales)[0];
const topCategoryByCount = Object.entries(categoryStats)
  .sort((a, b) => b[1].count - a[1].count)[0];

// --- By region ---
const byRegion = groupBy(rows, (r) => r.region);
const regionStats = {};
for (const [reg, items] of byRegion) {
  regionStats[reg] = {
    count: items.length,
    totalSales: round2(sum(items.map((r) => r.sales))),
  };
}
const topRegionBySales = Object.entries(regionStats)
  .sort((a, b) => b[1].totalSales - a[1].totalSales)[0];

// --- By segment ---
const bySegment = groupBy(rows, (r) => r.segment);
const segmentStats = {};
for (const [seg, items] of bySegment) {
  segmentStats[seg] = {
    count: items.length,
    totalSales: round2(sum(items.map((r) => r.sales))),
  };
}

// --- By sub_category ---
const bySubCategory = groupBy(rows, (r) => r.sub_category);
const subCategorySales = {};
for (const [sc, items] of bySubCategory) {
  subCategorySales[sc] = round2(sum(items.map((r) => r.sales)));
}
const top5SubCategoriesBySales = Object.entries(subCategorySales)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([sc, sales]) => ({ sub_category: sc, sales }));

// --- Monthly sales (for time series / forecast) ---
const byMonth = groupBy(rows, (r) => r.order_date.slice(0, 7));
const monthlySales = [];
for (const [month, items] of [...byMonth.entries()].sort()) {
  monthlySales.push({
    month,
    totalSales: round2(sum(items.map((r) => r.sales))),
    orderCount: items.length,
  });
}

// --- Top products by sales ---
const byProduct = groupBy(rows, (r) => r.product_name);
const productSales = {};
for (const [p, items] of byProduct) {
  productSales[p] = round2(sum(items.map((r) => r.sales)));
}
const top5ProductsBySales = Object.entries(productSales)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([p, sales]) => ({ product_name: p, sales }));

// --- Profit by region ---
const profitByRegion = {};
for (const [reg, items] of byRegion) {
  profitByRegion[reg] = round2(sum(items.map((r) => r.profit)));
}

// --- Discount distribution ---
const discountBuckets = { "0": 0, "0.05": 0, "0.1": 0, "0.15": 0, "0.2": 0, "0.3": 0 };
for (const r of rows) {
  const key = String(r.discount);
  if (key in discountBuckets) discountBuckets[key]++;
}

// --- Loss-making orders (profit < 0) ---
const lossOrders = rows.filter((r) => r.profit < 0);
const lossCount = lossOrders.length;
const totalLoss = round2(sum(lossOrders.map((r) => r.profit)));

// --- Date range ---
const dateRange = {
  min: rows[0].order_date,
  max: rows[rows.length - 1].order_date,
};

const groundTruth = {
  schema: {
    tableName: "sales",
    columns: columns.map((c) => ({
      name: c,
      type: ["sales", "discount", "profit"].includes(c)
        ? "number"
        : c === "quantity"
          ? "integer"
          : "text",
    })),
  },
  basic: {
    totalRows,
    totalSales,
    totalProfit,
    totalQuantity,
    avgSales,
    avgDiscount,
    uniqueProducts,
    dateRange,
  },
  byCategory: categoryStats,
  topCategoryBySales: { category: topCategoryBySales[0], ...topCategoryBySales[1] },
  topCategoryByCount: { category: topCategoryByCount[0], ...topCategoryByCount[1] },
  byRegion: regionStats,
  topRegionBySales: { region: topRegionBySales[0], ...topRegionBySales[1] },
  bySegment: segmentStats,
  top5SubCategoriesBySales,
  top5ProductsBySales,
  monthlySales,
  profitByRegion,
  discountDistribution: discountBuckets,
  lossOrders: { count: lossCount, totalLoss },
};

writeFileSync(
  join(OUT_DIR, "ground-truth.json"),
  JSON.stringify(groundTruth, null, 2),
  "utf8",
);
console.log(`Wrote ground truth to ${join(OUT_DIR, "ground-truth.json")}`);

// Print a summary for quick reference.
console.log("\n=== Ground Truth Summary ===");
console.log(`Total rows:         ${totalRows}`);
console.log(`Total sales:        ${totalSales}`);
console.log(`Total profit:       ${totalProfit}`);
console.log(`Total quantity:     ${totalQuantity}`);
console.log(`Avg sales/order:    ${avgSales}`);
console.log(`Avg discount:       ${avgDiscount}`);
console.log(`Unique products:    ${uniqueProducts}`);
console.log(`Date range:         ${dateRange.min} .. ${dateRange.max}`);
console.log(`Top category (sales): ${topCategoryBySales[0]} = ${topCategoryBySales[1].totalSales}`);
console.log(`Top region (sales):   ${topRegionBySales[0]} = ${topRegionBySales[1].totalSales}`);
console.log(`Loss-making orders:   ${lossCount} (total loss ${totalLoss})`);
console.log(`Monthly data points:  ${monthlySales.length}`);
console.log("\nTop 5 sub-categories by sales:");
for (const s of top5SubCategoriesBySales) {
  console.log(`  ${s.sub_category.padEnd(15)} ${s.sales}`);
}
console.log("\nTop 5 products by sales:");
for (const p of top5ProductsBySales) {
  console.log(`  ${p.product_name.padEnd(22)} ${p.sales}`);
}
console.log("\nCategory breakdown:");
for (const [cat, s] of Object.entries(categoryStats)) {
  console.log(`  ${cat.padEnd(18)} count=${s.count}  sales=${s.totalSales}  profit=${s.totalProfit}`);
}
console.log("\nRegion breakdown:");
for (const [reg, s] of Object.entries(regionStats)) {
  console.log(`  ${reg.padEnd(8)} count=${s.count}  sales=${s.totalSales}`);
}
