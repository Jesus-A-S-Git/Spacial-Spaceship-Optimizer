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
  // One list for every room. cat = a category from ROOM_CATEGORIES (its kind decides how the optimizer
  // treats the room); armor = "" for the default sweet spot or "low-high" for this room's own.
  rooms: [
    { name: "Small Reactor", cat: "reactor", w: 3, h: 2, count: 3, armor: "", short: "REA" },
    { name: "Fusion Reactor", cat: "reactor", w: 4, h: 2, count: 1, armor: "", short: "FRE" },
    { name: "Shield Generator", cat: "shield", w: 3, h: 2, count: 1, armor: "", short: "SHD" },
    { name: "Photon Phaser", cat: "laser", w: 2, h: 2, count: 2, armor: "" },
    { name: "Mineral Mining Laser", cat: "laser", w: 3, h: 2, count: 2, armor: "" },
    { name: "Plasma Discharger", cat: "laser", w: 3, h: 2, count: 2, armor: "" },
    { name: "Guardian Defense System", cat: "antiair", w: 3, h: 2, count: 1, armor: "", short: "GDS" },
    { name: "Drone Hangar", cat: "hangar", w: 5, h: 2, count: 1, armor: "", short: "DH" },
    { name: "Hangar", cat: "hangar", w: 5, h: 2, count: 1, armor: "", short: "HAN" },
    { name: "Ion Cannon", cat: "combat", w: 3, h: 3, count: 1, armor: "", short: "ION" },
    { name: "Freeze Ray", cat: "combat", w: 4, h: 2, count: 1, armor: "" },
    { name: "Android Studio", cat: "utility", w: 2, h: 2, count: 1, armor: "", short: "AS" },
    { name: "Shield Battery", cat: "utility", w: 2, h: 2, count: 1, armor: "" },
    { name: "Cloak Generator", cat: "utility", w: 3, h: 2, count: 1, armor: "", short: "CG" },
    { name: "Bedroom", cat: "crew", w: 3, h: 2, count: 9, armor: "", short: "BED" },
  ],
  resource_anywhere: true,
  place_bonus_rooms: true,
  walk_noncombat: true,     // crew walk through every room (as in the game), not only combat rooms
  connect_all: true,        // after each search, add vents/lifts until every combat room is reachable
  use_top: true,            // start searches from top-100 layouts on the same hull
  learn_top: true,          // score with patterns and habits learned from the top 100
  style_v2: true,
  style_v3: true,
  priority_range: [3, 6],
  combat_range: [2, 6],
  settings: {
    ARMOR_COUNT: 45, MIN_LIFTS: 1, MAX_LIFTS: 4, START_LIFTS: 2, VENT_COUNT: 8,
    VENT_LINK_COST: 1, LIFT_COST: 2, MAX_EMPTY_RUN: 3,
    PRIORITY_WEIGHT: 3, W_ARMOR: 4, W_UNARMORED: 250, W_PRIORITY_UNARMORED: 500, W_FLOAT: 45,
    W_ARMOR_UNDER: 25, PRIORITY_UNDER_MULT: 2, W_ARMOR_OVER: 2,
    W_TRAVEL: 0.75, W_CORNER: 0.4, W_DISC: 30, CORNER_UNREACHABLE: 60,
    W_LIFT: 35, W_LTOUCH: 25, W_LIFT_BALANCE: 50, W_LIFT_COUNT: 18,
    W_GAP: 2.5, W_EMPTY: 6, W_RUN: 6, W_ISO: 25,
    W_SPREAD: 1.5, SPREAD_CAP: 24, W_VENT: 15, W_CENTER: 3, W_PATTERN: 3, W_SHELL: 3, W_NC_CLUSTER: 15, W_LIFT_DENSITY: 20,
  },
  search: { iters: 1200, polish: 300, restarts: 0, time_limit: 300, seed: 1, stagnation: 0, population: 24, cores: 0 },
};

// Weight styles (Scoring weights > Style). "top" is the default: armor-first weights that bring layouts close
// to the top-100 ladder ships (tools/benchmark_top.py; the optimizer's STYLE = "top" / --style top).
// "original" = the optimizer's own weights, which value crew reaching every room much more.
const STYLES = {
  top: { W_ARMOR: 4, W_DISC: 30, W_TRAVEL: 0.75, W_CORNER: 0.4, W_GAP: 2.5, MIN_LIFTS: 1, MAX_LIFTS: 4, W_LIFT_COUNT: 18 },
  original: { W_ARMOR: 1, W_DISC: 500, W_TRAVEL: 5, W_CORNER: 4, W_GAP: 12, MIN_LIFTS: 2, MAX_LIFTS: 6, W_LIFT_COUNT: 8 },
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
  ["Anti-air placement", [
    ["W_CENTER", "Anti-air away from combat middle (per tile)"]]],
  ["Learned from the top 100 (when enabled under Search)", [
    ["W_PATTERN", "Room neighbours / edge use like top ships"], ["W_SHELL", "Hull-edge use per room kind"],
    ["W_NC_CLUSTER", "Non-combat room not grouped"], ["W_LIFT_DENSITY", "Lift count outside top-100 range"]]],
];
const SEARCH_FIELDS = [
  ["iters", "Annealing steps per restart"], ["polish", "Polish steps per restart"],
  ["restarts", "Restarts (0 = until stopped)"], ["time_limit", "Time limit, seconds (0 = none)"],
  ["seed", "Random seed"], ["stagnation", "Stop after N restarts with no gain (0 = off)"],
  ["population", "Elite layouts kept"], ["cores", "CPU cores to use (0 = automatic)"],
];
const STORE_KEY = "shipOptimizerSettings.v1";

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
let cfgState = loadSettings();
let running = false;
let layouts = [], activeIdx = 0, lastBest = null;

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw), d = clone(DEFAULTS);
      if (!Array.isArray(s.rooms) && (s.priority_rooms || s.combat_rooms || s.noncombat_rooms || s.resource_rooms)) s.rooms = migrateRooms(s);
      // one-time: untouched old default weights -> the new top-player style default
      if (!s.style_v2) {
        const set = s.settings || {};
        if (Object.entries(STYLES.original).every(([k, v]) => set[k] === undefined || +set[k] === v)) s.settings = Object.assign({}, set, STYLES.top);
        s.style_v2 = true;
      }
      // one-time: the first top-player style (connectivity 15) -> current one (30, measured with game-like vents)
      if (!s.style_v3) {
        const set = s.settings || {};
        if (Object.entries(STYLES.top).every(([k, v]) => +set[k] === (k === "W_DISC" ? 15 : v))) s.settings = Object.assign({}, set, { W_DISC: STYLES.top.W_DISC });
        s.style_v3 = true;
      }
      return Object.assign(d, s, { settings: Object.assign(d.settings, s.settings || {}), search: Object.assign(d.search, s.search || {}) });
    }
  } catch (e) { /* storage blocked or corrupt: fall back to defaults */ }
  return clone(DEFAULTS);
}
function migrateRooms(s) {
  // settings saved by the older page (one table per kind) -> one categorized list
  const out = [];
  (s.priority_rooms || []).forEach(([w, h, c]) => out.push({ name: `Priority ${w}x${h}`, cat: "priority", w, h, count: c, armor: "" }));
  (s.combat_rooms || []).forEach(([w, h, c]) => out.push({ name: `Combat ${w}x${h}`, cat: "combat", w, h, count: c, armor: "" }));
  (s.noncombat_rooms || []).forEach(([n, , w, h, c]) => out.push({ name: n, cat: /bed|crew/i.test(n) ? "crew" : "noncombat", w, h, count: c, armor: "" }));
  (s.resource_rooms || []).forEach(([n, , w, h, c]) => out.push({ name: n, cat: "resource", w, h, count: c, armor: "" }));
  return out;
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
  t.addEventListener("input", () => { upd(); if ($("roomSummary").childElementCount) updateRoomSummary(); updateTopNote(); }); upd();
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

// ---------------------------------------------------------------- rooms (one categorized list)
function intInput(value, title, onChange) {
  const i = el("input", { type: "number", min: "0", step: "1", title, "aria-label": title });
  i.value = value;
  i.addEventListener("change", () => { const n = parseInt(i.value, 10); onChange(isNaN(n) ? 0 : Math.max(0, n)); i.value = isNaN(n) ? 0 : Math.max(0, n); });
  return i;
}
function categorySelect(value, onChange) {
  const sel = el("select", { title: "Room type", "aria-label": "Room type" });
  for (const kind of Object.keys(KIND_LABELS)) {
    const g = el("optgroup", { label: KIND_LABELS[kind] });
    ROOM_CATEGORIES.filter((c) => c.kind === kind).forEach((c) => g.append(el("option", { value: c.id, text: c.label })));
    sel.append(g);
  }
  sel.value = catOf(value).id;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}
function validArmor(v) { return !v || /^\s*\d+\s*-\s*\d+\s*$/.test(v) && (([a, b]) => +a <= +b)(v.split("-")); }
function roomCard(room, idx) {
  const cat = catOf(room.cat);
  const card = el("div", { class: "roomcard", "data-idx": String(idx) });
  card.style.borderLeftColor = cat.color;
  const name = el("input", { type: "text", maxlength: "40", placeholder: "Room name (type to search game rooms)", title: "Room name. Pick a game room to fill in its real size and type.", "aria-label": "Room name", list: "gameRoomNames", autocomplete: "off" });
  name.value = room.name;
  name.addEventListener("change", () => {
    room.name = name.value.trim();
    const g = GameRooms.find(room.name);
    if (g) {                                   // a real game room: use its size and type
      room.name = g.name; room.w = g.w; room.h = g.h; room.cat = g.cat; room.short = g.short;
      saveSettings(); buildRooms();
      const card = $("roomList").querySelector(`.roomcard[data-idx="${idx}"]`);
      if (card) { const q = card.querySelector('.rc-nums input[aria-label="How many"]'); if (q) { q.focus(); q.select(); } }
      return;
    }
    room.short = "";
    saveSettings();
    hint.textContent = "";
  });
  const sel = categorySelect(room.cat, (v) => {
    const oldLabel = catOf(room.cat).label;
    room.cat = v;
    if (!room.name || room.name === oldLabel) room.name = catOf(v).label;
    saveSettings(); buildRooms();
  });
  const up = el("button", { class: "small icon", text: "↑", title: "Move up", "aria-label": "Move up" });
  // move up within its own group (priority / combat / ...), which is how the list is shown
  const prev = cfgState.rooms.map((r, i) => i).filter((i) => i < idx && catOf(cfgState.rooms[i].cat).kind === cat.kind).pop();
  up.disabled = prev === undefined;
  up.onclick = () => { const r = cfgState.rooms; [r[prev], r[idx]] = [r[idx], r[prev]]; saveSettings(); buildRooms(); };
  const dup = el("button", { class: "small icon", text: "⧉", title: "Duplicate", "aria-label": "Duplicate" });
  dup.onclick = () => { cfgState.rooms.splice(idx + 1, 0, clone(room)); saveSettings(); buildRooms(); };
  const del = el("button", { class: "small icon", text: "×", title: "Remove", "aria-label": "Remove" });
  del.onclick = () => { cfgState.rooms.splice(idx, 1); saveSettings(); buildRooms(); };
  card.append(el("div", { class: "rc-top" }, name, sel, up, dup, del));
  const g = GameRooms.find(room.name);
  const hint = el("div", { class: "rc-hint muted" });
  if (g) {
    hint.textContent = `Game room: ${GameRooms.describe(g)}` + (g.w !== room.w || g.h !== room.h ? ` (size changed to ${room.w}x${room.h})` : "");
  }
  card.append(hint);

  const nums = el("div", { class: "rc-nums" });
  const field = (label, input) => nums.append(el("label", {}, el("span", { text: label }), input));
  field("Width", intInput(room.w, "Width (tiles)", (n) => { room.w = n; saveSettings(); updateRoomSummary(); }));
  field("Height", intInput(room.h, "Height (tiles)", (n) => { room.h = n; saveSettings(); updateRoomSummary(); }));
  field("Qty", intInput(room.count, "How many", (n) => { room.count = n; saveSettings(); updateRoomSummary(); card.classList.toggle("off", !n); }));
  if (cat.kind === "priority" || cat.kind === "combat") {
    const def = cat.kind === "priority" ? cfgState.priority_range : cfgState.combat_range;
    const ar = el("input", { type: "text", placeholder: `${def[0]}-${def[1]}`, title: "Armor sweet spot for this room, e.g. 4-6. Empty = the default for its kind.", "aria-label": "Armor sweet spot" });
    ar.value = room.armor || "";
    ar.addEventListener("change", () => {
      const v = ar.value.trim();
      ar.classList.toggle("invalid", !validArmor(v));
      if (validArmor(v)) { room.armor = v; saveSettings(); }
    });
    field("Armor", ar);
  } else {
    nums.append(el("div", { class: "rc-note muted", text: cat.kind === "resource" ? "on r tiles" : "no armor" }));
  }
  card.append(nums);
  card.classList.toggle("off", !room.count);
  return card;
}
function updateRoomSummary() {
  const tot = { priority: [0, 0], combat: [0, 0], noncombat: [0, 0], resource: [0, 0] };
  const byCat = {};
  cfgState.rooms.forEach((r) => {
    const c = catOf(r.cat), n = r.count || 0;
    tot[c.kind][0] += n; tot[c.kind][1] += n * r.w * r.h;
    if (n) byCat[c.id] = (byCat[c.id] || 0) + n;
  });
  const hullTiles = (cfgState.hull.match(/[xr]/g) || []).length;
  const used = Object.values(tot).reduce((a, [, t]) => a + t, 0) + (cfgState.settings.ARMOR_COUNT || 0);
  const box = $("roomSummary");
  box.innerHTML = "";
  const chips = el("div", { class: "chips" });
  ROOM_CATEGORIES.forEach((c) => { if (byCat[c.id]) chips.append(el("span", { class: "chip" }, el("i", { style: `background:${c.color}` }), document.createTextNode(`${c.label} ${byCat[c.id]}`))); });
  box.append(chips);
  const parts = Object.entries(tot).filter(([, [n]]) => n).map(([k, [n, t]]) => `${KIND_LABELS[k].split(" (")[0]} ${n} (${t} tiles)`);
  box.append(el("div", { class: "muted" + (used > hullTiles ? " bad" : ""), text:
    `${parts.join(" · ") || "No rooms"}. Rooms + ${cfgState.settings.ARMOR_COUNT || 0} armor = ${used} of ${hullTiles} hull tiles` + (used > hullTiles ? " (too many!)" : "") }));
}
function buildRooms() {
  const box = $("roomList");
  box.innerHTML = "";
  for (const kind of Object.keys(KIND_LABELS)) {
    const idxs = cfgState.rooms.map((r, i) => [r, i]).filter(([r]) => catOf(r.cat).kind === kind);
    if (!idxs.length) continue;
    box.append(el("div", { class: "kindhead", text: KIND_LABELS[kind] }));
    idxs.forEach(([r, i]) => box.append(roomCard(r, i)));
  }
  const add = $("roomAdd");
  add.innerHTML = "";
  ROOM_CATEGORIES.forEach((c) => {
    const b = el("button", { class: "small addchip", title: `Add a ${c.label} room (${c.size[0]}x${c.size[1]})` }, el("i", { style: `background:${c.color}` }), document.createTextNode("+ " + c.label));
    b.onclick = () => {
      cfgState.rooms.push({ name: c.label, cat: c.id, w: c.size[0], h: c.size[1], count: 1, armor: "" });
      saveSettings(); buildRooms();
      const card = $("roomList").querySelector(`.roomcard[data-idx="${cfgState.rooms.length - 1}"]`);
      if (card) { card.scrollIntoView({ block: "nearest" }); const n = card.querySelector("input"); n.focus(); n.select(); }
    };
    add.append(b);
  });
  updateRoomSummary();
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
  $("structure").addEventListener("change", () => { updateRoomSummary(); });
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

// ---------------------------------------------------------------- top 100 (js/top.js)
function hullShipIds() {
  const rows = cfgState.hull.split("\n").map((r) => r.trim()).filter(Boolean);
  return Hulls.count ? Hulls.byRows(rows).map((s) => s.id).filter((id) => id != null) : [];
}
// starting layouts for this hull: top-100 layouts on the same hull, otherwise borrowed from similar hulls
let simCache = { key: null, list: [] };
function topTemplates() {
  const exact = Top100.templates(hullShipIds(), 6);
  if (exact.length) return { list: exact, borrowed: false };
  const rows = cfgState.hull.split("\n").map((r) => r.trim()).filter(Boolean);
  const key = rows.join("/");
  if (simCache.key !== key) simCache = { key, list: Top100.layouts.length && Hulls.count ? Top100.similar(rows, 6, 0.6) : [] };
  return { list: simCache.list, borrowed: true };
}
function updateTopNote() {
  const box = $("topNote");
  if (!box) return;
  if (!Top100.layouts.length || !Hulls.count) { box.textContent = "Top-100 data not loaded."; return; }
  const ids = hullShipIds();
  const lays = ids.flatMap((id) => Top100.forShip(id));
  if (!lays.length) {
    const ship = ids.length ? Hulls.byId(ids[0]) : null;
    const sim = topTemplates().list;
    if (sim.length) {
      const names = [...new Set(sim.map((t) => t.ship))].slice(0, 2).join(", ");
      box.textContent = (ship ? `${ship.name}: ` : "") + `no top-100 player uses this hull. The search borrows ${sim.length} top layouts ` +
        `from similar hulls (${names}; ${Math.round(sim[0].overlap * 100)}% shape match), with rooms that do not fit placed in free space.`;
    } else {
      box.textContent = (ship ? `${ship.name}: ` : "") + "no top-100 player uses this hull or a similar one, so the search starts from scratch. " +
        "Pick a popular hull on the Top 100 page to start from real layouts.";
    }
    return;
  }
  const best = Math.min(...lays.map((l) => l.rank));
  box.textContent = `${lays.length} top-100 player${lays.length > 1 ? "s use" : " uses"} this hull (${lays[0].ship_name}, best rank #${best}). ` +
    `The search starts from their layouts, with your rooms put where they placed the same type and size.`;
}
function currentStyle() {
  for (const [name, w] of Object.entries(STYLES)) {
    if (Object.entries(w).every(([k, v]) => +cfgState.settings[k] === v)) return name;
  }
  return null;
}
function updateStyleNote() {
  const st = currentStyle();
  ["top", "original"].forEach((n) => $("style_" + n).classList.toggle("active", st === n));
  const b = Top100.analysis && Top100.analysis.benchmark;
  const cfg = b && b.configs.find((c) => c.name === "top");
  let txt = st === "top" ? "Top-player style: armor first, like the top-100 ships."
    : st === "original" ? "Original style: crew can reach every room, at the cost of armor."
    : "Custom weights.";
  if (cfg) txt += ` On top-100 hulls with the same rooms, top-player style reaches ${Math.round(100 * cfg.optimizer.armor_sum / cfg.real.armor_sum)}% of the real ships' armor value (details on the Top 100 page).`;
  $("styleNote").textContent = txt;
}
function buildTopUi() {
  $("useTop").checked = cfgState.use_top;
  $("useTop").onchange = (e) => { cfgState.use_top = e.target.checked; saveSettings(); };
  $("learnTop").checked = cfgState.learn_top;
  $("learnTop").onchange = (e) => { cfgState.learn_top = e.target.checked; saveSettings(); };
  $("walkNc").checked = cfgState.walk_noncombat;
  $("walkNc").onchange = (e) => { cfgState.walk_noncombat = e.target.checked; saveSettings(); };
  $("connectAll").checked = cfgState.connect_all;
  $("connectAll").onchange = (e) => { cfgState.connect_all = e.target.checked; saveSettings(); };
  Object.keys(STYLES).forEach((name) => {
    $("style_" + name).onclick = () => {
      Object.assign(cfgState.settings, STYLES[name]);
      saveSettings(); buildWeights(); buildStructure(); updateStyleNote();
    };
  });
  $("weights").addEventListener("change", updateStyleNote);
  $("structure").addEventListener("change", updateStyleNote);
}


// ---------------------------------------------------------------- worker control (one per CPU core)
// Each worker is a separate Python runtime running the optimizer with its own random seed. The search runs
// in rounds: when a round ends, every core starts the next one from the best layouts found by ALL cores,
// so good ideas spread between them. The best layouts are also saved in this browser, so a later
// search can continue from them.
const ROUND_SECONDS = 45;
const BEST_KEY = "shipOptimizerBest.v1";
let pool = [];           // [{w, ready, prog, layouts}]
let run = null;          // the search in progress
let found = [];          // best layouts across all cores and rounds (layout JSON, best first)

function autoCores() { return Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)); }
function wantedCores() {
  const n = Math.round(cfgState.search.cores || 0);
  return n > 0 ? Math.min(16, n) : autoCores();
}
function spawn(i) {
  const slot = { w: new Worker("js/worker.js"), ready: false, prog: null, layouts: [], odds: null };
  slot.w.onmessage = (e) => handle(e.data, slot);
  slot.w.onerror = (e) => showError("Worker error: " + (e.message || "could not start"));
  pool[i] = slot;
}
function ensurePool(n) {
  while (pool.length > n) pool.pop().w.terminate();
  for (let i = pool.length; i < n; i++) spawn(i);
}
function resetPool() { pool.forEach((p) => p.w.terminate()); pool = []; ensurePool(1); }
function anyReady() { return pool.some((p) => p.ready); }
function setIdleUi() {
  running = false;
  run = null;
  $("startBtn").disabled = !anyReady();
  $("stopBtn").disabled = true;
}
function showError(msg) {
  const b = $("errorBox"); b.textContent = msg; b.hidden = false;
  if (running) { pool.forEach((p) => p.w.terminate()); pool = []; ensurePool(1); setIdleUi(); }
  $("status").textContent = "Error";
}
function loadSavedBest() {
  try { const v = JSON.parse(localStorage.getItem(BEST_KEY) || "null"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function saveBest() {
  try { localStorage.setItem(BEST_KEY, JSON.stringify(found.slice(0, 6).map((l) => l.state).filter(Boolean))); } catch (e) { /* ignore */ }
}
function updateSavedNote() {
  const n = loadSavedBest().length;
  $("resumeNote").textContent = n ? `${n} saved layout${n > 1 ? "s" : ""} from earlier searches in this browser.` : "No saved layouts yet.";
  $("resume").disabled = !n;
}
function mergeLayouts(list) {
  if (!list || !list.length) return false;
  const key = (l) => l.grid.join("/") + "|" + l.armor.map((t) => t.join(",")).join(" ");
  const all = new Map();
  found.concat(list).forEach((l) => { const k = key(l); if (!all.has(k) || all.get(k).score < l.score) all.set(k, l); });
  const before = found.length ? found[0].score : -Infinity;
  found = [...all.values()].sort((x, y) => y.score - x.score).slice(0, 5);
  setLayouts(found, true);
  if (found[0].score > before) saveBest();
  return true;
}
function showProgress() {
  if (!run) return;
  const elapsed = (Date.now() - run.t0) / 1000;
  const doneNow = run.doneBefore + pool.reduce((a, p) => a + (p.prog ? p.prog.done : 0), 0);
  const best = found.length ? found[0].score : null;
  let frac = null;
  if (run.timeLimit) frac = elapsed / run.timeLimit;
  else if (run.restarts) frac = doneNow / run.restarts;
  else if (!run.rounds) frac = Math.max(0, ...pool.map((p) => (p.prog && p.prog.frac) || 0));
  $("barFill").style.width = frac == null ? "100%" : (Math.min(1, frac) * 100).toFixed(1) + "%";
  const total = run.restarts ? `/${run.restarts}` : "";
  const cores = `${pool.length} core${pool.length > 1 ? "s" : ""}`;
  const round = run.rounds ? ` | round ${run.round} (${Math.round(run.roundLen)}s)` : "";
  $("progressText").textContent = `Restart ${doneNow}${total} on ${cores}${round}` + (best != null ? ` | best score ${best.toFixed(1)}` : "") + ` | ${elapsed.toFixed(0)}s elapsed`;
}
function handle(m, slot) {
  switch (m.type) {
    case "status": if (!running) $("status").textContent = m.msg; break;
    case "ready":
      slot.ready = true;
      if (!running) { $("status").textContent = "Ready"; $("startBtn").disabled = false; }
      break;
    case "log": if (slot === pool[0]) $("status").textContent = m.msg; break;
    case "progress": slot.prog = m; if (running) { $("status").textContent = "Searching..."; showProgress(); } break;
    case "best": mergeLayouts(m.layouts); showProgress(); break;
    case "done":
      mergeLayouts(m.layouts);
      if (m.odds) slot.odds = m.odds;
      slot.finished = true;
      if (run && pool.every((p) => p.finished)) roundFinished();
      break;
    case "error": showError(m.message); break;
  }
}
function startRound() {
  const r = run;
  r.round += 1;
  const cfg = buildConfig();
  const seeds = (r.round === 1 ? r.firstSeeds : found.map((l) => l.state)).filter(Boolean).slice(0, 6);
  pool.forEach((p, i) => {
    p.prog = null; p.finished = false;
    const search = Object.assign({}, cfg.search);
    search.seed = (Math.round(cfg.search.seed) || 1) * 1000 + r.round * 37 + i * 7919;
    if (r.rounds) {
      search.time_limit = r.timeLimit ? Math.max(1, Math.min(r.roundLen, r.timeLimit - (Date.now() - r.t0) / 1000)) : r.roundLen;
      search.restarts = 0;
    } else if (r.restarts) {
      search.restarts = Math.floor(r.restarts / pool.length) + (i < r.restarts % pool.length ? 1 : 0);
      if (!search.restarts) { p.finished = true; return; }
    }
    const templates = r.round === 1 ? r.templates : [];
    p.w.postMessage({ type: "start", cfg: Object.assign({}, cfg, { search, seed_states: seeds, templates }) });
  });
  if (pool.every((p) => p.finished)) roundFinished();
}
function roundFinished() {
  const r = run;
  if (!r) return;
  const doneThisRound = pool.reduce((a, p) => a + (p.prog ? p.prog.done : 0), 0);
  r.doneBefore += doneThisRound;
  // On a big hull one search pass can take longer than a round; then make rounds longer so passes finish.
  if (!doneThisRound) r.roundLen = Math.min(r.roundLen * 2, 720);
  pool.forEach((p) => { p.prog = null; });
  const elapsed = (Date.now() - r.t0) / 1000;
  if (r.rounds && (!r.timeLimit || elapsed < r.timeLimit - 1)) { startRound(); return; }
  const odds = (pool.find((p) => p.odds) || {}).odds;
  setLayouts(found, false);
  $("barFill").style.width = "100%";
  $("progressText").textContent = `${r.doneBefore} restarts on ${pool.length} core${pool.length > 1 ? "s" : ""}` + (found.length ? ` | best score ${found[0].score.toFixed(1)}` : "") + ` | ${elapsed.toFixed(0)}s`;
  $("status").textContent = r.timeLimit && r.rounds ? "Finished: time limit reached" : "Finished";
  if (odds) $("oddsBox").textContent = "Learned move odds: " + Object.entries(odds).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ");
  updateSavedNote();
  setIdleUi();
}
function buildConfig() {
  const rows = cfgState.hull.split("\n").map((r) => r.trim()).filter(Boolean);
  return {
    hull: rows, settings: cfgState.settings, priority_range: cfgState.priority_range,
    combat_range: cfgState.combat_range, place_bonus_rooms: cfgState.place_bonus_rooms,
    rooms: cfgState.rooms.map((r) => { const c = catOf(r.cat); return { name: r.name || c.label, short: r.short || "", cat: c.id, catLabel: c.label, kind: c.kind, w: r.w, h: r.h, count: r.count, armor: c.kind === "priority" || c.kind === "combat" ? (r.armor || "") : "" }; }),
    resource_anywhere: cfgState.resource_anywhere, search: cfgState.search,
    walk_noncombat: cfgState.walk_noncombat, vent_game_links: cfgState.walk_noncombat, connect_all: cfgState.connect_all,
    ...(cfgState.learn_top && Top100.analysis ? { patterns: Top100.analysis.patterns, top50_priors: Top100.analysis.priors } : {}),
  };
}
function start() {
  $("errorBox").hidden = true;
  $("oddsBox").textContent = "";
  $("barFill").style.width = "0";
  $("progressText").textContent = "";
  const sc = cfgState.search;
  const resume = $("resume").checked && !$("resume").disabled;
  found = resume ? found.filter((l) => l.state) : [];
  if (!resume) { layouts = []; $("altTabs").hidden = true; }
  ensurePool(wantedCores());
  running = true;
  run = {
    t0: Date.now(), round: 0, doneBefore: 0, roundLen: ROUND_SECONDS,
    timeLimit: Math.max(0, +sc.time_limit || 0), restarts: Math.max(0, Math.round(+sc.restarts || 0)),
    rounds: !(+sc.restarts) && !(+sc.stagnation),            // rounds share results between cores
    firstSeeds: resume ? loadSavedBest() : [],
    templates: cfgState.use_top ? topTemplates().list : [],
  };
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("status").textContent = `Starting on ${pool.length} core${pool.length > 1 ? "s" : ""}...`;
  startRound();
}
function stop() {
  // The optimizer is a long synchronous Python loop, so the reliable way to stop it is to end the workers.
  // The best layouts found so far stay on screen and are saved for "Continue".
  pool.forEach((p) => p.w.terminate());
  pool = [];
  $("status").textContent = "Stopped. Restarting Python runtime...";
  $("progressText").textContent += " (stopped)";
  updateSavedNote();
  setIdleUi();
  $("startBtn").disabled = true;
  ensurePool(1);
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
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// colour of a room in the result picture: its category colour (older results without categories: by kind)
function roomColor(r) {
  if (r.cat && CAT[r.cat]) return CAT[r.cat].color;
  if (r.priority) return CAT.reactor.color;
  return r.combat ? CAT.combat.color : CAT.noncombat.color;
}
// short label drawn on a room: initials of its name ("Mining Laser" -> "ML", "Reactor" -> "Re")
function roomShort(r) {
  if (r.short) return r.w === 1 ? r.short[0] : r.short.slice(0, r.w >= 3 ? 4 : 3);
  const base = r.label || r.name.replace(/\s*#\d+$/, "");
  const words = base.split(/[\s/_-]+/).filter(Boolean);
  if (!words.length) return r.sym;
  const t = words.length > 1 ? words.slice(0, 3).map((w) => w[0].toUpperCase()).join("") : words[0].slice(0, 2);
  return r.w === 1 ? t[0] : t;
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
    const tip = `${r.name}` + (r.catLabel ? ` [${r.catLabel}]` : "") + ` (${r.w}x${r.h}) at ${r.x}, ${r.y}` + (r.combat ? ` | armor touching: ${r.armor}` : "");
    rect(r, roomColor(r), esc(roomShort(r)), esc(tip));
  });
  l.bonus.forEach((r) => rect(r, "#3f9b57", "x", `${r.name} at ${r.x}, ${r.y}`));
  l.armor.forEach(([x, y]) => p.push(`<rect x="${x * T + 2}" y="${y * T + 2}" width="${T - 4}" height="${T - 4}" fill="#e6b93c"><title>Armor ${x}, ${y}</title></rect>`));
  l.lifts.forEach(([x, y0, y1]) => p.push(`<rect x="${x * T + 3}" y="${y0 * T}" width="${T - 6}" height="${(y1 - y0 + 1) * T}" fill="#38c6d9"><title>Lift x=${x}, y ${y0}-${y1}</title></rect>`));
  l.vents.forEach(([x, y]) => p.push(`<rect x="${x * T + 4}" y="${y * T + 4}" width="${T - 8}" height="${T - 8}" fill="#f5f5f5"><title>Vent ${x}, ${y}</title></rect>`));
  if (l.combat_center) {
    const [cx, cy] = [l.combat_center[0] * T, l.combat_center[1] * T];
    p.push(`<g stroke="#ffffff" stroke-width="2.5"><title>Middle of the combat rooms (anti-air target)</title>` +
      `<circle cx="${cx}" cy="${cy}" r="8" fill="#0c111b" fill-opacity=".55"/><line x1="${cx - 11}" y1="${cy}" x2="${cx + 11}" y2="${cy}"/><line x1="${cx}" y1="${cy - 11}" x2="${cx}" y2="${cy + 11}"/></g>`);
  }
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
  const items = [];
  const seen = new Map();
  l.rooms.forEach((r) => { const key = r.cat || (r.priority ? "reactor" : r.combat ? "combat" : "noncombat"); seen.set(key, (seen.get(key) || 0) + 1); });
  ROOM_CATEGORIES.forEach((c) => { if (seen.has(c.id)) items.push([c.color, `${c.label} (${seen.get(c.id)})`]); });
  if (l.combat_center) items.push(["transparent", "\u2316 combat middle (anti-air target)"]);
  items.push(["#e6b93c", "Armor"], ["#38c6d9", "Lift"], ["#f5f5f5", "Vent"], ["#3f9b57", "Bonus room"]);
  if (l.resource_tiles && l.resource_tiles.length) items.push(["#24406b", "Resource space (r)"]);
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
  if (s.center_rooms) defs.push([`Anti-air distance from combat middle (${s.center_rooms} room${s.center_rooms > 1 ? "s" : ""})`, `${s.center_distance.toFixed(1)} tiles`, s.center_distance / s.center_rooms > 4]);
  const sb = $("stats"); sb.innerHTML = "";
  defs.forEach(([k, v, warn]) => sb.append(el("div", { class: "stat" + (warn ? " warn" : "") }, el("b", { text: String(v) }), document.createTextNode(k))));

  const t = $("inventory");
  t.innerHTML = "<tr><th>Room</th><th>Type</th><th>Size</th><th>x, y</th><th>Armor</th></tr>";
  const sorted = l.rooms.map((r) => r).sort((a, b) => a.y - b.y || a.x - b.x);
  sorted.forEach((r) => {
    let armor = "", bad = false;
    if (r.combat) {
      armor = String(r.armor);
      if (r.range) { armor += ` (${r.range[0]}-${r.range[1]})`; bad = r.armor < r.range[0]; }
    }
    const typ = el("td", { class: "typecell" }, el("i", { style: `background:${roomColor(r)}` }), document.createTextNode(r.catLabel || (r.priority ? "Priority" : r.combat ? "Combat" : "Non-combat")));
    const tr = el("tr", {}, el("td", { text: r.name }), typ, el("td", { text: `${r.w}x${r.h}` }), el("td", { text: `${r.x}, ${r.y}` }), el("td", { class: bad ? "bad" : "", text: armor }));
    t.append(tr);
  });
  l.bonus.forEach((r) => t.append(el("tr", {}, el("td", { text: r.name }), el("td", { text: "Bonus" }), el("td", { text: `${r.w}x${r.h}` }), el("td", { text: `${r.x}, ${r.y}` }), el("td"))));
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function coordsText(l) {
  const lines = l.rooms.map((r) => `${r.name}${r.catLabel ? " [" + r.catLabel + "]" : ""} (${r.w}x${r.h}) -> ${r.x}, ${r.y}`);
  l.bonus.forEach((r) => lines.push(`${r.name} (${r.w}x${r.h}) -> ${r.x}, ${r.y}`));
  l.lifts.forEach(([x, y0, y1]) => lines.push(`Lift column x=${x}: y ${y0}-${y1}`));
  l.vents.forEach(([x, y]) => lines.push(`Vent (1x1) -> ${x}, ${y}`));
  lines.push(`Armor (${l.armor.length}): ` + l.armor.map(([x, y]) => `(${x},${y})`).join(" "));
  return lines.join("\n");
}

// ---------------------------------------------------------------- wire up
$("startBtn").onclick = start;
$("stopBtn").onclick = stop;
$("resetBtn").onclick = () => { if (confirm("Reset all settings to the defaults?")) { cfgState = clone(DEFAULTS); saveSettings(); buildAll(); buildTopUi(); updateTopNote(); } };
$("dlJson").onclick = () => download("ship-layout.json", JSON.stringify(layouts[activeIdx], null, 2), "application/json");
$("dlSvg").onclick = () => download("ship-layout.svg", layoutSvg(layouts[activeIdx]), "image/svg+xml");
$("copyCoords").onclick = async () => {
  try { await navigator.clipboard.writeText(coordsText(layouts[activeIdx])); $("status").textContent = "Coordinates copied"; }
  catch (e) { $("status").textContent = "Copy blocked by the browser"; }
};
buildAll();
buildShipFinder();
buildTopUi();
Promise.all([Hulls.load(false).catch(() => null), Top100.load()]).then(() => {
  const id = parseInt(new URLSearchParams(location.search).get("ship"), 10);   // link from the Top 100 page
  const ship = isNaN(id) ? null : Hulls.byId(id);
  if (ship) {
    hullBefore = cfgState.hull;
    $("hull").value = ship.rows.join("\n");
    $("hull").dispatchEvent(new Event("input"));
    $("hullUndo").hidden = false;
    $("shipStatus").textContent = `Hull set to ${ship.name} from the Top 100 page.`;
    history.replaceState(null, "", location.pathname);
  }
  updateTopNote(); updateStyleNote();
});
GameRooms.load().then((n) => {
  if (!n) return;
  GameRooms.fillDatalist($("gameRoomNames"));
  cfgState.rooms.forEach((r) => { const g = GameRooms.find(r.name); if (g && !r.short) r.short = g.short; });
  $("roomLibNote").textContent = `Type a room name to use one of ${n} game rooms (real size and type filled in automatically; list from ${GameRooms.updated}).`;
  buildRooms();
});
updateSavedNote();
ensurePool(1);
