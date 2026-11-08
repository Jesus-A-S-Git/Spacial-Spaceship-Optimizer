"use strict";

// ---------------------------------------------------------------- defaults
const DEFAULTS = {
  hull: [
    "..xxxxx............................",
    "xxxxxxxxxxxx........xxxxxxxxxxxxx..",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.",
    ".xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.",
  ].join("\n"),
  priority_rooms: [[3, 2, 4]],
  combat_rooms: [[2, 2, 6], [3, 2, 6], [4, 2, 2], [5, 2, 0]],
  noncombat_rooms: [["Bedroom", "X", 3, 2, 9]],
  resource_rooms: [],
  resource_anywhere: true,
  place_bonus_rooms: true,
  priority_range: [3, 6],
  combat_range: [2, 6],
  settings: {
    ARMOR_COUNT: 45, MIN_LIFTS: 2, MAX_LIFTS: 6, START_LIFTS: 2, VENT_COUNT: 8,
    VENT_LINK_COST: 1, LIFT_COST: 2, MAX_EMPTY_RUN: 3,
    PRIORITY_WEIGHT: 3, W_ARMOR: 1, W_UNARMORED: 250, W_PRIORITY_UNARMORED: 500, W_FLOAT: 45,
    W_ARMOR_UNDER: 25, PRIORITY_UNDER_MULT: 2, W_ARMOR_OVER: 2,
    W_TRAVEL: 5, W_CORNER: 4, W_DISC: 500, CORNER_UNREACHABLE: 60,
    W_LIFT: 35, W_LTOUCH: 25, W_LIFT_BALANCE: 50, W_LIFT_COUNT: 8,
    W_GAP: 12, W_EMPTY: 6, W_RUN: 6, W_ISO: 25,
    W_SPREAD: 1.5, SPREAD_CAP: 24, W_VENT: 15,
  },
  search: { iters: 1200, polish: 300, restarts: 0, time_limit: 300, seed: 1, stagnation: 0, population: 24 },
};

const STRUCTURE_FIELDS = [
  ["ARMOR_COUNT", "Armor tiles"], ["MIN_LIFTS", "Min lifts"], ["MAX_LIFTS", "Max lifts"],
  ["START_LIFTS", "Lifts at start"], ["VENT_COUNT", "Max vents"], ["VENT_LINK_COST", "Vent step cost"],
  ["LIFT_COST", "Extra cost per lift step"], ["MAX_EMPTY_RUN", "Max empty run (tiles)"],
];
const WEIGHT_GROUPS = [
  ["Armor and protection", [
    ["PRIORITY_WEIGHT", "Priority room armor multiplier"], ["W_ARMOR", "Armor touchpoint reward"],
    ["W_UNARMORED", "Room with no armor"], ["W_PRIORITY_UNARMORED", "Priority room with no armor (extra)"],
    ["W_FLOAT", "Armor tile touching no room"], ["W_ARMOR_UNDER", "Armor short of sweet spot (per tile)"],
    ["PRIORITY_UNDER_MULT", "Shortfall multiplier for priority rooms"], ["W_ARMOR_OVER", "Armor above sweet spot (per tile)"]]],
  ["Travel and connectivity", [
    ["W_TRAVEL", "Average travel time"], ["W_CORNER", "Corner-to-corner travel"],
    ["W_DISC", "Unreachable room pair"], ["CORNER_UNREACHABLE", "Assumed time for unreachable corners"]]],
  ["Lifts", [
    ["W_LIFT", "Weak / broken lift"], ["W_LTOUCH", "Lift tile touching nothing"],
    ["W_LIFT_BALANCE", "Unbalanced lift traffic"], ["W_LIFT_COUNT", "Cost per lift"]]],
  ["Space and zoning", [
    ["W_GAP", "Corridor tile"], ["W_EMPTY", "Unused interior tile"], ["W_RUN", "Long empty run"],
    ["W_ISO", "Non-combat room touching armor/lift"]]],
  ["Priority spacing and vents", [
    ["W_SPREAD", "Priority room spacing reward"], ["SPREAD_CAP", "Spacing reward cap"], ["W_VENT", "Unlinked vent"]]],
];
const SEARCH_FIELDS = [
  ["iters", "Annealing steps per restart"], ["polish", "Polish steps per restart"],
  ["restarts", "Restarts (0 = until stopped)"], ["time_limit", "Time limit, seconds (0 = none)"],
  ["seed", "Random seed"], ["stagnation", "Stop after N restarts with no gain (0 = off)"],
  ["population", "Elite layouts kept"],
];
const STORE_KEY = "shipOptimizerSettings.v1";

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
let cfgState = loadSettings();
let worker = null, workerReady = false, running = false;
let layouts = [], activeIdx = 0, lastBest = null;

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw), d = clone(DEFAULTS);
      return Object.assign(d, s, { settings: Object.assign(d.settings, s.settings || {}), search: Object.assign(d.search, s.search || {}) });
    }
  } catch (e) { /* storage blocked or corrupt: fall back to defaults */ }
  return clone(DEFAULTS);
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfgState)); } catch (e) { /* ignore */ }
}
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
  }
  kids.forEach((k) => e.append(k));
  return e;
}
function numField(value, onChange, step) {
  const i = el("input", { type: "number", step: step || "any" });
  i.value = value;
  i.addEventListener("change", () => { const n = parseFloat(i.value); if (!isNaN(n)) onChange(n); else i.value = value; });
  return i;
}

// ---------------------------------------------------------------- settings UI
function buildHull() {
  const t = $("hull");
  t.value = cfgState.hull;
  const upd = () => {
    cfgState.hull = t.value; saveSettings();
    const rows = t.value.split("\n").map((r) => r.trim()).filter(Boolean);
    const ok = rows.length && rows.every((r) => r.length === rows[0].length && /^[xr.]+$/.test(r));
    const all = rows.join(""), tiles = all.split("x").length - 1, res = all.split("r").length - 1;
    $("hullInfo").textContent = ok ? `${rows[0].length} x ${rows.length}, ${tiles + res} usable tiles` + (res ? ` (${res} resource space)` : "") : "Invalid: rows must be equal length and use only x, r and .";
  };
  t.addEventListener("input", upd); upd();
}

// ---------------------------------------------------------------- ship hull picker (js/hulls.js)
let shipPicked = null, shipActive = -1, hullBefore = null;
function hullPreviewSvg(rows) {
  const T = Math.max(4, Math.min(12, Math.floor(380 / rows[0].length)));
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${rows[0].length * T} ${rows.length * T}" width="${rows[0].length * T}" height="${rows.length * T}">`];
  rows.forEach((r, y) => [...r].forEach((c, x) => {
    if (c !== ".") p.push(`<rect x="${x * T}" y="${y * T}" width="${T - 1}" height="${T - 1}" fill="${c === "r" ? "#24406b" : "#4a5a7a"}"/>`);
  }));
  p.push("</svg>");
  return p.join("");
}
function shipShowResults() {
  const box = $("shipResults"), q = $("shipSearch").value;
  const hits = Hulls.search(q, 60);
  box.innerHTML = "";
  shipActive = -1;
  box.hidden = !hits.length;
  hits.forEach((s, i) => {
    const b = el("button", { type: "button" }, document.createTextNode(s.name), el("span", { text: `${s.rows[0].length} x ${s.rows.length}, ${s.tiles} tiles` }));
    b.onclick = () => shipSelect(s, i);
    box.append(b);
  });
  const shown = hits.length, total = Hulls.count;
  $("shipStatus").textContent = !total ? "" : q.trim()
    ? (shown ? `${shown}${shown === 60 ? "+" : ""} matching ship${shown === 1 ? "" : "s"}. Click one to preview it.` : `No ship matches "${q.trim()}". Try part of the name.`)
    : `${total} ships (${Hulls.source}). Type to filter, then click one.`;
}
function shipSelect(s, i) {
  shipPicked = s;
  [...$("shipResults").children].forEach((b, j) => b.classList.toggle("active", j === i));
  shipActive = i;
  $("shipPreview").hidden = false;
  $("shipPreviewName").textContent = `${s.name} (${s.rows[0].length} x ${s.rows.length}, ${s.tiles} tiles)`;
  $("shipPreviewSvg").innerHTML = hullPreviewSvg(s.rows);
}
async function shipEnsureLoaded(preferGame) {
  if (Hulls.count && !preferGame) return true;
  $("shipStatus").textContent = preferGame ? "Asking the game server for the newest ship list..." : "Loading ship list...";
  try { await Hulls.load(preferGame); shipShowResults(); return true; }
  catch (e) { $("shipStatus").textContent = e.message; return false; }
}
function buildShipFinder() {
  const inp = $("shipSearch");
  inp.addEventListener("focus", () => shipEnsureLoaded(false));
  inp.addEventListener("input", async () => { if (await shipEnsureLoaded(false)) shipShowResults(); });
  inp.addEventListener("keydown", (e) => {
    const items = [...$("shipResults").children];
    if (!items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = Math.max(0, Math.min(items.length - 1, shipActive + (e.key === "ArrowDown" ? 1 : -1)));
      items[i].click(); items[i].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shipActive < 0) items[0].click(); else $("shipUse").click();
    }
  });
  $("shipRefresh").onclick = () => shipEnsureLoaded(true);
  $("shipFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { await Hulls.loadFile(f); inp.value = ""; shipShowResults(); }
    catch (err) { $("shipStatus").textContent = "Could not read that file: " + err.message; }
    e.target.value = "";
  };
  $("shipUse").onclick = () => {
    if (!shipPicked) return;
    hullBefore = cfgState.hull;
    const t = $("hull");
    t.value = shipPicked.rows.join("\n");
    t.dispatchEvent(new Event("input"));
    $("hullUndo").hidden = false;
    $("shipStatus").textContent = `Hull set to ${shipPicked.name}. Change some x to r below to mark resource space.`;
  };
  $("hullUndo").onclick = () => {
    if (hullBefore == null) return;
    const t = $("hull");
    t.value = hullBefore; hullBefore = null;
    t.dispatchEvent(new Event("input"));
    $("hullUndo").hidden = true;
    $("shipStatus").textContent = "Hull change undone.";
  };
}

function buildRoomRows(key, containerId, fields) {
  const box = $(containerId);
  box.innerHTML = "";
  cfgState[key].forEach((row, ri) => {
    const r = el("div", { class: "row" });
    fields.forEach((f, ci) => {
      const inp = el("input", { type: f.text ? "text" : "number", min: "0", placeholder: f.label, title: f.label });
      if (f.text) inp.maxLength = f.max || 40;
      inp.value = row[ci];
      inp.style.flex = f.flex || "1";
      inp.addEventListener("change", () => {
        if (f.text) row[ci] = inp.value; else { const n = parseInt(inp.value, 10); row[ci] = isNaN(n) ? 0 : Math.max(0, n); inp.value = row[ci]; }
        saveSettings();
      });
      r.append(inp);
    });
    const del = el("button", { class: "small", text: "x", title: "Remove" });
    del.addEventListener("click", () => { cfgState[key].splice(ri, 1); saveSettings(); buildRoomRows(key, containerId, fields); });
    r.append(del);
    box.append(r);
  });
}
const ROOM_TABLES = {
  priorityRooms: ["priority_rooms", [{ label: "width" }, { label: "height" }, { label: "count" }], [3, 2, 1]],
  combatRooms: ["combat_rooms", [{ label: "width" }, { label: "height" }, { label: "count" }], [2, 2, 1]],
  noncombatRooms: ["noncombat_rooms", [{ label: "name", text: true, flex: "3" }, { label: "symbol", text: true, max: 1, flex: "1" }, { label: "width" }, { label: "height" }, { label: "count" }], ["Cargo Bay", "C", 4, 2, 1]],
  resourceRooms: ["resource_rooms", [{ label: "name", text: true, flex: "3" }, { label: "symbol", text: true, max: 1, flex: "1" }, { label: "width" }, { label: "height" }, { label: "count" }], ["Storage", "S", 3, 2, 1]],
};
function buildRooms() {
  for (const [id, [key, fields]] of Object.entries(ROOM_TABLES)) buildRoomRows(key, id, fields);
  document.querySelectorAll("[data-add]").forEach((b) => {
    b.onclick = () => {
      const [key, fields, blank] = ROOM_TABLES[b.dataset.add];
      cfgState[key].push(clone(blank)); saveSettings(); buildRoomRows(key, b.dataset.add, fields);
    };
  });
  $("placeBonus").checked = cfgState.place_bonus_rooms;
  $("placeBonus").onchange = (e) => { cfgState.place_bonus_rooms = e.target.checked; saveSettings(); };
  $("resAnywhere").checked = cfgState.resource_anywhere;
  $("resAnywhere").onchange = (e) => { cfgState.resource_anywhere = e.target.checked; saveSettings(); };
}

function buildGrid(containerId, fields, store, step) {
  const box = $(containerId);
  box.innerHTML = "";
  fields.forEach(([key, label]) => {
    box.append(el("label", { text: label }), numField(store[key], (n) => { store[key] = n; saveSettings(); }, step));
  });
}
function buildStructure() {
  buildGrid("structure", STRUCTURE_FIELDS, cfgState.settings);
  const box = $("structure");
  [["priority_range", "Priority armor sweet spot (low)", 0], ["priority_range", "Priority armor sweet spot (high)", 1],
   ["combat_range", "Combat armor sweet spot (low)", 0], ["combat_range", "Combat armor sweet spot (high)", 1]].forEach(([k, label, i]) => {
    box.append(el("label", { text: label }), numField(cfgState[k][i], (n) => { cfgState[k][i] = Math.round(n); saveSettings(); }, "1"));
  });
}
function buildWeights() {
  const box = $("weights");
  box.innerHTML = "";
  WEIGHT_GROUPS.forEach(([title, fields]) => {
    box.append(el("div", { class: "wgroup", text: title }));
    const g = el("div", { class: "grid2" });
    fields.forEach(([key, label]) => g.append(el("label", { text: label }), numField(cfgState.settings[key], (n) => { cfgState.settings[key] = n; saveSettings(); })));
    box.append(g);
  });
}
function buildSearch() { buildGrid("search", SEARCH_FIELDS, cfgState.search, "1"); }
function buildAll() { buildHull(); buildRooms(); buildStructure(); buildWeights(); buildSearch(); }

// ---------------------------------------------------------------- worker control
function newWorker() {
  workerReady = false;
  worker = new Worker("js/worker.js");
  worker.onmessage = (e) => handle(e.data);
  worker.onerror = (e) => showError("Worker error: " + (e.message || "could not start"));
}
function setIdleUi() {
  running = false;
  $("startBtn").disabled = !workerReady;
  $("stopBtn").disabled = true;
}
function showError(msg) {
  const b = $("errorBox"); b.textContent = msg; b.hidden = false;
  if (running) setIdleUi();
  $("status").textContent = "Error";
}
function handle(m) {
  switch (m.type) {
    case "status": $("status").textContent = m.msg; break;
    case "ready":
      workerReady = true;
      if (!running) { $("status").textContent = "Ready"; $("startBtn").disabled = false; }
      break;
    case "log": $("status").textContent = m.msg; break;
    case "progress": {
      if (m.frac != null) $("barFill").style.width = (m.frac * 100).toFixed(1) + "%";
      else $("barFill").style.width = "100%";
      const best = m.best != null ? ` | best score ${m.best.toFixed(1)}` : "";
      const total = m.restarts ? `/${m.restarts}` : "";
      $("progressText").textContent = `Restart ${m.done}${total}${best} | ${m.elapsed.toFixed(0)}s elapsed`;
      $("status").textContent = "Searching...";
      break;
    }
    case "best":
      setLayouts(m.layouts, true);
      break;
    case "done":
      setLayouts(m.layouts, false);
      $("barFill").style.width = "100%";
      $("status").textContent = `Finished: ${m.reason}`;
      if (m.odds) $("oddsBox").textContent = "Learned move odds: " + Object.entries(m.odds).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ");
      setIdleUi();
      break;
    case "error": showError(m.message); break;
  }
}
function buildConfig() {
  const rows = cfgState.hull.split("\n").map((r) => r.trim()).filter(Boolean);
  return {
    hull: rows, settings: cfgState.settings, priority_range: cfgState.priority_range,
    combat_range: cfgState.combat_range, place_bonus_rooms: cfgState.place_bonus_rooms,
    priority_rooms: cfgState.priority_rooms, combat_rooms: cfgState.combat_rooms,
    noncombat_rooms: cfgState.noncombat_rooms, resource_rooms: cfgState.resource_rooms,
    resource_anywhere: cfgState.resource_anywhere, search: cfgState.search,
  };
}
function start() {
  $("errorBox").hidden = true;
  $("oddsBox").textContent = "";
  $("barFill").style.width = "0";
  $("progressText").textContent = "";
  running = true;
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("status").textContent = "Starting...";
  worker.postMessage({ type: "start", cfg: buildConfig() });
}
function stop() {
  // The optimizer is a long synchronous Python loop, so the reliable way to stop it is to end the worker.
  // The best layouts reported so far stay on screen.
  worker.terminate();
  $("status").textContent = "Stopped. Restarting Python runtime...";
  $("progressText").textContent += " (stopped)";
  setIdleUi();
  $("startBtn").disabled = true;
  newWorker();
}

// ---------------------------------------------------------------- results
function setLayouts(list, keepTab) {
  if (!list || !list.length) return;
  layouts = list;
  if (!keepTab || activeIdx >= layouts.length) activeIdx = 0;
  renderTabs(); renderLayout();
}
function renderTabs() {
  const box = $("altTabs");
  box.innerHTML = "";
  box.hidden = layouts.length < 2;
  layouts.forEach((l, i) => {
    const b = el("button", { class: i === activeIdx ? "active" : "", text: (i === 0 ? "Best" : "Alt " + i) + ` (${l.score.toFixed(0)})` });
    b.onclick = () => { activeIdx = i; renderTabs(); renderLayout(); };
    box.append(b);
  });
}
const PALETTE = ["#d17ad9", "#e0b84a", "#59c7a0", "#6ad1e0", "#c4c9d4", "#ff9f6b"];
function roomColor(sym, combat, priority) {
  if (priority || sym === "P") return "#d94b4b";
  if (sym === "x") return "#3f9b57";
  if (sym === "X") return "#9b4fb3";
  const digit = { 2: "#3d6fd1", 3: "#4a86e0", 4: "#2f5cb0", 5: "#5b9be6" }[sym];
  if (digit) return digit;
  let h = 0; for (const c of sym) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return combat ? "#3d6fd1" : PALETTE[h % PALETTE.length];
}
const TILE = 26;
function layoutSvg(l) {
  const W = l.width, H = l.height, T = TILE;
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * T} ${H * T}" width="${W * T}" height="${H * T}" font-family="system-ui,sans-serif">`];
  p.push(`<rect width="${W * T}" height="${H * T}" fill="#0c111b"/>`);
  l.grid.forEach((row, y) => [...row].forEach((c, x) => {
    if (c !== "#") p.push(`<rect x="${x * T}" y="${y * T}" width="${T}" height="${T}" fill="#2a3347" stroke="#1a2133" stroke-width="1"/>`);
  }));
  (l.resource_tiles || []).forEach(([x, y]) => p.push(`<rect x="${x * T}" y="${y * T}" width="${T}" height="${T}" fill="#24406b" stroke="#1a2133" stroke-width="1"><title>Resource space ${x}, ${y}</title></rect>`));
  const rect = (r, fill, label, tip) => p.push(
    `<g><title>${tip}</title><rect x="${r.x * T + 1}" y="${r.y * T + 1}" width="${r.w * T - 2}" height="${r.h * T - 2}" rx="3" fill="${fill}" stroke="#0c111b" stroke-width="1.5"/>` +
    `<text x="${(r.x + r.w / 2) * T}" y="${(r.y + r.h / 2) * T + 5}" text-anchor="middle" fill="#fff" font-size="13" font-weight="600">${label}</text></g>`);
  l.rooms.forEach((r) => {
    const tip = `${r.name} (${r.w}x${r.h}) at ${r.x}, ${r.y}` + (r.combat ? ` | armor touching: ${r.armor}` : "");
    rect(r, roomColor(r.sym, r.combat, r.priority), r.sym, tip);
  });
  l.bonus.forEach((r) => rect(r, "#3f9b57", "x", `${r.name} at ${r.x}, ${r.y}`));
  l.armor.forEach(([x, y]) => p.push(`<rect x="${x * T + 2}" y="${y * T + 2}" width="${T - 4}" height="${T - 4}" fill="#e6b93c"><title>Armor ${x}, ${y}</title></rect>`));
  l.lifts.forEach(([x, y0, y1]) => p.push(`<rect x="${x * T + 3}" y="${y0 * T}" width="${T - 6}" height="${(y1 - y0 + 1) * T}" fill="#38c6d9"><title>Lift x=${x}, y ${y0}-${y1}</title></rect>`));
  l.vents.forEach(([x, y]) => p.push(`<rect x="${x * T + 4}" y="${y * T + 4}" width="${T - 8}" height="${T - 8}" fill="#f5f5f5"><title>Vent ${x}, ${y}</title></rect>`));
  p.push("</svg>");
  return p.join("");
}
function renderLayout() {
  const l = layouts[activeIdx];
  if (!l) return;
  $("emptyMsg").hidden = true; $("layoutWrap").hidden = false;
  $("layoutSvg").innerHTML = layoutSvg(l);
  $("scoreVal").textContent = l.score.toFixed(1);

  const legend = $("legend"); legend.innerHTML = "";
  const items = [["#e6b93c", "Armor"], ...(l.resource_tiles && l.resource_tiles.length ? [["#24406b", "Resource space (r)"]] : []), ["#38c6d9", "Lift"], ["#f5f5f5", "Vent"], ["#3f9b57", "Bonus room"], ["#d94b4b", "Priority room (P)"]];
  Object.entries(l.legend).forEach(([sym, name]) => { if (sym !== "P") items.push([roomColor(sym, !/non|bed|cargo|med/i.test(name) && sym !== "X", false), `${sym} = ${name}`]); });
  items.forEach(([c, t]) => { const s = el("span"); s.innerHTML = `<i style="background:${c}"></i>`; s.append(t); legend.append(s); });

  const s = l.stats;
  const defs = [
    ["Average travel", s.avg_travel.toFixed(1)], ["Corner travel max / avg", `${s.corner_travel_max.toFixed(0)} / ${s.corner_travel_avg.toFixed(1)}`],
    ["Unreachable room pairs", s.unreachable_pairs, s.unreachable_pairs > 0], ["Lifts", s.lifts],
    ["Lift usage", Object.entries(s.lift_usage).map(([k, v]) => `x${k}: ${v}`).join(", ") || "-"],
    ["Vents (unlinked)", `${s.vents} (${s.vents_unlinked})`, s.vents_unlinked > 0],
    ["Armor tiles", s.armor_tiles], ["Armor touching no room", s.armor_touching_no_room, s.armor_touching_no_room > 0],
    ["Combat rooms with no armor", s.combat_rooms_without_armor, s.combat_rooms_without_armor > 0],
    ["Priority rooms with no armor", s.priority_rooms_without_armor, s.priority_rooms_without_armor > 0],
    ["Sweet-spot shortfall / excess", `${s.sweet_spot_shortfall.toFixed(0)} / ${s.sweet_spot_excess}`],
    ["Unused open tiles", s.unused_open_tiles], ["Priority spread", s.priority_spread.toFixed(1)],
  ];
  const sb = $("stats"); sb.innerHTML = "";
  defs.forEach(([k, v, warn]) => sb.append(el("div", { class: "stat" + (warn ? " warn" : "") }, el("b", { text: String(v) }), document.createTextNode(k))));

  const t = $("inventory");
  t.innerHTML = "<tr><th>Room</th><th>Size</th><th>x, y</th><th>Armor</th></tr>";
  const sorted = l.rooms.map((r) => r).sort((a, b) => a.y - b.y || a.x - b.x);
  sorted.forEach((r) => {
    let armor = "", bad = false;
    if (r.combat) {
      armor = String(r.armor);
      if (r.range) { armor += ` (${r.range[0]}-${r.range[1]})`; bad = r.armor < r.range[0]; }
    }
    const tr = el("tr", {}, el("td", { text: r.name }), el("td", { text: `${r.w}x${r.h}` }), el("td", { text: `${r.x}, ${r.y}` }), el("td", { class: bad ? "bad" : "", text: armor }));
    t.append(tr);
  });
  l.bonus.forEach((r) => t.append(el("tr", {}, el("td", { text: r.name }), el("td", { text: `${r.w}x${r.h}` }), el("td", { text: `${r.x}, ${r.y}` }), el("td"))));
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function coordsText(l) {
  const lines = l.rooms.map((r) => `${r.name} (${r.w}x${r.h}) -> ${r.x}, ${r.y}`);
  l.bonus.forEach((r) => lines.push(`${r.name} (${r.w}x${r.h}) -> ${r.x}, ${r.y}`));
  l.lifts.forEach(([x, y0, y1]) => lines.push(`Lift column x=${x}: y ${y0}-${y1}`));
  l.vents.forEach(([x, y]) => lines.push(`Vent (1x1) -> ${x}, ${y}`));
  lines.push(`Armor (${l.armor.length}): ` + l.armor.map(([x, y]) => `(${x},${y})`).join(" "));
  return lines.join("\n");
}

// ---------------------------------------------------------------- wire up
$("startBtn").onclick = start;
$("stopBtn").onclick = stop;
$("resetBtn").onclick = () => { if (confirm("Reset all settings to the defaults?")) { cfgState = clone(DEFAULTS); saveSettings(); buildAll(); } };
$("dlJson").onclick = () => download("ship-layout.json", JSON.stringify(layouts[activeIdx], null, 2), "application/json");
$("dlSvg").onclick = () => download("ship-layout.svg", layoutSvg(layouts[activeIdx]), "image/svg+xml");
$("copyCoords").onclick = async () => {
  try { await navigator.clipboard.writeText(coordsText(layouts[activeIdx])); $("status").textContent = "Coordinates copied"; }
  catch (e) { $("status").textContent = "Copy blocked by the browser"; }
};
buildAll();
buildShipFinder();
newWorker();
