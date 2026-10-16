// "Not on the menu?" on the tablet: a quick spec for a drink or dish the kitchen doesn't have a card for.
// No login on the tablet, so this only works with a valid tablet link code, and each link is capped per day.
// Netlify env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY (optional ANTHROPIC_MODEL, TABLET_AI_DAILY_CAP).
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const clean = v => String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();

async function rpc(name, args) {
  const url = clean(process.env.SUPABASE_URL), key = clean(process.env.SUPABASE_ANON_KEY);
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: key, "content-type": "application/json" }, body: JSON.stringify(args) });
  if (!res.ok) throw new Error(name + " " + res.status);
  return res.json();
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const key = clean(process.env.ANTHROPIC_API_KEY);
  if (!key) return json(501, { error: "AI isn't set up", reason: "noai" });
  let body; try { body = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const token = String(body?.token || ""), order = String(body?.order || "").trim().slice(0, 160);
  const kind = body?.kind === "food" ? "food" : "drink";
  if (token.length < 40 || !/^[A-Za-z0-9]+$/.test(token)) return json(401, { error: "Bad link", reason: "link" });
  if (!order) return json(400, { error: "What did the guest order?" });

  let ok = false, stock = [];
  try {
    ok = await rpc("book_ai_ok", { p_token: token, p_cap: Number(process.env.TABLET_AI_DAILY_CAP) || 100 });
    if (ok) stock = await rpc("book_stock", { p_token: token });
  } catch (e) { console.error("tablet-ai check failed", e.message); return json(502, { error: "Couldn't check the link", reason: "other" }); }
  if (!ok) return json(429, { error: "This tablet link is off, or today's custom builds are used up.", reason: "cap" });

  const prompt = (kind === "drink"
      ? `A guest at a small-town American diner and bar ordered a drink that isn't on the menu: "${order}". Write the standard bar spec for ONE drink a bartender can make right now.`
      : `A guest at a small-town American diner and bar asked for a dish that isn't on the menu: "${order}". Write a simple spec for ONE serving the line can make right now.`) +
    `\nWhat the kitchen and bar stock (use these names when they fit): ${(Array.isArray(stock) ? stock : []).slice(0, 300).join("; ") || "(not listed)"}` +
    `\nIf an ingredient isn't in stock, say so and suggest the closest stocked substitute. Use US bar measures (oz, dash, barspoon) or kitchen units. Keep steps short and practical, at most 8.` +
    `\nReturn ONLY JSON: {"name": string, "description": one short sentence, "glass": string or "", "garnish": string or "", "plating": string or "", ` +
    `"ingredients": [{"qty": string like "1.5 oz", "name": string, "inStock": true|false, "substitute": string or ""}], "steps": [string], "notes": string or "", ` +
    `"allergens": [from: Milk, Eggs, Fish, Shellfish, Tree nuts, Peanuts, Wheat, Soy, Sesame]}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", max_tokens: 2500, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) { console.error("tablet-ai Anthropic error", res.status, (await res.text().catch(() => "")).slice(0, 300)); return json(502, { error: "The AI service had a problem. Try again in a minute.", reason: "ai" }); }
  const out = await res.json();
  const text = (out.content || []).map(c => c.text || "").join("");
  try { const t = text.replace(/```json|```/g, ""); return json(200, { build: JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)) }); }
  catch { return json(502, { error: "The AI's answer couldn't be read. Try again.", reason: "unreadable" }); }
};

export const config = { path: "/api/tablet-ai" };
