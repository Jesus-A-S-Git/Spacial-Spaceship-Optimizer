"use strict";
// Game room designs (data/rooms.json, built from the official API by tools/build_room_list.py).
// Typing a room's name in the room list fills in its real size and type.
const GameRooms = (() => {
  // game RoomType -> this page's room category (see ROOM_CATEGORIES in app.js)
  const TYPE_CAT = {
    Reactor: "reactor", Shield: "shield",
    Laser: "laser", Cannon: "combat", Missile: "missile", StationMissile: "missile",
    Carrier: "hangar", AntiCraft: "antiair",
    Engine: "utility", Android: "utility", Stealth: "utility", Teleport: "utility", Medical: "utility",
    Command: "utility", Bridge: "utility", Trap: "utility", Radar: "utility", Booster: "utility",
    AntiTeleport: "utility", Reviver: "utility",
    Bedroom: "crew", Training: "noncombat", Council: "noncombat", Research: "noncombat",
    Gas: "resource", Mineral: "resource", Storage: "resource", Supply: "resource", Printer: "resource", Recycling: "resource",
  };
  const SKIP = new Set(["Wall", "Lift", "Corridor", "Hull", "None"]);   // armor, lifts etc. are not rooms here
  let byName = new Map(), list = [], updated = "";

  // Only shield GENERATORS are priority rooms; batteries, capacitors etc. are support (utility).
  const catFor = (type, name) => (type === "Shield" && !/generator/i.test(name) ? "utility" : TYPE_CAT[type] || "combat");
  const base = (n) => n.replace(/\s+Lv\s*\d+$/i, "").trim();
  const norm = (n) => base(String(n || "")).toLowerCase().replace(/\s+/g, " ");

  async function load() {
    try {
      const res = await fetch("data/rooms.json");
      if (!res.ok) return 0;
      const data = await res.json();
      updated = (data.updated || "").slice(0, 10);
      const groups = new Map();
      for (const r of data.rooms || []) {
        if (SKIP.has(r.type) || /^destroyed\b/i.test(r.name)) continue;
        const name = base(r.name), k = name.toLowerCase();
        const lv = r.levels || [0, 0];
        const g = groups.get(k);
        if (!g) {
          groups.set(k, { name, w: r.w, h: r.h, type: r.type, category: r.category, cat: catFor(r.type, name),
                          short: (r.short || "").replace(/:\d+$/, ""), levels: [lv[0], lv[1]] });
        } else {
          g.levels = [Math.min(g.levels[0], lv[0]), Math.max(g.levels[1], lv[1])];
        }
      }
      list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
      byName = new Map(list.map((g) => [g.name.toLowerCase(), g]));
      return list.length;
    } catch (e) { return 0; }
  }
  function find(name) { return byName.get(norm(name)) || null; }
  function describe(g) {
    const lv = g.levels[0] === g.levels[1] ? `Lv ${g.levels[0]}` : `Lv ${g.levels[0]}-${g.levels[1]}`;
    return `${g.w}x${g.h} · ${g.type} · ${lv}`;
  }
  function fillDatalist(dl) {
    dl.innerHTML = "";
    list.forEach((g) => { const o = document.createElement("option"); o.value = g.name; o.label = describe(g); dl.append(o); });
  }
  // category for a room in top-100 data (also armor / lift / corridor)
  function catOf(type, name) {
    if (type === "Armor" || type === "Wall") return "armor";
    if (type === "Lift") return "lift";
    if (type === "Corridor") return "corridor";
    return catFor(type, name || "");
  }
  return { load, find, describe, fillDatalist, catOf, get count() { return list.length; }, get updated() { return updated; } };
})();
