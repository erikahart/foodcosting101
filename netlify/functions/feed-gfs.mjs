// Collects new GFS EDI files every 15 minutes and files them into kitchens that switched the feed on.
import { pollGfs } from "../lib/feeds.mjs";

export default async () => {
  try {
    const out = await pollGfs({ log: console.log });
    console.log("GFS feed:", JSON.stringify({ kitchens: out.kitchens, files: out.files.map(f => `${f.file}: ${f.status}`) }));
  } catch (e) {
    console.error("GFS feed failed:", e.reason || "", e.message);
  }
};

export const config = { schedule: "*/15 * * * *" };
