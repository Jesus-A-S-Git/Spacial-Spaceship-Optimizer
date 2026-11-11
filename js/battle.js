"use strict";
// Ship vs ship page: a MOCK win-rate estimate between two ship layouts.
// This is NOT the game's battle engine. It is a small, transparent Monte Carlo model built only from the data the
// site has (room designs and their level, counts, armor placement, power made vs used). Crew, AI scripts, research,
// equipment, room upgrades below max and exact weapon numbers are not modelled.
//
// The model part (BattleModel) has no DOM dependencies, so tools can run it in Node:
//   const BM = require("./js/battle.js"); BM.setup(roomsJson, analysisJson); BM.duel(BM.fromTop(layout), ...)

// ---------------------------------------------------------------- assumptions (all in one place)
// The game data on this site does not include hull HP, weapon damage, reload times or shield regen, so these are
// ASSUMED values in made-up units. Only their ratios matter. The ones marked [cal] were swept (x0.5 / x2 and similar)
// against all 4950 pairs of top-100 ships to see if any setting makes the better-ranked ship win more often. None did
// (47-49% for every setting tried): the top 100 run nearly the same rooms, so the round values below were kept.
// See README "Ship vs ship" for the numbers.
const BATTLE_CONSTANTS = {
  SIMS: 2000,                 // simulated fights per match-up
  MAX_TIME: 180,              // seconds per fight; then the ship with more hull left wins (equal = draw, half each)
  DT: 1,                      // simulation step, seconds
  SHIP_LEVEL: 14,             // rooms are taken at the best level this ship level can build (all top-100 ships are level 14)
  HULL_HP: 1000,              // same for every ship: hull HP is not in data/ships.json (and is set by ship level in the game)
  ROOM_HP_PER_TILE: 10,       // a room is knocked out after this much damage per tile it covers (no repairs: no crew)
  DMG_PER_POWER: 6,           // damage per volley per power bar a weapon draws (game weapons scale roughly with power)
  RELOAD: 10,                 // seconds between volleys, the same for every weapon...
  RELOAD_JITTER: 0.25,        // ...+-25% random each time (hit timing randomness)
  SHIELD_HP_PER_POINT: 12,    // shield pool = sum of shield rooms' Capacity (rooms.json) x this
  SHIELD_REGEN_PER_POWER: 0.6, // shield points regained per second per power bar of shield rooms (batteries included) [cal]
  ARMOR_SCALE: 1.0,           // armor damage reduction = armor Capacity % x share of the room's edge touching armor x this [cal]
  // Counters work like a stopping capacity that refills: every RELOAD seconds a counter can stop incoming weapon power up
  // to its own power x COUNTER. Few missiles against many engines: nearly all are stopped. Many missiles against few
  // engines: the engines are saturated and most get through. The same for craft vs anti-air and boarding vs gates.
  COUNTER: { missile: 1.0, craft: 1.0 }, // incoming missile / craft power one bar of engines / anti-air can stop per volley
  COUNTER_HIT: 0.9,           // chance a counter with capacity left stops the shot (never a perfect wall)
  GATE_POWER: 3,              // boarding (teleport) power one Interdictor Gate / Teleport Repulsor can stop per volley
  TRAP_CUT: 0.25,             // each Security Gate / Disintegrator Gate / gas trap / Zaki garden: boarders that got through
                              // do 1 / (1 + this x traps) of their damage (kills or weakens them on arrival)
  CLOAK_EVADE_PER_POWER: 0.02, // chance a shot misses per cloak power bar, minus the same per radar power bar of the shooter
  CLOAK_EVADE_MAX: 0.15,
  ROLE_DMG: { laser: 1, missile: 1, craft: 1, board: 1 },   // damage multiplier per weapon kind (lasers include cannons) [cal]
  FIGHT_LUCK: 0.25,           // each side's damage is scaled by a random 1 +- this per fight: stands in for crew, AI,
                              // research and equipment, none of which are modelled [cal]
  BOOST_PER_ROOM: 0.05,       // weapon damage +5% per booster room (Gunnery Core, Missile Matrix ...), at most +20%
  BOOST_MAX: 0.2,
  POWER_REF: 0.5,             // power made / needed at which weapons and shields run at full output. Replaced at load
                              // by the top-100 median (top_analysis.json recommend.power_ratio): the top ships never power everything.
};

const BattleModel = (() => {
  const C = BATTLE_CONSTANTS;
  let catalogue = new Map();    // lower-case room family name -> best design at SHIP_LEVEL {type, category, power, powerGen, capacity, w, h, level}
  let catMedian = {};           // page category -> typical design (for "my build" rooms the game data does not know)

  const base = (n) => String(n || "").replace(/\s+Lv\s*\d+$/i, "").trim().toLowerCase().replace(/\s+/g, " ");
  function setup(roomsJson, analysisJson) {
    catalogue = new Map();
    for (const r of (roomsJson && roomsJson.rooms) || []) {
      if (/^destroyed\b/i.test(r.name)) continue;
      const k = base(r.name), lv = (r.levels || [0, 0])[1];
      if (r.minShip != null && r.minShip > C.SHIP_LEVEL) continue;
      const cur = catalogue.get(k);
      if (!cur || lv > cur.level) {
        catalogue.set(k, { type: r.type, category: r.category || "", power: r.power || 0, powerGen: r.powerGen || 0,
          capacity: r.capacity || 0, w: r.w, h: r.h, level: lv });
      }
    }
    const pr = analysisJson && analysisJson.recommend && analysisJson.recommend.power_ratio;
    if (Array.isArray(pr) && pr[1] > 0) C.POWER_REF = pr[1];
  }
  function design(name, type) {
    const d = catalogue.get(base(name));
    if (d) return d;
    if (/^(armor|wall)$/i.test(type)) return catalogue.get("armor") || { type: "Wall", capacity: 0 };
    return null;
  }

  // what a room does in the model
  function roleOf(type, d, name) {
    switch (type) {
      case "Laser": return "laser";
      case "Cannon": return "laser";            // treated like lasers (shielded, no interception)
      case "Missile": case "StationMissile": return "missile";
      case "Carrier": return d && d.category === "Defence" ? "antiair" : "craft";
      case "Teleport": return "board";
      case "Shield": return "shield";
      case "Reactor": return "reactor";
      case "AntiCraft": return "antiair";
      case "Engine": return "antimissile";
      case "AntiTeleport": return "antitele";   // Teleport Interdictor Gate, Teleport Repulsor: stop boarding
      case "Trap": return "trap";               // Security Gate, Disintegrator Gate, gas traps: hurt boarders that land
      case "Stealth": return "cloak";
      case "Radar": return "radar";
      case "Booster": return "booster";
      case "Android": case "Medical": case "Reviver": return "crew";
      default: return "other";
    }
  }
  const WEAPON_ROLES = new Set(["laser", "missile", "craft", "board"]);
  // a page category (room list of the optimizer) -> game room type, for rooms it cannot find by name
  const CAT_TYPE = { laser: "Laser", missile: "Missile", hangar: "Carrier", combat: "Cannon", boarding: "Teleport", reactor: "Reactor",
    shield: "Shield", shieldsupport: "Shield", antiair: "AntiCraft", antimissile: "Engine", antitele: "AntiTeleport", cloak: "Stealth",
    booster: "Booster", crewsupport: "Android" };

  function mkRoom(name, type, x, y, w, h) {
    const d = design(name, type);
    const role = roleOf(type, d, name);
    return { name, type, role, x, y, w, h, power: d ? d.power : 0, gen: d ? d.powerGen : 0,
      cap: d ? d.capacity : 0, level: d ? d.level : null, known: !!d, cover: 0, armorPct: 0 };
  }
  // fraction of each room's outline that touches armor, and the armor % it gets
  function applyArmor(rooms, armorTiles, armorPct) {
    const set = new Set(armorTiles.map(([x, y]) => x + "," + y));
    rooms.forEach((r) => {
      let edge = 0, hit = 0;
      for (let i = 0; i < r.w; i++) { edge += 2; hit += set.has((r.x + i) + "," + (r.y - 1)) + set.has((r.x + i) + "," + (r.y + r.h)); }
      for (let j = 0; j < r.h; j++) { edge += 2; hit += set.has((r.x - 1) + "," + (r.y + j)) + set.has((r.x + r.w) + "," + (r.y + j)); }
      r.cover = edge ? hit / edge : 0;
      r.armorPct = armorPct;
    });
  }

  // one top-100 layout (data/top_layouts.json row) -> model ship
  function fromTop(l) {
    const rooms = [], armor = [];
    let armorCapSum = 0;
    for (const [x, y, w, h, type, , name] of l.rooms) {
      if (type === "Armor" || type === "Wall") {
        armor.push([x, y]);
        const d = design(name, "Wall");
        armorCapSum += d ? d.capacity : 0;
        continue;
      }
      if (type === "Lift" || type === "Corridor") continue;
      rooms.push(mkRoom(name, type, x, y, w, h));
    }
    const armorPct = armor.length ? armorCapSum / armor.length : 0;
    applyArmor(rooms, armor, armorPct);
    return finish({ id: "r" + l.rank, label: `#${l.rank} ${l.name}`, ship: l.ship_name, shipId: l.ship_id, rank: l.rank, trophies: l.trophies,
      rooms, armorTiles: armor.length, armorPct, placed: true });
  }
  // the optimizer page's room list (no room positions are stored): armor spread evenly over the rooms
  // edgesPerArmor = how many room edges one armor tile touches on average in the top 100 (measured by measureArmor)
  function fromBuild(cfg, edgesPerArmor) {
    const rooms = [];
    (cfg.rooms || []).forEach((r) => {
      const n = Math.max(0, Math.min(60, +r.count || 0));
      const d = design(r.name, "");
      const type = d ? d.type : CAT_TYPE[r.cat] || "Other";
      for (let i = 0; i < n; i++) {
        const m = mkRoom(r.name, type, 0, 0, +r.w || 2, +r.h || 2);
        if (!d && catMedian[r.cat]) Object.assign(m, catMedian[r.cat]);
        rooms.push(m);
      }
    });
    const armorN = Math.max(0, +((cfg.settings || {}).ARMOR_COUNT) || 0);
    const a = design("Armor", "Wall"), armorPct = a ? a.capacity : 0;
    const shielded = rooms.filter((r) => r.role !== "other" && r.role !== "crew");
    const edge = shielded.reduce((s, r) => s + 2 * (r.w + r.h), 0);
    const cover = edge ? Math.min(1, (armorN * (edgesPerArmor || 2)) / edge) : 0;
    rooms.forEach((r) => { r.cover = shielded.includes(r) ? cover : 0; r.armorPct = armorPct; });
    return finish({ id: "mine", label: "My build (optimizer page)", ship: cfg.hullName || "your hull", rank: null, rooms,
      armorTiles: armorN, armorPct, placed: false });
  }
  // typical design per page category, from the top-100 ships (median power / output / capacity)
  function learnCategories(layouts, catOfFn) {
    const by = {};
    layouts.forEach((l) => l.rooms.forEach(([, , , , type, , name]) => {
      const d = design(name, type);
      if (!d) return;
      const c = catOfFn(type, name);
      (by[c] = by[c] || []).push(d);
    }));
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 0; };
    catMedian = {};
    for (const [c, ds] of Object.entries(by)) catMedian[c] = { power: med(ds.map((d) => d.power)), gen: med(ds.map((d) => d.powerGen)), cap: med(ds.map((d) => d.capacity)), known: false };
  }
  // average room edges touched per armor tile in the top 100 (for "my build", whose armor has no positions)
  function measureArmor(ships) {
    let edges = 0, tiles = 0;
    ships.forEach((s) => { tiles += s.armorTiles; s.rooms.forEach((r) => { edges += r.cover * 2 * (r.w + r.h); }); });
    return tiles ? edges / tiles : 2;
  }

  // static numbers for the breakdown
  function finish(s) {
    const sum = (role, f) => s.rooms.filter((r) => r.role === role).reduce((t, r) => t + f(r), 0);
    const count = (role) => s.rooms.filter((r) => r.role === role).length;
    s.made = sum("reactor", (r) => r.gen);
    s.need = s.rooms.reduce((t, r) => t + (r.role === "reactor" ? 0 : r.power), 0);
    s.powerRatio = s.need ? s.made / s.need : 1;
    s.powerFactor = Math.min(1, s.powerRatio / C.POWER_REF);
    s.boost = 1 + Math.min(C.BOOST_MAX, count("booster") * C.BOOST_PER_ROOM);
    s.weaponPower = { laser: sum("laser", (r) => r.power), missile: sum("missile", (r) => r.power), craft: sum("craft", (r) => r.power), board: sum("board", (r) => r.power) };
    s.shieldPool = sum("shield", (r) => r.cap) * C.SHIELD_HP_PER_POINT;
    s.shieldRegen = sum("shield", (r) => r.power) * C.SHIELD_REGEN_PER_POWER;
    s.antiMissile = sum("antimissile", (r) => r.power);
    s.antiAir = sum("antiair", (r) => r.power);
    s.antiTele = count("antitele");
    s.traps = count("trap");
    s.cloak = sum("cloak", (r) => r.power);
    s.radar = sum("radar", (r) => r.power);
    s.crewRooms = count("crew");
    const core = s.rooms.filter((r) => r.role !== "other" && r.role !== "crew" && r.role !== "trap");
    s.armorCover = core.length ? core.reduce((t, r) => t + r.cover, 0) / core.length : 0;
    s.armorReduction = core.length ? core.reduce((t, r) => t + reduction(r), 0) / core.length : 0;
    s.unknown = s.rooms.filter((r) => !r.known).length;
    s.dpm = (s.weaponPower.laser + s.weaponPower.missile + s.weaponPower.craft + s.weaponPower.board) * C.DMG_PER_POWER * (60 / C.RELOAD) * s.boost * s.powerFactor;
    return s;
  }
  const reduction = (r) => Math.min(0.9, (r.armorPct / 100) * r.cover * C.ARMOR_SCALE);

  // ---------------------------------------------------------------- the duel
  function rng(seed) {   // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function state(s, R) {
    const rooms = s.rooms.map((r) => ({ r, hp: C.ROOM_HP_PER_TILE * r.w * r.h, red: reduction(r) }));
    const weapons = rooms.filter((x) => WEAPON_ROLES.has(x.r.role) && x.r.power > 0)
      .map((x) => ({ x, next: R() * C.RELOAD }));   // random first shot
    const role = () => ({ dmg: 0, stopped: 0, shield: 0, armor: 0, hull: 0 });
    return { s, rooms, weapons, hull: C.HULL_HP, shield: s.shieldPool, snap: null, luck: 1 + (R() * 2 - 1) * C.FIGHT_LUCK,
      pool: { missile: 0, craft: 0, board: 0 },     // counter capacity left (starts full: set on the first step)
      stats: { fired: 0, intercepted: 0, blocked: 0, missed: 0, shield: 0, hull: 0, armor: 0, knocked: 0,
        role: { laser: role(), missile: role(), craft: role(), board: role() } } };
  }
  function live(st, role, f) { let t = 0; for (const x of st.rooms) if (x.hp > 0 && x.r.role === role) t += f ? f(x.r) : 1; return t; }
  function snapshot(st) {      // cached until a room is knocked out
    return st.snap || (st.snap = snapshotNow(st));
  }
  function snapshotNow(st) {
    const made = live(st, "reactor", (r) => r.gen);
    let need = 0;
    for (const x of st.rooms) if (x.hp > 0 && x.r.role !== "reactor") need += x.r.power;
    return { pf: need ? Math.min(1, made / need / C.POWER_REF) : 1, am: live(st, "antimissile", (r) => r.power), aa: live(st, "antiair", (r) => r.power),
      at: live(st, "antitele"), traps: live(st, "trap"), cloak: live(st, "cloak", (r) => r.power), radar: live(st, "radar", (r) => r.power),
      shieldMax: live(st, "shield", (r) => r.cap) * C.SHIELD_HP_PER_POINT, regen: live(st, "shield", (r) => r.power) * C.SHIELD_REGEN_PER_POWER };
  }
  // shots fired by `att` this step at `def` (both snapshots taken at the start of the step, so the order of sides never matters)
  function fire(att, def, A, D, t, R, out) {
    for (const w of att.weapons) {
      if (w.x.hp <= 0 || w.next > t) continue;
      w.next = t + C.RELOAD * (1 + (R() * 2 - 1) * C.RELOAD_JITTER);
      const role = w.x.r.role;
      let dmg = w.x.r.power * C.DMG_PER_POWER * A.pf * att.s.boost * att.luck * C.ROLE_DMG[role];
      const rs = att.stats.role[role];
      att.stats.fired++;
      rs.dmg += dmg;
      const evade = Math.max(0, Math.min(C.CLOAK_EVADE_MAX, (D.cloak - A.radar) * C.CLOAK_EVADE_PER_POWER));
      if (R() < evade) { att.stats.missed++; rs.stopped += dmg; continue; }
      if (role === "missile" || role === "craft" || role === "board") {
        // the defender's counter capacity for this kind of weapon (refilled every step in fight())
        const p = w.x.r.power, left = def.pool[role];
        const chance = C.COUNTER_HIT * Math.min(1, left / p);
        def.pool[role] = Math.max(0, left - p);
        if (chance > 0 && R() < chance) {
          if (role === "board") att.stats.blocked++; else att.stats.intercepted++;
          rs.stopped += dmg;
          continue;
        }
      }
      if (role === "board" && D.traps) { const cut = dmg - dmg / (1 + C.TRAP_CUT * D.traps); dmg -= cut; rs.stopped += cut; }
      out.push({ dmg, role, shielded: role === "laser" || role === "missile", armored: role !== "board", from: att });
    }
  }
  function land(def, hits, R) {
    for (const h of hits) {
      let d = h.dmg;
      const rs = h.from.stats.role[h.role];
      if (h.shielded && def.shield > 0) { const a = Math.min(def.shield, d); def.shield -= a; d -= a; h.from.stats.shield += a; rs.shield += a; }
      if (d <= 0) continue;
      const x = def.rooms[Math.floor(R() * def.rooms.length)];   // random target room (dead rooms still pass damage to the hull)
      const after = h.armored ? d * (1 - (x ? x.red : 0)) : d;   // boarders walk past armor
      h.from.stats.armor += d - after;
      h.from.stats.hull += after;
      rs.armor += d - after; rs.hull += after;
      def.hull -= after;
      if (x && x.hp > 0) { x.hp -= after; if (x.hp <= 0) { h.from.stats.knocked++; def.snap = null; } }
    }
  }
  // counter capacity per volley: engines vs missiles, anti-air vs craft, interdictor gates vs boarding (power-limited)
  function capOf(S) { return { missile: S.am * S.pf * C.COUNTER.missile, craft: S.aa * S.pf * C.COUNTER.craft, board: S.at * C.GATE_POWER }; }
  function refill(st, S) {
    const cap = capOf(S);
    for (const k in cap) st.pool[k] = Math.min(cap[k], st.pool[k] + (cap[k] / C.RELOAD) * C.DT);
  }
  function fight(a, b, R) {
    const A = state(a, R), B = state(b, R);
    A.pool = capOf(snapshot(A)); B.pool = capOf(snapshot(B));   // counters start ready
    let t = 0;
    for (; t < C.MAX_TIME; t += C.DT) {
      const sa = snapshot(A), sb = snapshot(B);
      A.shield = Math.min(sa.shieldMax, A.shield + sa.regen * sa.pf * C.DT);
      B.shield = Math.min(sb.shieldMax, B.shield + sb.regen * sb.pf * C.DT);
      refill(A, sa); refill(B, sb);
      const toB = [], toA = [];
      fire(A, B, sa, sb, t, R, toB);
      fire(B, A, sb, sa, t, R, toA);
      land(B, toB, R);
      land(A, toA, R);
      if (A.hull <= 0 || B.hull <= 0) break;
    }
    let win;
    if (A.hull <= 0 && B.hull <= 0) win = A.hull === B.hull ? 0.5 : A.hull > B.hull ? 1 : 0;
    else if (B.hull <= 0) win = 1;
    else if (A.hull <= 0) win = 0;
    else win = A.hull === B.hull ? 0.5 : A.hull > B.hull ? 1 : 0;
    return { win, time: Math.min(t + C.DT, C.MAX_TIME), timeout: A.hull > 0 && B.hull > 0, A, B };
  }
  function seedOf(a, b) { let h = 2166136261; for (const c of a.id + "|" + b.id) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
  // n fights; returns A's win share plus averages for the breakdown
  function duel(a, b, n, seed) {
    const R = rng(seed == null ? seedOf(a, b) : seed);
    n = n || C.SIMS;
    const keys = ["fired", "intercepted", "blocked", "missed", "shield", "hull", "armor", "knocked"];
    const tot = { a: Object.fromEntries(keys.map((k) => [k, 0])), b: Object.fromEntries(keys.map((k) => [k, 0])) };
    const rk = ["dmg", "stopped", "shield", "armor", "hull"], roles = ["laser", "missile", "craft", "board"];
    const rz = () => Object.fromEntries(roles.map((ro) => [ro, Object.fromEntries(rk.map((k) => [k, 0]))]));
    tot.a.role = rz(); tot.b.role = rz();
    let wins = 0, time = 0, timeouts = 0, draws = 0;
    for (let i = 0; i < n; i++) {
      const f = fight(a, b, R);
      wins += f.win; time += f.time; timeouts += f.timeout ? 1 : 0; draws += f.win === 0.5 ? 1 : 0;
      keys.forEach((k) => { tot.a[k] += f.A.stats[k]; tot.b[k] += f.B.stats[k]; });
      roles.forEach((ro) => rk.forEach((k) => { tot.a.role[ro][k] += f.A.stats.role[ro][k]; tot.b.role[ro][k] += f.B.stats.role[ro][k]; }));
    }
    keys.forEach((k) => { tot.a[k] /= n; tot.b[k] /= n; });
    roles.forEach((ro) => rk.forEach((k) => { tot.a.role[ro][k] /= n; tot.b.role[ro][k] /= n; }));
    return { pA: wins / n, pB: 1 - wins / n, n, avgTime: time / n, timeouts: timeouts / n, draws: draws / n, a: tot.a, b: tot.b };
  }
  return { setup, fromTop, fromBuild, learnCategories, measureArmor, duel, reduction, get constants() { return C; } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = Object.assign(BattleModel, { BATTLE_CONSTANTS });

// ---------------------------------------------------------------- page
if (typeof document !== "undefined") (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else if (k === "style") e.style.cssText = v; else e.setAttribute(k, v);
    }
    kids.forEach((k) => e.append(k));
    return e;
  }
  const fmt = (v, d = 0) => (v == null || !isFinite(+v) ? "-" : (+v).toFixed(d).replace(/\.0+$/, ""));
  const pct = (v) => (v == null || !isFinite(+v) ? "-" : Math.round(v * 100) + "%");
  function inkFor(hex) {   // copied from analyze.js
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return "#fff";
    const lin = [0, 2, 4].map((i) => { const c = parseInt(m[1].slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? "#0c111b" : "#fff";
  }
  // layout drawing, copied from analyze.js drawShip (kept separate so the two pages can change independently)
  function drawTop(l) {
    const ship = Hulls.byId(l.ship_id);
    const p = Top100.parse(l);
    const rows = ship ? ship.rows : null;
    let W = rows ? rows[0].length : 0, H = rows ? rows.length : 0;
    p.rooms.forEach(([x, y, w, h]) => { W = Math.max(W, x + w); H = Math.max(H, y + h); });
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); };
    if (rows) rows.forEach((r, y) => [...r].forEach((c, x) => { if (c !== ".") grow(x, y); }));
    p.rooms.forEach(([x, y, w, h]) => { grow(x, y); grow(x + w - 1, y + h - 1); });
    const T = 16, w = (x1 - x0) * T, h = (y1 - y0) * T;
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="system-ui,sans-serif" role="img" aria-label="Layout of ${esc(l.ship_name)}, rank ${l.rank}">`,
      `<rect width="${w}" height="${h}" fill="#0c111b"/>`];
    if (rows) rows.forEach((r, y) => [...r].forEach((c, x) => {
      if (c !== ".") out.push(`<rect x="${(x - x0) * T}" y="${(y - y0) * T}" width="${T}" height="${T}" fill="#2a3347" stroke="#1a2133"/>`);
    }));
    p.rooms.forEach(([x, y, rw, rh, cat, short, name]) => {
      const c = catOf(cat);
      const label = (short || "").slice(0, rw >= 3 ? 4 : 3);
      out.push(`<g><title>${esc(name)} [${esc(c.label)}] ${rw}x${rh} at ${x}, ${y}</title>` +
        `<rect x="${(x - x0) * T + 1}" y="${(y - y0) * T + 1}" width="${rw * T - 2}" height="${rh * T - 2}" rx="2" fill="${c.color}" stroke="#0c111b"/>` +
        (rw > 1 ? `<text x="${(x - x0 + rw / 2) * T}" y="${(y - y0 + rh / 2) * T + 4}" text-anchor="middle" fill="${inkFor(c.color)}" font-size="10" font-weight="600">${esc(label)}</text>` : "") + "</g>");
    });
    p.armor.forEach(([x, y]) => out.push(`<rect x="${(x - x0) * T + 2}" y="${(y - y0) * T + 2}" width="${T - 4}" height="${T - 4}" fill="#e6b93c"/>`));
    p.vents.forEach(([x, y]) => out.push(`<rect x="${(x - x0) * T + 3}" y="${(y - y0) * T + 3}" width="${T - 6}" height="${T - 6}" fill="#f5f5f5"/>`));
    p.lifts.forEach(([x, a, b]) => out.push(`<rect x="${(x - x0) * T + 3}" y="${(a - y0) * T}" width="${T - 6}" height="${(b - a + 1) * T}" fill="#38c6d9"/>`));
    out.push("</svg>");
    return out.join("");
  }
  // my build: only the hull (room positions are not stored by the optimizer page)
  function drawHull(rows) {
    if (!rows || !rows.length) return "";
    const T = 12, W = Math.max(...rows.map((r) => r.length)), w = W * T, h = rows.length * T;
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Your hull (room positions are not saved)">`, `<rect width="${w}" height="${h}" fill="#0c111b"/>`];
    rows.forEach((r, y) => [...r].forEach((c, x) => { if (c !== ".") out.push(`<rect x="${x * T}" y="${y * T}" width="${T}" height="${T}" fill="${c === "r" ? "#24406b" : "#2a3347"}" stroke="#1a2133"/>`); }));
    out.push("</svg>");
    return out.join("");
  }

  let layouts = [], ships = new Map(), mine = null, edgesPerArmor = 2;
  const sides = { a: null, b: null };

  function myBuild() {
    try {
      const cfg = JSON.parse(localStorage.getItem("shipOptimizerSettings.v1") || "null");
      if (!cfg || !Array.isArray(cfg.rooms) || !cfg.rooms.some((r) => (+r.count || 0) > 0)) return null;
      const rows = String(cfg.hull || "").split("\n").map((r) => r.trim()).filter(Boolean);
      const hit = rows.length ? Hulls.byRows(rows) : [];
      const s = BattleModel.fromBuild(Object.assign({}, cfg, { hullName: hit.length ? hit[0].name : "your hull" }), edgesPerArmor);
      s.hullRows = rows;
      return s;
    } catch (e) { return null; }
  }
  function optionsFor(q) {
    q = q.trim().toLowerCase();
    const list = [];
    if (mine && (!q || "my build optimizer".includes(q) || mine.ship.toLowerCase().includes(q))) list.push(["mine", `My build (optimizer page) - ${mine.ship}`]);
    layouts.forEach((l) => {
      const t = `#${l.rank} ${l.name} - ${l.ship_name}`;
      if (!q || t.toLowerCase().includes(q) || String(l.rank) === q.replace(/^#/, "")) list.push(["r" + l.rank, t]);
    });
    return list;
  }
  function fillSelect(side) {
    const sel = $("pick" + side.toUpperCase()), q = $("find" + side.toUpperCase()).value;
    const keep = sides[side];
    const opts = optionsFor(q);
    if (keep && !opts.some(([v]) => v === keep)) { const s = ships.get(keep) || (keep === "mine" && mine); if (s) opts.unshift([keep, keep === "mine" ? "My build (optimizer page)" : `${s.label} - ${s.ship}`]); }
    sel.replaceChildren(...opts.map(([v, t]) => el("option", { value: v, text: t })));
    if (keep) sel.value = keep;
    $("count" + side.toUpperCase()).textContent = `${opts.length} match${opts.length === 1 ? "" : "es"}`;
  }
  const shipOf = (id) => (id === "mine" ? mine : ships.get(id));

  function bar(pA, nameA, nameB) {
    const a = Math.round(pA * 1000) / 10, b = Math.round((100 - a) * 10) / 10;
    return el("div", { class: "odds" },
      el("div", { class: "oddslabels" }, el("span", { class: "sa" }, el("b", { text: fmt(a, 1) + "%" }), " " + nameA), el("span", { class: "sb" }, nameB + " ", el("b", { text: fmt(b, 1) + "%" }))),
      el("div", { class: "oddsbar", role: "img", "aria-label": `Estimated win chance: ${nameA} ${fmt(a, 1)}%, ${nameB} ${fmt(b, 1)}%` },
        el("span", { class: "fa", style: `width:${a}%` }), el("span", { class: "fb", style: `width:${b}%` })));
  }
  // weapon kind vs the counter that answers it, as simulated: what share of the damage the counter took out
  const KIND = {
    laser: { name: "Lasers & cannons", dmg: "laser and cannon", counter: (S) => `shields (${fmt(S.shieldRegen * S.powerFactor, 1)}/s regen, ${fmt(S.shieldPool)} pool)` },
    missile: { name: "Missiles", dmg: "missile", counter: (S) => `engines (${S.antiMissile} power) and shields` },
    craft: { name: "Hangars (craft)", dmg: "hangar craft", counter: (S) => `anti-air (${S.antiAir} power)` },
    board: { name: "Boarding (teleport)", dmg: "boarding", counter: (S) => [S.antiTele ? `${S.antiTele} interdictor gate${S.antiTele === 1 ? "" : "s"} / repulsor${S.antiTele === 1 ? "" : "s"}` : "",
      S.traps ? `${S.traps} trap${S.traps === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ") || "no gates or traps" },
  };
  function stopShare(rr) { return rr && rr.dmg > 0 ? (rr.stopped + rr.shield) / rr.dmg : null; }
  function verdict(v) { return v == null ? "" : v >= 0.75 ? "hard countered" : v >= 0.5 ? "countered" : v >= 0.25 ? "partly stopped" : "gets through"; }
  // [kind, attacker side 'a'|'b', share stopped] for every weapon kind a side actually uses
  function matchups(A, B, r) {
    const out = [];
    for (const [side, S] of [["a", A], ["b", B]]) for (const k of Object.keys(KIND)) {
      if (!S.weaponPower[k]) continue;
      out.push([k, side, stopShare(r[side].role[k])]);
    }
    return out;
  }
  function matchupTable(A, B, r) {
    const tb = el("tbody");
    matchups(A, B, r).forEach(([k, side, v]) => {
      const S = side === "a" ? A : B, D = side === "a" ? B : A, o = side === "a" ? "B" : "A";
      const rr = r[side].role[k];
      tb.append(el("tr", {},
        el("th", { scope: "row" }, el("span", { class: "tag " + (side === "a" ? "ta" : "tb"), text: side.toUpperCase() }),
          document.createTextNode(` ${KIND[k].name} (${S.weaponPower[k]} power)`), el("small", { text: `vs ${o}'s ${KIND[k].counter(D)}` })),
        el("td", { class: "num", text: pct(v) }),
        el("td", { class: "num", text: rr.dmg > 0 ? fmt(rr.hull / Math.max(1, r.avgTime) * 60) : "-" }),
        el("td", { class: "verdict v" + verdict(v).split(" ")[0], text: verdict(v) })));
    });
    if (!tb.children.length) return el("p", { class: "muted", text: "Neither ship has weapons." });
    return el("table", { class: "cmp mu" }, el("caption", { class: "vh", text: "Weapon matchups" }),
      el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "Weapons vs the enemy's counter" }),
        el("th", { scope: "col", class: "num", text: "Stopped", title: "Share of this weapon's damage shot down, dodged, blocked or soaked by shields" }),
        el("th", { scope: "col", class: "num", text: "Hull dmg/min", title: "What still reaches the enemy hull per minute (after armor)" }),
        el("th", { scope: "col", text: "" }))), tb);
  }
  // rows of the breakdown: [group, label, valueA, valueB, higherIsBetter (null = no judgement), hint]
  function rowsFor(A, B, r) {
    const wp = (s) => s.weaponPower;
    const dpmEff = (dd) => (dd.hull) / Math.max(1, r.avgTime) * 60;
    return [
      ["Offense", "Weapon power (bars)", wp(A).laser + wp(A).missile + wp(A).craft + wp(A).board, wp(B).laser + wp(B).missile + wp(B).craft + wp(B).board, true, "Power drawn by lasers, cannons, missiles, hangars and teleports."],
      ["Offense", "  lasers & cannons / missiles / craft / boarding", `${wp(A).laser} / ${wp(A).missile} / ${wp(A).craft} / ${wp(A).board}`, `${wp(B).laser} / ${wp(B).missile} / ${wp(B).craft} / ${wp(B).board}`, null, ""],
      ["Offense", "Weapon boost (booster rooms)", "+" + fmt((A.boost - 1) * 100) + "%", "+" + fmt((B.boost - 1) * 100) + "%", null, ""],
      ["Offense", "Damage per minute on paper", fmt(A.dpm), fmt(B.dpm), true, "Before shields, armor and interception."],
      ["Offense", "Shots stopped by the enemy (avg per fight)", fmt(r.a.intercepted + r.a.blocked + r.a.missed, 1), fmt(r.b.intercepted + r.b.blocked + r.b.missed, 1), false, "Missiles / craft shot down, boarding blocked, cloak misses."],
      ["Offense", "Hull damage dealt per minute (simulated)", fmt(dpmEff(r.a)), fmt(dpmEff(r.b)), true, "What gets through shields and armor."],
      ["Offense", "Enemy rooms knocked out (avg)", fmt(r.a.knocked, 1), fmt(r.b.knocked, 1), true, ""],
      ["Defense", "Shield pool", fmt(A.shieldPool), fmt(B.shieldPool), true, "Sum of shield rooms' capacity."],
      ["Defense", "Shield regen per second", fmt(A.shieldRegen * A.powerFactor, 1), fmt(B.shieldRegen * B.powerFactor, 1), true, ""],
      ["Defense", "Damage soaked by shields (avg)", fmt(r.b.shield), fmt(r.a.shield), true, ""],
      ["Defense", "Armor tiles", A.armorTiles, B.armorTiles, true, ""],
      ["Defense", "Armor coverage of systems", pct(A.armorCover), pct(B.armorCover), true, "Share of the outline of weapon, shield, reactor and defense rooms that touches armor."],
      ["Defense", "Average damage reduction from armor", pct(A.armorReduction), pct(B.armorReduction), true, ""],
      ["Defense", "Anti-missile power (engines)", A.antiMissile, B.antiMissile, true, ""],
      ["Defense", "Anti-air power", A.antiAir, B.antiAir, true, ""],
      ["Defense", "Interdictor gates / repulsors (stop boarders)", A.antiTele, B.antiTele, true, ""],
      ["Defense", "Traps: security gates etc. (hurt boarders)", A.traps, B.traps, true, ""],
      ["Defense", "Cloak / radar power", `${A.cloak} / ${A.radar}`, `${B.cloak} / ${B.radar}`, null, ""],
      ["Defense", "Hull HP (assumed equal)", BattleModel.constants.HULL_HP, BattleModel.constants.HULL_HP, null, "Not in the game data on this site."],
      ["Power", "Power made / needed at full power", `${A.made} / ${A.need}`, `${B.made} / ${B.need}`, null, ""],
      ["Power", "Power ratio", pct(A.powerRatio), pct(B.powerRatio), true, `Full output at ${pct(BattleModel.constants.POWER_REF)} or more (the top-100 median).`],
      ["Power", "Weapons and shields running at", pct(A.powerFactor), pct(B.powerFactor), true, ""],
      ["Crew", "Crew support rooms (not modelled)", A.crewRooms, B.crewRooms, null, "Androids, med bays, revivers. Crew fights are not simulated."],
    ];
  }
  function breakdown(A, B, r) {
    const tb = el("tbody");
    let group = "";
    rowsFor(A, B, r).forEach(([g, label, va, vb, better, hint]) => {
      if (g !== group) { group = g; tb.append(el("tr", { class: "grp" }, el("th", { colspan: "3", scope: "colgroup", text: g }))); }
      const na = parseFloat(va), nb = parseFloat(vb);
      let ca = "", cb = "";
      if (better != null && isFinite(na) && isFinite(nb) && na !== nb) {
        const aWins = better ? na > nb : na < nb;
        ca = aWins ? "win" : ""; cb = aWins ? "" : "win";
      }
      const th = el("th", { scope: "row", text: label.trim() });
      if (label.startsWith("  ")) th.className = "sub";
      if (hint) th.append(el("small", { text: hint }));
      tb.append(el("tr", {}, th, el("td", { class: "num " + ca, text: String(va) }), el("td", { class: "num " + cb, text: String(vb) })));
    });
    return el("table", { class: "cmp" }, el("caption", { class: "vh", text: "Side-by-side breakdown" }),
      el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "" }), el("th", { scope: "col", class: "num ca", text: "A" }), el("th", { scope: "col", class: "num cb", text: "B" }))), tb);
  }
  // a few plain-language reasons (largest differences first)
  function reasons(A, B, r) {
    const out = [];
    const nA = "A", nB = "B";
    const rel = (x, y) => (x + y > 0 ? (x - y) / Math.max(x, y) : 0);
    const push = (w, text) => out.push([Math.abs(w), text]);
    const dA = r.a.hull / Math.max(1, r.avgTime), dB = r.b.hull / Math.max(1, r.avgTime);
    push(rel(dA, dB) * 1.5, rel(dA, dB) > 0 ? `${nA} gets ${pct(rel(dA, dB))} more damage onto the enemy hull per second.` : `${nB} gets ${pct(-rel(dA, dB))} more damage onto the enemy hull per second.`);
    push(rel(A.dpm, B.dpm), rel(A.dpm, B.dpm) >= 0 ? `${nA} has more firepower on paper (${fmt(A.dpm)} vs ${fmt(B.dpm)} per minute).` : `${nB} has more firepower on paper (${fmt(B.dpm)} vs ${fmt(A.dpm)} per minute).`);
    push(rel(A.shieldPool + 60 * A.shieldRegen, B.shieldPool + 60 * B.shieldRegen), A.shieldPool + 60 * A.shieldRegen >= B.shieldPool + 60 * B.shieldRegen ? `${nA} has stronger shields.` : `${nB} has stronger shields.`);
    push(rel(A.armorReduction, B.armorReduction), A.armorReduction >= B.armorReduction ? `${nA}'s systems are better armored (${pct(A.armorCover)} vs ${pct(B.armorCover)} of their outline).` : `${nB}'s systems are better armored (${pct(B.armorCover)} vs ${pct(A.armorCover)} of their outline).`);
    push(rel(A.powerFactor, B.powerFactor), A.powerFactor >= B.powerFactor ? `${nB} is short of power (${pct(B.powerRatio)} of full power made).` : `${nA} is short of power (${pct(A.powerRatio)} of full power made).`);
    const iA = r.b.intercepted + r.b.blocked, iB = r.a.intercepted + r.a.blocked;
    push(rel(iA, iB) * 0.8, iA >= iB ? `${nA}'s anti-missile, anti-air and gates stop more incoming shots (${fmt(iA, 1)} vs ${fmt(iB, 1)} per fight).` : `${nB}'s anti-missile, anti-air and gates stop more incoming shots (${fmt(iB, 1)} vs ${fmt(iA, 1)} per fight).`);
    // the matchups that decide the most damage: a weapon kind that is a big share of a side's firepower and gets countered
    matchups(A, B, r).forEach(([k, side, v]) => {
      const S = side === "a" ? A : B, D = side === "a" ? B : A, me = side === "a" ? nA : nB, o = side === "a" ? nB : nA;
      const tot = S.weaponPower.laser + S.weaponPower.missile + S.weaponPower.craft + S.weaponPower.board;
      const weight = (S.weaponPower[k] / Math.max(1, tot)) * (v >= 0.5 ? v : v < 0.25 ? 0.7 - v : 0) * 1.4;
      if (v >= 0.5) push(weight, `${o}'s ${KIND[k].counter(D)} stop ${pct(v)} of ${me}'s ${KIND[k].dmg} damage (${verdict(v)}).`);
      else if (v < 0.25) push(weight, `${me}'s ${KIND[k].dmg} damage gets through: ${o}'s ${KIND[k].counter(D)} stop only ${pct(v)}.`);
    });
    return out.filter(([w]) => w > 0.05).sort((x, y) => y[0] - x[0]).slice(0, 5).map(([, t]) => t);
  }
  function card(side, s) {
    const box = $("ship" + side.toUpperCase());
    const l = s.rank != null ? layouts.find((x) => x.rank === s.rank) : null;
    const title = s.rank != null ? `#${s.rank} ${l.name}` : "My build";
    const sub = s.rank != null ? `${l.ship_name}${l.trophies != null ? ` - ${l.trophies} trophies` : ""}` : `${s.ship} - room list from the optimizer page`;
    box.replaceChildren(el("h3", {}, el("span", { class: "tag " + (side === "a" ? "ta" : "tb"), text: side.toUpperCase() }), document.createTextNode(" " + title)),
      el("p", { class: "muted", text: sub + `. ${s.rooms.length} rooms, ${s.armorTiles} armor tiles.` }));
    const draw = el("div", { class: "layoutbox" });
    draw.innerHTML = l ? drawTop(l) : drawHull(s.hullRows);
    box.append(draw);
    if (!l) box.append(el("p", { class: "muted", text: "Room positions are not saved by the optimizer page, so armor is assumed to be spread evenly over your combat rooms." + (s.unknown ? ` ${s.unknown} room(s) not found in the game data use the typical top-100 room of their type.` : "") }));
  }
  let timer = null;
  function run() {
    const A = shipOf(sides.a), B = shipOf(sides.b);
    if (!A || !B) return;
    card("a", A); card("b", B);
    $("result").setAttribute("aria-busy", "true");
    $("verdict").textContent = "Simulating...";
    clearTimeout(timer);
    timer = setTimeout(() => {
      const t0 = performance.now();
      const r = BattleModel.duel(A, B);
      const nameA = "A: " + (A.rank != null ? "#" + A.rank : "My build"), nameB = "B: " + (B.rank != null ? "#" + B.rank : "My build");
      $("odds").replaceChildren(bar(r.pA, nameA, nameB));
      const same = sides.a === sides.b;
      const fav = Math.abs(r.pA - 0.5) < 0.05 ? "About even." : (r.pA > 0.5 ? "A" : "B") + " is favoured.";
      $("verdict").textContent = `${fav} ${fmt(r.n)} simulated fights, ${fmt(r.avgTime)} s on average` +
        (r.timeouts > 0.01 ? `, ${pct(r.timeouts)} went the full ${BattleModel.constants.MAX_TIME} s (decided on hull left)` : "") +
        (same ? ". Same ship on both sides: should be close to 50%." : ".") + ` (${fmt(performance.now() - t0)} ms)`;
      $("why").replaceChildren(...reasons(A, B, r).map((t) => el("li", { text: t })));
      $("matchups").replaceChildren(matchupTable(A, B, r));
      $("breakdown").replaceChildren(breakdown(A, B, r));
      $("result").setAttribute("aria-busy", "false");
      try { history.replaceState(null, "", `?a=${encodeURIComponent(sides.a)}&b=${encodeURIComponent(sides.b)}`); } catch (e) { /* file:// */ }
    }, 20);
  }
  function wire(side) {
    const S = side.toUpperCase();
    $("find" + S).addEventListener("input", () => {
      fillSelect(side);
      const sel = $("pick" + S);
      if (sel.value && sel.value !== sides[side]) { sides[side] = sel.value; run(); }
    });
    $("pick" + S).addEventListener("change", (e) => { sides[side] = e.target.value; run(); });
  }

  Promise.all([Top100.load(), Hulls.load(false).catch(() => null), fetch("data/rooms.json").then((r) => r.json())]).then(([top, , roomsJson]) => {
    layouts = top.layouts.slice().sort((a, b) => a.rank - b.rank);
    if (!layouts.length) { $("loadMsg").textContent = "No top-100 data yet."; return; }
    BattleModel.setup(roomsJson, top.analysis);
    BattleModel.learnCategories(layouts, GameRooms.catOf);
    layouts.forEach((l) => { const s = BattleModel.fromTop(l); ships.set(s.id, s); });
    edgesPerArmor = BattleModel.measureArmor([...ships.values()]);
    mine = myBuild();
    const q = new URLSearchParams(location.search);
    const valid = (v) => v && (v === "mine" ? !!mine : ships.has(v));
    sides.a = valid(q.get("a")) ? q.get("a") : "r1";
    sides.b = valid(q.get("b")) ? q.get("b") : (mine ? "mine" : "r" + layouts[Math.min(9, layouts.length - 1)].rank);
    fillSelect("a"); fillSelect("b");
    wire("a"); wire("b");
    $("swap").onclick = () => { [sides.a, sides.b] = [sides.b, sides.a]; $("findA").value = $("findB").value = ""; fillSelect("a"); fillSelect("b"); run(); };
    $("mirror").onclick = () => { sides.b = sides.a; $("findB").value = ""; fillSelect("b"); run(); };
    $("loadMsg").hidden = true;
    $("app").hidden = false;
    $("mineNote").textContent = mine ? "\"My build\" uses the room list and armor count saved by the optimizer page in this browser."
      : "Tip: build a room list on the optimizer page and it shows up here as \"My build\".";
    run();
  }).catch((e) => {
    console.error(e);
    $("loadMsg").classList.add("error");
    $("loadMsg").textContent = "Could not load the data: " + (e && e.message ? e.message : e);
  });
})();
