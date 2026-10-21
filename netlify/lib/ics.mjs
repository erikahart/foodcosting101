// Reads iCal (.ics) calendar feeds: Google Calendar's "secret address in iCal format", Outlook, Apple, booking systems.
// Handles all-day and timed events, UTC and local times, repeating events (daily, weekly, monthly, yearly), cancelled
// events and skipped dates. Times come back as the restaurant's local wall-clock time ("2026-10-24T18:00").
const TZ = () => process.env.CAL_TZ || "America/New_York";
const pad = n => String(n).padStart(2, "0");
const unescape = v => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

export function parseICS(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const unfolded = [];
  for (const l of lines) { if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1); else unfolded.push(l); }
  const events = []; let cur = null;
  for (const line of unfolded) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...params] = head.split(";"); const p = {}; params.forEach(x => { const [k, v] = x.split("="); p[k.toUpperCase()] = (v || "").replace(/^"|"$/g, ""); });
    const N = name.toUpperCase();
    if (N === "EXDATE") (cur.EXDATE = cur.EXDATE || []).push(...value.split(",").map(v => ({ value: v, p })));
    else cur[N] = { value, p };
  }
  return events;
}
// A date-time value to local wall-clock parts in the restaurant's time zone.
function toLocal(v, p) {
  if (!v) return null;
  if (p && p.VALUE === "DATE" || /^\d{8}$/.test(v)) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, time: null };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/); if (!m) return null;
  if (m[7] === "Z" || (p && p.TZID && p.TZID !== TZ())) {
    const d = m[7] === "Z" ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : zonedToDate(+m[1], +m[2], +m[3], +m[4], +m[5], p.TZID);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };   // already local (TZID matches, or floating)
}
function zonedToDate(y, mo, d, h, mi, tz) {   // a wall-clock time in another zone, as a real moment
  try { const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(guess).map(x => [x.type, x.value]));
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute); return new Date(guess.getTime() - (asUTC - guess.getTime())); }
  catch { return new Date(Date.UTC(y, mo - 1, d, h, mi)); }
}
const addDays = (iso, k) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Events between two dates (inclusive), expanding repeats.
export function eventsBetween(text, from, to, limit = 400) {
  const out = [];
  for (const e of parseICS(text)) {
    if (e.STATUS && /cancel/i.test(e.STATUS.value)) continue;
    const s = toLocal(e.DTSTART && e.DTSTART.value, e.DTSTART && e.DTSTART.p); if (!s) continue;
    let en = e.DTEND ? toLocal(e.DTEND.value, e.DTEND.p) : null;
    const allDay = !s.time;
    if (allDay && en && en.date > s.date) en = { date: addDays(en.date, -1), time: null };   // all-day ends are exclusive
    const spanDays = en ? Math.max(0, dayDiff(s.date, en.date)) : 0;
    const base = { title: unescape((e.SUMMARY && e.SUMMARY.value) || "(no title)").slice(0, 140), location: unescape((e.LOCATION && e.LOCATION.value) || "").slice(0, 140),
      desc: unescape((e.DESCRIPTION && e.DESCRIPTION.value) || "").slice(0, 1500), allDay, time: s.time, endTime: en ? en.time : null, spanDays, uid: e.UID ? e.UID.value : "" };
    const ex = new Set((e.EXDATE || []).map(x => { const l = toLocal(x.value, x.p); return l && l.date; }));
    const push = date => { if (ex.has(date)) return; const endDate = addDays(date, spanDays); if (endDate < from || date > to) return; out.push(Object.assign({ date, endDate }, base)); };
    if (!e.RRULE) { push(s.date); continue; }
    const rr = Object.fromEntries(e.RRULE.value.split(";").map(x => x.split("=")));
    const freq = rr.FREQ, interval = Math.max(1, +rr.INTERVAL || 1), count = rr.COUNT ? +rr.COUNT : Infinity;
    const until = rr.UNTIL ? (toLocal(rr.UNTIL, {}) || {}).date : null;
    const byday = rr.BYDAY ? rr.BYDAY.split(",").map(x => DOW.indexOf(x.slice(-2))).filter(x => x >= 0) : null;
    let n = 0;
    for (let step = 0, d = s.date; n < count && step < 2000; step++) {
      if (until && d > until) break; if (d > to) break;
      if (freq === "WEEKLY" && byday && byday.length) {
        const wkStart = addDays(d, -new Date(d + "T12:00:00Z").getUTCDay());
        for (const wd of byday.slice().sort()) { const dd = addDays(wkStart, wd); if (dd < s.date || (until && dd > until) || n >= count) continue; n++; push(dd); }
        d = addDays(wkStart, 7 * interval); continue;
      }
      n++; push(d);
      if (freq === "DAILY") d = addDays(d, interval);
      else if (freq === "WEEKLY") d = addDays(d, 7 * interval);
      else if (freq === "MONTHLY") { const x = new Date(d + "T12:00:00Z"); x.setUTCMonth(x.getUTCMonth() + interval); d = x.toISOString().slice(0, 10); }
      else if (freq === "YEARLY") { const x = new Date(d + "T12:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + interval); d = x.toISOString().slice(0, 10); }
      else break;
    }
    if (out.length > limit) break;
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
}
// For the tablet: no phone numbers or email addresses from booking notes.
export const scrub = t => String(t || "").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, "[phone]").slice(0, 300);
