// A schedule change request from the tablet (no login): saved for managers, and emailed to them right away.
import { rpc } from "../lib/db.mjs";
import { sendEmail } from "../lib/duties.mjs";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const esc = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const KIND = { off: "time off", swap: "a swap or cover", cant: "help: can't make a shift", other: "a schedule change" };
const nice = d => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let b; try { b = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  const token = String(b?.token || "");
  if (token.length < 40 || !/^[A-Za-z0-9]+$/.test(token)) return json(401, { error: "This tablet link isn't valid.", reason: "link" });
  const day = /^\d{4}-\d\d-\d\d$/.test(b?.day || "") ? b.day : null, dayTo = /^\d{4}-\d\d-\d\d$/.test(b?.dayTo || "") ? b.dayTo : null;
  let res;
  try {
    res = await rpc(process.env, "schedule_request_add", { p_token: token, p_person: String(b?.person || ""), p_person_id: String(b?.personId || ""), p_kind: String(b?.kind || ""),
      p_day: day, p_day_to: dayTo, p_shift: b?.shift ? String(b.shift) : null, p_cover: b?.cover ? String(b.cover) : null, p_message: b?.message ? String(b.message) : null });
  } catch (e) { console.error("tablet request", e.message); return json(502, { error: "Couldn't send the request right now. Try again in a minute." }); }
  if (!res || !res.ok) return json(res && res.reason === "cap" ? 429 : 400, { error: res && res.reason === "link" ? "This tablet link isn't active anymore." : res && res.reason === "cap" ? "Too many requests today. Ask a manager directly." : "Something in the request wasn't right.", reason: res && res.reason });

  // Email the managers (best effort: the request is saved either way).
  const to = (Array.isArray(res.emails) ? res.emails : []).filter(e => /@/.test(e)).slice(0, 5);
  let emailed = false;
  if (res.on !== false && to.length) {
    const when = nice(day) + (dayTo && dayTo !== day ? " to " + nice(dayTo) : "");
    const subject = `${b.person} asked for ${KIND[b.kind] || "a change"}${when ? ": " + when : ""}`;
    const rows = [["Who", b.person], ["Request", KIND[b.kind]], ["When", when], ["Shift", b.shift], ["Covering", b.cover], ["Message", b.message]].filter(([, v]) => v);
    const app = process.env.URL || "https://kitchen.thefoxdendinerandbar.com";
    try {
      await sendEmail(to, { subject,
        text: subject + "\n\n" + rows.map(([k, v]) => k + ": " + v).join("\n") + "\n\nApprove or deny: " + app + " (Schedule > Requests)",
        html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#24221F"><h2 style="margin:0 0 10px">${esc(subject)}</h2><table style="border-collapse:collapse">` +
          rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#66655D">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("") +
          `</table><p style="margin-top:18px"><a href="${esc(app)}" style="background:#1F6F5C;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Approve or deny in the app</a></p><p style="color:#66655D;font-size:13px">Schedule \u2192 Requests</p></div>` });
      emailed = true;
    } catch (e) { console.error("tablet request email", e.message); }
  }
  return json(200, { ok: true, emailed });
};
export const config = { path: "/api/tablet-request" };
