// ── Adopt Me scraper → Supabase ───────────────────────────────────────────────
// Scrapes Elvebredd every 6 hours and writes CHANGED pet values to Supabase.
// No Turso, no HTTP-triggered snapshots — a clean scheduled data feeder.

process.env.PUPPETEER_CACHE_DIR = "/opt/render/.cache/puppeteer";

const express = require("express");
const puppeteer = require("puppeteer-extra");
const chromium = require("@sparticuz/chromium");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Supabase ───────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ── Map one Elvebredd pet into its (tier × potion) variants ─────────────────────
function buildVariants(p) {
  const tiers = [
    { neon: "normal", base: p.valueNoPot ?? p.value,    fly: p.valueFly, ride: p.valueRide, flyride: p.valueFlyRide },
    { neon: "neon",   base: p.neonNoPot ?? p.neonValue, fly: p.neonFly,  ride: p.neonRide,  flyride: p.neonFlyRide },
    { neon: "mega",   base: p.megaNoPot ?? p.megaValue, fly: p.megaFly,  ride: p.megaRide,  flyride: p.megaFlyRide },
  ];
  const out = [];
  for (const t of tiers) {
    if (t.base    != null) out.push({ neon: t.neon, fly: false, ride: false, value: t.base });
    if (t.fly     != null) out.push({ neon: t.neon, fly: true,  ride: false, value: t.fly });
    if (t.ride    != null) out.push({ neon: t.neon, fly: false, ride: true,  value: t.ride });
    if (t.flyride != null) out.push({ neon: t.neon, fly: true,  ride: true,  value: t.flyride });
  }
  return out;
}
// ── Daily net-worth snapshot for every user ─────────────────────────────────────
async function snapshotAllPortfolios() {
  // 1) latest value per variant (one read)
  const { data: vals, error: valErr } = await supabase
    .from("current_pet_values").select("pet_variant_id, value");
  if (valErr) throw valErr;
  const valueByVariant = new Map(vals.map(v => [v.pet_variant_id, Number(v.value)]));

  // 2) every user's holdings (one read)
  const { data: items, error: itemErr } = await supabase
    .from("portfolio_items").select("user_id, pet_variant_id, quantity");
  if (itemErr) throw itemErr;
  if (!items.length) { console.log("[snapshot] no portfolios to snapshot"); return; }

  // 3) group holdings by user and compute totals
  const byUser = new Map();
  for (const it of items) {
    const unit = valueByVariant.get(it.pet_variant_id) ?? 0;
    const entry = byUser.get(it.user_id) ?? { total: 0, holdings: [] };
    entry.total += unit * it.quantity;
    entry.holdings.push({ pet_variant_id: it.pet_variant_id, quantity: it.quantity, value: unit });
    byUser.set(it.user_id, entry);
  }

  // 4) write one snapshot row per user
  const rows = [...byUser.entries()].map(([user_id, e]) => ({
    user_id, total_value: e.total, holdings: e.holdings,
  }));
  const { error: insErr } = await supabase.from("portfolio_snapshots").insert(rows);
  if (insErr) throw insErr;

  console.log(`[snapshot] saved net worth for ${rows.length} users`);
}
// ── Write changed values to Supabase (change-detection) ─────────────────────────
async function writeToSupabase(pets) {
  // 1) upsert the catalog (fixed set — upsert updates, never duplicates)
  const petRows = pets.map(p => ({ name: p.name, rarity: p.rarity, icon_url: p.image }));
  const { data: petData, error: petErr } = await supabase
    .from("pets").upsert(petRows, { onConflict: "name" }).select("id, name");
  if (petErr) throw petErr;
  const petId = new Map(petData.map(r => [r.name, r.id]));

  // 2) upsert the variants
  const variantRows = [];
  for (const p of pets) {
    const id = petId.get(p.name);
    if (!id) continue;
    for (const v of buildVariants(p)) variantRows.push({ pet_id: id, neon: v.neon, fly: v.fly, ride: v.ride });
  }
  const { data: varData, error: varErr } = await supabase
    .from("pet_variants").upsert(variantRows, { onConflict: "pet_id,neon,fly,ride" })
    .select("id, pet_id, neon, fly, ride");
  if (varErr) throw varErr;
  const variantId = new Map(varData.map(r => [`${r.pet_id}|${r.neon}|${r.fly}|${r.ride}`, r.id]));

  // 3) latest stored value per variant (for change-detection)
  const { data: currentVals, error: curErr } = await supabase
    .from("current_pet_values").select("pet_variant_id, value");
  if (curErr) throw curErr;
  const lastValue = new Map(currentVals.map(r => [r.pet_variant_id, Number(r.value)]));

  // 4) APPEND only the values that actually changed (or are brand new)
  const valueRows = [];
  for (const p of pets) {
    const id = petId.get(p.name);
    if (!id) continue;
    for (const v of buildVariants(p)) {
      const vid = variantId.get(`${id}|${v.neon}|${v.fly}|${v.ride}`);
      if (vid == null) continue;
      if (lastValue.get(vid) === Number(v.value)) continue;  // unchanged → skip
      valueRows.push({ pet_variant_id: vid, value: v.value });
    }
  }

  if (!valueRows.length) {
    console.log("[supabase] no value changes — nothing to store");
    return;
  }
  for (let i = 0; i < valueRows.length; i += 500) {
    const { error } = await supabase.from("pet_values").insert(valueRows.slice(i, i + 500));
    if (error) throw error;
  }
  console.log(`[supabase] stored ${valueRows.length} changed values`);
}

// ── Cache (only serves the optional debug endpoints below) ──────────────────────
let petCache = [];
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ── Scraper ──────────────────────────────────────────────────────────────────────
async function scrapeAllPets(force = false) {
  if (!force && lastFetch && Date.now() - lastFetch < CACHE_TTL) {
    console.log(`[cache] returning ${petCache.length} pets`);
    return petCache;
  }

  console.log("[scrape] launching browser...");
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  const page = await browser.newPage();
  await page.setRequestInterception(true);
  let petData = null;

  page.on("request", req => req.continue());
  page.on("response", async res => {
    try {
      const url = res.url();
      if (!url.includes("adopt-me-calculator")) return;
      const text = (await res.buffer()).toString("utf8");
      if (!text.includes("initialPets")) return;

      const marker = 'self.__next_f.push([1,';
      let searchFrom = 0;
      while (searchFrom < text.length) {
        const pushIdx = text.indexOf(marker, searchFrom);
        if (pushIdx === -1) break;
        const strStart = pushIdx + marker.length;
        if (text[strStart] !== '"') { searchFrom = strStart; continue; }
        let strEnd = strStart + 1;
        while (strEnd < text.length) {
          if (text[strEnd] === '\\') { strEnd += 2; continue; }
          if (text[strEnd] === '"') break;
          strEnd++;
        }
        const jsonStr = text.slice(strStart, strEnd + 1);
        if (!jsonStr.includes("initialPets")) { searchFrom = strEnd; continue; }
        const unescaped = JSON.parse(jsonStr);
        const idx = unescaped.indexOf('"initialPets":[');
        if (idx === -1) { searchFrom = strEnd; continue; }
        const arrStart = unescaped.indexOf('[', idx + '"initialPets":'.length - 1);
        let depth = 0, arrEnd = arrStart;
        for (let j = arrStart; j < unescaped.length; j++) {
          if (unescaped[j] === '[' || unescaped[j] === '{') depth++;
          if (unescaped[j] === ']' || unescaped[j] === '}') depth--;
          if (depth === 0) { arrEnd = j; break; }
        }
        petData = JSON.parse(unescaped.slice(arrStart, arrEnd + 1));
        console.log(`[scrape] extracted ${petData.length} pets`);
        break;
      }
    } catch (e) {
      if (!e.message.includes("No data") && !e.message.includes("body") && !e.message.includes("Target closed"))
        console.log("[warn]", e.message);
    }
  });

  try {
    await page.goto("https://elvebredd.com/adopt-me-calculator", {
      waitUntil: "domcontentloaded", timeout: 60000,
    });
    await new Promise(r => setTimeout(r, 8000));

    if (!petData || !petData.length) throw new Error("Could not extract pet data.");

    const mapped = petData.filter(p => p.name && p.type === "pets").map(p => ({
      name: p.name,
      value:        p.rvalue ?? null,
      neonValue:    p.nvalue ?? null,
      megaValue:    p.mvalue ?? null,
      rarity:       p.rarity ?? null,
      image:        p.image ? `https://elvebredd.com${p.image}` : null,
      valueFlyRide: p["rvalue - fly&ride"] ?? null,
      valueFly:     p["rvalue - fly"]      ?? null,
      valueRide:    p["rvalue - ride"]     ?? null,
      valueNoPot:   p["rvalue - nopotion"] ?? null,
      neonFlyRide:  p["nvalue - fly&ride"] ?? null,
      neonFly:      p["nvalue - fly"]      ?? null,
      neonRide:     p["nvalue - ride"]     ?? null,
      neonNoPot:    p["nvalue - nopotion"] ?? null,
      megaFlyRide:  p["mvalue - fly&ride"] ?? null,
      megaFly:      p["mvalue - fly"]      ?? null,
      megaRide:     p["mvalue - ride"]     ?? null,
      megaNoPot:    p["mvalue - nopotion"] ?? null,
    }));

    petCache = mapped;
    lastFetch = Date.now();
    console.log(`[done] ${mapped.length} pets scraped`);
    return mapped;
  } finally {
    await browser.close();
  }
}

// ── Scheduled scrape → Supabase (runs on its own, no HTTP traffic needed) ───────
const SCRAPE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

async function scheduledScrape() {
  try {
    console.log("[auto] scheduled scrape starting...");
    const pets = await scrapeAllPets(true);   // force a fresh scrape
    await writeToSupabase(pets);
    console.log("[auto] scheduled scrape complete");
  } catch (e) {
    console.log("[auto] scrape failed:", e.message);
  }
}

// ── Routes (optional — the new app reads Supabase directly) ─────────────────────
app.get("/health", (req, res) => res.json({ ok: true, cachedPets: petCache.length }));
// Manually trigger a portfolio snapshot (for testing)
app.get("/api/snapshot", (req, res) => {
  dailySnapshotJob().catch(console.error);
  res.json({ ok: true, message: "Snapshot triggered — check logs and portfolio_snapshots." });
});
// Current cached values — handy for debugging
app.get("/api/pets/all", async (req, res) => {
  try {
    const pets = await scrapeAllPets(req.query.refresh === "true");
    res.json({ ok: true, count: pets.length, pets });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manually trigger a scrape + Supabase write (great for testing right now)
app.get("/api/scrape", (req, res) => {
  scheduledScrape().catch(console.error);
  res.json({ ok: true, message: "Scrape triggered — check the logs and Supabase." });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Adopt Me scraper running → port ${PORT}\n`);
  scheduledScrape();                              // run once right at startup
  setInterval(scheduledScrape, SCRAPE_INTERVAL);  // then every 6 hours
  console.log("[auto] scraping every 6 hours");
});
// daily portfolio snapshots
const DAY = 24 * 60 * 60 * 1000;
async function dailySnapshotJob() {
  try {
    await snapshotAllPortfolios();
  } catch (e) {
    console.log("[snapshot] failed:", e.message);
  }
}
setInterval(dailySnapshotJob, DAY);
dailySnapshotJob(); // also run once at startup so you get a point today