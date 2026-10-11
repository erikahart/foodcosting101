// AI for recipe drafting and the weekly plan. Needs ANTHROPIC_API_KEY.
// Uses EDIT_PIN (if set) so strangers can't run up your API bill.
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(501, { error: "AI not set up" });
  const pin = process.env.EDIT_PIN || "";
  if (pin && req.headers.get("x-edit-pin") !== pin) return json(401, { error: "Wrong or missing PIN" });
  let body; try { body = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const prompt = String(body?.prompt || "");
  if (!prompt || prompt.length > 30000) return json(400, { error: "Prompt missing or too long" });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) { console.error("Anthropic API error", res.status, (await res.text().catch(() => "")).slice(0, 300)); return json(502, { error: "AI service error" }); }
  const out = await res.json();
  return json(200, { text: (out.content || []).filter(b => b.type === "text").map(b => b.text).join("\n") });
};

export const config = { path: "/api/ai" };
