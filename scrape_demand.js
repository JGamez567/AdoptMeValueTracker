// scrape_demand.js
// Run-once AMVGG demand scraper for GitHub Actions.
// Scrapes https://amvgg.com/values/pets, reads each card's pet name + demand
// star count, fuzzy-matches names to Petora's `pets` rows (category = pet),
// writes the star count into pets.demand, then EXITS.
//
// We ONLY take name + demand from AMVGG. Values stay Elvebredd's — do not
// ever ingest AMVGG values here.
//
// Env (from GitHub repo secrets): SUPABASE_URL, SUPABASE_SECRET_KEY.

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { createClient } = require("@supabase/supabase-js");

puppeteer.use(StealthPlugin());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ── Manual override map ──────────────────────────────────────────────────────
// AMVGG and Elvebredd sometimes name the same pet differently. Key = the
// NORMALIZED AMVGG name (lowercase, letters+digits only), value = the EXACT
// Petora `pets.name` (Elvebredd spelling). Add lines here whenever the
// unmatched log at the end of a run shows a pet that clearly exists on both
// sites under different names.
const OVERRIDES = {
  // "kingbee": "King Bee",           // ← example format, remove when adding real ones
};

// Normalization used on BOTH sides before matching — same spirit as the
// scanner's name handling: case, spaces, punctuation, and accents all vanish,
// so "Tortuga de la Isla" and "Tortuga De La Isla" collapse to one key.
const norm = (n) =>
  (n ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]/g, "");      // strip everything but letters/digits

// ── Scrape AMVGG ─────────────────────────────────────────────────────────────
async function scrapeDemand() {
  console.log("[scrape] launching browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto("https://amvgg.com/values/pets", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await new Promise((r) => setTimeout(r, 6000)); // let hydration finish

    // The page may lazy-render cards as you scroll — scroll to the bottom
    // repeatedly until the card count stops growing.
    let prevCount = -1;
    for (let i = 0; i < 60; i++) {
      const count = await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        return document.querySelectorAll("[data-pet-name]").length;
      });
      if (count === prevCount && i > 2) break;
      prevCount = count;
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log(`[scrape] found ${prevCount} pet cards after scrolling`);

    // Each card: data-pet-name attr + a "Demand" label whose sibling holds
    // ★ characters in a .text-yellow-400 span. We count the ★s.
    const items = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("[data-pet-name]").forEach((card) => {
        const name = card.getAttribute("data-pet-name");
        if (!name) return;
        let stars = null;
        // find the span whose text is exactly "Demand", then read the
        // star span inside the same row container
        for (const label of card.querySelectorAll("span")) {
          if (label.textContent.trim().toLowerCase() !== "demand") continue;
          const row = label.parentElement;
          const starEl = row && row.querySelector(".text-yellow-400");
          const text = starEl ? starEl.textContent : "";
          const filled = (text.match(/★/g) || []).length;
          stars = filled;
          break;
        }
        out.push({ name, stars, raw: name });
      });
      return out;
    });

    const withStars = items.filter((i) => i.stars != null && i.stars > 0);
    const noStars = items.length - withStars.length;
    console.log(`[scrape] ${withStars.length} cards with demand stars, ${noStars} without`);
    if (withStars.length === 0) {
      throw new Error("Scraped 0 demand ratings — AMVGG's markup probably changed. Check the selectors.");
    }

    // sanity: log the distribution so a markup change is obvious in the log
    const dist = {};
    for (const i of withStars) dist[i.stars] = (dist[i.stars] ?? 0) + 1;
    console.log("[scrape] star distribution:", JSON.stringify(dist));

    return withStars;
  } finally {
    await browser.close();
  }
}

// ── Match + write to Supabase ────────────────────────────────────────────────
async function writeDemand(items) {
  // 1) read ALL Petora pets (category=pet), PAGINATED — Supabase REST caps
  //    every select at 1,000 rows and there are already >1,000 pets.
  const pets = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pets")
      .select("id, name, category, demand")
      .eq("category", "pet")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    pets.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`[supabase] loaded ${pets.length} Petora pets`);

  // 2) build normalized-name → pet map; log collisions (e.g. the Tortuga
  //    case-variant dupes collapse to one key — first row wins, harmless)
  const byNorm = new Map();
  for (const p of pets) {
    const k = norm(p.name);
    if (byNorm.has(k)) {
      console.log(`[match] name collision in Petora (dupes?): "${byNorm.get(k).name}" vs "${p.name}"`);
      continue;
    }
    byNorm.set(k, p);
  }
  const byExact = new Map(pets.map((p) => [p.name, p]));

  // 3) match AMVGG names → Petora pets
  const updates = [];
  const unmatched = [];
  let unchanged = 0;
  for (const item of items) {
    const k = norm(item.name);
    let pet = null;
    if (OVERRIDES[k]) pet = byExact.get(OVERRIDES[k]) ?? null;
    if (!pet) pet = byNorm.get(k) ?? null;
    if (!pet) { unmatched.push(item.name); continue; }
    if (pet.demand === item.stars) { unchanged++; continue; }
    updates.push({ name: pet.name, category: "pet", demand: item.stars });
  }

  console.log(`[match] matched: ${updates.length + unchanged} · changed: ${updates.length} · unchanged: ${unchanged} · unmatched: ${unmatched.length}`);
  if (unmatched.length) {
    console.log("[match] UNMATCHED AMVGG names (add to OVERRIDES if they exist on Petora):");
    console.log("        " + unmatched.join(" | "));
  }

  // 4) write changed demand values. Upsert on (name, category) only touches
  //    the columns we send — demand — so nothing else on the row moves.
  if (!updates.length) {
    console.log("[supabase] no demand changes — nothing to store");
    return;
  }
  for (let i = 0; i < updates.length; i += 500) {
    const { error } = await supabase
      .from("pets")
      .upsert(updates.slice(i, i + 500), { onConflict: "name,category" });
    if (error) throw error;
  }
  console.log(`[supabase] stored ${updates.length} demand updates ✅`);
}

// ── Main (run once, then exit) ──────────────────────────────────────────────
(async () => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars.");
    }
    console.log("[run] demand scrape starting…");
    const items = await scrapeDemand();
    await writeDemand(items);
    console.log("[run] demand scrape complete ✅");
    process.exit(0);
  } catch (e) {
    console.error("[run] demand scrape FAILED ❌:", e.message);
    process.exit(1);
  }
})();