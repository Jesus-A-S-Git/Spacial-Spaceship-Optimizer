"use strict";
// Top 100 analysis page: renders data/top_analysis.json and draws the top layouts from data/top_layouts.json.
const $ = (id) => document.getElementById(id);
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (k === "style") e.style.cssText = v; else e.setAttribute(k, v);
  }
  kids.forEach((k) => e.append(k));
  return e;
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v, d = 1) => (v == null ? "-" : (+v).toFixed(d).replace(/\.0+$/, ""));
const pct = (v) => (v == null ? "-" : Math.round(v * 100) + "%");
const show = (id) => { $(id).hidden = false; };
const swatch = (c) => el("i", { style: `background:${c}` });
const optimizerLink = (id) => `index.html?ship=${encodeURIComponent(id)}`;

// ---------------------------------------------------------------- overview
function tiles(a) {
  const p = a.per_ship;
  const items = [
    [a.ships, "top-100 ships analysed"], [a.hulls.length, "different hulls"],
    [p.rooms[1], "rooms per ship (median)"], [p.armor[1], "armor tiles per ship (median)"],
    [p.lift_columns[1], "lift columns per ship (median)"],
    ...(p.vents ? [[p.vents[1], "service vents per ship (median)"]] : []),
    [a.aa_center ? fmt(a.aa_center[1]) : "-", "tiles from anti-air to the combat middle (median)"],
  ];
  $("tiles").replaceChildren(...items.map(([v, t]) => el("div", { class: "tile" }, el("b", { text: String(v) }), el("span", { text: t }))));
}

function hullTable(a) {
  const t = $("hullTable");
  const max = Math.max(...a.hulls.map((h) => h.count));
  t.replaceChildren(el("tr", {}, el("th", { text: "Hull" }), el("th", { text: "Players" }), el("th", { class: "num", text: "Best rank" }),
    el("th", { class: "num", text: "Median rank" }), el("th")));
  a.hulls.forEach((h) => {
    const bar = el("span", { class: "minibar", style: `width:${Math.max(3, (h.count / max) * 120)}px` });
    t.append(el("tr", {},
      el("td", { text: h.ship_name }),
      el("td", { title: `${h.count} of the top 100` }, bar, document.createTextNode(String(h.count))),
      el("td", { class: "num", text: "#" + h.best_rank }),
      el("td", { class: "num", text: "#" + fmt(h.median_rank, 0) }),
      el("td", {}, el("a", { class: "btnlink small", href: optimizerLink(h.ship_id), text: "Open in optimizer" }))));
  });
}

// ---------------------------------------------------------------- bars
function hbars(box, rows, max, unit) {
  box.replaceChildren();
  rows.forEach(({ label, color, q }) => {
    const [lo, med, hi] = q;
    const track = el("div", { class: "track", title: `${label}: median ${fmt(med)}${unit || ""}, middle half of ships ${fmt(lo)}-${fmt(hi)}` },
      el("div", { class: "fill", style: `width:${(med / max) * 100}%` }),
      el("div", { class: "iqr", style: `left:${(lo / max) * 100}%;width:${Math.max(0.5, ((hi - lo) / max) * 100)}%` }));
    box.append(el("div", { class: "lab" }, ...(color ? [swatch(color)] : []), document.createTextNode(label)), track, el("div", { class: "val", text: fmt(med) }));
  });
}

function roomBars(a) {
  const rows = ROOM_CATEGORIES.map((c) => ({ label: c.label, color: c.color, q: a.per_ship["cat:" + c.id] || [0, 0, 0] }))
    .filter((r) => r.q[2] > 0);
  hbars($("roomBars"), rows, Math.max(...rows.map((r) => r.q[2])), " rooms");
  const t = $("popTable");
  t.replaceChildren(el("tr", {}, el("th", { text: "Type" }), el("th", { text: "Room" }), el("th", { class: "num", text: "Per ship" }), el("th", { class: "num", text: "Ships with it" })));
  ROOM_CATEGORIES.forEach((c) => (a.popular_rooms[c.id] || []).slice(0, 5).forEach(([name, per, share], i) => {
    t.append(el("tr", {}, el("td", { class: "typecell" }, ...(i === 0 ? [swatch(c.color), document.createTextNode(c.label)] : [])),
      el("td", { text: name }), el("td", { class: "num", text: fmt(per, 2) }), el("td", { class: "num", text: pct(share) })));
  }));
}

function edgeBars(a) {
  const box = $("edgeBars");
  const pe = a.patterns.edge;
  const rows = ROOM_CATEGORIES.filter((c) => c.id in pe).map((c) => ({ c, v: pe[c.id], share: a.edge_share[c.id] }))
    .sort((x, y) => y.v - x.v);
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.v)));
  box.replaceChildren();
  rows.forEach(({ c, v, share }) => {
    const w = (Math.abs(v) / max) * 50;
    const track = el("div", { class: "track", title: `${c.label}: ${pct(share)} of its outline is hull edge (average room ${pct(a.edge_overall)})` },
      el("div", { class: "zero" }), el("div", { class: "fill " + (v >= 0 ? "pos" : "neg"), style: `width:${w}%` }));
    box.append(el("div", { class: "lab" }, swatch(c.color), document.createTextNode(c.label)), track, el("div", { class: "val", text: (v > 0 ? "+" : "") + fmt(v, 2) }));
  });
}

// diverging colour: mid grey -> blue (together) / orange (apart), by |log2| up to 1.5
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
function adjTable(a) {
  const cs = getComputedStyle(document.documentElement);
  const POS = cs.getPropertyValue("--pos").trim(), NEG = cs.getPropertyValue("--neg").trim(), MID = cs.getPropertyValue("--mid").trim();
  const cats = ROOM_CATEGORIES.filter((c) => a.adjacency.some((r) => r.a === c.id || r.b === c.id));
  const cell = {};
  a.adjacency.forEach((r) => { cell[r.a + "|" + r.b] = r; cell[r.b + "|" + r.a] = r; });
  const used = a.patterns.adj;
  const t = $("adjTable");
  t.replaceChildren(el("tr", {}, el("th"), ...cats.map((c) => el("th", { class: "colh", text: c.label }))));
  cats.forEach((r) => {
    const tr = el("tr", {}, el("th", { class: "rowh", text: r.label }));
    cats.forEach((c) => {
      const d = cell[r.id + "|" + c.id];
      const key = [r.id, c.id].sort().join("|");
      if (!d) { tr.append(el("td", { class: "na" })); return; }
      const inUse = key in used;
      const v = d.log2;
      const bg = inUse ? mix(MID, v >= 0 ? POS : NEG, Math.min(1, Math.abs(v) / 1.5)) : "#2a3043";
      tr.append(el("td", {
        style: `background:${bg}`, text: inUse ? (v > 0 ? "+" : "") + v.toFixed(1) : "",
        title: `${r.label} next to ${c.label}: ${d.observed} times, chance would give ${d.expected}` + (inUse ? ` (log2 ${v.toFixed(2)})` : " (too rare, not used)"),
      }));
    });
    t.append(tr);
  });
}

function armor(a) {
  const rows = ROOM_CATEGORIES.filter((c) => a.armor_touch[c.id]).map((c) => ({ label: c.label, color: c.color, q: a.armor_touch[c.id] }));
  hbars($("armorBars"), rows, Math.max(1, ...rows.map((r) => r.q[2])), " armor tiles");
  const pr = a.priors;
  const notes = [`Armor tiles touching one room, by room type (median, with the middle half of rooms).`];
  if (pr) {
    notes.push(`Top ships use one lift column per ${fmt(pr.width_per_lift[1])} tiles of hull width (middle half ${fmt(pr.width_per_lift[0])}-${fmt(pr.width_per_lift[2])}).`);
    notes.push(`${pct(pr.armor_shared_share)} of armor tiles touch two or more combat rooms. ${pct(pr.nc_cluster_share)} of non-combat rooms touch another non-combat room.`);
  }
  $("armorNotes").replaceChildren(...notes.map((n) => el("p", { text: n })));
}

const BENCH_ROWS = [
  ["armor_sum", "Armor value (touchpoints, priority rooms count 3x)", 0, true],
  ["armor_pri", "Armor tiles on each priority room", 2, true],
  ["armor_float", "Armor touching no combat room", 1, false],
  ["lifts", "Lift columns", 1, null],
  ["vents", "Service vents", 1, null],
  ["unreach", "Room pairs crew cannot reach", 0, null],
  ["nc_grouped", "Non-combat rooms grouped", "%", true],
  ["edge_nc", "Non-combat outline on the hull edge", "%", null],
];
const BENCH_NAMES = {
  "original": "Original weights, from scratch",
  "top": "Top-player style, from scratch",
  "top+templates": "Top-player style, starting from other top layouts on the hull",
  "original+templates": "Original weights, starting from other top layouts",
};
function benchmark(a) {
  const b = a.benchmark;
  if (!b) { $("benchText").textContent = "No benchmark in this data yet (it runs with the weekly Action)."; return; }
  const n = b.configs[0].ships;
  $("benchText").replaceChildren(
    el("p", { text: `${n} top-100 ships (even ranks): the optimizer got the same hull, the same rooms and the same armor count as the real ` +
      `player, ${Math.round(b.seconds)} seconds of search on one core and the website's settings, and its best layout was measured ` +
      `the same way as the real ship. Medians over the ships; data from ${(b.updated || "").slice(0, 10)}.` }),
    el("p", { text: "Top players pack their hulls with armor and connect rooms with few lifts plus Service Vents (vents link the " +
      "rooms, vents and lifts they touch, and sit on armor between rooms: \"sandwiching\"). Reachability is measured with these " +
      "game-like vents. The top-player style (the website's default) weights armor like top players do; the original weights " +
      "keep every room reachable at the cost of armor." }));
  const t = $("benchTable");
  t.replaceChildren(el("tr", {}, el("th", { text: "Measure" }), el("th", { class: "num", text: "Real top ships" }),
    ...b.configs.map((c) => el("th", { class: "num", text: BENCH_NAMES[c.name] || c.name }))));
  const show = (v, d) => (d === "%" ? pct(v) : fmt(v, d));
  BENCH_ROWS.forEach(([k, label, d, higher]) => {
    const real = b.configs[0].real[k];
    t.append(el("tr", {}, el("td", { text: label }), el("td", { class: "num", text: show(real, d) }),
      ...b.configs.map((c) => {
        const v = c.optimizer[k];
        let note = "";
        if (k === "armor_sum") note = ` (${Math.round((100 * v) / real)}%)`;
        return el("td", { class: "num", text: show(v, d) + note });
      })));
  });
  t.append(el("tr", {}, el("td", { text: "Ships where the optimizer's armor value is at least the real ship's" }), el("td"),
    ...b.configs.map((c) => el("td", { class: "num", text: `${c.armor_at_least_real} of ${c.ships}` }))));
}

// ---------------------------------------------------------------- gallery
function drawShip(l) {
  const ship = Hulls.byId(l.ship_id);
  const p = Top100.parse(l);
  const rows = ship ? ship.rows : null;
  let W = rows ? rows[0].length : 0, H = rows ? rows.length : 0;
  p.rooms.forEach(([x, y, w, h]) => { W = Math.max(W, x + w); H = Math.max(H, y + h); });
  // crop to the used area
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); };
  if (rows) rows.forEach((r, y) => [...r].forEach((c, x) => { if (c !== ".") grow(x, y); }));
  p.rooms.forEach(([x, y, w, h]) => { grow(x, y); grow(x + w - 1, y + h - 1); });
  const T = 16, w = (x1 - x0) * T, h = (y1 - y0) * T;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="system-ui,sans-serif">`,
    `<rect width="${w}" height="${h}" fill="#0c111b"/>`];
  if (rows) rows.forEach((r, y) => [...r].forEach((c, x) => {
    if (c !== ".") out.push(`<rect x="${(x - x0) * T}" y="${(y - y0) * T}" width="${T}" height="${T}" fill="#2a3347" stroke="#1a2133"/>`);
  }));
  p.rooms.forEach(([x, y, rw, rh, cat, short, name, type]) => {
    const c = catOf(cat);
    const label = (short || "").slice(0, rw >= 3 ? 4 : 3);
    out.push(`<g><title>${esc(name)} [${esc(c.label)}] ${rw}x${rh} at ${x}, ${y}</title>` +
      `<rect x="${(x - x0) * T + 1}" y="${(y - y0) * T + 1}" width="${rw * T - 2}" height="${rh * T - 2}" rx="2" fill="${c.color}" stroke="#0c111b"/>` +
      (rw > 1 ? `<text x="${(x - x0 + rw / 2) * T}" y="${(y - y0 + rh / 2) * T + 4}" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${esc(label)}</text>` : "") + "</g>");
  });
  p.armor.forEach(([x, y]) => out.push(`<rect x="${(x - x0) * T + 2}" y="${(y - y0) * T + 2}" width="${T - 4}" height="${T - 4}" fill="#e6b93c"/>`));
  p.vents.forEach(([x, y]) => out.push(`<rect x="${(x - x0) * T + 3}" y="${(y - y0) * T + 3}" width="${T - 6}" height="${T - 6}" fill="#f5f5f5"><title>Service vent ${x}, ${y}</title></rect>`));
  p.lifts.forEach(([x, a, b]) => out.push(`<rect x="${(x - x0) * T + 3}" y="${(a - y0) * T}" width="${T - 6}" height="${(b - a + 1) * T}" fill="#38c6d9"><title>Lift x=${x}, y ${a}-${b}</title></rect>`));
  out.push("</svg>");
  return { svg: out.join(""), p };
}
function gallery(lays) {
  const sel = $("galPick");
  sel.replaceChildren(...lays.slice().sort((a, b) => a.rank - b.rank).map((l) =>
    el("option", { value: String(l.rank), text: `#${l.rank} ${l.name} - ${l.ship_name} (${l.trophies} trophies)` })));
  const render = () => {
    const l = lays.find((x) => String(x.rank) === sel.value);
    if (!l) return;
    const { svg, p } = drawShip(l);
    $("galSvg").innerHTML = svg;
    const cnt = {};
    p.rooms.forEach((r) => { cnt[r[4]] = (cnt[r[4]] || 0) + 1; });
    $("galInfo").textContent = `${l.ship_name}, level ${l.ship_level}${l.alliance ? " - " + l.alliance : ""}: ${p.rooms.length} rooms, ` +
      `${p.armor.length} armor tiles, ${new Set(p.lifts.map((s) => s[0])).size} lift columns, ${p.vents.length} vents.`;
    $("galLegend").replaceChildren(...ROOM_CATEGORIES.filter((c) => cnt[c.id]).map((c) => el("span", {}, swatch(c.color), document.createTextNode(`${c.label} (${cnt[c.id]})`))),
      el("span", {}, swatch("#e6b93c"), document.createTextNode("Armor")), el("span", {}, swatch("#38c6d9"), document.createTextNode("Lift")), el("span", {}, swatch("#f5f5f5"), document.createTextNode("Vent")));
    $("galOpen").href = optimizerLink(l.ship_id);
  };
  sel.onchange = render;
  render();
}

// ---------------------------------------------------------------- start
Promise.all([Top100.load(), Hulls.load(false).catch(() => null)]).then(() => {
  const a = Top100.analysis, lays = Top100.layouts;
  if (!a || !lays.length) {
    $("loadMsg").textContent = "No top-100 data yet. Run the \"Refresh game data and top-100 layouts\" workflow in the repository's Actions tab.";
    return;
  }
  $("loadMsg").hidden = true;
  $("subtitle").textContent = `How the top ${a.ships} ladder players build their ships (data from ${(a.updated || "").slice(0, 10)}), and what the optimizer learns from them.`;
  tiles(a); show("secOverview");
  hullTable(a); show("secHulls");
  gallery(lays); show("secGallery");
  roomBars(a); show("secRooms");
  edgeBars(a); show("secEdge");
  adjTable(a); show("secAdj");
  armor(a); show("secArmor");
  benchmark(a); show("secCalib");
});
