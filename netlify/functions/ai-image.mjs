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
  if (!process.env.OPENAI_API_KEY) return json(501, { error: "AI images aren't set up", reason: "noimagekey" });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(await memberOfAKitchen(token))) return json(401, { error: "Sign in first" });
  let body; try { body = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const dish = String(body?.dish || "").slice(0, 120).trim();
  if (!dish) return json(400, { error: "Which dish?" });
  const details = String(body?.details || "").slice(0, 600);
  const prompt = `Realistic, appetizing food photo of "${dish}" as served in a casual American small-town diner and bar. ${details} ` +
    "Plated simply on a white diner plate or basket as appropriate, natural window light, photographed at a 45-degree angle, shallow depth of field, " +
    "on a wooden or laminate table. No text, no logos, no hands, no people.";
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1", prompt, size: "1024x1024", quality: "low", n: 1 }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 600);
    console.error("OpenAI image error", res.status, detail);
    const reason = /billing|quota|insufficient|credit/i.test(detail) ? "imagecredit" : res.status === 401 ? "imagekey" : /safety|content_policy|moderation/i.test(detail) ? "imagesafety" : res.status === 429 ? "busy" : "other";
    return json(502, { error: "Image service error", reason, status: res.status });
  }
  const out = await res.json();
  const b64 = out?.data?.[0]?.b64_json;
  if (!b64) return json(502, { error: "No image came back", reason: "other" });
  return json(200, { type: "image/png", data: b64 });
};

export const config = { path: "/api/ai-image" };
