"use strict";
// Ship vs ship page: a MOCK win-rate estimate between two ship layouts.
// This is NOT the game's battle engine. It is a small, transparent Monte Carlo model built from the room designs the
// site has (data/rooms.json: the official game API's room, weapon and craft designs), the layouts' room levels, counts
// and armor placement, and power made vs used. Crew, AI scripts, targeting, research, equipment, crew repairs and
// the ammo players load are not modelled. README "Ship vs ship" lists what is real data and what is assumed.
//
// The model part (BattleModel) has no DOM dependencies, so tools can run it in Node:
//   const BM = require("./js/battle.js"); BM.setup(roomsJson, analysisJson); BM.duel(BM.fromTop(layout), ...)

// ---------------------------------------------------------------- constants (all in one place)
// [data]    read per room from data/rooms.json, which comes from the game API (see tools/build_room_list.py)
// [source]  a game mechanic or number from a named source (see README "Ship vs ship")
// [assumed] NOT from any source: a stand-in so the model can run. Change these freely; they are why this is a mock.
const BATTLE_CONSTANTS = {
  SIMS: 2000,                 // simulated fights per match-up
  MAX_TIME: 180,              // [assumed] seconds per fight; then the ship with more hull left wins (equal = draw)
  DT: 0.25,                   // simulation step, seconds
  SHIP_LEVEL: 14,             // rooms are taken at the best level this ship level can build (all top-100 ships are level 14)
  TICKS: 40,                  // [source] game ticks per second (YaDc: ReloadTime / 40 = seconds); rooms.json stores seconds
  HULL_HP: 35,                // [assumed] the same for every ship. Real hull HP is per ship design (ShipDesign Hp), but the
                              // newest design list we could read (2024) stops at level 12, where Titans have 34-35 HP;
                              // level-13/14 hulls (every top-100 ship) are not in it.
  ROOM_HP_PER_TILE: 1,        // [assumed] room HP per tile it covers (room HP is not in the room designs). No crew repairs.
  // weapons ---------------------------------------------------------------------------------------------------------
  // Per room [data]: reload, cooldown, volley, volley delay, per-projectile shield / hull / system / AP damage, EMP and
  // fire length. Launchers and hangars fire the ammo the player loads (not in the room design), so they use these
  // [assumed] default items, with their real stats from the game's missile / craft design lists:
  AMMO: { missile: "Rocket Level 7", cannon: "Ion Beam 6", craft: "Interceptor Lv9", decoy: "Decoy Drone", kamikaze: "Big Flying Bombshell" },
  BOARD_DMG: 2,               // [assumed] system damage a boarding party does when it lands (crew fights are not modelled)
  BOOST_PER_ROOM: 0.05,       // [assumed] weapon damage +5% per booster room (Gunnery Core, Missile Matrix ...), at most +20%
  BOOST_MAX: 0.2,
  POWER_REF: 0.5,             // [assumed] power made / needed at which rooms charge at full speed. Replaced at load by the
                              // top-100 median (top_analysis.json recommend.power_ratio): the top ships never power everything.
  // defenses --------------------------------------------------------------------------------------------------------
  // Shields [data]: pool = sum of shield rooms' Capacity, each room restores its "restore" points every reload.
  // [source] lasers, cannon beams and craft shots hit the shield while it is up (they take ShieldDamage off it);
  // missiles (Rocket type) bypass shields (wiki "Like all Missiles ... bypasses shields", via PSS-BattleStats).
  // Armor [source formula, assumed adjacency]: room defence D = its own DefaultDefenceBonus [data] + armor Capacity [data]
  // x share of the room's outline touching armor x ARMOR_SCALE; damage reduction = D / (100 + D) (YaDc "innate armor").
  // AP (DirectSystemDamage) ignores armor and does not reach the hull from a destroyed room [source: wiki via PSS-BattleStats].
  ARMOR_SCALE: 1.0,           // [assumed] how much of an armor block's value a touching room gets
  // Engines [data + source]: each engine's Capacity is its dodge modifier (YaDc "Dodge modifier"). The ship's evasion
  // pool is the sum (x power), refilled every second by the room type's evasion regeneration (official patch notes
  // v0.999.60: Engine 4%, Ship Thrusters 3%). [assumed] how the pool is spent:
  EVASION_REGEN: { "ship thrusters": 0.03, default: 0.04 },
  DODGE_COST: 10,             // [assumed] evasion points one dodged missile uses up
  DODGE_HIT: 0.9,             // [assumed] chance to dodge while the pool has enough points (never a perfect wall)
  // Anti-craft [data]: anti-craft rooms shoot enemy craft (their reload, volley and SystemDamage against the craft's Hp);
  // decoys first [source: patch notes v0.999.60 "AntiCraft Rooms now prioritize Decoy Crafts"].
  CRAFT_PER_HANGAR: 1,        // [assumed] craft a hangar keeps out at a time; a lost craft is replaced after the hangar's reload
  // Boarding: Teleport rooms land a party every reload [data]. Teleport Interdictor Gates / Repulsors stop it:
  GATE_RELOAD: 8,             // [source for Teleport Repulsor, patch notes v0.999.60; assumed for Interdictor Gates] seconds
                              // a gate needs before it can stop the next landing
  GATE_HIT: 0.9,              // [assumed] chance a ready gate stops a landing
  TRAP_PER_DMG: 0.02,         // [assumed] traps' crew damage [data: Trap Capacity] per landing cuts the boarders' damage to
                              // 1 / (1 + this x total trap damage)
  // Cloak [data]: a Cloak Generator hides the ship for Capacity ticks every reload + cooldown; [assumed] the enemy holds
  // fire while it is hidden, and an enemy Radar ends the cloak each time it fires (every Radar reload).
  FIGHT_LUCK: 0.25,           // [assumed] each side's damage is scaled by a random 1 +- this per fight: stands in for crew,
                              // AI, research and equipment, none of which are modelled
};

const BattleModel = (() => {
  const C = BATTLE_CONSTANTS;
  let catalogue = new Map();    // lower-case room family name -> design used at SHIP_LEVEL (see setup)
  let catMedian = {};           // page category -> typical design (for "my build" rooms the game data does not know)
  let ammo = { missiles: {}, crafts: {} };
  let typeFallback = {};        // room type -> combat stats of a typical real design of that type
  const COMBAT = ["reload", "cooldown", "defBonus", "restore", "shot", "craft"];

  const base = (n) => String(n || "").replace(/\s+Lv\s*\d+$/i, "").trim().toLowerCase().replace(/\s+/g, " ");
  const vol = (s) => (s && s.v) || 1;
  const hitDmg = (s) => (s ? (s.sy || 0) + (s.ap || 0) + (s.hu || 0) : 0);     // room + hull damage per projectile
  function setup(roomsJson, analysisJson) {
    catalogue = new Map();
    const fam = new Map();      // family -> designs (all levels), to borrow combat stats from an older level
    for (const r of (roomsJson && roomsJson.rooms) || []) {
      if (/^destroyed\b/i.test(r.name)) continue;
      const k = base(r.name);
      (fam.get(k) || fam.set(k, []).get(k)).push(r);
    }
    for (const [k, ds] of fam) {
      const ok = ds.filter((r) => r.minShip == null || r.minShip <= C.SHIP_LEVEL);
      if (!ok.length) continue;
      const lv = (r) => (r.levels || [0, 0])[1];
      const r = ok.reduce((a, b) => (lv(b) > lv(a) ? b : a));
      const d = { type: r.type, category: r.category || "", power: r.power || 0, powerGen: r.powerGen || 0,
        capacity: r.capacity || 0, w: r.w, h: r.h, level: lv(r), name: k, combatFrom: null };
      // combat stats: this level's, else the highest level of the family that has them (older API data may stop
      // below the newest levels), else the type's typical design (filled in below)
      const src = COMBAT.some((c) => c in r) ? r : ds.filter((x) => COMBAT.some((c) => c in x)).sort((a, b) => lv(b) - lv(a))[0];
      if (src) { COMBAT.forEach((c) => { if (c in src) d[c] = src[c]; }); d.combatFrom = src === r ? "data" : "older level"; }
      catalogue.set(k, d);
    }
    ammo = (roomsJson && roomsJson.ammo) || { missiles: {}, crafts: {} };
    // typical real design per room type (median damage per power per second), for designs with no combat stats
    typeFallback = {};
    const byType = {};
    for (const d of catalogue.values()) if (d.combatFrom && d.power > 0) (byType[d.type] = byType[d.type] || []).push(d);
    for (const [t, ds] of Object.entries(byType)) {
      const score = (d) => (d.shot ? hitDmg(d.shot) * vol(d.shot) + (d.shot.sh || 0) : d.restore || 0) / Math.max(0.5, cycleOf(d)) / d.power;
      const s = ds.slice().sort((a, b) => score(a) - score(b))[Math.floor(ds.length / 2)];
      typeFallback[t] = Object.fromEntries(COMBAT.filter((c) => c in s).map((c) => [c, s[c]]));
      typeFallback[t].from = s.name;
    }
    for (const d of catalogue.values()) {
      if (d.combatFrom || !typeFallback[d.type]) continue;
      const f = typeFallback[d.type];
      COMBAT.forEach((c) => { if (c in f && !(c in d)) d[c] = f[c]; });
      d.combatFrom = "like " + f.from;
    }
    const pr = analysisJson && analysisJson.recommend && analysisJson.recommend.power_ratio;
    if (Array.isArray(pr) && pr[1] > 0) C.POWER_REF = pr[1];
  }
  const cycleOf = (d) => (d.reload || 0) + (d.cooldown || 0) + (d.shot ? (vol(d.shot) - 1) * (d.shot.vd || 0) : 0);
  function design(name, type) {
    const d = catalogue.get(base(name));
    if (d) return d;
    if (/^(armor|wall)$/i.test(type)) return catalogue.get("armor") || { type: "Wall", capacity: 0 };
    return null;
  }

  // what a room does in the model
  function roleOf(type, d) {
    switch (type) {
      case "Laser": return "laser";
      case "Cannon": return "laser";            // beams: shielded, not dodged, like lasers
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

  // the projectile a weapon room fires and the craft a hangar launches (built in, else the assumed default ammo)
  function weaponOf(role, name, d) {
    const n = base(name);
    if (role === "laser" || role === "missile") {
      if (d && d.shot) return { shot: d.shot, ammo: null };
      const a = role === "missile" ? C.AMMO.missile : C.AMMO.cannon;
      const s = ammo.missiles[a];
      return s ? { shot: s, ammo: a } : { shot: null, ammo: null };
    }
    if (role === "craft") {
      if (d && d.craft) return { craft: d.craft, ammo: null };
      const a = /decoy/.test(n) ? C.AMMO.decoy : /flying rocket|nuke/.test(n) ? C.AMMO.kamikaze : C.AMMO.craft;
      return { craft: ammo.crafts[a] || null, ammo: ammo.crafts[a] ? a : null };
    }
    return {};
  }
  function mkRoom(name, type, x, y, w, h) {
    const d = design(name, type);
    const role = roleOf(type, d);
    const wpn = weaponOf(role, name, d);
    const aa = role === "antiair" && !(d && d.shot) ? typeFallback.AntiCraft : null;   // e.g. Defense Hangar: like a typical anti-craft room
    const r = { name, type, role, x, y, w, h, power: d ? d.power : 0, gen: d ? d.powerGen : 0,
      cap: d ? d.capacity : 0, level: d ? d.level : null, known: !!d, cover: 0, armorPct: 0,
      reload: aa ? aa.reload || 0 : d && d.reload || 0, cooldown: aa ? aa.cooldown || 0 : d && d.cooldown || 0, defBonus: d && d.defBonus || 0, restore: d && d.restore || 0,
      shot: aa ? aa.shot : role === "antiair" ? d.shot : wpn.shot || null, craft: wpn.craft || null, ammo: wpn.ammo || null,
      combatFrom: aa ? "like " + aa.from : d ? d.combatFrom : null,
      evRegen: C.EVASION_REGEN[base(name)] != null ? C.EVASION_REGEN[base(name)] : C.EVASION_REGEN.default };
    return r;
  }
  // fraction of each room's outline that touches armor, and the armor value it gets
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
        let m = mkRoom(r.name, type, 0, 0, +r.w || 2, +r.h || 2);
        if (!d && catMedian[r.cat]) { const t = catMedian[r.cat]; m = mkRoom(t.name, t.type, 0, 0, +r.w || 2, +r.h || 2); m.name = r.name; m.known = false; }
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
  // typical room per page category, from the top-100 ships (the most used room family of that category)
  function learnCategories(layouts, catOfFn) {
    const by = {};
    layouts.forEach((l) => l.rooms.forEach(([, , , , type, , name]) => {
      const d = design(name, type);
      if (!d) return;
      const c = catOfFn(type, name), m = (by[c] = by[c] || new Map());
      m.set(d.name, (m.get(d.name) || 0) + 1);
    }));
    catMedian = {};
    for (const [c, m] of Object.entries(by)) {
      const top = [...m].sort((x, y) => y[1] - x[1])[0][0], d = catalogue.get(top);
      catMedian[c] = { name: top, type: d.type };
    }
  }
  // average room edges touched per armor tile in the top 100 (for "my build", whose armor has no positions)
  function measureArmor(ships) {
    let edges = 0, tiles = 0;
    ships.forEach((s) => { tiles += s.armorTiles; s.rooms.forEach((r) => { edges += r.cover * 2 * (r.w + r.h); }); });
    return tiles ? edges / tiles : 2;
  }

  // ---------------------------------------------------------------- static numbers for the breakdown
  const cycle = (r) => Math.max(0.25, r.reload + r.cooldown + (r.shot ? (vol(r.shot) - 1) * (r.shot.vd || 0) : 0));
  const craftCycle = (c) => Math.max(0.25, (c.reload || 0) + (vol(c.shot) - 1) * ((c.shot && c.shot.vd) || 0) + (c.vd || 0) * ((c.v || 1) - 1));
  // damage per second of a weapon room at full power (before boosts, shields, armor, dodge)
  function dps(r) {
    if (r.role === "laser" || r.role === "missile") return r.shot ? hitDmg(r.shot) * vol(r.shot) / cycle(r) : 0;
    if (r.role === "craft") return r.craft && r.craft.shot ? hitDmg(r.craft.shot) * vol(r.craft.shot) * (r.craft.v || 1) / craftCycle(r.craft) * C.CRAFT_PER_HANGAR : 0;
    if (r.role === "board") return r.reload ? C.BOARD_DMG / cycle(r) : 0;
    return 0;
  }
  function finish(s) {
    const sum = (role, f) => s.rooms.filter((r) => r.role === role).reduce((t, r) => t + f(r), 0);
    const count = (role) => s.rooms.filter((r) => r.role === role).length;
    s.made = sum("reactor", (r) => r.gen);
    s.need = s.rooms.reduce((t, r) => t + (r.role === "reactor" ? 0 : r.power), 0);
    s.powerRatio = s.need ? s.made / s.need : 1;
    s.powerFactor = Math.min(1, s.powerRatio / C.POWER_REF);
    s.boost = 1 + Math.min(C.BOOST_MAX, count("booster") * C.BOOST_PER_ROOM);
    s.weaponPower = { laser: sum("laser", (r) => r.power), missile: sum("missile", (r) => r.power), craft: sum("craft", (r) => r.power), board: sum("board", (r) => r.power) };
    s.weaponDps = { laser: sum("laser", dps), missile: sum("missile", dps), craft: sum("craft", dps), board: sum("board", dps) };
    s.shieldPool = sum("shield", (r) => r.cap);
    s.shieldRegen = sum("shield", (r) => (r.reload ? r.restore / r.reload : 0));     // points per second at full power
    s.antiMissile = sum("antimissile", (r) => r.cap);                                 // evasion pool (dodge modifiers)
    s.evasionRegen = sum("antimissile", (r) => r.cap * r.evRegen);                    // evasion points per second
    s.antiAirPower = sum("antiair", (r) => r.power);
    s.antiAir = sum("antiair", (r) => (r.shot ? (r.shot.sy || 0) * vol(r.shot) / cycle(r) : 0));   // craft HP shot per second
    s.antiTele = count("antitele");
    s.traps = count("trap");
    s.trapDmg = sum("trap", (r) => r.cap);
    s.cloak = sum("cloak", (r) => r.power);
    s.cloakTime = sum("cloak", (r) => r.cap / C.TICKS);
    s.radar = sum("radar", (r) => r.power);
    s.crewRooms = count("crew");
    s.hullHp = C.HULL_HP;
    const core = s.rooms.filter((r) => r.role !== "other" && r.role !== "crew" && r.role !== "trap");
    s.armorCover = core.length ? core.reduce((t, r) => t + r.cover, 0) / core.length : 0;
    s.armorReduction = core.length ? core.reduce((t, r) => t + reduction(r), 0) / core.length : 0;
    s.unknown = s.rooms.filter((r) => !r.known).length;
    s.estimated = s.rooms.filter((r) => WEAPON_ROLES.has(r.role) || r.role === "shield" || r.role === "antiair")
      .filter((r) => !r.combatFrom || r.combatFrom !== "data" || r.ammo).length;
    s.dpm = (s.weaponDps.laser + s.weaponDps.missile + s.weaponDps.craft + s.weaponDps.board) * 60 * s.boost * s.powerFactor;
    return s;
  }
  // damage reduction of a room: D / (100 + D), D = own defence bonus + armor value x share of outline touching armor
  const reduction = (r) => { const D = r.defBonus + r.armorPct * r.cover * C.ARMOR_SCALE; return D > 0 ? D / (100 + D) : 0; };

  // ---------------------------------------------------------------- the duel
  function rng(seed) {   // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function state(s, R) {
    const rooms = s.rooms.map((r) => ({ r, hp: C.ROOM_HP_PER_TILE * r.w * r.h, red: reduction(r), emp: 0, fire: 0,
      next: R() * cycle(r), craftHp: 0, craftNext: 0 }));    // random first activation
    const role = () => ({ dmg: 0, stopped: 0, shield: 0, armor: 0, hull: 0 });
    const by = (f) => rooms.filter((x) => f(x.r));
    return { s, rooms, hull: C.HULL_HP, shield: s.shieldPool, evasion: s.antiMissile * s.powerFactor,
      luck: 1 + (R() * 2 - 1) * C.FIGHT_LUCK, cloakUntil: -1, gateReady: [], snap: null,
      weapons: by((r) => WEAPON_ROLES.has(r.role) && r.reload > 0 && (r.shot || r.craft || r.role === "board")),
      shields: by((r) => r.role === "shield"), engines: by((r) => r.role === "antimissile"),
      antiair: by((r) => r.role === "antiair" && r.shot && r.reload > 0), gates: by((r) => r.role === "antitele"),
      traps: by((r) => r.role === "trap"), cloaks: by((r) => r.role === "cloak"), radars: by((r) => r.role === "radar"),
      stats: { fired: 0, intercepted: 0, blocked: 0, missed: 0, shield: 0, hull: 0, armor: 0, knocked: 0,
        role: { laser: role(), missile: role(), craft: role(), board: role() } } };
  }
  const up = (x, t) => x.hp > 0 && x.emp <= t;    // room works (not destroyed, not EMP'd)
  function powerFactor(st) {     // cached until a room is knocked out
    if (st.snap != null) return st.snap;
    let made = 0, need = 0;
    for (const x of st.rooms) if (x.hp > 0) { if (x.r.role === "reactor") made += x.r.gen; else need += x.r.power; }
    return (st.snap = need ? Math.min(1, made / need / C.POWER_REF) : 1);
  }
  // one projectile lands on `def`: shields, then a random room (dead rooms pass system damage to the hull), armor
  function land(att, def, shot, role, mult, R, t, shieldable) {
    const rs = att.stats.role[role];
    if (shieldable && def.shield > 0 && shot.t !== "Rocket") {
      const sh = Math.min(def.shield, (shot.sh || 0) * mult);
      def.shield = Math.max(0, def.shield - (shot.sh || 0) * mult);
      const absorbed = hitDmg(shot) * mult;
      att.stats.shield += absorbed; rs.shield += absorbed;
      return sh;
    }
    const x = def.rooms[Math.floor(R() * def.rooms.length)];
    const sy = (shot.sy || 0) * mult, ap = (shot.ap || 0) * mult, hu = (shot.hu || 0) * mult;
    const after = sy * (1 - x.red);
    const toRoom = after + (x.hp > 0 ? ap : 0);
    const hull = toRoom + hu;
    att.stats.armor += sy - after; rs.armor += sy - after;
    att.stats.hull += hull; rs.hull += hull;
    def.hull -= hull;
    if (x.hp > 0) {
      x.hp -= toRoom;
      if (shot.emp) x.emp = Math.max(x.emp, t + shot.emp);
      if (shot.fire) x.fire = Math.max(x.fire, shot.fire * C.TICKS);
      if (x.hp <= 0) { att.stats.knocked++; def.snap = null; }
    }
    return 0;
  }
  // weapon rooms of `att` that are ready fire at `def`
  function fire(att, def, t, R) {
    const pf = powerFactor(att), mult = att.s.boost * att.luck;
    const hidden = def.cloakUntil > t;
    for (const w of att.weapons) {
      const r = w.r;
      if (!up(w, t)) continue;
      if (r.role === "craft") { fireCraft(att, def, w, t, R, mult, pf); continue; }
      if (w.next > t) continue;
      w.next = t + (r.reload / pf) + r.cooldown + (r.shot ? (vol(r.shot) - 1) * (r.shot.vd || 0) : 0);
      const rs = att.stats.role[r.role];
      if (r.role === "board") {
        const dmg = C.BOARD_DMG * mult;
        att.stats.fired++; rs.dmg += dmg;
        if (hidden) { att.stats.missed++; rs.stopped += dmg; continue; }
        // a ready gate stops the landing
        const g = def.gates.find((x) => up(x, t) && !(x.ready > t));
        if (g) { g.ready = t + C.GATE_RELOAD; if (R() < C.GATE_HIT) { att.stats.blocked++; rs.stopped += dmg; continue; } }
        let trap = 0;
        for (const x of def.traps) if (up(x, t)) trap += x.r.cap;
        const cut = dmg - dmg / (1 + C.TRAP_PER_DMG * trap);
        rs.stopped += cut;
        land(att, def, { ap: (dmg - cut) / mult }, "board", mult, R, t, false);   // [assumed] boarders walk past shields and armor
        continue;
      }
      for (let i = 0; i < vol(r.shot); i++) {
        const dmg = hitDmg(r.shot) * mult;
        att.stats.fired++; rs.dmg += dmg;
        if (hidden) { att.stats.missed++; rs.stopped += dmg; continue; }
        if (r.shot.t === "Rocket" && !r.shot.beam && dodge(def, t, R)) { att.stats.intercepted++; rs.stopped += dmg; continue; }
        land(att, def, r.shot, r.role, mult, R, t, true);
      }
    }
  }
  // hangars: one craft out at a time; it attacks on its own reload until anti-craft shoots it down
  function fireCraft(att, def, w, t, R, mult, pf) {
    const c = w.r.craft, rs = att.stats.role.craft;
    if (!c) return;
    if (w.craftHp <= 0 && w.next <= t) {          // launch (after the hangar's reload)
      w.craftHp = c.hp || 1; w.craftNext = t + R() * craftCycle(c); w.next = Infinity;
    }
    if (w.craftNext > t || (w.craftHp <= 0 && !w.downed)) return;
    w.craftNext = t + craftCycle(c);
    const shots = (c.v || 1) * vol(c.shot);
    const dmg = hitDmg(c.shot) * mult;
    if (w.craftHp <= 0) { rs.dmg += dmg * shots; rs.stopped += dmg * shots; return; }   // shot down by anti-craft: attacks lost until relaunch
    for (let i = 0; i < shots; i++) {
      att.stats.fired++; rs.dmg += dmg;
      if (def.cloakUntil > t) { att.stats.missed++; rs.stopped += dmg; continue; }
      if (c.shot) land(att, def, c.shot, "craft", mult, R, t, true);
    }
    if (c.attack === "Kamikaze") { w.craftHp = 0; w.next = t + w.r.reload / pf + w.r.cooldown; }
  }
  function dodge(def, t, R) {
    if (def.evasion <= 0) return false;
    const chance = C.DODGE_HIT * Math.min(1, def.evasion / C.DODGE_COST);
    def.evasion = Math.max(0, def.evasion - C.DODGE_COST);
    return R() < chance;
  }
  // defenses of `st` against `en` for one step: shields restore, evasion refills, anti-craft fires, cloak / radar
  function defend(st, en, t, R) {
    const pf = powerFactor(st), dt = C.DT;
    let shieldMax = 0, evMax = 0, evRegen = 0;
    for (const x of st.shields) if (x.hp > 0) {
      shieldMax += x.r.cap;
      if (up(x, t) && x.r.reload) {
        if (x.next <= t) { st.shield += x.r.restore; x.next = t + x.r.reload / pf; }
      }
    }
    st.shield = Math.min(st.shield, shieldMax);
    for (const x of st.engines) if (up(x, t)) { evMax += x.r.cap * pf; evRegen += x.r.cap * x.r.evRegen * pf; }
    st.evasion = Math.min(evMax, st.evasion + evRegen * dt);
    // anti-craft: decoys first, then any craft
    for (const x of st.antiair) {
      if (!up(x, t) || x.next > t) continue;
      const targets = en.weapons.filter((w) => w.r.role === "craft" && w.craftHp > 0);
      if (!targets.length) continue;
      x.next = t + x.r.reload / pf + x.r.cooldown + (vol(x.r.shot) - 1) * (x.r.shot.vd || 0);
      for (let i = 0; i < vol(x.r.shot); i++) {
        const live = targets.filter((w) => w.craftHp > 0);
        if (!live.length) break;
        const decoys = live.filter((w) => !hitDmg(w.r.craft.shot));
        const w = (decoys.length ? decoys : live)[Math.floor(R() * (decoys.length || live.length))];
        w.craftHp -= x.r.shot.sy || 0;
        if (w.craftHp <= 0) { en.stats.intercepted++; w.downed = true; w.next = t + w.r.reload / powerFactor(en) + w.r.cooldown; }
      }
    }
    // fire burns: AP = remaining ticks / 500 each second, the fire shrinking by a second each time [source: wiki via PSS-BattleStats]
    if (Math.abs(t - Math.round(t)) < 1e-9) for (const x of st.rooms) if (x.fire > 0) {
      const ap = x.hp > 0 ? x.fire / 500 : 0;
      x.fire = Math.max(0, x.fire - C.TICKS);
      if (ap) { x.hp -= ap; st.hull -= ap; en.stats.hull += ap; if (x.hp <= 0) { en.stats.knocked++; st.snap = null; } }
    }
    // cloak: hide for Capacity ticks every reload + cooldown; enemy radar ends it each time the radar fires
    for (const x of st.cloaks) if (up(x, t) && x.next <= t && st.cloakUntil <= t) {
      st.cloakUntil = t + x.r.cap / C.TICKS;
      x.next = t + x.r.reload / pf + x.r.cooldown + x.r.cap / C.TICKS;
    }
    for (const x of en.radars) if (up(x, t) && x.next <= t) { x.next = t + Math.max(1, x.r.reload) / powerFactor(en); if (st.cloakUntil > t) st.cloakUntil = t; }
  }
  function fight(a, b, R) {
    const A = state(a, R), B = state(b, R);
    let t = 0;
    for (; t < C.MAX_TIME; t += C.DT) {
      defend(A, B, t, R); defend(B, A, t, R);
      // both sides fire against the state at the start of the step (random order: neither side always shoots first)
      if (R() < 0.5) { fire(A, B, t, R); fire(B, A, t, R); } else { fire(B, A, t, R); fire(A, B, t, R); }
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
  return { setup, fromTop, fromBuild, learnCategories, measureArmor, duel, reduction, dps, get constants() { return C; },
    get catalogue() { return catalogue; } };
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
    // raised-block edges for a room (pixel look): light top/left, dark bottom/right
    const bevel = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="2" fill="#fff" fill-opacity=".28"/><rect x="${x}" y="${y}" width="2" height="${h}" fill="#fff" fill-opacity=".15"/>` +
      `<rect x="${x}" y="${y + h - 2}" width="${w}" height="2" fill="#000" fill-opacity=".35"/><rect x="${x + w - 2}" y="${y}" width="2" height="${h}" fill="#000" fill-opacity=".25"/>`;
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
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="'IBM Plex Sans',system-ui,sans-serif" shape-rendering="crispEdges" role="img" aria-label="Layout of ${esc(l.ship_name)}, rank ${l.rank}">`,
      `<rect width="${w}" height="${h}" fill="#060912"/>`];
    if (rows) rows.forEach((r, y) => [...r].forEach((c, x) => {
      if (c !== ".") out.push(`<rect x="${(x - x0) * T}" y="${(y - y0) * T}" width="${T}" height="${T}" fill="#2a3560" stroke="#10172b"/>`);
    }));
    p.rooms.forEach(([x, y, rw, rh, cat, short, name]) => {
      const c = catOf(cat);
      const label = (short || "").slice(0, rw >= 3 ? 4 : 3);
      out.push(`<g><title>${esc(name)} [${esc(c.label)}] ${rw}x${rh} at ${x}, ${y}</title>` +
        `<rect x="${(x - x0) * T + 1}" y="${(y - y0) * T + 1}" width="${rw * T - 2}" height="${rh * T - 2}" fill="${c.color}" stroke="#060912"/>` + bevel((x - x0) * T + 1, (y - y0) * T + 1, rw * T - 2, rh * T - 2) +
        (rw > 1 ? `<text x="${(x - x0 + rw / 2) * T}" y="${(y - y0 + rh / 2) * T + 4}" text-anchor="middle" fill="${inkFor(c.color)}" font-size="10" font-weight="600">${esc(label)}</text>` : "") + "</g>");
    });
    p.armor.forEach(([x, y]) => out.push(`<rect x="${(x - x0) * T + 2}" y="${(y - y0) * T + 2}" width="${T - 4}" height="${T - 4}" fill="#e6b93c" stroke="#8a6a14"/>`));
    p.vents.forEach(([x, y]) => out.push(`<rect x="${(x - x0) * T + 3}" y="${(y - y0) * T + 3}" width="${T - 6}" height="${T - 6}" fill="#f5f5f5"/>`));
    p.lifts.forEach(([x, a, b]) => out.push(`<rect x="${(x - x0) * T + 3}" y="${(a - y0) * T}" width="${T - 6}" height="${(b - a + 1) * T}" fill="#38c6d9"/>`));
    out.push("</svg>");
    return out.join("");
  }
  // my build: only the hull (room positions are not stored by the optimizer page)
  function drawHull(rows) {
    if (!rows || !rows.length) return "";
    const T = 12, W = Math.max(...rows.map((r) => r.length)), w = W * T, h = rows.length * T;
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Your hull (room positions are not saved)" shape-rendering="crispEdges">`, `<rect width="${w}" height="${h}" fill="#060912"/>`];
    rows.forEach((r, y) => [...r].forEach((c, x) => { if (c !== ".") out.push(`<rect x="${x * T}" y="${y * T}" width="${T}" height="${T}" fill="${c === "r" ? "#3a6db5" : "#2a3560"}" stroke="#10172b"/>`); }));
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
    laser: { name: "Lasers & cannons", dmg: "laser and cannon", counter: (S) => `shields (${fmt(S.shieldPool)} points, +${fmt(S.shieldRegen * S.powerFactor, 2)}/s)` },
    missile: { name: "Missiles", dmg: "missile", counter: (S) => `engines (${fmt(S.antiMissile)} dodge, +${fmt(S.evasionRegen * S.powerFactor, 1)}/s)` },
    craft: { name: "Hangars (craft)", dmg: "hangar craft", counter: (S) => `anti-craft (${S.antiAirPower} power, ${fmt(S.antiAir, 1)} craft HP/s) and shields` },
    board: { name: "Boarding (teleport)", dmg: "boarding", counter: (S) => [S.antiTele ? `${S.antiTele} interdictor gate${S.antiTele === 1 ? "" : "s"} / repulsor${S.antiTele === 1 ? "" : "s"}` : "",
      S.traps ? `${S.traps} trap${S.traps === 1 ? "" : "s"} (${fmt(S.trapDmg)} crew dmg)` : ""].filter(Boolean).join(" and ") || "no gates or traps" },
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
        el("td", { class: "num", text: rr.dmg > 0 ? fmt(rr.hull / Math.max(1, r.avgTime) * 60, 1) : "-" }),
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
      ["Offense", "Damage per minute on paper", fmt(A.dpm, 1), fmt(B.dpm, 1), true, "System + AP + hull damage from the game's weapon data (default ammo for launchers and hangars), before shields, armor and dodges."],
      ["Offense", "Shots stopped by the enemy (avg per fight)", fmt(r.a.intercepted + r.a.blocked + r.a.missed, 1), fmt(r.b.intercepted + r.b.blocked + r.b.missed, 1), false, "Missiles / craft shot down, boarding blocked, cloak misses."],
      ["Offense", "Hull damage dealt per minute (simulated)", fmt(dpmEff(r.a), 1), fmt(dpmEff(r.b), 1), true, "What gets through shields and armor."],
      ["Offense", "Enemy rooms knocked out (avg)", fmt(r.a.knocked, 1), fmt(r.b.knocked, 1), true, ""],
      ["Defense", "Shield points", fmt(A.shieldPool), fmt(B.shieldPool), true, "Sum of shield rooms' capacity (game data)."],
      ["Defense", "Shield restored per second", fmt(A.shieldRegen * A.powerFactor, 2), fmt(B.shieldRegen * B.powerFactor, 2), true, "Each shield room restores its points every reload (game data)."],
      ["Defense", "Damage soaked by shields (avg)", fmt(r.b.shield, 1), fmt(r.a.shield, 1), true, "Lasers, cannons and craft hit the shield while it is up; missiles and boarders go around it."],
      ["Defense", "Armor tiles", A.armorTiles, B.armorTiles, true, ""],
      ["Defense", "Armor coverage of systems", pct(A.armorCover), pct(B.armorCover), true, "Share of the outline of weapon, shield, reactor and defense rooms that touches armor."],
      ["Defense", "Average damage reduction from armor", pct(A.armorReduction), pct(B.armorReduction), true, ""],
      ["Defense", "Engine dodge (sum of dodge modifiers)", fmt(A.antiMissile), fmt(B.antiMissile), true, "Evasion pool that dodges missiles; refills 3-4% of it per second (game data and patch notes)."],
      ["Defense", "Anti-craft fire (craft HP per second)", fmt(A.antiAir, 2), fmt(B.antiAir, 2), true, "Anti-craft rooms' damage per second against craft (game data)."],
      ["Defense", "Interdictor gates / repulsors (stop boarders)", A.antiTele, B.antiTele, true, ""],
      ["Defense", "Traps: security gates etc. (hurt boarders)", A.traps, B.traps, true, "Their crew damage per landing is game data; how much it cuts boarders is assumed."],
      ["Defense", "Cloak / radar power", `${A.cloak} / ${A.radar}`, `${B.cloak} / ${B.radar}`, null, ""],
      ["Defense", "Hull HP (assumed equal)", BattleModel.constants.HULL_HP, BattleModel.constants.HULL_HP, null, "Level-12 Titan value; level-14 hull HP is not in the data we could read."],
      ["Defense", "Rooms with estimated combat stats", A.estimated, B.estimated, null, "Weapons, shields and anti-craft whose level is missing from the weapon data: they use an older level, a typical room of the same type, or default ammo."],
      ["Power", "Power made / needed at full power", `${A.made} / ${A.need}`, `${B.made} / ${B.need}`, null, ""],
      ["Power", "Power ratio", pct(A.powerRatio), pct(B.powerRatio), true, `Full output at ${pct(BattleModel.constants.POWER_REF)} or more (the top-100 median).`],
      ["Power", "Rooms charging at", pct(A.powerFactor), pct(B.powerFactor), true, "Reloads, shield restore and engine evasion slow down when power is short."],
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
