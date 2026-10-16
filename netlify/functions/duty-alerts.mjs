// Every morning: email each kitchen's managers the duties that weren't done yesterday, and who was responsible.
import { rpc } from "../lib/db.mjs";
import { missedReport, alertEmail, sendEmail, easternDay } from "../lib/duties.mjs";

export default async () => {
  const day = easternDay(-1);
  let rows = [];
  try { rows = await rpc(process.env, "duty_alert_accounts", { p_day: day }) || []; } catch (e) { console.error("duty alerts: couldn't read kitchens", e.message); return; }
  for (const k of rows) {
    if (k.already || !k.place) continue;
    const to = ((k.place.dutyAlerts || {}).emails || []).filter(e => /@/.test(e)).slice(0, 5);
    const report = missedReport(k.place, day, k.checks);
    const mail = alertEmail(k.place.name || k.name, day, report);
    try {
      if (report.length && to.length) await sendEmail(to, mail);
      await rpc(process.env, "duty_alert_sent", { p_account: k.account_id, p_day: day, p_to: to.join(","), p_missed: mail.count });
      console.log("duty alerts:", k.name, day, mail.count, "missed", report.length && to.length ? "emailed" : "nothing to send");
    } catch (e) { console.error("duty alerts:", k.name, e.message); }
  }
};
export const config = { schedule: "0 11 * * *" };   // 6 or 7 AM in Ohio, depending on daylight saving
