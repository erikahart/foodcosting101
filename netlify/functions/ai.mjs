// AI for recipe drafting and the weekly plan. Only signed-in members of a kitchen can use it.
// Netlify env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY (same values as config.js).
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function memberOfAKitchen(token) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key || !token) return false;
  // Asking the database for "my kitchens" with the person's own login both checks the
  // login is real and that they belong to at least one kitchen.
  const res = await fetch(`${url}/rest/v1/rpc/my_accounts`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return false;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) return json(501, { error: "AI not set up" });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(await memberOfAKitchen(token))) return json(401, { error: "Sign in first" });
  let body; try { body = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const prompt = String(body?.prompt || "");
  if (!prompt || prompt.length > 30000) return json(400, { error: "Prompt missing or too long" });
  // Optional invoice photo or PDF to read.
  const content = [];
  if (body?.file) {
    const { data, mediaType } = body.file;
    const ok = ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(mediaType);
    if (!ok || typeof data !== "string" || data.length > 5_600_000) return json(400, { error: "Send a photo or PDF under 4 MB" });
    content.push(mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: mediaType, data } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  content.push({ type: "text", text: prompt });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    // A fast model by default: Netlify stops a function after 30 seconds.
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", max_tokens: body?.file ? 8000 : 4000, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 600);
    console.error("Anthropic API error", res.status, detail);
    // A plain reason the app can show, without exposing anything sensitive.
    const reason = /credit balance|billing|purchase credits/i.test(detail) ? "credit"
      : res.status === 401 || /invalid x-api-key|authentication/i.test(detail) ? "key"
      : res.status === 403 ? "permission"
      : res.status === 404 || /model/i.test(detail) && res.status === 400 ? "model"
      : res.status === 429 ? "busy" : res.status === 529 || res.status >= 500 ? "overloaded" : "other";
    return json(502, { error: "AI service error", reason, status: res.status });
  }
  const out = await res.json();
  return json(200, { text: (out.content || []).filter(b => b.type === "text").map(b => b.text).join("\n") });
};

export const config = { path: "/api/ai" };
