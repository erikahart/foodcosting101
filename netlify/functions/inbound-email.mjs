// Receives emails from Postmark's inbound service (Gmail forwards supplier invoice emails there).
// Saves each invoice attachment for the app to read, and catches Gmail's forwarding confirmation code.
//
// Postmark > Server > Default Inbound Stream > Settings > Webhook URL:
//   https://kitchen.thefoxdendinerandbar.com/api/inbound-email?key=<INBOUND_KEY>
// Netlify env: INBOUND_KEY (a long random phrase you make up), SUPABASE_URL, SUPABASE_SECRET_KEY.
import { rpc } from "../lib/db.mjs";
import { timingSafeEqual } from "node:crypto";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clean = v => String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
const sameSecret = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
const USEFUL = /\.(pdf|csv|xlsx?|png|jpe?g|webp|heic|edi|x12|810|832|txt|dat)$/i;
const MAX = 8 * 1024 * 1024;

export function gmailConfirmation(mail) {
  const from = String(mail.FromFull?.Email || mail.From || "").toLowerCase();
  if (!/forwarding-noreply@google\.com|mail-noreply@google\.com/.test(from) && !/forwarding confirmation/i.test(mail.Subject || "")) return null;
  const text = (mail.TextBody || "") + "\n" + (mail.HtmlBody || "").replace(/<[^>]+>/g, " ");
  const code = ((mail.Subject || "").match(/\(#(\d{6,12})\)/) || text.match(/confirmation code[:\s]+(\d{6,12})/i) || [])[1] || "";
  const link = (text.match(/https:\/\/mail(?:-settings)?\.google\.com\/[^\s"'<>]+/i) || [])[0] || "";
  const forWho = ((mail.Subject || "").match(/from\s+(\S+@\S+)/i) || [])[1] || "";
  return { code, link, forWho };
}
export function rowsFromMail(mail) {
  const base = { from_addr: mail.FromFull?.Email || mail.From || "", from_name: mail.FromFull?.Name || "", subject: mail.Subject || "" };
  const conf = gmailConfirmation(mail);
  if (conf) return [{ ...base, kind: "confirmation", info: conf, status: "done", message: "Gmail forwarding confirmation" }];
  const rows = [];
  for (const a of mail.Attachments || []) {
    const name = a.Name || "attachment", type = a.ContentType || "", size = Number(a.ContentLength) || Math.floor((a.Content || "").length * 0.75);
    const inlineImage = /^image\//i.test(type) && (a.ContentID || /^image\d{3}\./i.test(name)) && size < 60000;   // logos and signatures
    if (inlineImage || !(USEFUL.test(name) || /pdf|csv|spreadsheet|excel|image\//i.test(type))) continue;
    if (size > MAX) { rows.push({ ...base, kind: "note", filename: name, status: "ignored", message: "Attachment too large (over 8 MB)" }); continue; }
    rows.push({ ...base, kind: "attachment", filename: name, content_type: type, size, data: a.Content });
  }
  if (!rows.length) rows.push({ ...base, kind: "note", status: "ignored", message: "No invoice attachment found in this email" });
  return rows;
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const want = clean(process.env.INBOUND_KEY), got = new URL(req.url).searchParams.get("key") || "";
  if (!want || !sameSecret(want, got)) return json(401, { error: "Wrong or missing key" });
  let mail; try { mail = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  try {
    const targets = await rpc(process.env, "feed_targets", { p_source: "email" });
    if (!targets || !targets.length) { console.log("Email arrived but email-in isn't switched on for any kitchen:", mail.Subject); return json(200, { stored: 0, note: "Email-in is off" }); }
    const rows = rowsFromMail(mail);
    for (const t of targets) await rpc(process.env, "inbound_add", { p_account: t.account_id, p_rows: rows });
    console.log("Email stored:", mail.Subject, rows.map(r => r.kind + (r.filename ? ":" + r.filename : "")).join(", "));
    return json(200, { stored: rows.length });
  } catch (e) {
    console.error("Inbound email failed:", e.reason || "", e.message);
    return json(500, { error: "Couldn't store the email" });   // Postmark retries later
  }
};

export const config = { path: "/api/inbound-email" };
