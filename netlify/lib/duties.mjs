// Which duties were missed on a day, and who was responsible (from the schedule). Shared by the morning alert
// and the "Send a test" button. The app has the same rules for its own screens.
const toMin = v => v ? +v.slice(0, 2) * 60 + +v.slice(3) : 24 * 60 + 1;   // no end = until close
export function listsFor(place, day) {
  const dow = new Date(day + "T12:00:00Z").getUTCDay();
  return (place.duties || []).filter(l => !l.days || !l.days.length || l.days.includes(dow));
}
export function responsibleFor(place, list, day) {
  const staff = new Map((place.staff || []).map(p => [p.id, p.name]));
  if (list.people && list.people.length) return list.people.map(id => staff.get(id)).filter(Boolean);
  let pool = (place.shifts || []).filter(s => s.date === day && !s.off);
  const roles = (list.roles || []).map(r => String(r).toLowerCase());
  if (roles.length) pool = pool.filter(s => roles.includes(String(s.role || "").toLowerCase()));
  else if (list.area === "Bar") { const b = pool.filter(s => /bar/i.test(s.role || "")); if (b.length) pool = b; }
  else { const nb = pool.filter(s => !/bar/i.test(s.role || "")); if (nb.length) pool = nb; }   // bar shifts don't close the kitchen
  if (!pool.length) return [];
  if (list.when === "open") { const first = Math.min(...pool.map(s => toMin(s.start))); pool = pool.filter(s => toMin(s.start) <= first + 60); }
  else if (list.when === "close") { const last = Math.max(...pool.map(s => toMin(s.end))); pool = pool.filter(s => toMin(s.end) >= last - 60); }
  return [...new Set(pool.map(s => staff.get(s.staff)).filter(Boolean))].slice(0, 5);
}
export function missedReport(place, day, checks) {
  const byKey = new Map((checks || []).map(c => [c.list_id + "|" + c.item_id, c]));
  const out = [];
  for (const l of listsFor(place, day)) {
    const items = l.items.filter(x => { const c = byKey.get(l.id + "|" + x.id); return !c || c.status === "skipped"; });
    if (items.length) out.push({ list: l.name, responsible: responsibleFor(place, l, day),
      items: items.map(x => { const c = byKey.get(l.id + "|" + x.id); return { text: x.text, skipped: !!c, note: c ? c.note || "" : "", by: c ? c.done_by || "" : "" }; }) });
  }
  return out;
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
export function alertEmail(kitchen, day, report) {
  const d = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  const n = report.reduce((t, l) => t + l.items.length, 0);
  const subject = `${kitchen}: ${n} ${n === 1 ? "duty" : "duties"} not done on ${d}`;
  const line = x => x.skipped ? `Couldn't do it: ${x.note || "no reason given"}${x.by ? " (" + x.by + ")" : ""}` : "Not done, no reason given";
  const text = [subject, ""].concat(report.flatMap(l => [`${l.list}  |  Responsible: ${l.responsible.join(", ") || "no one scheduled"}`, ...l.items.map(x => `  - ${x.text}: ${line(x)}`), ""])).join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#24221F"><h2 style="margin:0 0 4px">${esc(subject)}</h2>` +
    report.map(l => `<h3 style="margin:18px 0 4px">${esc(l.list)}</h3><div style="color:#66655D;margin-bottom:6px">Responsible: <b>${esc(l.responsible.join(", ") || "no one scheduled")}</b></div><ul style="margin:0;padding-left:18px">` +
      l.items.map(x => `<li style="margin:4px 0">${esc(x.text)}: <span style="color:${x.skipped ? "#9A6A0B" : "#B8352A"}">${esc(line(x))}</span></li>`).join("") + "</ul>").join("") +
    `<p style="color:#66655D;font-size:13px;margin-top:20px">See every checklist under Schedule \u2192 Checklists in the app.</p></div>`;
  return { subject, text, html, count: n };
}
export async function sendEmail(to, mail) {
  const token = String(process.env.POSTMARK_SERVER_TOKEN || "").trim();
  if (!token) throw Object.assign(new Error("POSTMARK_SERVER_TOKEN isn't set in Netlify."), { reason: "nomail" });
  const res = await fetch("https://api.postmarkapp.com/email", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({ From: process.env.ALERT_FROM || "Kitchen alerts <alerts@triplefoxllc.com>", To: to.join(","), Subject: mail.subject, TextBody: mail.text, HtmlBody: mail.html, MessageStream: "outbound" }) });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw Object.assign(new Error("Postmark: " + res.status + " " + t.slice(0, 200)), { reason: "mail" }); }
}
export const easternDay = (offsetDays = 0) => { const d = new Date(Date.now() + offsetDays * 864e5); return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); };
