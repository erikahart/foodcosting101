// Shared storage for the whole app (brand, restaurants, menus, inbox) in Netlify Blobs.
// GET returns it (204 if nothing saved yet). PUT saves it, needs EDIT_PIN if one is set,
// and refuses (409) if someone else saved since this browser last loaded.
import { getStore } from "@netlify/blobs";

const KEY = "state";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req) => {
  const store = getStore({ name: "platemargin", consistency: "strong" });
  if (req.method === "GET") {
    const data = await store.get(KEY, { type: "json" });
    return data ? json(200, data) : new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  if (req.method === "PUT") {
    const pin = process.env.EDIT_PIN || "";
    if (pin && req.headers.get("x-edit-pin") !== pin) return json(401, { error: "Wrong or missing PIN" });
    const text = await req.text();
    if (text.length > 4 * 1024 * 1024) return json(413, { error: "Too large" });
    let body; try { body = JSON.parse(text); } catch { return json(400, { error: "Not valid JSON" }); }
    if (!body?.state?.restaurants || typeof body.state.restaurants !== "object") return json(400, { error: "Missing state" });
    const current = await store.get(KEY, { type: "json" });
    const version = current?.version || 0;
    if (Number(body.baseVersion ?? -1) !== version) return json(409, { error: "Someone else saved first", current });
    const saved = { version: version + 1, updatedAt: new Date().toISOString(), state: body.state };
    await store.setJSON(KEY, saved);
    return json(200, { version: saved.version });
  }
  return json(405, { error: "Method not allowed" });
};

export const config = { path: "/api/data" };
