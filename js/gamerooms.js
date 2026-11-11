"use strict";
// Game room designs (data/rooms.json, built from the official API by tools/build_room_list.py).
// Typing a room's name in the room list fills in its real size and type.
const GameRooms = (() => {
  // game RoomType -> this page's room category (see ROOM_CATEGORIES in app.js)
  const TYPE_CAT = {
    Reactor: "reactor", Shield: "shield",
    Laser: "laser", Cannon: "combat", Missile: "missile", StationMissile: "missile",
    Carrier: "hangar", AntiCraft: "antiair",
    Engine: "antimissile", AntiTeleport: "antitele", Trap: "antitele", Teleport: "boarding",
    Android: "crewsupport", Medical: "crewsupport", Reviver: "crewsupport", Stealth: "cloak", Radar: "cloak",
    Command: "command", Bridge: "command", Booster: "booster",
    Bedroom: "crew", Training: "noncombat", Council: "noncombat", Research: "noncombat",
    Gas: "resource", Mineral: "resource", Storage: "resource", Supply: "resource", Printer: "resource", Recycling: "resource",
  };
  const SKIP = new Set(["Wall", "Lift", "Corridor", "Hull", "None"]);   // armor, lifts etc. are not rooms here
  let byName = new Map(), list = [], updated = "", hasTiers = false;

  // Only shield GENERATORS are priority rooms; batteries, capacitors etc. are shield support.
  const catFor = (type, name) => (type === "Shield" && !/generator/i.test(name) ? "shieldsupport" : TYPE_CAT[type] || "combat");
  const hasPrices = (data) => (data.fields || []).includes("PriceString") && (data.rooms || []).some((r) => r.price);
  // a design bought with starbux, or not sold at all (no price, or the 9999 placeholder the game uses for rewards)
  const isBuxPrice = (p, priced) => priced && (!p || /^starbux\s*:/i.test(p) || /:\s*9999$/.test(p));
  // event / premium rooms, left out unless "Include event and premium rooms" is ticked. The game's price only says
  // how a level is upgraded, so look at the whole family: premium bedrooms (Aquarium, Cat House ...), starter rooms
  // (Captain's Quarters, Coal Reactor) and event rooms all come with one or two levels and mineral/gas prices.
  function isSpecial(g, priced) {
    if (g.prices.length <= 2) return true;                                    // one or two levels only
    if (g.prices.some((p) => isBuxPrice(p, priced))) return true;            // any level bought with starbux / not sold
    if (g.flags.some((f) => f & 64)) return true;                             // a level that cannot be built (rewards, wrecks)
    if (g.maxCounts.some((m) => m === 1)) return true;                        // one per ship: event / premium room
    if (g.type === "Bedroom" && g.name.toLowerCase() !== "bedroom") return true;   // premium bedroom skins
    if (g.station) return true;                                               // starbase room
    return g.designs.some((d) => d.bux);
  }
  const base = (n) => n.replace(/\s+Lv\s*\d+$/i, "").trim();
  const norm = (n) => base(String(n || "")).toLowerCase().replace(/\s+/g, " ");

  let loading = null;
  function load() { return loading || (loading = loadOnce()); }
  async function loadOnce() {
    try {
      const res = await fetch("data/rooms.json");
      if (!res.ok) return 0;
      const data = await res.json();
      updated = (data.updated || "").slice(0, 10);
      const groups = new Map();
      const priced = hasPrices(data);
      for (const r of data.rooms || []) {
        if (SKIP.has(r.type) || /^destroyed\b/i.test(r.name)) continue;
        const name = base(r.name), k = name.toLowerCase();
        const lv = r.levels || [0, 0];
        let g = groups.get(k);
        if (!g) {
          g = { name, w: r.w, h: r.h, type: r.type, category: r.category, cat: catFor(r.type, name),
                short: (r.short || "").replace(/:\d+$/, ""), levels: [lv[0], lv[1]], designs: [], prices: [], flags: [], maxCounts: [] };
          groups.set(k, g);
        } else {
          g.levels = [Math.min(g.levels[0], lv[0]), Math.max(g.levels[1], lv[1])];
        }
        g.prices.push(r.price || "");
        g.flags.push(+r.flags || 0);
        g.maxCounts.push(r.maxCount || 0);
        if (r.w === g.w && r.h === g.h) {
          g.designs.push({ level: lv[1], minShip: r.minShip == null ? null : r.minShip, power: r.power || 0,
                           powerGen: r.powerGen || 0, capacity: r.capacity || 0, maxCount: r.maxCount || 0, price: r.price || "",
                           bux: isBuxPrice(r.price, priced) });
        }
      }
      list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
      list.forEach((g) => {
        g.designs.sort((a, b) => a.level - b.level);
        const tiers = g.designs.map((d) => d.minShip).filter((v) => v != null);
        g.minShip = tiers.length ? Math.min(...tiers) : null;      // lowest ship level that can build it
        hasTiers = hasTiers || tiers.length > 0;
        g.station = g.prices.some((p) => /^supply\s*:/i.test(p));  // starbase rooms (paid in supplies): no top ship has one
        g.special = isSpecial(g, priced);
        delete g.prices; delete g.flags; delete g.maxCounts;
      });
      byName = new Map(list.map((g) => [g.name.toLowerCase(), g]));
      return list.length;
    } catch (e) { return 0; }
  }
  function find(name) { return byName.get(norm(name)) || null; }
  function describe(g) {
    const lv = g.levels[0] === g.levels[1] ? `Lv ${g.levels[0]}` : `Lv ${g.levels[0]}-${g.levels[1]}`;
    return `${g.w}x${g.h} · ${g.type} · ${lv}` + (g.minShip != null ? ` · ship level ${g.minShip}+` : "");
  }
  // best design of a room family that a ship of this level can build (null = none yet)
  // noBux: never a design bought with starbux / not sold (a family can be fine while one level is not)
  function bestFor(g, shipLevel, noBux) {
    if (!g) return null;
    let best = null;
    g.designs.forEach((d) => {
      if (noBux && d.bux) return;
      if (shipLevel == null || !hasTiers || d.minShip == null || d.minShip <= shipLevel) best = d;
    });
    return best;
  }
  // a family the recommender may suggest when event / premium rooms are not wanted
  const buyable = (g) => !!g && !g.special && !g.station;
  // every room family of one page category (for the recommender's fallbacks)
  function ofCategory(cat) { return list.filter((g) => g.cat === cat); }
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
  return { load, find, describe, fillDatalist, catOf, bestFor, ofCategory, buyable,
    get count() { return list.length; }, get updated() { return updated; }, get hasTiers() { return hasTiers; } };
})();
