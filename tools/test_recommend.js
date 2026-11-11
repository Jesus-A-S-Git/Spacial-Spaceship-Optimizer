#!/usr/bin/env node
// Checks the room recommender (js/recommend.js + js/gamerooms.js) over every player hull, every build and many
// ship levels:
//   * with "Include event and premium rooms" off, no event / premium / starbux / starbase room is suggested
//     (checked against the raw data/rooms.json, not only GameRooms' own flag);
//   * the required rooms are always there: the most Bedrooms allowed and the Fleet Council (from ship level 4);
//   * no room above the ship level, no more of a room than its limit.
//     node tools/test_recommend.js
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const ctx = { console, fetch: async (u) => ({ ok: true, json: async () => JSON.parse(read(u)) }) };
vm.createContext(ctx);
for (const f of ["js/categories.js", "js/gamerooms.js", "js/recommend.js"]) vm.runInContext(read(f), ctx, { filename: f });
const { GameRooms, Recommender } = vm.runInContext("({ GameRooms, Recommender })", ctx);

// raw data: every family that has a level bought with starbux / not sold, or only one or two levels
const raw = JSON.parse(read("data/rooms.json")).rooms;
const base = (n) => n.replace(/\s+Lv\s*\d+$/i, "").trim().toLowerCase();
const fams = new Map();
raw.forEach((r) => { const k = base(r.name); (fams.get(k) || fams.set(k, []).get(k)).push(r); });
const rawBux = (name) => {
  const l = fams.get(name.toLowerCase()) || [];
  return l.length <= 2 || l.some((r) => !r.price || /^(starbux|supply)\s*:/i.test(r.price) || /:\s*9999$/.test(r.price) || (+r.flags & 64));
};
// rooms players know as premium / event / starter rooms
const KNOWN_PREMIUM = ["Aquarium", "Captain's Quarters", "Coal Reactor", "Cat House", "Car Garage", "Dog House", "Oven",
  "Xmas Tree", "Graveyard", "Cryopod", "Visiri Mechbay", "Ghostly Factory", "Zongzi Factory", "K Blaster", "Kias Phaser",
  "Doomlaser", "Computer Room", "Serious Workshop", "Poker Room", "Auxiliary Missile Launcher", "Galaxy Gym", "Lunar College",
  "Toilet", "Flower Gardens", "Gray Launch Pad", "Heavy Shield Generator", "Large Reactor", "Starfleet Headquarters"];

(async () => {
  const n = await GameRooms.load();
  if (!n) throw new Error("data/rooms.json did not load");
  const analysis = JSON.parse(read("data/top_analysis.json"));
  const ships = JSON.parse(read("data/ships.json")).ships.filter((s) => s.type === "Player" && s.hull && s.hull.length);
  const W = Recommender.WEAPONS.map(([k]) => k);
  const builds = W.flatMap((p) => [[p, ""], ...W.filter((s) => s !== p).map((s) => [p, s])]);
  const fails = [];
  const fail = (msg) => { if (fails.length < 40) fails.push(msg); else fails.length++; };
  let runs = 0;
  const seenPremium = new Set();
  for (const ship of ships) {
    const levels = [...new Set([ship.level, null, 1, 3, 4, 6, 9, 12, 14].filter((v) => v !== undefined))];
    for (const [p, s] of builds) for (const level of levels) for (const special of [false, true]) {
      if (special && level !== ship.level) continue;
      const r = Recommender.recommend(analysis, { rows: ship.hull, level, primary: p, secondary: s, special });
      runs++;
      const lv = level >= 1 ? level : null;     // the recommender reads 0 / none as "no ship level"
      const where = `${ship.name} L${level} ${p}${s ? "+" + s : ""}${special ? " (special on)" : ""}`;
      const byName = new Map(r.rooms.map((x) => [x.name.toLowerCase(), x]));
      for (const x of r.rooms) {
        const g = GameRooms.find(x.name);
        if (!g) { fail(`${where}: unknown room ${x.name}`); continue; }
        if (!(x.count > 0)) fail(`${where}: ${x.name} count ${x.count}`);
        if (lv != null && x.minShip != null && x.minShip > lv) fail(`${where}: ${x.name} Lv ${x.level} needs ship level ${x.minShip}`);
        const d = g.designs.find((v) => v.level === x.level);
        if (d && d.maxCount && x.count > d.maxCount) fail(`${where}: ${x.count} x ${x.name}, max ${d.maxCount}`);
        if (g.station) fail(`${where}: starbase room ${x.name}`);
        if (!special) {
          if (g.special || (d && d.bux) || x.special) fail(`${where}: event / premium room ${x.name}`);
          if (rawBux(x.name)) fail(`${where}: raw data says ${x.name} is starbux / event`);
          if (KNOWN_PREMIUM.some((k) => k.toLowerCase() === x.name.toLowerCase())) fail(`${where}: premium room ${x.name}`);
        } else if (g.special) seenPremium.add(x.name);
      }
      const bed = byName.get("bedroom");
      if (!bed) fail(`${where}: no Bedroom`);
      else {
        if (bed.count !== 3) fail(`${where}: ${bed.count} Bedrooms, want 3`);
        if (!bed.required) fail(`${where}: Bedroom not marked required`);
      }
      const council = byName.get("fleet council");
      if (lv == null || lv >= 4) {
        if (!council) fail(`${where}: no Fleet Council`);
        else if (council.count !== 1 || !council.required) fail(`${where}: Fleet Council x${council.count}, required=${council.required}`);
      } else if (council) fail(`${where}: Fleet Council below ship level 4`);
      const bedTotal = r.rooms.filter((x) => x.cat === "crew" && x.name !== "Bedroom");
      bedTotal.forEach((x) => { if (x.count > 1) fail(`${where}: ${x.count} x ${x.name} (one per ship)`); });
    }
  }
  console.log(`${runs} recommendations on ${ships.length} hulls x ${builds.length} builds.`);
  if (seenPremium.size) console.log(`With event / premium rooms on, these appear: ${[...seenPremium].sort().join(", ")}`);
  if (fails.length) {
    console.log(`FAILED (${fails.length}):\n  ` + fails.slice(0, 40).join("\n  "));
    process.exit(1);
  }
  console.log("OK: no event / premium / starbux room with the option off; Bedrooms and Fleet Council always included.");
})().catch((e) => { console.error(e); process.exit(1); });
