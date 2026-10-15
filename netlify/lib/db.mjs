// Calls the app's database functions with the Supabase project's secret key (server only).
const clean = v => String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
export class FeedError extends Error { constructor(reason, message) { super(message); this.reason = reason; } }

// Calls a database function with the project's secret key.
export async function rpc(env, name, args) {
  const url = clean(env.SUPABASE_URL), key = clean(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) throw new FeedError("nosecret", "SUPABASE_URL and SUPABASE_SECRET_KEY must be set in Netlify.");
  const headers = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;      // older JWT-style service_role keys
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new FeedError(res.status === 401 || res.status === 403 ? "nosecret" : /function|PGRST202/.test(text) ? "nosql" : "db", `${name}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

