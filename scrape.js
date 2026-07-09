// scrape.js
// Run-once Elvebredd value scraper for GitHub Actions.
// Scrapes the calculator, writes CHANGED pet/egg/pet-wear values to Supabase,
// then EXITS. No Express / no server / no setInterval — the workflow cron is
// the scheduler.
//
// Env (from GitHub repo secrets): SUPABASE_URL, SUPABASE_SECRET_KEY (service_role).
//
// v3: catalog identity is (name, category) — Elvebredd reuses names across
// categories (e.g. a pet and a pet-wear item can share a name), so upserts key
// on both, and same-key duplicates within one scrape are collapsed before
// writing (postgres forbids one upsert batch touching the same row twice).

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { createClient } = require("@supabase/supabase-js");

puppeteer.use(StealthPlugin());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ── Which Elvebredd item types we ingest, and the category each maps to ──────
// Types seen in the wild: pets, toys, strollers, gifts, other, food, pet wear,
// vehicles, eggs, stickers. Only these three are ingested; the rest are logged
// and skipped. Add lines here if you ever want more.
const TYPE_TO_CATEGORY = {
  "pets": "pet",
  "eggs": "egg",
  "pet wear": "pet_wear",
};

const catKey = (name, category) => `${name}|${category}`;

// ── Map one Elvebredd item into its (tier × potion) variants ─────────────────
// Eggs and pet wear have no neon/mega tiers and no potions, so their rows only
// carry a base value → a single (normal, no-fly, no-ride) variant.
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

// ── Write changed values to Supabase (change-detection) ─────────────────────
async function writeToSupabase(items) {
  // 0) collapse duplicates within this scrape: one row per (name, category).
  //    (Two identical entries in Elvebredd's payload would otherwise make the
  //    upsert touch the same row twice → postgres error.)
  const seen = new Map();
  for (const p of items) {
    const k = catKey(p.name, p.category);
    if (!seen.has(k)) seen.set(k, p);
  }
  const unique = [...seen.values()];
  if (unique.length !== items.length) {
    console.log(`[supabase] collapsed ${items.length - unique.length} duplicate (name, category) rows`);
  }

  // 1) upsert the catalog — identity is (name, category)
  const petRows = unique.map(p => ({
    name: p.name,
    rarity: p.rarity,
    icon_url: p.image,
    category: p.category,
  }));
  const { data: petData, error: petErr } = await supabase
    .from("pets").upsert(petRows, { onConflict: "name,category" })
    .select("id, name, category");
  if (petErr) throw petErr;
  const petId = new Map(petData.map(r => [catKey(r.name, r.category), r.id]));

  // 2) upsert the variants
  const variantRows = [];
  for (const p of unique) {
    const id = petId.get(catKey(p.name, p.category));
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

  // 4) APPEND only values that actually changed (or are brand new)
  const valueRows = [];
  for (const p of unique) {
    const id = petId.get(catKey(p.name, p.category));
    if (!id) continue;
    for (const v of buildVariants(p)) {
      const vid = variantId.get(`${id}|${v.neon}|${v.fly}|${v.ride}`);
      if (vid == null) continue;
      if (lastValue.get(vid) === Number(v.value)) continue;   // unchanged → skip
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

// ── Scraper ─────────────────────────────────────────────────────────────────
async function scrapeAllItems() {
  console.log("[scrape] launching browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
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
        console.log(`[scrape] extracted ${petData.length} items`);
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

    // Log the distinct type strings Elvebredd uses, so unmatched categories
    // are visible in the Actions log instead of silently dropped.
    const typeCounts = {};
    for (const p of petData) {
      const t = (p.type ?? "(none)").toLowerCase();
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }
    console.log("[scrape] item types found:", JSON.stringify(typeCounts));
    const unmatched = Object.keys(typeCounts).filter(t => !(t in TYPE_TO_CATEGORY) && t !== "(none)");
    if (unmatched.length) {
      console.log(`[scrape] skipped types (add to TYPE_TO_CATEGORY to ingest): ${unmatched.join(", ")}`);
    }

    const mapped = petData
      .filter(p => p.name && TYPE_TO_CATEGORY[(p.type ?? "").toLowerCase()])
      .map(p => ({
        name: p.name,
        category:     TYPE_TO_CATEGORY[(p.type ?? "").toLowerCase()],
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

    const byCat = {};
    for (const m of mapped) byCat[m.category] = (byCat[m.category] ?? 0) + 1;
    console.log(`[done] ${mapped.length} items scraped:`, JSON.stringify(byCat));
    return mapped;
  } finally {
    await browser.close();
  }
}

// ── Main (run once, then exit) ──────────────────────────────────────────────
(async () => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars.");
    }
    console.log("[run] scrape starting…");
    const items = await scrapeAllItems();
    await writeToSupabase(items);
    console.log("[run] scrape complete ✅");
    process.exit(0);
  } catch (e) {
    console.error("[run] scrape FAILED ❌:", e.message);
    process.exit(1); // non-zero → GitHub marks the run failed (red ✗)
  }
})();