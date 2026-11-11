"use strict";
// Room recommender: "which rooms should a missile/hangar hybrid on this hull have?"
// Uses what the top-100 ships of that build run (data/top_analysis.json "recommend", tools/analyze_top.py),
// scaled to the hull's size, and only rooms the hull's ship level can build (data/rooms.json minShip).
// Shared by the optimizer page (app.js) and the Top 100 page (analyze.js).
const Recommender = (() => {
  const WEAPONS = [["laser", "Lasers"], ["missile", "Missiles"], ["hangar", "Hangars"], ["combat", "Cannons (EMP, Ion, Gamma)"], ["boarding", "Boarding (teleports)"]];
  const WEAPON_SET = new Set(WEAPONS.map(([k]) => k));
  const SHORT = { laser: "Laser", missile: "Missile", hangar: "Hangar", combat: "Cannon", boarding: "Boarding" };
  // categories every ship keeps at least one of (when the build's top ships nearly all have one)
  const ESSENTIAL = new Set(["reactor", "shield", "crew"]);
  // what goes first when the hull is too small: least important first
  const DROP_ORDER = ["noncombat", "resource", "booster", "command", "crewsupport", "cloak", "shieldsupport", "antitele",
    "antimissile", "antiair", "utility", "combat", "boarding", "laser", "missile", "hangar", "crew", "priority"];

  // rooms every ship keeps, whatever the build: the most Bedrooms the ship level allows and the Fleet Council.
  // The game data has no bedroom limit per ship level (MaxCount is 0); every top-100 ship (all ship level 14) has
  // exactly 3 Bedrooms, the most the game allows. A level's own MaxCount in data/rooms.json wins when it has one.
  const BEDROOM = "Bedroom", COUNCIL = "Fleet Council";
  const BEDROOM_MAX = 3;
  const bedroomMax = (level, d) => (d && d.maxCount ? d.maxCount : BEDROOM_MAX);
  // how many of one room a ship may have (0 = no limit known)
  const ONE_PER_SHIP = new Set(["fleet council"]);
  const maxFor = (g, d) => (d && d.maxCount) || (ONE_PER_SHIP.has(g.name.toLowerCase()) || (g.special && g.type === "Bedroom") ? 1 : 0);

  const buildKey = (p, s) => (p ? p + (s && s !== p ? "+" + s : "") : "");
  function buildName(p, s) {
    if (!p) return "";
    return s && s !== p ? `${SHORT[p]}/${SHORT[s]} hybrid` : `${SHORT[p]} build`;
  }
  // top-100 builds that exist, most ships first: [{key, name, ships}]
  function knownBuilds(analysis) {
    const r = analysis && analysis.recommend;
    if (!r) return [];
    return Object.entries(r.builds).map(([key, v]) => {
      const [p, s] = key.split("+");
      return { key, p, s: s || "", name: buildName(p, s), ships: v.ships };
    });
  }

  // room profile (per 100 hull tiles) for a build. Builds with few top ships are blended with the
  // primary-weapon group and all ships, so one odd ship does not decide everything.
  function profileFor(analysis, p, s) {
    const r = analysis.recommend;
    const all = r.all, exact = r.builds[buildKey(p, s)], prim = r.primary[p];
    const parts = [];
    if (exact) parts.push([exact, Math.min(1, exact.ships / 8)]);
    const rest = 1 - (parts.length ? parts[0][1] : 0);
    if (prim && rest > 0) parts.push([prim, rest * 0.6]);
    parts.push([all, 1 - parts.reduce((a, [, w]) => a + w, 0)]);
    const cats = {};
    parts.forEach(([pr, w]) => Object.entries(pr.cats).forEach(([c, v]) => {
      const o = cats[c] || (cats[c] = [0, 0, 0]);
      o[0] += w * v[0]; o[1] += w * v[1]; o[2] += w * v[2];
    }));
    // weapons: keep the blended weapon total but split it the way this build does
    const wTotal = WEAPONS.reduce((a, [k]) => a + ((cats[k] || [0])[0]), 0);
    const share = {};
    if (exact) {
      const ex = WEAPONS.reduce((a, [k]) => a + ((exact.cats[k] || [0])[0]), 0) || 1;
      WEAPONS.forEach(([k]) => { share[k] = ((exact.cats[k] || [0])[0]) / ex; });
    } else {
      WEAPONS.forEach(([k]) => { share[k] = 0; });
      if (s && s !== p) { share[p] = 0.65; share[s] = 0.35; } else share[p] = 0.9;
    }
    WEAPONS.forEach(([k]) => {
      const sz = cats[k] && cats[k][0] ? cats[k][1] / cats[k][0] : 6;      // average room size of that weapon
      cats[k] = [wTotal * share[k], wTotal * share[k] * sz, share[k] > 0.12 ? 1 : share[k] > 0 ? 0.3 : 0];
    });
    const fam = (c) => (exact && exact.families[c]) || (prim && prim.families[c]) || all.families[c] || [];
    const pick = (k) => parts.reduce((a, [pr, w]) => a + w * (pr[k] || 0), 0);
    // power made / power all systems need, as this build's top ships run it (blended like the rooms)
    const pw = parts.filter(([pr]) => pr.power && pr.power.ratio);
    const pwSum = pw.reduce((a, [, w]) => a + w, 0);
    const powerRatio = pwSum ? [0, 1, 2].map((i) => pw.reduce((a, [pr, w]) => a + (w * pr.power.ratio[i]) / pwSum, 0)) : null;
    return { cats, families: fam, armor: pick("armor"), lifts: pick("lifts"), vents: pick("vents"), powerRatio,
             power: exact && exact.power ? exact.power : all.power,
             ships: exact ? exact.ships : 0, ranks: exact ? exact.ranks : [], exact: !!exact };
  }

  // largest-remainder rounding of shares to a whole total
  function apportion(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const raw = weights.map((w) => (total * w) / sum);
    const out = raw.map(Math.floor);
    let left = total - out.reduce((a, b) => a + b, 0);
    raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
    return out;
  }

  // opts: {rows, level, primary, secondary, special}
  function recommend(analysis, opts) {
    const rows = opts.rows;
    const hullTiles = rows.join("").replace(/[^xr]/g, "").length;
    // no ship level (or 0 / not a number, e.g. a hull without one): every room level is allowed
    const lvIn = opts.level == null || opts.level === "" ? NaN : +opts.level;
    const level = lvIn >= 1 ? lvIn : null;
    const prof = profileFor(analysis, opts.primary, opts.secondary);
    const notes = [], locked = [];
    const items = [];               // {g, d, cat, count, min, fallback, required}
    const essentialWeapons = new Set([opts.primary, opts.secondary].filter(Boolean));
    const noBux = !opts.special;
    // may this family be suggested? (event / premium / starbase rooms only when asked for)
    const allowed = (g) => !!g && !g.station && (opts.special || GameRooms.buyable(g));
    const pickDesign = (g) => GameRooms.bestFor(g, level, noBux);

    // required rooms first: they are never left out to make space
    const required = new Map();     // lower-case family name -> item
    for (const [name, want] of [[BEDROOM, null], [COUNCIL, 1]]) {
      const g = GameRooms.find(name);
      if (!g) continue;
      if (!allowed(g)) { notes.push(`${g.name} is an event / premium room here, so it is not added.`); continue; }
      const d = pickDesign(g);
      if (!d) { notes.push(`${g.name} needs ship level ${g.minShip}` + (level != null ? ` (this hull is level ${level}).` : ".")); continue; }
      const n = want == null ? bedroomMax(level, d) : Math.min(want, maxFor(g, d) || want);
      const it = { g, d, cat: g.cat, count: n, min: n, required: true };
      items.push(it); required.set(g.name.toLowerCase(), it);
    }
    const requiredIn = (cat) => items.filter((it) => it.required && it.cat === cat).reduce((a, it) => a + it.count, 0);
    for (const [cat, [per100]] of Object.entries(prof.cats)) {
      if (!CAT[cat] || cat === "priority" || cat === "utility") continue;
      let target = (per100 * hullTiles) / 100;
      const share = prof.cats[cat][2];
      if (WEAPON_SET.has(cat) && !essentialWeapons.has(cat)) {
        if (target < 0.75) continue;                 // a weapon this build only dabbles in
      }
      const req = requiredIn(cat);
      const min = Math.max(0, (ESSENTIAL.has(cat) && share >= 0.7 ? 1 : essentialWeapons.has(cat) ? 1 : 0) - req);
      // required rooms (Bedrooms, Fleet Council) already count towards this category
      let n = Math.max(min, Math.round(target) - req);
      if (!n) continue;
      // room families top ships of this build use, limited to what this ship level can build
      const fams = [];
      for (const [name, , , perShip] of prof.families(cat)) {
        const g = GameRooms.find(name);
        if (!g || required.has(g.name.toLowerCase())) continue;
        if (!allowed(g)) continue;                   // event / premium rooms (starbux, rewards, one or two levels only)
        const d = pickDesign(g);
        if (!d) { locked.push({ name: g.name, cat, minShip: g.minShip }); continue; }
        fams.push({ g, d, w: perShip });
      }
      if (!fams.length) {
        // nothing the top ships use is available: fall back to any buyable game room of this category at this level
        const alt = GameRooms.ofCategory(cat).filter((g) => GameRooms.buyable(g) && g.designs.length > 2 && !required.has(g.name.toLowerCase()) && !/^(destroyed|station)\b/i.test(g.name))
          .map((g) => ({ g, d: pickDesign(g) })).filter((x) => x.d)
          .sort((a, b) => b.g.designs.length - a.g.designs.length || b.d.level - a.d.level);
        if (alt.length) fams.push({ g: alt[0].g, d: alt[0].d, w: 1, fallback: true });
      }
      if (!fams.length) { if (min) notes.push(`No ${catOf(cat).label.toLowerCase()} room is available at ship level ${level}.`); continue; }
      // spread the rooms over the families like top ships do (at most 3 kinds per category)
      const top = fams.sort((a, b) => b.w - a.w).slice(0, Math.max(1, Math.min(cat === "reactor" ? 4 : 3, n)));
      const counts = apportion(n, top.map((f) => f.w));
      top.forEach((f, i) => {
        let c = counts[i];
        const mx = maxFor(f.g, f.d);
        if (mx) c = Math.min(c, mx);
        if (c > 0) items.push({ g: f.g, d: f.d, cat, count: c, min: i === 0 ? min : 0, fallback: f.fallback });
      });
    }

    // power: reactors must cover what the rooms use
    const powerOf = () => items.reduce((a, it) => [a[0] + it.d.power * it.count, a[1] + it.d.powerGen * it.count], [0, 0]);
    let [use, make] = powerOf();
    // reactors that may get more copies: allowed (no starbux / event reactor unless asked) and below their limit
    const reactors = items.filter((it) => it.cat === "reactor" && it.d.powerGen > 0 && allowed(it.g) && !(noBux && it.d.bux) && !maxFor(it.g, it.d))
      .sort((a, b) => b.d.powerGen / (b.g.w * b.g.h) - a.d.powerGen / (a.g.w * a.g.h));
    // top ships' reactors make only about half of what all their rooms could draw at once
    const ratio = prof.powerRatio || analysis.recommend.power_ratio || [0.5, 0.5, 0.55];
    if (GameRooms.hasTiers && use && make < use * ratio[0] && reactors.length) {
      const best = reactors[0];
      const add = Math.ceil((use * ratio[0] - make) / best.d.powerGen);
      best.count += add;
      notes.push(`Added ${add} ${best.g.name} so power is in the range this build's top ships run.`);
      [use, make] = powerOf();
    }

    // fit on the hull: rooms + armor + room for lifts and vents
    // a lift runs the height of the hull where it stands: use the average column height of this hull
    const cols = new Map();
    rows.forEach((r) => [...r].forEach((c, x) => { if (c !== ".") cols.set(x, (cols.get(x) || 0) + 1); }));
    const colH = cols.size ? hullTiles / cols.size : rows.length;
    const liftTiles = Math.round(Math.max(1, prof.lifts) * Math.max(2, colH - 2) + prof.vents);
    let armor = Math.round((prof.armor * hullTiles) / 100);
    const roomTiles = () => items.reduce((a, it) => a + it.count * it.g.w * it.g.h, 0);
    const over = () => roomTiles() + armor + liftTiles - hullTiles;
    const minArmor = Math.round(armor * 0.6);
    let dropped = 0, guard = 500;
    while (over() > 0 && guard-- > 0) {
      if (armor > minArmor && over() <= armor - minArmor && dropped > 0) { armor -= over(); break; }
      // remove one room from the least important category that still has a spare one
      let done = false;
      for (const cat of DROP_ORDER) {
        const cand = items.filter((it) => it.cat === cat && it.count > it.min).sort((a, b) => b.count - a.count)[0];
        if (cand && !(cat === "reactor")) { cand.count--; dropped++; done = true; break; }
      }
      if (!done) { armor = Math.max(0, armor - over()); break; }
    }
    if (dropped) notes.push(`Not everything fits on this hull: ${dropped} room${dropped > 1 ? "s" : ""} left out, least important first.`);
    // slack: lifts cut full columns and vents/gaps strand tiles, so armor asked for up to the last free tile is never all placed
    const slack = Math.round(hullTiles * 0.04);
    const spare = hullTiles - roomTiles() - armor - liftTiles;
    if (spare < slack) armor = Math.max(Math.min(armor, minArmor), armor - (slack - spare));
    const free = hullTiles - roomTiles() - armor - liftTiles - slack;
    if (free > 0) armor += Math.min(free, Math.round(armor * 0.25));
    [use, make] = powerOf();
    if (GameRooms.hasTiers && use && make < use * ratio[0] * 0.9) notes.push("Power is low: the hull has no room for more reactors.");

    const rooms = items.filter((it) => it.count > 0).map((it) => ({
      name: it.g.name, cat: it.cat, w: it.g.w, h: it.g.h, count: it.count, short: it.g.short,
      level: it.d.level, minShip: it.d.minShip, power: it.d.power, powerGen: it.d.powerGen, fallback: !!it.fallback,
      required: !!it.required, special: !!(it.g.special || it.d.bux),
    }));
    const order = ROOM_CATEGORIES.map((c) => c.id);
    rooms.sort((a, b) => b.required - a.required || order.indexOf(a.cat) - order.indexOf(b.cat) || b.count - a.count);
    const lockedUniq = [...new Map(locked.map((l) => [l.name, l])).values()].sort((a, b) => (a.minShip || 0) - (b.minShip || 0));
    return {
      build: buildName(opts.primary, opts.secondary), level, hullTiles, rooms, armor, liftTiles,
      power: { use, make, top: ratio[1], range: [ratio[0], ratio[2]], build: prof.power }, notes, locked: lockedUniq, basis: prof.exact ? prof.ships : 0, ranks: prof.ranks,
      tiles: roomTiles(), special: !!opts.special,
    };
  }
  return { WEAPONS, buildKey, buildName, knownBuilds, recommend };
})();
