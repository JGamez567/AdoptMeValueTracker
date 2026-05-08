process.env.PUPPETEER_CACHE_DIR = "/opt/render/.cache/puppeteer";
const express = require("express");
const puppeteer = require("puppeteer-extra");
const chromium = require("@sparticuz/chromium");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cors = require("cors");
const { createClient } = require("@libsql/client");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Turso Database ────────────────────────────────────────────────────────────
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pet_name    TEXT    NOT NULL,
      value       REAL,
      neon_value  REAL,
      mega_value  REAL,
      captured_at INTEGER NOT NULL
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_pet_time ON snapshots(pet_name, captured_at)`);
  console.log("[db] Turso database ready");
}

async function cleanOldData() {
  // Delete anything older than 30 days
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const result = await db.execute({
    sql: `DELETE FROM snapshots WHERE captured_at < ?`,
    args: [cutoff],
  });
  console.log(`[db] cleaned old data, removed ${result.rowsAffected} rows`);
}

async function addSnapshot(pets) {
  const now = Date.now();
  // Batch insert in chunks of 100 to avoid large transactions
  const chunkSize = 100;
  for (let i = 0; i < pets.length; i += chunkSize) {
    const chunk = pets.slice(i, i + chunkSize);
    const batch = chunk.map(p => ({
      sql: `INSERT INTO snapshots (pet_name, value, neon_value, mega_value, captured_at) VALUES (?, ?, ?, ?, ?)`,
      args: [p.name, p.value, p.neonValue, p.megaValue, now],
    }));
    await db.batch(batch);
  }
  console.log(`[db] saved ${pets.length} snapshots`);
}

// ── Trending Cache ─────────────────────────────────────────────────────────────
// Calculated server-side every 30 min — zero extra DB reads from frontend
let trendingCache = { rising: [], falling: [], calculatedAt: null };

async function calculateTrending(pets) {
  if (!pets.length) return;
  console.log("[trending] calculating rising/falling...");

  const now = Date.now();
  const DAY = 86400000;
  const oneDayAgo = now - DAY;
  const threeDaysAgo = now - (3 * DAY);
  const sevenDaysAgo = now - (7 * DAY);

  // Single query to get first and last snapshot per pet in the last 7 days
  // This is just 2 reads total regardless of pet count
  const [firstRows, lastRows] = await Promise.all([
    db.execute({
      sql: `SELECT pet_name, value, captured_at FROM snapshots
            WHERE captured_at >= ? AND captured_at <= ?
            GROUP BY pet_name
            HAVING captured_at = MIN(captured_at)`,
      args: [sevenDaysAgo, now],
    }),
    db.execute({
      sql: `SELECT pet_name, value, captured_at FROM snapshots
            WHERE captured_at >= ?
            GROUP BY pet_name
            HAVING captured_at = MAX(captured_at)`,
      args: [oneDayAgo],
    }),
  ]);

  // Also get value from 3 days ago for falling detection
  const threeDay = await db.execute({
    sql: `SELECT pet_name, value, captured_at FROM snapshots
          WHERE captured_at >= ? AND captured_at <= ?
          GROUP BY pet_name
          HAVING captured_at = MIN(captured_at)`,
    args: [threeDaysAgo, threeDaysAgo + (2 * 60 * 60 * 1000)], // within 2hr window of 3 days ago
  });

  const firstMap = new Map(firstRows.rows.map(r => [r.pet_name, Number(r.value)]));
  const lastMap  = new Map(lastRows.rows.map(r => [r.pet_name, Number(r.value)]));
  const threeDayMap = new Map(threeDay.rows.map(r => [r.pet_name, Number(r.value)]));

  const rising = [];
  const falling = [];

  for (const pet of pets) {
    const first = firstMap.get(pet.name);
    const last  = lastMap.get(pet.name);
    const threeAgo = threeDayMap.get(pet.name);

    if (first == null || last == null) continue;

    // Rising: up 1+ over the past week
    if ((last - first) >= 1) rising.push(pet.name);

    // Falling: down 1+ over 3 days (or week if no 3-day data)
    const compareVal = threeAgo ?? first;
    if ((last - compareVal) <= -1) falling.push(pet.name);
  }

  trendingCache = { rising, falling, calculatedAt: now };
  console.log(`[trending] ${rising.length} rising, ${falling.length} falling`);
}

// ── History (only called when user clicks a pet) ──────────────────────────────
async function getHistory(petName, range) {
  const now = Date.now();
  const since = {
    day:   now - 86400000,
    week:  now - 604800000,
    month: now - 2592000000,
  }[range] ?? now - 86400000;

  const result = await db.execute({
    sql: `SELECT value, neon_value, mega_value, captured_at as ts
          FROM snapshots
          WHERE LOWER(pet_name) = LOWER(?) AND captured_at >= ?
          ORDER BY captured_at ASC`,
    args: [petName, since],
  });

  const rows = result.rows.map(r => ({
    ts: Number(r.ts),
    value: r.value,
    neonValue: r.neon_value,
    megaValue: r.mega_value,
  }));

  if (rows.length >= 2) return rows;

  // Fall back to all available
  const all = await db.execute({
    sql: `SELECT value, neon_value, mega_value, captured_at as ts
          FROM snapshots WHERE LOWER(pet_name) = LOWER(?)
          ORDER BY captured_at ASC`,
    args: [petName],
  });
  return all.rows.map(r => ({
    ts: Number(r.ts), value: r.value,
    neonValue: r.neon_value, megaValue: r.mega_value,
  }));
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let petCache = [];
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000;

// ── Scraper ───────────────────────────────────────────────────────────────────
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
    } catch(e) {
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
    await addSnapshot(mapped);
    console.log(`[done] ${mapped.length} pets cached & saved`);
    return mapped;
  } finally {
    await browser.close();
  }
}

// ── Auto tasks every 30 min ───────────────────────────────────────────────────
const INTERVAL = 30 * 60 * 1000;

async function autoTasks() {
  if (!petCache.length) return;
  console.log("[auto] running scheduled tasks...");
  await addSnapshot(petCache);
  await calculateTrending(petCache);
  await cleanOldData();
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, cachedPets: petCache.length }));

app.get("/api/pets/all", async (req, res) => {
  try {
    const pets = await scrapeAllPets(req.query.refresh === "true");
    // Calculate trending after first scrape
    if (trendingCache.calculatedAt === null) calculateTrending(pets).catch(console.error);
    res.json({ ok: true, count: pets.length, pets });
  } catch (err) {
    console.error("[error]", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Returns cached trending — no DB reads
app.get("/api/pets/trending", (req, res) => {
  res.json({ ok: true, ...trendingCache });
});

app.get("/api/pet/:name", async (req, res) => {
  try {
    const all = await scrapeAllPets();
    const key = req.params.name.toLowerCase();
    const pet = all.find(p => p.name.toLowerCase() === key)
              || all.find(p => p.name.toLowerCase().includes(key));
    if (!pet) return res.status(404).json({ ok: false, error: `"${req.params.name}" not found.` });
    res.json({ ok: true, ...pet });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/pet/:name/history", async (req, res) => {
  try {
    const petName = decodeURIComponent(req.params.name);
    const range = req.query.range ?? "day";
    const history = await getHistory(petName, range);
    const note = history.length < 2 ? "Not enough data yet — keep refreshing to build up history" : null;
    res.json({ ok: true, pet: petName, range, history, note });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/pets", async (req, res) => {
  const names = req.body.names || [];
  if (!names.length) return res.status(400).json({ ok: false, error: "Provide { names: [...] }" });
  try {
    const all = await scrapeAllPets();
    const results = {};
    for (const name of names) {
      const key = name.toLowerCase();
      results[name] = all.find(p => p.name.toLowerCase() === key)
                   || all.find(p => p.name.toLowerCase().includes(key))
                   || { error: "Not found" };
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/cache/clear", (req, res) => {
  petCache = []; lastFetch = 0;
  res.json({ ok: true, message: "Cache cleared" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅  Adopt Me proxy running → http://localhost:${PORT}\n`);
    setInterval(autoTasks, INTERVAL);
    console.log("[auto] tasks scheduled every 30 minutes");
  });
}).catch(err => {
  console.error("[db] Failed to connect to Turso:", err.message);
  process.exit(1);
});