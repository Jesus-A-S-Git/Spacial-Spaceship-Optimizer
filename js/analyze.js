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

function calibration(a) {
  const c = a.calibration;
  if (!c) { $("calibText").textContent = "No calibration in this data."; return; }
  const last = c.rounds[c.rounds.length - 1] || {};
  const before = (c.rounds[0] || {}).real_beats_optimizer_before_fit || {};
  const after = last.real_beats_optimizer_after_fit || {};
  $("calibText").replaceChildren(
    el("p", { text: `For ${c.ships_used} top ships, the optimizer built its own layout on the same hull with the same rooms ` +
      `(${c.search.iters} search steps each), and the score weights were fitted so that the real top layout scores higher. ` +
      `Odd-ranked ships were used for fitting and even-ranked ships only for checking.` }),
    el("p", { text: `On the held-out ships the real layout beat the optimizer's in ${pct(before.test)} of cases with the default weights ` +
      `and ${pct(after.test)} with the fitted weights. When this is already high, the weights were not the problem: the search ` +
      `simply does not reach top-player layouts from scratch, which is why the optimizer now starts from them.` }));
  const rt = $("calibRounds");
  rt.replaceChildren(el("tr", {}, el("th", { text: "Round" }), el("th", { class: "num", text: "Ships" }),
    el("th", { class: "num", text: "Real wins before fit" }), el("th", { class: "num", text: "Real wins after fit" })));
  c.rounds.forEach((r) => rt.append(el("tr", {}, el("td", { text: String(r.round) }), el("td", { class: "num", text: String(r.ships.train + r.ships.test) }),
    el("td", { class: "num", text: `${pct(r.real_beats_optimizer_before_fit.test)} held out / ${pct(r.real_beats_optimizer_before_fit.train)} fitted` }),
    el("td", { class: "num", text: `${pct(r.real_beats_optimizer_after_fit.test)} held out / ${pct(r.real_beats_optimizer_after_fit.train)} fitted` }))));
  const t = $("calibTable");
  t.replaceChildren(el("tr", {}, el("th", { text: "Weight" }), el("th", { class: "num", text: "Default" }), el("th", { class: "num", text: "Fitted" }), el("th", { class: "num", text: "Change" })));
  Object.keys(c.defaults).forEach((k) => {
    const d = c.defaults[k], w = c.weights[k], ch = d ? w / d : 1;
    t.append(el("tr", {}, el("td", { text: k }), el("td", { class: "num", text: fmt(d, 2) }), el("td", { class: "num", text: fmt(w, 2) }),
      el("td", { class: "num", text: Math.abs(ch - 1) < 0.01 ? "same" : "x" + ch.toFixed(2) })));
  });
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
      `${p.armor.length} armor tiles, ${new Set(p.lifts.map((s) => s[0])).size} lift columns.`;
    $("galLegend").replaceChildren(...ROOM_CATEGORIES.filter((c) => cnt[c.id]).map((c) => el("span", {}, swatch(c.color), document.createTextNode(`${c.label} (${cnt[c.id]})`))),
      el("span", {}, swatch("#e6b93c"), document.createTextNode("Armor")), el("span", {}, swatch("#38c6d9"), document.createTextNode("Lift")));
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
  calibration(a); show("secCalib");
});
