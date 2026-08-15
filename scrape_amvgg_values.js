// scrape_amvgg_values.js
// Run-once AMVGG *value* scraper for GitHub Actions.
//
// Sibling of scrape_demand.js. That one takes name + demand stars; this one
// takes name + the 12 variant values. They MUST agree about pet identity, so
// norm() and OVERRIDES below are copied verbatim from scrape_demand.js —
// if you change one, change BOTH, or you'll get demand hearts on one row and
// values on a different row for the same pet.
//
// HOW IT WORKS (verified by probe_amvgg.js):
//   - Every card is a [data-pet-name] div on https://amvgg.com/values/pets
//   - Each card has its own F / R / N / M toggle buttons
//   - Clicking a pill re-renders that card's value CLIENT-SIDE — zero network
//     requests — so cycling 760 pets x 12 states is cheap and un-rate-limited
//   - Cards use `content-visibility: auto`, which skips PAINT but not DOM.
//     Elements exist and .click() works whether or not they're on screen.
//   - Active pills carry a solid bg class; inactive ones carry "bg-white/5".
//     That's how we read current state instead of assuming it.
//
// ── AMVGG KEEPS NO HISTORY ───────────────────────────────────────────────────
// Elvebredd rows in pet_values are a real append-only time series (graphs,
// Rising/Falling, portfolio history all read it). AMVGG is NOT. It exists for
// exactly one feature — the Trade Calculator's "see if it's a win on AMVGG"
// toggle — which only ever reads the CURRENT value. So after each run we prune
// every AMVGG row that isn't the newest for its variant.
//
// The order is INSERT THEN PRUNE, never the reverse. Deleting first would
// leave a window where the calculator finds no AMVGG value and shows the
// "no value" warning on every pet mid-trade.
//
// UNIT WARNING: AMVGG values are NOT in the same unit as Elvebredd. A Bat
// Dragon is 4.97 here and thousands on Elvebredd. These are separate scales
// and must never be summed, averaged, or compared with each other. That's why
// pet_values.source exists and why the leaderboard stays Elvebredd-only.
//
// We scrape the BASELESS tab only (the default). "Frost" and "Ride Pot" are
// the same values denominated in a different pet — not extra data.
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

const SOURCE = "amvgg";
const LIST_URL = "https://amvgg.com/values/pets";

// Process cards in chunks so no single page.evaluate() runs for minutes and
// trips Puppeteer's protocol timeout.
const CHUNK = 20;

// ── Manual override map — KEEP IN SYNC WITH scrape_demand.js ────────────────
const OVERRIDES = {
  // "kingbee": "King Bee",
};

// ── Name normalization — KEEP IN SYNC WITH scrape_demand.js ─────────────────
// Note AMVGG's data-pet-name is hyphenated ("Bat-Dragon"); stripping
// non-alphanumerics collapses that to the same key as Elvebredd's "Bat Dragon".
const norm = (n) =>
  (n ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

// The 12 variant states Petora tracks: neon tier x fly x ride.
const TIERS = ["normal", "neon", "mega"];
const COMBOS = [];
for (const tier of TIERS) {
  for (const fly of [false, true]) {
    for (const ride of [false, true]) {
      COMBOS.push({ tier, fly, ride });
    }
  }
}

// Parse "4.97" / "1,234.5" / "37.85" -> number. Anything non-numeric
// (dashes, "N/A", blank) returns null, meaning "no value at this variant".
function parseValue(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/,/g, "").trim();
  if (!/^\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Scrape ───────────────────────────────────────────────────────────────────
async function scrapeValues() {
  console.log("[scrape] launching browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    page.setDefaultTimeout(120000);

    await page.goto(LIST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 6000)); // hydration

    // Scroll until the card count stops growing — same approach as the demand
    // scraper. Cards are lazily ADDED to the DOM as you scroll; once added
    // they stay, even though content-visibility keeps them unpainted.
    let prevCount = -1;
    for (let i = 0; i < 80; i++) {
      const count = await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        return document.querySelectorAll("[data-pet-name]").length;
      });
      if (count === prevCount && i > 2) break;
      prevCount = count;
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log(`[scrape] ${prevCount} pet cards in the DOM after scrolling`);

    if (!prevCount || prevCount < 100) {
      throw new Error(
        `Only ${prevCount} cards found — AMVGG's markup probably changed, or the ` +
        `scroll loop stopped early. Expected 700+. Re-run probe_amvgg.js.`
      );
    }

    // Install helpers in page context once, then drive them chunk by chunk.
    await page.evaluate(() => {
      window.__petora = {
        cards: () => [...document.querySelectorAll("[data-pet-name]")],

        // A pill is INACTIVE when it carries the neutral bg class. Active pills
        // carry a solid brand background instead. Reading state beats assuming
        // it — the default varies per pet (most default to F+R on).
        isActive: (el) => !el.className.includes("bg-white/5"),

        pill: (card, letter) =>
          [...card.querySelectorAll("button")].find(
            (b) => b.textContent.trim() === letter
          ) || null,

        // The value lives in the .tabular-nums span next to the "Value" label.
        readValue: (card) => {
          const el = card.querySelector(".tabular-nums");
          return el ? el.textContent.trim() : null;
        },

        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      };
    });

    const results = [];
    for (let start = 0; start < prevCount; start += CHUNK) {
      const chunk = await page.evaluate(
        async (start, chunkSize, combos) => {
          const P = window.__petora;
          const out = [];
          const cards = P.cards();

          for (let i = start; i < Math.min(start + chunkSize, cards.length); i++) {
            const card = cards[i];
            const name = card.getAttribute("data-pet-name");
            if (!name) continue;

            const pills = {
              F: P.pill(card, "F"),
              R: P.pill(card, "R"),
              N: P.pill(card, "N"),
              M: P.pill(card, "M"),
            };

            const values = {};
            for (const combo of combos) {
              // Drive the card into the exact target state. Tier pills (N/M)
              // are mutually exclusive: turning one on turns the other off,
              // so we clear both first, then enable the one we want.
              const want = {
                F: combo.fly,
                R: combo.ride,
                N: combo.tier === "neon",
                M: combo.tier === "mega",
              };

              let reachable = true;
              // Order matters: clear tier pills before setting one.
              for (const letter of ["M", "N", "F", "R"]) {
                const el = pills[letter];
                if (!el) {
                  // Pet has no such pill (e.g. no fly potion form). Only a
                  // problem if we NEEDED it on.
                  if (want[letter]) reachable = false;
                  continue;
                }
                if (P.isActive(el) !== want[letter]) {
                  el.click();
                  await P.sleep(18);
                }
              }

              if (!reachable) {
                values[`${combo.tier}|${combo.fly}|${combo.ride}`] = null;
                continue;
              }

              await P.sleep(25); // let React commit the re-render
              values[`${combo.tier}|${combo.fly}|${combo.ride}`] = P.readValue(card);
            }

            out.push({ name, values });
          }
          return out;
        },
        start,
        CHUNK,
        COMBOS
      );

      results.push(...chunk);
      if (start % 200 === 0) {
        console.log(`[scrape] ${results.length}/${prevCount} cards read...`);
      }
    }

    console.log(`[scrape] read ${results.length} cards`);

    // Sanity check against a pet we verified by hand in the probe.
    const bat = results.find((r) => norm(r.name) === "batdragon");
    if (bat) {
      console.log("[scrape] Bat Dragon sample:", JSON.stringify(bat.values));
    } else {
      console.log("[scrape] WARNING: Bat Dragon not found — check the name attribute");
    }

    return results;
  } finally {
    await browser.close();
  }
}

// ── Paginated read helper (invariant: REST caps every select at 1,000 rows) ──
async function readAll(table, select, tune = (q) => q) {
  const rows = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(select);
    q = tune(q);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// ── Match + write ────────────────────────────────────────────────────────────
async function writeValues(items) {
  // 1) Petora pets
  const pets = await readAll("pets", "id, name, category", (q) =>
    q.eq("category", "pet").order("id")
  );
  console.log(`[supabase] loaded ${pets.length} Petora pets`);

  const byNorm = new Map();
  for (const p of pets) {
    const k = norm(p.name);
    if (byNorm.has(k)) {
      console.log(`[match] Petora name collision (dupes?): "${byNorm.get(k).name}" vs "${p.name}"`);
      continue;
    }
    byNorm.set(k, p);
  }
  const byExact = new Map(pets.map((p) => [p.name, p]));

  // 2) all variants for those pets — ~9k rows, MUST paginate
  const variants = await readAll(
    "pet_variants",
    "id, pet_id, neon, fly, ride",
    (q) => q.order("id")
  );
  console.log(`[supabase] loaded ${variants.length} pet_variants`);

  const variantKey = (petId, tier, fly, ride) => `${petId}|${tier}|${fly}|${ride}`;
  const variantByKey = new Map(
    variants.map((v) => [variantKey(v.pet_id, v.neon, v.fly, v.ride), v.id])
  );

  // 3) current AMVGG values, so we only write on CHANGE.
  //
  //    Still worth doing even though we prune: an unchanged value that gets
  //    re-inserted and then pruned is a pointless write plus a pointless
  //    delete, and it churns the table's dead-tuple count for nothing.
  //
  //    current_pet_values is a DISTINCT ON view, so this reads correctly
  //    whether there's one AMVGG row behind each variant or a hundred — which
  //    means the prune can never break the change detection.
  const current = await readAll(
    "current_pet_values",
    "pet_variant_id, value, source",
    (q) => q.eq("source", SOURCE).order("pet_variant_id")
  );
  console.log(`[supabase] ${current.length} existing ${SOURCE} values`);
  const currentByVariant = new Map(
    current.map((c) => [c.pet_variant_id, Number(c.value)])
  );

  // 4) build the insert set
  const inserts = [];
  const unmatched = [];
  let noVariantRow = 0;
  let unparsed = 0;
  let unchanged = 0;

  for (const item of items) {
    const k = norm(item.name);
    let pet = null;
    if (OVERRIDES[k]) pet = byExact.get(OVERRIDES[k]) ?? null;
    if (!pet) pet = byNorm.get(k) ?? null;
    if (!pet) { unmatched.push(item.name); continue; }

    for (const combo of COMBOS) {
      const cellKey = `${combo.tier}|${combo.fly}|${combo.ride}`;
      const value = parseValue(item.values[cellKey]);
      if (value == null) { unparsed++; continue; }

      const vid = variantByKey.get(
        variantKey(pet.id, combo.tier, combo.fly, combo.ride)
      );
      if (!vid) { noVariantRow++; continue; }

      const prev = currentByVariant.get(vid);
      if (prev != null && Math.abs(prev - value) < 1e-9) { unchanged++; continue; }

      inserts.push({ pet_variant_id: vid, value, source: SOURCE });
    }
  }

  console.log(
    `[match] pets matched: ${items.length - unmatched.length}/${items.length} · ` +
    `unmatched: ${unmatched.length}`
  );
  console.log(
    `[values] to insert: ${inserts.length} · unchanged: ${unchanged} · ` +
    `no value on AMVGG: ${unparsed} · no Petora variant row: ${noVariantRow}`
  );
  if (unmatched.length) {
    console.log("[match] UNMATCHED AMVGG names (add to OVERRIDES if they exist on Petora):");
    console.log("        " + unmatched.join(" | "));
  }

  if (!inserts.length) {
    console.log("[supabase] no value changes — nothing to store");
    return;
  }

  // 5) INSERT, not upsert. pet_values is structurally an append-only table
  //    (Elvebredd genuinely uses it as one), so we add rows here and let the
  //    prune step below collapse AMVGG back down to current afterwards.
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await supabase.from("pet_values").insert(inserts.slice(i, i + 500));
    if (error) throw error;
    console.log(`[supabase] inserted ${Math.min(i + 500, inserts.length)}/${inserts.length}`);
  }
  console.log(`[supabase] stored ${inserts.length} ${SOURCE} values ✅`);
}

// ── Prune superseded AMVGG rows ──────────────────────────────────────────────
// Keeps exactly one AMVGG row per variant: the newest. Elvebredd rows are
// never touched — the SQL function filters on source itself.
//
// Deliberately NOT fatal. By the time this runs the values are already stored
// and correct; a failed prune only means some extra rows survive until next
// run, which is not worth failing a workflow (and going red) over. It warns
// loudly instead so a persistent failure is still visible in the log.
async function pruneHistory() {
  console.log(`[prune] collapsing ${SOURCE} history to current values…`);
  const { data, error } = await supabase.rpc("prune_amvgg_values");
  if (error) {
    console.log(`[prune] WARNING: prune failed (values are still correct): ${error.message}`);
    return;
  }
  console.log(`[prune] removed ${data ?? 0} superseded ${SOURCE} row(s) ✅`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars.");
    }
    console.log(`[run] ${SOURCE} value scrape starting…`);
    const items = await scrapeValues();
    await writeValues(items);
    // Runs unconditionally — writeValues() returns early when nothing changed,
    // so putting this inside it would skip the prune on no-change runs and let
    // leftovers from a previously failed prune sit around indefinitely.
    await pruneHistory();
    console.log(`[run] ${SOURCE} value scrape complete ✅`);
    process.exit(0);
  } catch (e) {
    console.error(`[run] ${SOURCE} value scrape FAILED ❌:`, e.message);
    process.exit(1);
  }
})();