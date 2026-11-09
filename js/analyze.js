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
const planLink = (key, id) => `index.html?build=${encodeURIComponent(key)}` + (id != null ? `&ship=${encodeURIComponent(id)}` : "");
const WEAPON_NAMES = { laser: "Lasers", missile: "Missiles", hangar: "Hangars", combat: "Cannons", boarding: "Boarding", none: "No weapons" };

// ---------------------------------------------------------------- overview
function tiles(a) {
  const p = a.per_ship;
  const items = [
    [a.ships, "top-100 ships analysed"], [a.hulls.length, "different hulls"],
    [p.rooms[1], "rooms per ship (median)"], [p.armor[1], "armor tiles per ship (median)"],
    [p.lift_columns[1], "lift columns per ship (median)"],
    ...(p.vents ? [[p.vents[1], "service vents per ship (median)"]] : []),
    [a.aa_center ? fmt(a.aa_center[1]) : "-", "tiles from anti-air to the combat middle (median)"],
    ...(a.recommend && a.recommend.power_ratio ? [[pct(a.recommend.power_ratio[1]), "of their rooms' full power made by reactors (median)"]] : []),
    ...(a.insights ? [[pct(a.insights.tiers.reduce((x, t) => x + t.fill * t.ships, 0) / a.ships), "of the hull filled with rooms, armor, lifts and vents"]] : []),
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
  "top+similar": "Top-player style, borrowing layouts from similar hulls",
  "top+templates": "Top-player style, starting from other top layouts on the hull",
  "original+templates": "Original weights, starting from other top layouts",
};
function benchmark(a) {
  const b = a.benchmark;
  if (!b) { $("benchText").textContent = "No benchmark in this data yet (it runs with the GitHub Action every two weeks)."; return; }
  const n = b.configs[0].ships;
  $("benchText").replaceChildren(
    el("p", { text: `${n} top-100 ships (even ranks): the optimizer got the same hull, the same rooms and the same armor count as the real ` +
      `player, ${Math.round(b.seconds)} seconds of search on one core and the website's settings, and its best layout was measured ` +
      `the same way as the real ship. Medians over the ships; data from ${(b.updated || "").slice(0, 10)}.` }),
    el("p", { text: "Top players pack their hulls with armor and connect rooms with few lifts plus Service Vents (vents move crew " +
      "sideways and connect to a room only at its bottom row; side-by-side vents form a passage). Reachability is measured with " +
      "these rules, and the optimizer adds vents or lifts after each search until every combat room is reachable where possible." }));
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

// ---------------------------------------------------------------- builds
function buildsSection(a) {
  const b = a.builds;
  if (!b) return false;
  const box = $("buildBars");
  box.replaceChildren();
  const max = Math.max(...b.summary.map((g) => g.ships));
  b.summary.forEach((g) => {
    const track = el("div", { class: "track", title: `${g.build}: ${g.ships} of the top 100, best rank #${g.best_rank}, median rank #${fmt(g.median_rank, 0)}, average ${g.trophies} trophies` },
      el("div", { class: "fill", style: `width:${(g.ships / max) * 100}%` }));
    box.append(el("div", { class: "lab" }, document.createTextNode(g.build)), track,
      el("div", { class: "val", text: `${g.ships} · #${g.best_rank}` }));
  });
  // build x (offense mix, defenses) table, cells shaded where clearly above the top-100 median
  const off = b.offense_types, dfn = b.defense_types;
  const t = $("buildTable");
  t.replaceChildren(el("tr", {}, el("th", { text: "Build" }), el("th", { class: "num", text: "Ships" }),
    ...off.map(([, n]) => el("th", { class: "num", text: n === "Boarding" ? "Boarding (teleports)" : n + "s" })),
    ...dfn.map(([, n]) => el("th", { class: "num", text: n })), el("th")));
  const offMed = {};
  off.forEach(([k]) => { const v = b.ships.map((s) => s.offense[k]).sort((x, y) => x - y); offMed[k] = v[Math.floor(v.length / 2)]; });
  b.summary.forEach((g) => {
    t.append(el("tr", {}, el("td", { text: g.build }), el("td", { class: "num", text: String(g.ships) }),
      ...off.map(([k]) => el("td", { class: "num" + (g.offense[k] >= Math.max(1, offMed[k] * 2) ? " hi" : ""), text: fmt(g.offense[k]) })),
      ...dfn.map(([k]) => el("td", { class: "num" + (g.defense[k] > b.spread[k][2] - 0.01 && g.defense[k] > b.spread[k][1] ? " hi" : ""), text: fmt(g.defense[k]) })),
      el("td", {}, ...(buildKeyOf(g.build) ? [el("a", { class: "btnlink small", href: planLink(buildKeyOf(g.build)), text: "Plan" })] : []))));
  });
  // every ship, filterable by build
  const sel = $("buildFilter");
  sel.replaceChildren(el("option", { value: "", text: `All builds (${b.ships.length} ships)` }),
    ...b.summary.map((g) => el("option", { value: g.build, text: `${g.build} (${g.ships})` })));
  const list = () => {
    const tb = $("buildShips");
    tb.replaceChildren(el("tr", {}, el("th", { class: "num", text: "Rank" }), el("th", { text: "Player" }), el("th", { text: "Hull" }), el("th", { text: "Build" })));
    b.ships.filter((s) => !sel.value || s.build === sel.value).sort((x, y) => x.rank - y.rank).forEach((s) => {
      const off = b.offense_types.filter(([k]) => s.offense[k]).map(([k, n]) => `${s.offense[k]} ${n.toLowerCase()}`).join(", ");
      const dfn = b.defense_types.map(([k, n]) => `${s.defense[k]} ${n}`).join(", ");
      tb.append(el("tr", {}, el("td", { class: "num", text: "#" + s.rank }), el("td", { text: s.name }), el("td", { text: s.ship }),
        el("td", { class: "buildcell", text: s.label, title: `Weapons: ${off || "none"}\nDefense: ${dfn}` })));
    });
  };
  sel.onchange = list;
  list();
  return true;
}


// "Missile/Hangar hybrid" -> "missile+hangar" (the recommender's build key)
function buildKeyOf(name) {
  const keys = { Laser: "laser", Missile: "missile", Hangar: "hangar", Cannon: "combat", Boarding: "boarding" };
  const m = String(name).match(/^(\w+)(?:\/(\w+))? (?:build|hybrid)$/);
  return m && keys[m[1]] ? keys[m[1]] + (m[2] && keys[m[2]] ? "+" + keys[m[2]] : "") : null;
}

// ---------------------------------------------------------------- top 10 vs the rest
function tiersSection(a) {
  const ins = a.insights;
  if (!ins) return false;
  const T = ins.tiers;
  const rows = [
    ["Average trophies", (t) => t.trophies, 0], ["Rooms", (t) => t.rooms, 1], ["Armor tiles", (t) => t.armor, 1],
    ["Lift columns", (t) => t.lifts, 1], ["Service vents", (t) => t.vents, 1], ["Hull tiles", (t) => t.hull_tiles, 0],
    ["Hull filled", (t) => t.fill, "%"],
    ...ROOM_CATEGORIES.filter((c) => T.some((t) => t.cats[c.id] >= 0.3)).map((c) => [c.label + " rooms", (t) => t.cats[c.id], 1, c.color]),
  ];
  const tb = $("tierTable");
  tb.replaceChildren(el("tr", {}, el("th", { text: "Per ship" }), ...T.map((t) => el("th", { class: "num", text: `${t.label} (${t.ships})` }))));
  rows.forEach(([label, f, d, color]) => {
    const vals = T.map(f), max = Math.max(...vals), min = Math.min(...vals);
    const clear = max > 0 && (max - min) / max >= 0.05;            // only shade a real difference
    tb.append(el("tr", {}, el("td", { class: "typecell" }, ...(color ? [swatch(color)] : []), document.createTextNode(label)),
      ...vals.map((v) => el("td", { class: "num" + (clear && v === max ? " hi" : ""), text: d === "%" ? pct(v) : fmt(v, d) }))));
  });
  // main weapon share per band
  const box = $("weaponMix");
  box.replaceChildren();
  const keys = ["laser", "missile", "hangar", "combat", "boarding", "none"];
  const color = (k) => (k === "none" ? "#555" : catOf(k).color);
  ins.weapon_mix.forEach((m) => {
    const bar = el("div", { class: "bar" });
    keys.forEach((k) => {
      const n = m.primary[k] || 0;
      if (n) bar.append(el("span", { style: `width:${(100 * n) / m.ships}%;background:${color(k)}`, title: `${m.label}: ${n} of ${m.ships} ships run mainly ${WEAPON_NAMES[k].toLowerCase()}` }));
    });
    box.append(el("div", { text: m.label }), bar);
  });
  $("weaponLegend").replaceChildren(...keys.filter((k) => ins.weapon_mix.some((m) => m.primary[k])).map((k) => el("span", {}, swatch(color(k)), document.createTextNode(WEAPON_NAMES[k]))));
  const t = $("top10Rooms");
  t.replaceChildren(el("tr", {}, el("th", { text: "Room" }), el("th", { text: "Type" }), el("th", { class: "num", text: "Top 10" }), el("th", { class: "num", text: "Ranks 11-100" })));
  const add = (list, tag) => list.forEach(([c, n, top, rest]) => t.append(el("tr", {}, el("td", { text: n + tag }),
    el("td", { class: "typecell" }, swatch(catOf(c).color), document.createTextNode(catOf(c).label)),
    el("td", { class: "num", text: pct(top) }), el("td", { class: "num", text: pct(rest) }))));
  add(ins.top10_rooms, "");
  if (ins.top10_rare.length) {
    t.append(el("tr", {}, el("td", { colspan: "4", class: "muted", text: "...and rooms the top 10 run less often:" })));
    add(ins.top10_rare, "");
  }
  return true;
}

// ---------------------------------------------------------------- build explorer
function explorer(a) {
  const r = a.recommend;
  if (!r) return false;
  const sel = $("exPick");
  const name = (k) => {
    const [p, q] = k.split("+");
    return q ? `${WEAPON_NAMES[p].replace(/s$/, "")}/${WEAPON_NAMES[q].replace(/s$/, "")} hybrid` : `${WEAPON_NAMES[p].replace(/s$/, "")} build`;
  };
  sel.replaceChildren(...Object.entries(r.builds).map(([k, v]) => el("option", { value: k, text: `${name(k)} (${v.ships} ship${v.ships > 1 ? "s" : ""})` })),
    el("option", { value: "*all", text: `All top-100 ships (${r.all.ships})` }));
  const render = () => {
    const k = sel.value, pr = k === "*all" ? r.all : r.builds[k];
    $("exPlan").hidden = k === "*all";
    if (k !== "*all") $("exPlan").href = planLink(k);
    $("exInfo").textContent = `${pr.ships} ship${pr.ships > 1 ? "s" : ""} (ranks ${pr.ranks.slice(0, 8).map((x) => "#" + x).join(", ")}${pr.ranks.length > 8 ? ", ..." : ""}), ` +
      `hulls of ${fmt(pr.hull_tiles, 0)} tiles on average. Per 100 hull tiles: ${fmt(pr.armor)} armor tiles; per ship ${fmt(pr.lifts)} lift columns and ${fmt(pr.vents)} vents.`;
    const t = $("exTable");
    t.replaceChildren(el("tr", {}, el("th", { text: "Type" }), el("th", { class: "num", text: "Rooms / 100 tiles" }),
      el("th", { class: "num", text: "Tiles / 100" }), el("th", { class: "num", text: "Ships with it" }), el("th", { text: "Rooms they use (per ship)" })));
    ROOM_CATEGORIES.filter((c) => pr.cats[c.id]).sort((x, y) => pr.cats[y.id][1] - pr.cats[x.id][1]).forEach((c) => {
      const [n, tiles, share] = pr.cats[c.id];
      const fam = (pr.families[c.id] || []).slice(0, 5).map(([nm, w, h, per]) => `${nm} ${w}x${h} (${fmt(per, 2)})`).join(", ");
      t.append(el("tr", {}, el("td", { class: "typecell" }, swatch(c.color), document.createTextNode(c.label)),
        el("td", { class: "num", text: fmt(n, 2) }), el("td", { class: "num", text: fmt(tiles, 1) }),
        el("td", { class: "num", text: pct(share) }), el("td", { class: "buildcell", text: fam })));
    });
  };
  sel.onchange = render;
  render();
  return true;
}

// ---------------------------------------------------------------- trophies
function trophySection(a) {
  const c = a.insights && a.insights.trophy_corr;
  if (!c) return false;
  const label = (k) => (k.startsWith("cat:") ? catOf(k.slice(4)).label + " rooms" : { armor: "Armor tiles", rooms: "Rooms", weapons: "Weapon rooms", lifts: "Lift columns", vents: "Service vents", hull_tiles: "Hull size" }[k] || k);
  const rows = Object.entries(c).sort((x, y) => y[1] - x[1]);
  const box = $("trophyBars");
  box.replaceChildren();
  rows.forEach(([k, v]) => {
    const color = k.startsWith("cat:") ? catOf(k.slice(4)).color : null;
    const track = el("div", { class: "track", title: `${label(k)}: ${v > 0 ? "+" : ""}${v.toFixed(2)}` },
      el("div", { class: "zero" }), el("div", { class: "fill " + (v >= 0 ? "pos" : "neg"), style: `width:${Math.min(50, Math.abs(v) * 100)}%` }));
    box.append(el("div", { class: "lab" }, ...(color ? [swatch(color)] : []), document.createTextNode(label(k))), track, el("div", { class: "val", text: (v > 0 ? "+" : "") + fmt(v, 2) }));
  });
  return true;
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
    const bs = Top100.analysis && Top100.analysis.builds && Top100.analysis.builds.ships.find((s) => s.rank === l.rank);
    $("galBuild").replaceChildren();
    if (bs) {
      $("galBuild").append(document.createTextNode("Build: " + bs.label + " "));
      const k = buildKeyOf(bs.build);
      if (k) $("galBuild").append(el("a", { class: "btnlink small", href: planLink(k, l.ship_id), text: "Plan this build on this hull" }));
    }
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
  tiles(a); show("secOverview"); show("jump");
  if (tiersSection(a)) show("secTiers");
  if (explorer(a)) show("secExplorer");
  hullTable(a); show("secHulls");
  if (buildsSection(a)) show("secBuilds");
  gallery(lays); show("secGallery");
  roomBars(a); show("secRooms");
  if (trophySection(a)) show("secTrophy");
  edgeBars(a); show("secEdge");
  adjTable(a); show("secAdj");
  armor(a); show("secArmor");
  benchmark(a); show("secCalib");
});
