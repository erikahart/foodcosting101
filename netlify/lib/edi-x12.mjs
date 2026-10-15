// X12 EDI parsing for food distributor feeds.
//   810 = invoice (and credit memo)   832 = price/sales catalog
// Distributors bend the standard in small ways, so this parser is tolerant:
// it reads separators from the ISA header, accepts several item-code
// qualifiers, and keeps unknown segments in `extra` instead of failing.

/** Split raw X12 text into segments of elements. */
export function tokenize(text) {
  const raw = String(text).replace(/^\uFEFF/, "");
  const start = raw.indexOf("ISA");
  if (start < 0) throw new Error("Not an X12 file: no ISA header");
  const s = raw.slice(start);
  const el = s[3];                       // element separator: the character right after "ISA"
  // ISA has 16 elements; the component separator is ISA16 and the segment terminator follows it.
  let count = 0, i = 0;
  for (; i < s.length && count < 16; i++) if (s[i] === el) count++;
  const component = s[i];
  const term = s[i + 1];
  if (!term) throw new Error("Not an X12 file: ISA header is cut short");
  const segs = s.split(term).map(x => x.replace(/^[\r\n]+|[\r\n]+$/g, "")).filter(Boolean);
  return { el, component, term, segments: segs.map(x => x.split(el)) };
}

const num = v => { if (v == null || v === "") return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
const cents = v => { const x = num(v); return x == null ? null : x / 100; };   // TDS and SAC amounts carry 2 implied decimals
const date = v => (v && /^\d{8}$/.test(v)) ? `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`
  : (v && /^\d{6}$/.test(v) ? `20${v.slice(0,2)}-${v.slice(2,4)}-${v.slice(4,6)}` : null);

// Product ID qualifiers seen from broadliners, in order of preference for the supplier's own item number.
const ITEM_QUALS = ["VN", "VP", "SK", "IN", "BP", "SV"];
function pickIds(pairs) {
  const ids = {};
  for (let k = 0; k + 1 < pairs.length; k += 2) { const q = pairs[k], v = pairs[k + 1]; if (q && v) ids[q] = v; }
  const code = ITEM_QUALS.map(q => ids[q]).find(Boolean) || null;
  return { code, upc: ids.UP || ids.UK || ids.EN || null, ids };
}

/** Group segments into transaction sets (ST..SE) with their envelope info. */
function transactions(tok) {
  const out = []; let isa = null, gs = null, cur = null;
  for (const seg of tok.segments) {
    const id = seg[0].trim();
    if (id === "ISA") isa = { sender: (seg[6] || "").trim(), receiver: (seg[8] || "").trim(), control: (seg[13] || "").trim(), test: (seg[15] || "").trim() === "T" };
    else if (id === "GS") gs = { code: seg[1], sender: seg[2], receiver: seg[3] };
    else if (id === "ST") cur = { type: seg[1], control: seg[2], isa, gs, segs: [] };
    else if (id === "SE") { if (cur) { cur.declaredCount = num(seg[1]); out.push(cur); } cur = null; }
    else if (cur) cur.segs.push(seg);
  }
  return out;
}

/** Parse one 810 transaction into a normalized invoice. */
function parse810(t) {
  const inv = {
    kind: "invoice", format: "edi810", isCredit: false, invoiceNumber: null, invoiceDate: null, poNumber: null, poDate: null,
    supplier: { name: null, id: t.gs?.sender || t.isa?.sender || null },
    shipTo: { name: null, customerNumber: null }, billTo: { name: null, customerNumber: null },
    lines: [], charges: [], total: null,
    envelope: { isaControl: t.isa?.control || null, stControl: t.control || null, test: !!t.isa?.test }, extra: [],
  };
  let party = null, line = null;
  for (const s of t.segs) {
    const id = s[0].trim();
    switch (id) {
      case "BIG":
        inv.invoiceDate = date(s[1]); inv.invoiceNumber = s[2] || null; inv.poDate = date(s[3]); inv.poNumber = s[4] || null;
        if ((s[7] || "").toUpperCase() === "CR") inv.isCredit = true;
        break;
      case "N1": {
        party = s[1]; const name = s[2] || null, idv = s[4] || null;
        // Only overwrite the customer number when this segment carries one (it may have come from REF already).
        if (party === "ST") { inv.shipTo.name = name; if (idv) inv.shipTo.customerNumber = idv; }
        else if (party === "BT" || party === "BY") { inv.billTo.name = name; if (idv) inv.billTo.customerNumber = idv; }
        else if (["SE", "VN", "SU", "RE"].includes(party)) { inv.supplier.name = inv.supplier.name || name; }
        break;
      }
      case "REF":
        // Some distributors send the customer account in REF*IA / REF*VR / REF*CN instead of N1*ST.
        if (["IA", "VR", "CN"].includes(s[1]) && !inv.shipTo.customerNumber) inv.shipTo.customerNumber = s[2] || null;
        if (s[1] === "PO" && !inv.poNumber) inv.poNumber = s[2] || null;
        break;
      case "IT1": {
        const ids = pickIds(s.slice(6));
        line = { lineNo: s[1] || String(inv.lines.length + 1), qty: num(s[2]), uom: s[3] || null, unitPrice: num(s[4]),
                 itemCode: ids.code, upc: ids.upc, ids: ids.ids, description: null, pack: null, extended: null };
        if (line.qty != null && line.unitPrice != null) line.extended = Math.round(line.qty * line.unitPrice * 100) / 100;
        inv.lines.push(line);
        break;
      }
      case "PID": if (line) line.description = [line.description, s[5]].filter(Boolean).join(" ").trim() || null; break;
      case "PO4": if (line) line.pack = { count: num(s[1]), size: num(s[2]), uom: s[3] || null }; break;
      case "TDS": inv.total = cents(s[1]); line = null; break;
      case "SAC": {
        const amt = cents(s[5]); if (amt == null) break;
        inv.charges.push({ type: s[1] === "A" ? "allowance" : "charge", code: s[2] || null, description: s[15] || null, amount: s[1] === "A" ? -amt : amt });
        break;
      }
      case "CTT": case "DTM": case "ITD": case "N2": case "N3": case "N4": case "PER": case "TXI": case "CUR": case "ISS": break;
      default: inv.extra.push(s.join("*"));
    }
  }
  // Some distributors mark credits only with a negative total instead of BIG07 = CR.
  if (!inv.isCredit && inv.total != null && inv.total < 0) inv.isCredit = true;
  if (inv.isCredit) inv.lines.forEach(l => { if (l.qty > 0) { l.qty = -l.qty; if (l.extended != null) l.extended = -l.extended; } });
  const sum = inv.lines.reduce((a, l) => a + (l.extended || 0), 0) + inv.charges.reduce((a, c) => a + c.amount, 0);
  inv.computedTotal = Math.round(sum * 100) / 100;
  const declared = inv.total == null ? null : (inv.isCredit ? -Math.abs(inv.total) : inv.total);
  inv.totalMismatch = declared != null && Math.abs(declared - inv.computedTotal) > 0.02;
  if (!inv.supplier.name) inv.supplier.name = inv.supplier.id;
  return inv;
}

/** Parse one 832 transaction into a normalized price list. */
function parse832(t) {
  const cat = { kind: "pricelist", format: "edi832", supplier: { name: null, id: t.gs?.sender || null }, customerNumber: null, effectiveDate: null, items: [], extra: [] };
  let item = null;
  for (const s of t.segs) {
    const id = s[0].trim();
    if (id === "DTM" && ["007", "196", "092"].includes(s[1])) cat.effectiveDate = date(s[2]);
    else if (id === "N1") {
      if (s[1] === "ST" || s[1] === "BY") cat.customerNumber = s[4] || cat.customerNumber;
      else if (["SE", "VN", "SU"].includes(s[1])) cat.supplier.name = s[2] || cat.supplier.name;
    }
    else if (id === "LIN") { const ids = pickIds(s.slice(2)); item = { itemCode: ids.code, upc: ids.upc, description: null, pack: null, price: null, uom: null }; cat.items.push(item); }
    else if (id === "PID" && item) item.description = [item.description, s[5]].filter(Boolean).join(" ").trim() || null;
    else if (id === "PO4" && item) item.pack = { count: num(s[1]), size: num(s[2]), uom: s[3] || null };
    else if (id === "CTP" && item) {
      const p = num(s[3]);
      if (p != null && (item.price == null || s[2] === "CON" || s[2] === "NET")) { item.price = p; item.uom = (s[5] || "").split(/[^A-Z]/)[0] || item.uom; }
    }
    else if (!["BCT", "CTT", "REF", "PER", "N3", "N4", "DTM"].includes(id)) cat.extra.push(s.join("*"));
  }
  if (!cat.supplier.name) cat.supplier.name = cat.supplier.id;
  return cat;
}

/** Parse any X12 text. Returns { documents, warnings }. Unsupported sets are reported, not thrown. */
export function parseX12(text) {
  const tok = tokenize(text);
  const documents = [], warnings = [];
  for (const t of transactions(tok)) {
    if (t.type === "810") documents.push(parse810(t));
    else if (t.type === "832") documents.push(parse832(t));
    else warnings.push(`Skipped transaction set ${t.type} (${t.control}); not supported yet`);
    if (t.declaredCount != null && t.declaredCount !== t.segs.length + 2) warnings.push(`Set ${t.control}: SE says ${t.declaredCount} segments, found ${t.segs.length + 2}`);
  }
  return { documents, warnings };
}

export const isX12 = text => /^\s*\uFEFF?ISA/.test(String(text).slice(0, 200));
