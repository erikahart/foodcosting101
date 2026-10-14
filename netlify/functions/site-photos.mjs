// Reads food photos (with their captions) from a restaurant's own website, so they can be
// added to recipe cards. Browsers can't copy images from another site directly, so this runs here.
// Only signed-in members of a kitchen can use it, and images are only fetched from the site scanned.
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function memberOfAKitchen(token) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key || !token) return false;
  const res = await fetch(`${url}/rest/v1/rpc/my_accounts`, { method: "POST", headers: { apikey: key, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
  if (!res.ok) return false;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}
const bareHost = h => String(h || "").toLowerCase().replace(/^www\./, "");
const decode = s => String(s || "").replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&nbsp;/g, " ").replace(/&mdash;/g, "\u2014").replace(/&ndash;/g, "\u2013").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const attr = (tag, name) => { const m = tag.match(new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")); return m ? (m[2] ?? m[3] ?? m[4] ?? "") : ""; };
const SKIP = /logo|favicon|icon|og-image|avatar|sprite|badge|banner-bg|placeholder|qr|map/i;

async function getPage(u) {
  const res = await fetch(u, { headers: { "user-agent": "KitchenApp/1.0 (+photo import)", accept: "text/html" }, redirect: "follow" });
  if (!res.ok) throw new Error("Page returned " + res.status);
  return { html: (await res.text()).slice(0, 2_000_000), url: res.url || u };
}
function photosIn(html, base, page) {
  const out = [];
  const add = (src, alt, caption) => {
    if (!src || /^data:/i.test(src)) return;
    let abs; try { abs = new URL(src, base).href; } catch { return; }
    if (!/\.(jpe?g|png|webp)(\?|#|$)/i.test(abs) || SKIP.test(abs)) return;
    out.push({ src: abs, alt: decode(alt), caption: decode(caption), page });
  };
  // Figures first (image + its caption), then any other images with alt text.
  const seen = new Set();
  for (const fig of html.match(/<figure[\s\S]*?<\/figure>/gi) || []) {
    const img = (fig.match(/<img\b[^>]*>/i) || [])[0]; if (!img) continue;
    const cap = (fig.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i) || [])[1] || (fig.match(/<em[^>]*>([\s\S]*?)<\/em>/i) || [])[1] || "";
    const src = attr(img, "src") || attr(img, "data-src"); seen.add(src); add(src, attr(img, "alt"), cap);
  }
  // Images followed closely by an <em> or heading caption (common in simple galleries).
  const re = /<img\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) {
    const src = attr(m[0], "src") || attr(m[0], "data-src"); if (seen.has(src)) continue;
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const cap = (after.match(/^\s*(?:<\/?(?:a|div|p|span|picture)[^>]*>\s*)*<(?:em|figcaption|h3|h4|strong)[^>]*>([\s\S]*?)<\/(?:em|figcaption|h3|h4|strong)>/i) || [])[1] || "";
    add(src, attr(m[0], "alt"), cap);
  }
  return out;
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(await memberOfAKitchen(token))) return json(401, { error: "Sign in first" });
  let body; try { body = await req.json(); } catch { return json(400, { error: "Not valid JSON" }); }
  let site; try { site = new URL(/^https?:\/\//i.test(body.site || "") ? body.site : "https://" + String(body.site || "")); } catch { return json(400, { error: "That website address doesn't look right." }); }
  if (!/^https?:$/.test(site.protocol)) return json(400, { error: "Use an http or https address." });

  if (body.action === "image") {
    // Download one photo, only from the same website.
    let src; try { src = new URL(body.src); } catch { return json(400, { error: "Bad image address" }); }
    if (bareHost(src.hostname) !== bareHost(site.hostname)) return json(403, { error: "Photos can only come from your own website." });
    const res = await fetch(src.href, { headers: { "user-agent": "KitchenApp/1.0 (+photo import)" } });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/^image\/(jpeg|png|webp)/i.test(type)) return json(502, { error: "That photo couldn't be downloaded." });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 6_000_000) return json(413, { error: "That photo is too large." });
    return json(200, { type: type.split(";")[0], data: buf.toString("base64") });
  }

  // Scan: the page given, plus up to 6 linked pages on the same site that are likely to have food photos.
  const pages = new Map(); const errors = [];
  try { const p = await getPage(site.href); pages.set(p.url, p.html); } catch (e) { return json(502, { error: "Couldn't open " + site.href + " (" + e.message + ")." }); }
  const first = [...pages.values()][0];
  const links = new Set();
  for (const a of first.match(/<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>/gi) || []) {
    let href; try { href = new URL(attr(a, "href"), site.href); } catch { continue; }
    if (bareHost(href.hostname) !== bareHost(site.hostname)) continue;
    if (/gallery|photo|menu|food|special|bar|dessert|drink|kids|brunch|breakfast|lunch|dinner/i.test(href.pathname)) links.add(href.origin + href.pathname);
  }
  for (const u of [...links].slice(0, 6)) {
    if (pages.has(u)) continue;
    try { const p = await getPage(u); pages.set(p.url, p.html); } catch (e) { errors.push(u); }
  }
  const all = []; const seen = new Set();
  for (const [u, html] of pages) for (const p of photosIn(html, u, new URL(u).pathname || "/")) { if (seen.has(p.src)) continue; seen.add(p.src); all.push(p); }
  return json(200, { site: site.origin, pages: [...pages.keys()], photos: all.slice(0, 300), skipped: errors });
};

export const config = { path: "/api/site-photos" };
