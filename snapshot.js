// snapshot.js
// Run-once daily net-worth snapshot for GitHub Actions.
// Computes each user's total portfolio value from CURRENT values and writes one
// portfolio_snapshots row per user, then EXITS.
//
// Writes source: 'scraper' EXPLICITLY. This keeps these rows:
//   - OUT of the leaderboard (get_leaderboard only counts source = 'submit')
//   - IN the portfolio net-worth graph (that query reads all sources for the user)
//
// Env (from GitHub repo secrets): SUPABASE_URL, SUPABASE_SECRET_KEY (service_role).

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

async function snapshotAllPortfolios() {
  // 1) latest value per variant
  const { data: vals, error: valErr } = await supabase
    .from("current_pet_values").select("pet_variant_id, value");
  if (valErr) throw valErr;
  const valueByVariant = new Map(vals.map(v => [v.pet_variant_id, Number(v.value)]));

  // 2) every user's holdings
  const { data: items, error: itemErr } = await supabase
    .from("portfolio_items").select("user_id, pet_variant_id, quantity");
  if (itemErr) throw itemErr;
  if (!items.length) { console.log("[snapshot] no portfolios to snapshot"); return 0; }

  // 3) group by user, compute totals
  const byUser = new Map();
  for (const it of items) {
    const unit = valueByVariant.get(it.pet_variant_id) ?? 0;
    const entry = byUser.get(it.user_id) ?? { total: 0, holdings: [] };
    entry.total += unit * it.quantity;
    entry.holdings.push({ pet_variant_id: it.pet_variant_id, quantity: it.quantity, value: unit });
    byUser.set(it.user_id, entry);
  }

  // 4) one snapshot row per user — source explicitly 'scraper'
  const rows = [...byUser.entries()].map(([user_id, e]) => ({
    user_id,
    total_value: e.total,
    holdings: e.holdings,
    source: "scraper",
  }));

  // insert in chunks to be safe with large user counts
  for (let i = 0; i < rows.length; i += 500) {
    const { error: insErr } = await supabase.from("portfolio_snapshots").insert(rows.slice(i, i + 500));
    if (insErr) throw insErr;
  }
  console.log(`[snapshot] saved net worth for ${rows.length} users`);
  return rows.length;
}

(async () => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY env vars.");
    }
    console.log("[run] daily snapshot starting…");
    await snapshotAllPortfolios();
    console.log("[run] snapshot complete ✅");
    process.exit(0);
  } catch (e) {
    console.error("[run] snapshot FAILED ❌:", e.message);
    process.exit(1);s
  }
})();