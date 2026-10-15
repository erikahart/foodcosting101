// "Check now" in the app: collects new GFS files for one kitchen right away.
// Only an owner or manager of that kitchen can run it.
import { pollGfs } from "../lib/feeds.mjs";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function myRole(token, account) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key || !token) return null;
  const res = await fetch(`${url}/rest/v1/rpc/my_accounts`, { method: "POST", headers: { apikey: key, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) ? rows.find(r => r.id === account) : null;
  return row ? row.role : null;
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let body; try { body = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const role = await myRole(token, body?.account);
  if (!role) return json(401, { error: "Sign in first" });
  if (!["owner", "manager"].includes(role)) return json(403, { error: "Only owners and managers can check the feed." });
  try { return json(200, await pollGfs({ accountIds: [body.account] })); }
  catch (e) { console.error("GFS check failed:", e.reason, e.message); return json(502, { error: e.message, reason: e.reason || "feed" }); }
};

export const config = { path: "/api/feed-check" };
