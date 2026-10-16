// "Send a test" in the app: emails the missed-duty report for a day right away (owners and managers).
import { rpc } from "../lib/db.mjs";
import { missedReport, alertEmail, sendEmail } from "../lib/duties.mjs";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
async function myRole(token, account) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/my_accounts`, { method: "POST", headers: { apikey: process.env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  if (!res.ok) return null; const rows = await res.json().catch(() => []); const r = Array.isArray(rows) ? rows.find(x => x.id === account) : null; return r ? r.role : null;
}
export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let body; try { body = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const role = await myRole((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), body?.account);
  if (!role) return json(401, { error: "Sign in first" });
  if (!["owner", "manager"].includes(role)) return json(403, { error: "Only owners and managers can send alerts." });
  const day = /^\d{4}-\d\d-\d\d$/.test(body?.day || "") ? body.day : null; if (!day) return json(400, { error: "Which day?" });
  try {
    const rows = await rpc(process.env, "duty_alert_accounts", { p_day: day }) || [];
    const k = rows.find(x => x.account_id === body.account);
    if (!k) return json(400, { error: "Turn on missed-duty alerts first (and save), then try again.", reason: "off" });
    const to = ((k.place.dutyAlerts || {}).emails || []).filter(e => /@/.test(e)).slice(0, 5);
    if (!to.length) return json(400, { error: "Add at least one email address for alerts.", reason: "noemail" });
    const report = missedReport(k.place, day, k.checks), mail = alertEmail(k.place.name || k.name, day, report);
    if (!report.length) mail.subject = (k.place.name || k.name) + ": test alert, every duty was done on " + day;
    await sendEmail(to, report.length ? mail : Object.assign(mail, { text: mail.subject, html: "<p>" + mail.subject + "</p>" }));
    return json(200, { sent: to, missed: mail.count });
  } catch (e) { console.error("duty alert test", e.message); return json(502, { error: e.message, reason: e.reason || "other" }); }
};
export const config = { path: "/api/duty-alert-test" };
