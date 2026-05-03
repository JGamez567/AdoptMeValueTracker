const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({ headless: false, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  await page.setRequestInterception(true);
  let petData = null;

  page.on("request", req => req.continue());

  page.on("response", async res => {
    try {
      const url = res.url();
      if (!url.includes("adopt-me-calculator")) return;
      const buffer = await res.buffer();
      const text = buffer.toString("utf8");
      if (!text.includes("initialPets")) return;

      console.log("Found! Extracting...");

      // Find the opening quote of the string after [1,
      const marker = 'self.__next_f.push([1,';
      let searchFrom = 0;
      while (searchFrom < text.length) {
        const pushIdx = text.indexOf(marker, searchFrom);
        if (pushIdx === -1) break;

        const strStart = pushIdx + marker.length;
        if (text[strStart] !== '"') { searchFrom = strStart; continue; }

        // Find end of the JSON string
        let strEnd = strStart + 1;
        while (strEnd < text.length) {
          if (text[strEnd] === '\\') { strEnd += 2; continue; }
          if (text[strEnd] === '"') break;
          strEnd++;
        }

        const jsonStr = text.slice(strStart, strEnd + 1);
        
        if (!jsonStr.includes("initialPets")) { searchFrom = strEnd; continue; }

        // Properly parse the JSON string to unescape everything
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
        console.log("Got", petData.length, "pets!");
        console.log("Sample:", JSON.stringify(petData.slice(0, 2), null, 2));
        break;
      }
    } catch(e) {
      if (!e.message.includes("No data") && !e.message.includes("body")) {
        console.log("error:", e.message);
      }
    }
  });

  await page.goto("https://elvebredd.com/adopt-me-calculator", { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  if (!petData) console.log("no pet data captured");
  await browser.close();
})();