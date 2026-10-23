// Creates an AI picture of a dish for its recipe card, using OpenAI's image API.
// Netlify env vars: OPENAI_API_KEY (required to switch this on), optional OPENAI_IMAGE_MODEL,
// plus SUPABASE_URL and SUPABASE_ANON_KEY so only signed-in kitchen members can use it.
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function memberOfAKitchen(token) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key || !token) return false;
  const res = await fetch(`${url}/rest/v1/rpc/my_accounts`, { method: "POST", headers: { apikey: key, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  if (!res.ok) return false;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  // Forgive common paste mistakes: spaces, line breaks, quotes, or a leading "Bearer".
  const key = String(process.env.OPENAI_API_KEY || "").trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
  if (!key) return json(501, { error: "AI images aren't set up", reason: "noimagekey" });
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return json(502, { error: "That doesn't look like an OpenAI API key", reason: "imagekeyformat" });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(await memberOfAKitchen(token))) return json(401, { error: "Sign in first" });
  let body; try { body = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const dish = String(body?.dish || "").slice(0, 120).trim();
  if (!dish) return json(400, { error: "Which dish?" });
  const details = String(body?.details || "").slice(0, 600);
  const prompt = `Realistic, appetizing food photo of "${dish}" as served in a casual American small-town diner and bar. ${details} ` +
    "Plated simply on a white diner plate or basket as appropriate, natural window light, photographed at a 45-degree angle, shallow depth of field, " +
    "on a wooden or laminate table. No text, no logos, no hands, no people.";
  // OpenAI retires image models from time to time (gpt-image-1 was removed Oct 23, 2026), so try the newest first
  // and fall back to the next one if a model is rejected. OPENAI_IMAGE_MODEL in Netlify, if set, is tried first.
  const models = [...new Set([process.env.OPENAI_IMAGE_MODEL, "gpt-image-2", "gpt-image-1.5", "gpt-image-1-mini"].map(m => String(m || "").trim()).filter(Boolean))];
  let res = null, detail = "", lastReason = "other";
  for (const model of models) {
    for (const withQuality of [true, false]) {   // if a model doesn't take "quality: low", ask again without it
      res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(Object.assign({ model, prompt, size: "1024x1024", n: 1 }, withQuality ? { quality: "low" } : {})),
      });
      if (res.ok) break;
      detail = (await res.text().catch(() => "")).slice(0, 600);
      console.error("OpenAI image error", model, res.status, detail);
      if (withQuality && res.status === 400 && /quality/i.test(detail)) continue;
      break;
    }
    if (res.ok) break;
    lastReason = /billing|quota|insufficient|credit/i.test(detail) ? "imagecredit" : res.status === 401 ? "imagekey"
      : /verif/i.test(detail) && res.status === 403 ? "imageverify" : /safety|content_policy|moderation/i.test(detail) ? "imagesafety"
      : /model/i.test(detail) && (res.status === 404 || res.status === 400 || res.status === 403) ? "imagemodel" : res.status === 429 ? "busy" : "other";
    if (lastReason !== "imagemodel") break;   // only a rejected model is worth trying the next one for
  }
  if (!res || !res.ok) return json(502, { error: "Image service error", reason: lastReason, status: res && res.status });
  const out = await res.json();
  const b64 = out?.data?.[0]?.b64_json;
  if (!b64) return json(502, { error: "No image came back", reason: "other" });
  return json(200, { type: "image/png", data: b64 });
};

export const config = { path: "/api/ai-image" };
