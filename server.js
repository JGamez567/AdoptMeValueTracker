process.env.PUPPETEER_CACHE_DIR = "/opt/render/.cache/puppeteer";
const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: "*"
}));
app.use(express.json());

// ── History stored as a simple JSON file ──────────────────────────────────────
const HISTORY_PATH = path.join(__dirname, "history.json");

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  } catch(e) { console.log("[history] load error:", e.message); }
  return {}; // { "Bat Dragon": [ { ts, value, neonValue, megaValue }, ... ] }
}

function saveHistory(history) {
  try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(history)); }
  catch(e) { console.log("[history] save error:", e.message); }
}

function addSnapshot(pets) {
  const history = loadHistory();
  const now = Date.now();
  for (const p of pets) {
    if (!history[p.name]) history[p.name] = [];
    history[p.name].push({ ts: now, value: p.value, neonValue: p.neonValue, megaValue: p.megaValue });
    // Keep max 1000 snapshots per pet to avoid the file growing forever
    if (history[p.name].length > 1000) history[p.name] = history[p.name].slice(-1000);
  }
  saveHistory(history);
  console.log(`[history] saved snapshots for ${pets.length} pets`);
}

function getHistory(petName, range) {
  const history = loadHistory();
  // Case-insensitive match
  const key = Object.keys(history).find(k => k.toLowerCase() === petName.toLowerCase());
  if (!key) return [];

  const now = Date.now();
  const since = { day: now - 86400000, month: now - 2592000000, year: now - 31536000000 }[range] ?? now - 2592000000;
  const all = history[key];
  const filtered = all.filter(s => s.ts >= since);
  return filtered.length >= 2 ? filtered : all; // fall back to all if not enough in range
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
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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

      console.log("[scrape] found pet data, extracting...");
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
    console.log("[scrape] loading page...");
    await page.goto("https://elvebredd.com/adopt-me-calculator", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    await new Promise(r => setTimeout(r, 3000));

    if (!petData || petData.length === 0) throw new Error("Could not extract pet data from page.");

    const mapped = petData
      .filter(p => p.name && p.type === "pets")
      .map(p => ({
        name: p.name,
        value: p.rvalue ?? null,
        neonValue: p.nvalue ?? null,
        megaValue: p.mvalue ?? null,
        rarity: p.rarity ?? null,
        image: p.image ? `https://elvebredd.com${p.image}` : null,
      }));

    petCache = mapped;
    lastFetch = Date.now();
    addSnapshot(mapped);
    console.log(`[done] ${mapped.length} pets cached & saved to history`);
    return mapped;
  } finally {
    await browser.close();
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, cachedPets: petCache.length }));

app.get("/api/pets/all", async (req, res) => {
  try {
    const pets = await scrapeAllPets(req.query.refresh === "true");
    res.json({ ok: true, count: pets.length, pets });
  } catch (err) {
    console.error("[error]", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
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

app.get("/api/pet/:name/history", (req, res) => {
  const petName = decodeURIComponent(req.params.name);
  const range = req.query.range ?? "day";
  const history = getHistory(petName, range);
  const note = history.length < 2 ? "Not enough data yet — keep refreshing to build up history" : null;
  res.json({ ok: true, pet: petName, range, history, note });
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

app.listen(PORT, () => {
  console.log(`\n✅  Adopt Me proxy running → http://localhost:${PORT}`);
  console.log(`   http://localhost:${PORT}/api/pets/all`);
  console.log(`   http://localhost:${PORT}/api/pet/Bat%20Dragon\n`);
  if (fs.existsSync(HISTORY_PATH)) {
    const h = loadHistory();
    console.log(`[history] loaded existing history for ${Object.keys(h).length} pets`);
  } else {
    console.log("[history] no history file yet — will be created on first scrape");
  }
  // Save a snapshot every 30 minutes automatically
  setInterval(autoSnapshot, SNAPSHOT_INTERVAL);
  console.log("[auto-snapshot] will save every 30 minutes");
});

// ── Auto-snapshot every 30 minutes ───────────────────────────────────────────
// This runs independently of user requests so history builds up automatically
const SNAPSHOT_INTERVAL = 30 * 60 * 1000; // 30 minutes

async function autoSnapshot() {
  if (petCache.length === 0) return; // nothing cached yet
  console.log("[auto-snapshot] saving snapshot...");
  addSnapshot(petCache);
}

// Remove the last line (app.listen) and re-add with interval