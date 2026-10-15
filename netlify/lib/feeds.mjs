// Collects EDI files from a distributor's SFTP folder and files them into a kitchen's inbox.
// Used by functions/feed-gfs.mjs (every 15 minutes) and functions/feed-check.mjs ("Check now").
//
// Netlify environment variables (kept secret there, never in code):
//   GFS_SFTP_HOST (default sftp-gordon.gfs.com), GFS_SFTP_PORT (22), GFS_SFTP_USER, GFS_SFTP_PASSWORD,
//   GFS_SFTP_DIR (default outbox), GFS_DELETE_AFTER (leave unset: files stay on GFS's server),
//   SUPABASE_URL, SUPABASE_SECRET_KEY (the project's secret key; lets the job file invoices while nobody is signed in).
import SftpClient from "ssh2-sftp-client";
import { parseX12, isX12 } from "./edi-x12.mjs";

const clean = v => String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
export function gfsSettings(env = process.env) {
  return {
    host: clean(env.GFS_SFTP_HOST) || "sftp-gordon.gfs.com",
    port: Number(clean(env.GFS_SFTP_PORT)) || 22,
    username: clean(env.GFS_SFTP_USER),
    password: clean(env.GFS_SFTP_PASSWORD),
    dir: clean(env.GFS_SFTP_DIR) || "outbox",
    deleteAfter: /^(1|true|yes)$/i.test(clean(env.GFS_DELETE_AFTER)),
  };
}
export class FeedError extends Error { constructor(reason, message) { super(message); this.reason = reason; } }

// Calls a database function with the project's secret key.
async function rpc(env, name, args) {
  const url = clean(env.SUPABASE_URL), key = clean(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) throw new FeedError("nosecret", "SUPABASE_URL and SUPABASE_SECRET_KEY must be set in Netlify.");
  const headers = { apikey: key, "content-type": "application/json" };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;      // older JWT-style service_role keys
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new FeedError(res.status === 401 || res.status === 403 ? "nosecret" : /function|PGRST202/.test(text) ? "nosql" : "db", `${name}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const UOM = { LB: "LB", OZ: "OZ", GA: "GAL", GL: "GAL", FO: "FL OZ", OZF: "FL OZ", DZ: "DZ", CT: "CT", EA: "EA", LT: "L", ML: "ML", KG: "KG", QT: "QT", PT: "PT" };
const packText = p => { if (!p || !p.size) return ""; const u = UOM[String(p.uom || "").toUpperCase()]; return u ? (p.count && p.count > 1 ? p.count + "/" : "") + p.size + " " + u : ""; };
const uid = p => p + Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);

// The same shape the app makes when someone uploads an EDI file by hand.
export function docsFromX12(text, supplierName, fileName) {
  const parsed = parseX12(text), docs = []; let credits = 0;
  for (const d of parsed.documents) {
    if (d.kind === "invoice" && d.isCredit) { credits++; continue; }
    const isPL = d.kind === "pricelist";
    const lines = ((isPL ? d.items : d.lines) || []).map(l => ({
      code: l.itemCode || "", desc: String(l.description || (l.itemCode ? "Item " + l.itemCode : "Item")).trim(),
      qty: isPL ? 1 : (Number(l.qty) || 1), price: Number(isPL ? l.price : l.unitPrice) || 0, pack: packText(l.pack),
    })).filter(l => l.price > 0);
    if (!lines.length) continue;
    const doc = { id: uid("d"), kind: isPL ? "pricelist" : "invoice", source: "EDI (automatic)", supplier: supplierName,
      number: isPL ? "Price sheet" : (d.invoiceNumber || "EDI-" + Math.floor(1000 + Math.random() * 9000)),
      date: (isPL ? d.effectiveDate : d.invoiceDate) || today(), status: "new", lines, feedFile: fileName, arrivedAt: new Date().toISOString() };
    if (!isPL && d.totalMismatch) doc.note = "The file's total doesn't match its lines; check it against the paper copy.";
    docs.push(doc);
  }
  return { docs, credits, warnings: parsed.warnings || [] };
}

export async function pollGfs({ env = process.env, accountIds = null, budgetMs = 20000, log = () => {} } = {}) {
  const s = gfsSettings(env), started = Date.now();
  if (!s.username || !s.password) throw new FeedError("nosftp", "GFS_SFTP_USER and GFS_SFTP_PASSWORD must be set in Netlify.");
  const targets = accountIds ? accountIds.map(id => ({ account_id: id, restaurant: null })) : await rpc(env, "feed_targets", { p_source: "gfs" });
  if (!targets || !targets.length) return { kitchens: 0, files: [], note: "GFS feed isn't switched on for any kitchen." };
  const sftp = new SftpClient("gfs");
  try {
    await sftp.connect({ host: s.host, port: s.port, username: s.username, password: s.password, readyTimeout: 15000, retries: 1 });
  } catch (e) {
    throw new FeedError(/authentication|auth fail|All configured/i.test(e.message) ? "sftpauth" : "sftpconnect", e.message);
  }
  const report = [];
  try {
    const list = (await sftp.list(s.dir)).filter(f => f.type === "-" && !f.name.startsWith(".")).sort((a, b) => (a.modifyTime || 0) - (b.modifyTime || 0));
    const doneEverywhere = new Map(list.map(f => [f.name, 0]));
    for (const t of targets) {
      const seen = new Set(await rpc(env, "feed_seen", { p_account: t.account_id, p_source: "gfs", p_names: list.map(f => f.name) }) || []);
      for (const f of list) {
        if (seen.has(f.name)) { doneEverywhere.set(f.name, doneEverywhere.get(f.name) + 1); continue; }
        if (Date.now() - started > budgetMs) { log("Out of time; the rest will be collected next run"); break; }
        let status = "added", message = null, docs = [];
        try {
          const text = (await sftp.get(`${s.dir}/${f.name}`)).toString("latin1");
          if (!isX12(text)) { status = "skipped"; message = "Not an EDI file"; }
          else {
            const out = docsFromX12(text, "Gordon Food Service", f.name); docs = out.docs;
            const notes = [out.credits ? out.credits + " credit memo(s) set aside" : "", ...out.warnings.slice(0, 2)].filter(Boolean);
            if (!docs.length) { status = "skipped"; message = notes.join("; ") || "No priced lines"; } else message = notes.join("; ") || null;
          }
        } catch (e) { status = "error"; message = e.message.slice(0, 300); }
        const added = await rpc(env, "feed_add", { p_account: t.account_id, p_source: "gfs", p_filename: f.name, p_docs: docs, p_status: status, p_message: message, p_restaurant: t.restaurant || null });
        if (status !== "error") doneEverywhere.set(f.name, doneEverywhere.get(f.name) + 1);
        report.push({ account: t.account_id, file: f.name, status: status === "added" && added === 0 && docs.length ? "duplicate" : status, documents: added, message });
      }
    }
    if (s.deleteAfter) for (const [name, n] of doneEverywhere) if (n === targets.length) { try { await sftp.delete(`${s.dir}/${name}`); } catch (e) { log("Couldn't delete " + name + ": " + e.message); } }
  } finally { await sftp.end().catch(() => {}); }
  return { kitchens: targets.length, files: report };
}
