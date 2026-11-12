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
// number with up to d decimals ("2.50" -> "2.5" is not trimmed, "2.0" -> "2"); never "-0"
const fmt = (v, d = 1) => {
  if (v == null || !isFinite(+v)) return "-";
  const t = (+v).toFixed(d).replace(/\.0+$/, "");
  return /^-0(\.0*)?$/.test(t) ? t.slice(1) : t;
};
const signed = (v, d) => (+v > 0 && fmt(v, d) !== "0" ? "+" : "") + fmt(v, d);
const pct = (v) => (v == null || !isFinite(+v) ? "-" : Math.round(v * 100) + "%");
const show = (id) => { $(id).hidden = false; };
// readable text colour (near-black or white) on a #rrggbb background
function inkFor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return "#fff";
  const lin = [0, 2, 4].map((i) => { const c = parseInt(m[1].slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? "#000" : "#fff";   // pure black/white: always 4.5:1 or more
}
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
    ...(a.insights && a.insights.tiers && a.insights.tiers.length ? [[pct(a.insights.tiers.reduce((x, t) => x + t.fill * t.ships, 0) /
      a.insights.tiers.reduce((x, t) => x + t.ships, 0)), "of the hull filled with rooms, armor, lifts and vents (average)"]] : []),
  ];
  $("tiles").replaceChildren(...items.map(([v, t]) => el("div", { class: "tile" }, el("b", { text: String(v) }), el("span", { text: t }))));
}

function hullTable(a) {
  const t = $("hullTable");
  const max = Math.max(...a.hulls.map((h) => h.count));
  t.replaceChildren(el("tr", {}, el("th", { text: "Hull" }), el("th", { text: "Players" }), el("th", { class: "num", text: "Best rank" }),
    el("th", { class: "num hidem", text: "Median rank" }), el("th")));
  a.hulls.forEach((h) => {
    const bar = el("span", { class: "minibar", style: `width:${Math.max(3, (h.count / max) * 120)}px` });
    t.append(el("tr", {},
      el("td", { text: h.ship_name }),
      el("td", { title: `${h.count} of the top 100` }, bar, document.createTextNode(String(h.count))),
      el("td", { class: "num", text: "#" + h.best_rank }),
      el("td", { class: "num hidem", text: "#" + fmt(h.median_rank, 0) }),
      el("td", {}, el("a", { class: "btnlink small", href: optimizerLink(h.ship_id), text: "Open" , title: "Open this hull in the optimizer", "aria-label": "Open " + h.ship_name + " in optimizer" }))));
  });
}

// ---------------------------------------------------------------- bars
// rows: {label, color, q: [q1, median, q3]} (bar = median, whisker = middle half) or {label, color, v} (one value, no whisker)
function hbars(box, rows, max, unit, valText) {
  box.replaceChildren();
  if (!(max > 0)) max = 1;
  const w = (x) => Math.max(0, Math.min(100, (x / max) * 100));
  rows.forEach(({ label, color, q, v }) => {
    const single = q == null;
    const [lo, med, hi] = single ? [v, v, v] : q;
    const title = single ? `${label}: ${valText ? valText(med) : fmt(med) + (unit || "")}`
      : `${label}: median ${fmt(med)}${unit || ""}, middle half ${fmt(lo)}-${fmt(hi)}`;
    const track = el("div", { class: "track", title },
      el("div", { class: "fill", style: `width:${w(med)}%` }),
      ...(single ? [] : [el("div", { class: "iqr", style: `left:${w(lo)}%;width:${Math.max(0.5, w(hi) - w(lo))}%` })]));
    box.append(el("div", { class: "lab" }, ...(color ? [swatch(color)] : []), document.createTextNode(label)), track,
      el("div", { class: "val", text: valText ? valText(med) : fmt(med) }));
  });
}

function roomBars(a) {
  const rows = ROOM_CATEGORIES.map((c) => ({ label: c.label, color: c.color, q: a.per_ship["cat:" + c.id] || [0, 0, 0] }))
    .filter((r) => r.q[2] > 0);
  hbars($("roomBars"), rows, Math.max(1, ...rows.map((r) => r.q[2])), " rooms");
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
    box.append(el("div", { class: "lab" }, swatch(c.color), document.createTextNode(c.label)), track, el("div", { class: "val", text: signed(v, 2) }));
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
        style: `background:${bg};color:${inkFor(bg)}`, text: inUse ? (v > 0 ? "+" : "") + v.toFixed(1) : "",
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
  if (!b || !b.configs || !b.configs.length) { $("benchText").textContent = "No benchmark in this data yet (it runs with the GitHub Action every two weeks)."; return; }
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
        if (k === "armor_sum" && real > 0 && v != null) note = ` (${Math.round((100 * v) / real)}%)`;
        return el("td", { class: "num", text: show(v, d) + note });
      })));
  });
  t.append(el("tr", {}, el("td", { text: "Ships where the optimizer's armor value is at least the real ship's" }), el("td"),
    ...b.configs.map((c) => el("td", { class: "num", text: c.armor_at_least_real != null ? `${c.armor_at_least_real} of ${c.ships}` : "-" }))));
}

// ---------------------------------------------------------------- builds
// build names like "Hangar/Boarding": allow a line break after the slash on narrow screens
const slashBreak = (t) => String(t).replace(/\//g, "/\u200b");
function buildsSection(a) {
  const b = a.builds;
  if (!b) return false;
  const box = $("buildBars");
  box.replaceChildren();
  const max = Math.max(1, ...b.summary.map((g) => g.ships));
  b.summary.forEach((g) => {
    const track = el("div", { class: "track", title: `${g.build}: ${g.ships} of the top 100, best rank #${g.best_rank}, median rank #${fmt(g.median_rank, 0)}, average ${g.trophies} trophies` },
      el("div", { class: "fill", style: `width:${(g.ships / max) * 100}%` }));
    box.append(el("div", { class: "lab" }, document.createTextNode(slashBreak(g.build))), track,
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
    tb.replaceChildren(el("tr", {}, el("th", { class: "num", text: "Rank" }), el("th", { text: "Player" }), el("th", { text: "Hull" }), el("th", { text: "Build" }),
      el("th", { class: "num", text: "Power made / needed", title: "Reactor power / power all systems draw at full power" })));
    b.ships.filter((s) => !sel.value || s.build === sel.value).sort((x, y) => x.rank - y.rank).forEach((s) => {
      const off = b.offense_types.filter(([k]) => s.offense[k]).map(([k, n]) => `${s.offense[k]} ${n.toLowerCase()}`).join(", ");
      const dfn = b.defense_types.map(([k, n]) => `${s.defense[k]} ${n}`).join(", ");
      tb.append(el("tr", {}, el("td", { class: "num", text: "#" + s.rank }), el("td", { text: s.name }), el("td", { text: s.ship }),
        el("td", { class: "buildcell", text: s.label, title: `Weapons: ${off || "none"}\nDefense: ${dfn}` }),
        el("td", { class: "num", text: s.power && s.power.use ? `${s.power.make} / ${s.power.use} (${pct(s.power.ratio)})` : "-" })));
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
      if (n && m.ships) bar.append(el("span", { style: `width:${(100 * n) / m.ships}%;background:${color(k)}`, title: `${m.label}: ${n} of ${m.ships} ships run mainly ${WEAPON_NAMES[k].toLowerCase()}` }));
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
      `hulls of ${fmt(pr.hull_tiles, 0)} tiles on average. Per 100 hull tiles: ${fmt(pr.armor)} armor tiles; per ship ${fmt(pr.lifts)} lift columns and ${fmt(pr.vents)} vents.` +
      (pr.power ? ` Power: ${fmt(pr.power.make)} made against ${fmt(pr.power.use)} needed at full power (${pct(pr.power.ratio[1])}).` : "");
    const t = $("exTable");
    t.replaceChildren(el("tr", {}, el("th", { text: "Type" }), el("th", { class: "num", text: "Rooms / 100 tiles" }),
      el("th", { class: "num", text: "Room tiles / 100", title: "Hull tiles taken by rooms of this type, per 100 hull tiles" }), el("th", { class: "num", text: "Ships with it" }), el("th", { text: "Rooms they use (per ship)" })));
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
    const track = el("div", { class: "track", title: `${label(k)}: ${signed(v, 2)}` },
      el("div", { class: "zero" }), el("div", { class: "fill " + (v >= 0 ? "pos" : "neg"), style: `width:${Math.min(50, Math.abs(v) * 100)}%` }));   // full half-track = +-0.5
    box.append(el("div", { class: "lab" }, ...(color ? [swatch(color)] : []), document.createTextNode(label(k))), track, el("div", { class: "val", text: signed(v, 2) }));
  });
  return true;
}


// ---------------------------------------------------------------- power
function powerSection(a) {
  const r = a.recommend;
  if (!r || !r.all.power) return false;
  const P = r.all.power;
  const ships = (a.builds ? a.builds.ships : []).filter((s) => s.power && s.power.use);
  const makes = ships.map((s) => s.power.make), uses = ships.map((s) => s.power.use);
  // most common power made (most top ships run the same reactor setup); only shown when it is most ships
  const modeCount = {};
  makes.forEach((m) => { modeCount[m] = (modeCount[m] || 0) + 1; });
  const [modeMake, same] = Object.entries(modeCount).sort((x, y) => y[1] - x[1])[0] || [null, 0];
  $("powerTiles").replaceChildren(...[
    [fmt(P.make), "power made by reactors (average)"],
    [fmt(P.use), "power all systems need at full power (average)"],
    [pct(P.ratio[1]), `made / needed (median; middle half ${pct(P.ratio[0])}-${pct(P.ratio[2])})`],
    ...(uses.length ? [[`${Math.min(...uses)}-${Math.max(...uses)}`, "power needed, lowest to highest ship"]] : []),
    ...(same >= makes.length / 2 ? [[`${same} of ${makes.length}`, `ships make exactly ${fmt(modeMake)} power`]] : []),
  ].map(([v, t]) => el("div", { class: "tile" }, el("b", { text: String(v) }), el("span", { text: t }))));
  const name = (k) => {
    const [p, q] = k.split("+");
    const n = (x) => WEAPON_NAMES[x].replace(/s$/, "");
    return q ? `${n(p)}/${n(q)} hybrid` : `${n(p)} build`;
  };
  const t = $("powerTable");
  t.replaceChildren(el("tr", {}, el("th", { text: "Build" }), el("th", { class: "num", text: "Ships" }), el("th", { class: "num", text: "Made" }),
    el("th", { class: "num", text: "Needed" }), el("th", { class: "num", text: "Made / needed" }), el("th", { class: "num", text: "Middle half" }),
    el("th", { text: "Biggest draws" })));
  const rows = [["All top 100", r.all], ...Object.entries(r.builds).map(([k, v]) => [name(k), v])].filter(([, v]) => v.power);
  const med = P.ratio[1];
  rows.forEach(([n, v]) => {
    const p = v.power;
    const draws = Object.entries(p.draw).slice(0, 3).map(([c, f]) => `${catOf(c).label} ${pct(f)}`).join(", ");
    const diff = p.ratio[1] - med;
    t.append(el("tr", {}, el("td", { text: slashBreak(n) }), el("td", { class: "num", text: String(v.ships) }), el("td", { class: "num", text: fmt(p.make) }),
      el("td", { class: "num", text: fmt(p.use) }),
      el("td", { class: "num" + (v !== r.all && Math.abs(diff) >= 0.02 ? (diff > 0 ? " pos" : " neg") : ""), text: pct(p.ratio[1]) }),
      el("td", { class: "num", text: v.ships > 1 ? `${pct(p.ratio[0])}-${pct(p.ratio[2])}` : "-" }), el("td", { class: "buildcell", text: draws })));
  });
  const drawRows = Object.entries(P.draw).map(([c, f]) => ({ label: catOf(c).label, color: catOf(c).color, v: f }));
  hbars($("powerDraw"), drawRows, Math.max(...drawRows.map((d) => d.v)), "", pct);
  return true;
}


// ---------------------------------------------------------------- gates
const GATE_NB = { interdictor: "Interdictor Gate", security: "Security Gate", repulsor: "Teleport Repulsor", edge: "Hull edge", armor: "Armor", lift: "Lift", vent: "Vent", empty: "Empty" };
const nbLabel = (k) => GATE_NB[k] || (CAT[k] ? CAT[k].label : k);
function gatesSection(a) {
  const g = a.gates;
  if (!g || !Object.keys(g.types).length) return false;
  const T = g.types, B = g.baseline, keys = Object.keys(T);
  const sg = T.security, ti = T.interdictor;
  const take = [];
  if (sg) {
    const o = sg.lift_other_side[0];
    take.push((sg.lift > B.lift ? "Security Gates stand at lift exits: " : "Security Gates and lifts: ") +
      `${pct(sg.lift)} have a lift on their left or right, against ${pct(B.lift)} of other combat rooms.` +
      (o ? ` Across from the lift is most often a ${nbLabel(o[0]).toLowerCase()} (${pct(o[1])}); ${pct(sg.reactor)} touch a reactor.` : ""));
  }
  if (ti) {
    const p = g.interdictor_pairs, n = p.reduce((x, [, c]) => x + c, 0), top = p[0];
    const twos = ti.per_ship.length && ti.per_ship[0][0] === 2;
    take.push(`${twos ? "Interdictor Gates come in twos" : "Interdictor Gates per ship"} (${ti.per_ship.map(([k, c]) => `${c} ships with ${k}`).join(", ")}); ` +
      (top && n ? `${pct(top[1] / n)} of ships with two put them ${top[0]}. ` : "") +
      `${pct(ti.same)} touch the other one and ${pct(ti.security)} touch a Security Gate.`);
    const less = ti.armor < B.armor && (!sg || sg.armor < B.armor);
    take.push(`${ti.sealed < 0.1 ? "Gates are not sealed in armor: " : ""}${pct(ti.sealed)} of Interdictor Gates are closed off by armor and hull edge. ` +
      `Armor covers ${pct(ti.armor)} of an Interdictor Gate's outline${sg ? ` and ${pct(sg.armor)} of a Security Gate's` : ""}, ` +
      `against ${pct(B.armor)} for other combat rooms${less ? " (less armor than other combat rooms)" : ""}.`);
  }
  if (g.boarding) take.push(`Ships with 2+ teleport rooms run ${fmt(g.boarding.security, 1)} Security Gates each, others ${fmt(g.other.security, 1)}.`);
  $("gateTake").replaceChildren(el("ul", {}, ...take.map((t) => el("li", { text: t }))));
  const rows = [
    ["Ships using it", (v) => (v.ships != null && v !== B ? String(v.ships) : "-")],
    ["Armor share of the outline", (v) => pct(v.armor)],
    ["Sealed in by armor / hull edge", (v) => pct(v.sealed)],
    ["Touching no room", (v) => pct(v.isolated)],
    ["On the hull edge", (v) => pct(v.edge)],
    ["Lift on its left or right", (v) => pct(v.lift)],
    ["...and a reactor on the other side", (v) => pct(v.lift_reactor)],
    ["Touching a reactor", (v) => pct(v.reactor)],
    ["Touching an Interdictor Gate", (v) => pct(v.interdictor)],
    ["Touching a Security Gate", (v) => pct(v.security)],
  ];
  const t = $("gateTable");
  t.replaceChildren(el("tr", {}, el("th", { text: "Share of rooms" }), ...keys.map((k) => el("th", { class: "num", text: `${T[k].label} (${T[k].rooms})` })),
    el("th", { class: "num", text: `Other combat rooms (${B.rooms})` })));
  rows.forEach(([label, f]) => t.append(el("tr", {}, el("td", { text: label }), ...keys.map((k) => el("td", { class: "num", text: f(T[k]) })),
    el("td", { class: "num muted", text: f(B) }))));
  t.append(el("tr", {}, el("td", { text: "Most common neighbours" }), ...keys.map((k) => el("td", { class: "buildcell",
    text: T[k].neighbours.slice(0, 4).map(([c, v]) => `${nbLabel(c)} ${pct(v)}`).join(", ") })), el("td", { class: "buildcell muted",
    text: B.neighbours.slice(0, 4).map(([c, v]) => `${nbLabel(c)} ${pct(v)}`).join(", ") })));
  const bars = (box, list) => {
    const rs = list.map(([k, v]) => ({ label: nbLabel(k), color: CAT[k] ? CAT[k].color : null, v }));
    hbars($(box), rs, Math.max(0.01, ...rs.map((r) => r.v)), "", pct);
  };
  if (sg) bars("gateLiftOther", sg.lift_other_side);
  const pn = g.interdictor_pairs.reduce((x, [, c]) => x + c, 0);
  if (pn) bars("gatePairs", g.interdictor_pairs.map(([k, c]) => [k, c / pn]));
  const ct = $("gateCounts");
  ct.replaceChildren(el("tr", {}, el("th", { text: "Ships" }), ...keys.map((k) => el("th", { class: "num", text: T[k].label + "s" }))));
  [["Top 10", g.top10], ["2+ teleport rooms (boarding)", g.boarding], ["Other ships", g.other]].forEach(([n, v]) =>
    ct.append(el("tr", {}, el("td", { text: `${n} (${v.ships})` }), ...keys.map((k) => el("td", { class: "num", text: fmt(v[k], 1) })))));
  const L = { security_lift: "Security Gate with a lift on its left or right", security_lift_reactor: "...and a reactor on the other side",
    security_reactor: "Security Gate touching a reactor (no lift)", interdictor_pair: "Interdictor Gates touching each other", interdictor_security: "Interdictor Gate touching a Security Gate" };
  const lp = (a.patterns && a.patterns.gates) || {};
  $("gateLearn").replaceChildren(el("p", { text: "With Search > Score with patterns learned from the top 100, the optimizer rewards each gate for these habits " +
    "(reward = log2 of how much more often top ships do it than with other combat rooms, times Scoring weights > Anti-teleport gates):" }),
    el("ul", {}, ...Object.entries(lp).map(([k, v]) => el("li", { text: `${L[k] || k}: ${fmt(v, 2)}` }))));
  return true;
}

// ---------------------------------------------------------------- gallery
function drawShip(l) {
  // raised-block edges for a room (pixel look): light top/left, dark bottom/right
  const bevel = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="2" fill="#fff" fill-opacity=".28"/><rect x="${x}" y="${y}" width="2" height="${h}" fill="#fff" fill-opacity=".15"/>` +
    `<rect x="${x}" y="${y + h - 2}" width="${w}" height="2" fill="#000" fill-opacity=".35"/><rect x="${x + w - 2}" y="${y}" width="2" height="${h}" fill="#000" fill-opacity=".25"/>`;
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
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="'IBM Plex Sans',system-ui,sans-serif" shape-rendering="crispEdges">`,
    `<rect width="${w}" height="${h}" fill="#060912"/>`];
  if (rows) rows.forEach((r, y) => [...r].forEach((c, x) => {
    if (c !== ".") out.push(`<rect x="${(x - x0) * T}" y="${(y - y0) * T}" width="${T}" height="${T}" fill="#2a3560" stroke="#10172b"/>`);
  }));
  p.rooms.forEach(([x, y, rw, rh, cat, short, name, type]) => {
    const c = catOf(cat);
    const label = (short || "").slice(0, rw >= 3 ? 4 : 3);
    out.push(`<g><title>${esc(name)} [${esc(c.label)}] ${rw}x${rh} at ${x}, ${y}</title>` +
      `<rect x="${(x - x0) * T + 1}" y="${(y - y0) * T + 1}" width="${rw * T - 2}" height="${rh * T - 2}" fill="${c.color}" stroke="#060912"/>` + bevel((x - x0) * T + 1, (y - y0) * T + 1, rw * T - 2, rh * T - 2) +
      (rw > 1 ? `<text x="${(x - x0 + rw / 2) * T}" y="${(y - y0 + rh / 2) * T + 4}" text-anchor="middle" fill="${inkFor(c.color)}" font-size="10" font-weight="600">${esc(label)}</text>` : "") + "</g>");
  });
  p.armor.forEach(([x, y]) => out.push(`<rect x="${(x - x0) * T + 2}" y="${(y - y0) * T + 2}" width="${T - 4}" height="${T - 4}" fill="#e6b93c" stroke="#8a6a14"/>`));
  p.vents.forEach(([x, y]) => out.push(`<rect x="${(x - x0) * T + 3}" y="${(y - y0) * T + 3}" width="${T - 6}" height="${T - 6}" fill="#f5f5f5"><title>Service vent ${x}, ${y}</title></rect>`));
  p.lifts.forEach(([x, a, b]) => out.push(`<rect x="${(x - x0) * T + 3}" y="${(a - y0) * T}" width="${T - 6}" height="${(b - a + 1) * T}" fill="#38c6d9"><title>Lift x=${x}, y ${a}-${b}</title></rect>`));
  out.push("</svg>");
  return { svg: out.join(""), p };
}
function gallery(lays) {
  const sel = $("galPick");
  sel.replaceChildren(...lays.slice().sort((a, b) => a.rank - b.rank).map((l) =>
    el("option", { value: String(l.rank), text: `#${l.rank} ${l.name} - ${l.ship_name}` + (l.trophies != null ? ` (${l.trophies} trophies)` : "") })));
  const render = () => {
    const l = lays.find((x) => String(x.rank) === sel.value);
    if (!l) return;
    const { svg, p } = drawShip(l);
    $("galSvg").innerHTML = svg;
    const cnt = {};
    p.rooms.forEach((r) => { cnt[r[4]] = (cnt[r[4]] || 0) + 1; });
    $("galInfo").textContent = `${l.ship_name}${l.ship_level != null ? ", level " + l.ship_level : ""}${l.alliance ? " - " + l.alliance : ""}: ${p.rooms.length} rooms, ` +
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
  tiles(a); show("secOverview");
  if (tiersSection(a)) show("secTiers");
  if (explorer(a)) show("secExplorer");
  hullTable(a); show("secHulls");
  if (buildsSection(a)) show("secBuilds");
  gallery(lays); show("secGallery");
  roomBars(a); show("secRooms");
  if (trophySection(a)) show("secTrophy");
  edgeBars(a); show("secEdge");
  adjTable(a); show("secAdj");
  if (powerSection(a)) show("secPower");
  if (gatesSection(a)) show("secGates");
  armor(a); show("secArmor");
  benchmark(a); show("secCalib");
  setupTabs();
}).catch((e) => {
  console.error(e);
  $("loadMsg").hidden = false;
  $("loadMsg").classList.add("error");
  $("loadMsg").textContent = "Could not show the top-100 data: " + (e && e.message ? e.message : e) + ". Try reloading the page.";
});

// ---------------------------------------------------------------- tabs (Overview / Builds / Ships & layouts / Room placement / Optimizer check)
// The address keeps the tab (#builds) or a section (#secGates opens its tab and scrolls to it).
function setupTabs() {
  const panes = [...document.querySelectorAll(".tabpane")];
  panes.forEach((p) => {
    const secs = [...p.querySelectorAll("section.panel")].filter((x) => !x.hidden && x.querySelector("h2"));
    if (secs.length > 2) {
      p.querySelector(".tabintro").after(el("nav", { class: "inpage" }, ...secs.map((x) =>
        el("a", { href: "#" + x.id, text: x.querySelector("h2").textContent }))));
    }
  });
  $("pageTabs").hidden = false;
  const open = (hash, scroll) => {
    const id = (hash || "").replace(/^#/, "");
    const sec = id && document.getElementById(id);
    const pane = sec && sec.classList.contains("tabpane") ? sec : sec ? sec.closest(".tabpane") : null;
    const name = (pane || panes[0]).dataset.tab;
    panes.forEach((p) => { p.hidden = p.dataset.tab !== name; });
    document.querySelectorAll("#pageTabs a").forEach((x) => {
      const on = x.dataset.tab === name;
      x.classList.toggle("active", on);
      x.setAttribute("aria-selected", on ? "true" : "false");
      if (on) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current");
    });
    if (sec && !sec.classList.contains("tabpane") && scroll) sec.scrollIntoView({ block: "start" });
    else if (scroll) window.scrollTo(0, 0);
  };
  document.querySelectorAll("#pageTabs a").forEach((x) => { x.href = "#" + x.dataset.tab; });
  // tab ids for the panes so #builds works
  panes.forEach((p) => {
    if (!p.id) p.id = p.dataset.tab;
    p.setAttribute("role", "tabpanel");
  });
  document.querySelectorAll("#pageTabs a").forEach((x) => x.setAttribute("aria-controls", x.dataset.tab));
  // arrow keys move between tabs (ARIA tab pattern)
  $("pageTabs").addEventListener("keydown", (e) => {
    const tabs = [...document.querySelectorAll("#pageTabs a")];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const j = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length
      : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    tabs[j].click();
    tabs[j].focus();
  });
  window.addEventListener("hashchange", () => open(location.hash, true));
  open(location.hash, !!location.hash);
}
