// Events from connected calendars (Google Calendar's secret iCal address, Outlook, booking systems).
//  - The app (signed in): POST { account, feeds:[{id,name,url,color}], from, to }  -> full details for staff in the app
//  - The tablet (no login): GET ?token=...&from=&to=  -> the kitchen's feeds are looked up on the server; contact details removed
import { rpc } from "../lib/db.mjs";
import { eventsBetween, scrub } from "../lib/ics.mjs";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const CACHE = new Map();   // url -> { at, text }
const isoOk = v => /^\d{4}-\d\d-\d\d$/.test(v || "");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.CAL_TZ || "America/New_York" });
const shift = (iso, k) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

async function fetchFeed(url) {
  const u = String(url || "").trim().replace(/^webcals?:\/\//i, "https://");
  if (!/^https:\/\/[^\s]+$/i.test(u)) throw new Error("Calendar addresses start with https:// (or webcal://).");
  const hit = CACHE.get(u); if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.text;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch(u, { signal: ctl.signal, headers: { accept: "text/calendar, text/plain, */*" } });
    if (!res.ok) throw new Error(res.status === 404 ? "That calendar address wasn't found. Copy it again from your calendar's settings." : "The calendar answered " + res.status + ".");
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/.test(text.slice(0, 2000))) throw new Error("That address isn't an iCal calendar. In Google Calendar use \u201cSecret address in iCal format\u201d.");
    if (text.length > 6e6) throw new Error("That calendar is too large.");
    CACHE.set(u, { at: Date.now(), text }); return text;
  } catch (e) { throw new Error(e.name === "AbortError" ? "The calendar took too long to answer." : e.message); }
  finally { clearTimeout(timer); }
}
async function memberOf(token, account) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/my_accounts`, { method: "POST", headers: { apikey: process.env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  if (!res.ok) return false; const rows = await res.json().catch(() => []); return Array.isArray(rows) && rows.some(x => x.id === account);
}
export default async (req) => {
  const url = new URL(req.url);
  let feeds, forTablet = false, from, to;
  if (req.method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (token.length < 40 || !/^[A-Za-z0-9]+$/.test(token)) return json(401, { error: "Bad link" });
    try { feeds = await rpc(process.env, "cal_feeds_for_token", { p_token: token }); } catch (e) { return json(502, { error: "Couldn't look up the calendars." }); }
    if (feeds === null) return json(401, { error: "This tablet link isn't active." });
    feeds = (feeds || []).filter(f => f && f.url && f.tablet !== false); forTablet = true;
    from = url.searchParams.get("from"); to = url.searchParams.get("to");
  } else if (req.method === "POST") {
    let b; try { b = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
    const ok = await memberOf((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""), b && b.account);
    if (!ok) return json(401, { error: "Sign in first" });
    feeds = (Array.isArray(b.feeds) ? b.feeds : []).slice(0, 8); from = b.from; to = b.to;
  } else return json(405, { error: "Method not allowed" });
  from = isoOk(from) ? from : shift(today(), -7); to = isoOk(to) ? to : shift(today(), 90);
  if (to > shift(from, 400)) to = shift(from, 400);
  const events = [], errors = [];
  await Promise.all(feeds.map(async f => {
    try { const list = eventsBetween(await fetchFeed(f.url), from, to);
      list.forEach(e => events.push({ feed: f.id || "", feedName: f.name || "Calendar", color: f.color || "", date: e.date, endDate: e.endDate, allDay: e.allDay, time: e.time, endTime: e.endTime,
        title: e.title, location: e.location, desc: forTablet ? scrub(e.desc) : e.desc.slice(0, 1500) })); }
    catch (e) { errors.push({ feed: f.id || "", name: f.name || "Calendar", error: e.message }); }
  }));
  events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
  return json(200, { from, to, events: events.slice(0, 800), errors });
};
export const config = { path: "/api/calendar" };
