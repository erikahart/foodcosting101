// Emails a staff member their personal app link (from Brand & accounts > PINs > Send app link).
// Only an owner or manager of the kitchen can send it, and only for a link that kitchen made.
import { sendEmail } from "../lib/duties.mjs";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const esc = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
async function asUser(token, fn, args) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST",
    headers: { apikey: process.env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args || {}) });
  if (!res.ok) return { error: res.status };
  return { data: await res.json().catch(() => null) };
}
export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let b; try { b = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const account = String(b?.account || ""), link = String(b?.link || ""), email = String(b?.email || "").trim().toLowerCase();
  if (!token || !/^[0-9a-f-]{36}$/i.test(account) || !/^[a-f0-9]{40,}$/.test(link) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "Missing details" });
  const info = await asUser(token, "staff_invite_info", { p_account: account, p_token: link });
  if (info.error) return json(info.error === 401 ? 401 : 403, { error: "Only owners and managers can send app links." });
  const name = info.data; if (!name) return json(404, { error: "That link has expired. Make a new one." });
  const kitchens = await asUser(token, "my_accounts", {});
  const kitchen = (Array.isArray(kitchens.data) && (kitchens.data.find(k => k.id === account) || {}).name) || "our kitchen";
  const app = String(process.env.URL || "https://kitchen.thefoxdendinerandbar.com").replace(/\/$/, ""), url = `${app}/join/${link}`;
  const first = String(name).split(" ")[0];
  const subject = `${first}, here's your ${kitchen} staff app`;
  const text = `Hi ${first},\n\nHere's your link to ${kitchen}'s staff app (recipes, the schedule, duties and events):\n\n${url}\n\n1. Open the link on your phone\n2. Pick a 4-digit PIN\n3. Tap "Add to Home Screen" when it asks\n\nAfter that, open the app and type your PIN. This link is just for you and works once.\n`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#24221F;max-width:520px">
    <h2 style="margin:0 0 8px">Hi ${esc(first)}, here's your staff app</h2>
    <p>Recipes, the schedule, duties and events for ${esc(kitchen)}.</p>
    <p><a href="${esc(url)}" style="display:inline-block;background:#1F6F5C;color:#fff;text-decoration:none;padding:14px 22px;border-radius:10px;font-weight:bold;font-size:18px">Set up my app</a></p>
    <ol style="padding-left:20px"><li>Open the button above on your phone</li><li>Pick a 4-digit PIN</li><li>Tap <b>Add to Home Screen</b> when it asks</li></ol>
    <p style="color:#666;font-size:14px">After that, open the app and type your PIN. This link is just for you and works once.</p></div>`;
  try { await sendEmail([email], { subject, text, html }); }
  catch (e) { console.error("staff link email", e.message); return json(502, { error: e.reason === "nomail" ? "Email isn't set up yet (POSTMARK_SERVER_TOKEN in Netlify)." : "Couldn't send the email right now." }); }
  return json(200, { ok: true });
};
export const config = { path: "/api/staff-link-email" };
