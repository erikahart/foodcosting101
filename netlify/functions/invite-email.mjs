// Emails an invite to someone an owner or manager has already invited (Brand & accounts > Team).
// Only addresses with a pending invite can be emailed, and only by an owner or manager of that kitchen.
import { sendEmail } from "../lib/duties.mjs";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const esc = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const ROLE = { staff: "the Kitchen book, Test kitchen, Schedule and Events", member: "the menu, recipes, supplies and invoices", manager: "everything, including the schedule and inviting people" };

async function asUser(token, fn, args) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST",
    headers: { apikey: process.env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args || {}) });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}
export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let b; try { b = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const account = String(b?.account || ""), email = String(b?.email || "").trim().toLowerCase();
  if (!token || !/^[0-9a-f-]{36}$/i.test(account) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "Missing details" });
  const team = await asUser(token, "team", { p_account: account });
  if (!Array.isArray(team)) return json(401, { error: "Sign in first" });
  const me = team.find(t => t.is_me), invite = team.find(t => t.kind === "invite" && String(t.email || "").toLowerCase() === email);
  if (!me || !["owner", "manager"].includes(me.role)) return json(403, { error: "Only owners and managers can send invites." });
  if (!invite) return json(404, { error: "Invite them first, then the email can be sent." });
  const kitchens = await asUser(token, "my_accounts", {});
  const kitchen = (Array.isArray(kitchens) && (kitchens.find(k => k.id === account) || {}).name) || "our kitchen";
  const app = String(process.env.URL || "https://kitchen.thefoxdendinerandbar.com").replace(/\/$/, "");
  const from = String(me.email || "").split("@")[0] || "Your manager";
  const what = ROLE[invite.role] || ROLE.member;
  const subject = `You're invited to ${kitchen}'s staff app`;
  const text = `Hi,\n\n${from} invited you to ${kitchen}'s staff app. You'll be able to see ${what}.\n\nTo join:\n1. Open ${app}\n2. Tap "Create account"\n3. Use this email address (${email}) and choose a password\n\nYou'll land right in ${kitchen}. On your phone, you can add the app to your home screen when it asks.\n`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#24221F;max-width:520px">
    <h2 style="margin:0 0 8px">You're invited to ${esc(kitchen)}'s staff app</h2>
    <p>${esc(from)} invited you. You'll be able to see ${esc(what)}.</p>
    <ol style="padding-left:20px"><li>Open <a href="${esc(app)}">${esc(app.replace(/^https?:\/\//, ""))}</a></li><li>Tap <b>Create account</b></li><li>Use this email address (<b>${esc(email)}</b>) and choose a password</li></ol>
    <p><a href="${esc(app)}" style="display:inline-block;background:#1F6F5C;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">Open the app</a></p>
    <p style="color:#666;font-size:14px">You'll land right in ${esc(kitchen)}. On your phone, add the app to your home screen when it asks.</p></div>`;
  try { await sendEmail([email], { subject, text, html }); }
  catch (e) { console.error("invite email", e.message); return json(502, { error: e.reason === "nomail" ? "Email isn't set up yet (POSTMARK_SERVER_TOKEN in Netlify)." : "Couldn't send the email right now.", reason: e.reason || "mail" }); }
  return json(200, { ok: true });
};
export const config = { path: "/api/invite-email" };
