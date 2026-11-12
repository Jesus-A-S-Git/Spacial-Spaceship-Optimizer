// Checks the Ship vs ship mock model (js/battle.js) on the real top-100 data:
//  - a ship against itself is close to 50%
//  - each counter works in the right direction: adding engines stops more missiles, Interdictor Gates stop boarders,
//    anti-air stops craft, more shields soak more lasers, and the ship that gets the counter wins more often
//  - the rooms use the game's own numbers (data/rooms.json) and the mechanics behave: missiles skip shields, armor
//    cuts laser damage but not boarders', cloak makes shots miss and radar ends it, power and shields matter
// Run: node tools/test_battle.js            (add --rank for the better-ranked ship's win rate over all top-100 pairs)
"use strict";
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const BM = require(path.join(root, "js/battle.js"));
const rooms = JSON.parse(fs.readFileSync(path.join(root, "data/rooms.json")));
const analysis = JSON.parse(fs.readFileSync(path.join(root, "data/top_analysis.json")));
const top = JSON.parse(fs.readFileSync(path.join(root, "data/top_layouts.json")));
const layouts = (Array.isArray(top) ? top : top.layouts).slice().sort((a, b) => a.rank - b.rank);
BM.setup(rooms, analysis);
const ships = layouts.map((l) => BM.fromTop(l));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "ok   " : "FAIL ") + msg); if (!cond) fails++; };
const pct = (v) => (100 * v).toFixed(1) + "%";
const N = 1500;

// self matches
ships.slice(0, 6).forEach((s) => { const r = BM.duel(s, s, N); ok(Math.abs(r.pA - 0.5) < 0.05, `self ${s.label}: ${pct(r.pA)}`); });

// add rooms off the grid (no armor touches them), as a top-100 layout copy
function withExtra(l, n, type, name, w, h, tag) {
  const c = JSON.parse(JSON.stringify(l));
  for (let i = 0; i < n; i++) c.rooms.push([1000 + i * 10, 1000, w, h, type, "X", name]);
  const s = BM.fromTop(c); s.id += tag; s.label += tag; return s;
}
const stopShare = (rr) => (rr.dmg ? (rr.stopped + rr.shield) / rr.dmg : 0);
function check(kind, attackerKey, type, name, w, h, n) {
  const ai = ships.map((s, i) => [s.weaponPower[attackerKey], i]).sort((x, y) => y[0] - x[0])[0][1];
  const A = ships[ai];
  const bi = ai === 50 ? 51 : 50, B = ships[bi], Bx = withExtra(layouts[bi], n, type, name, w, h, `+${n} ${name}`);
  const r0 = BM.duel(A, B, N, 7), r1 = BM.duel(A, Bx, N, 7);
  const s0 = stopShare(r0.a.role[attackerKey]), s1 = stopShare(r1.a.role[attackerKey]);
  ok(s1 > s0 + 0.05, `${kind}: ${A.label} (${A.weaponPower[attackerKey]} ${attackerKey} power) stopped ${pct(s0)} -> ${pct(s1)} with B +${n} ${name}`);
  ok(r1.pB >= r0.pB - 0.01, `${kind}: B wins ${pct(r0.pB)} -> ${pct(r1.pB)}`);
}
check("missiles vs engines", "missile", "Engine", "Engine", 2, 2, 8);
check("boarding vs gates", "board", "AntiTeleport", "Teleport Interdictor Gate", 1, 2, 4);
check("boarding vs traps", "board", "Trap", "Security Gate", 1, 2, 4);
check("craft vs anti-air", "craft", "AntiCraft", "Anti Craft Laser", 2, 2, 6);
check("lasers vs shields", "laser", "Shield", "Shield Generator", 3, 2, 4);

// saturation: the same engines stop a bigger share of a small missile load than of a big one
{
  const li = ships.findIndex((x) => x.weaponPower.missile >= 6 && x.weaponPower.missile <= 14), l = layouts[li], small = ships[li];
  const heavy = withExtra(l, 10, "Missile", "Missile Launcher", 2, 2, "+10 missiles");
  const def = withExtra(layouts[li === 1 ? 2 : 1], 4, "Engine", "Engine", 2, 2, "+4 engines");
  const share = (r) => r.a.role.missile.stopped / Math.max(1e-9, r.a.role.missile.dmg);   // engines only, not shields
  const a = share(BM.duel(small, def, N, 3)), b = share(BM.duel(heavy, def, N, 3));
  ok(a > b + 0.1, `saturation: engines stop ${pct(a)} of a ${small.weaponPower.missile}-power missile load, ${pct(b)} of a ${heavy.weaponPower.missile}-power one`);
}

// ---------------------------------------------------------------- real data and mechanics
{
  const cat = BM.catalogue, pd = cat.get("plasma discharger"), sg = cat.get("shield generator"), eng = cat.get("engine");
  ok(pd && pd.reload > 0 && pd.shot && pd.shot.sy > 0 && pd.shot.sh > 0,
    `weapon stats come from the game data: Plasma Discharger reload ${pd && pd.reload} s, ${pd && JSON.stringify(pd.shot)}`);
  ok(sg && sg.capacity > 0 && sg.restore > 0 && sg.reload > 0, `shield stats: Shield Generator ${sg && sg.capacity} points, +${sg && sg.restore} every ${sg && sg.reload} s`);
  ok(eng && eng.capacity > 0, `engine dodge modifier from the game data: ${eng && eng.capacity}`);
  const known = ships.reduce((t, s) => t + s.rooms.filter((r) => (r.shot || r.craft) && r.combatFrom === "data").length, 0);
  const weap = ships.reduce((t, s) => t + s.rooms.filter((r) => ["laser", "missile", "craft", "board", "antiair"].includes(r.role)).length, 0);
  console.log(`info weapon / anti-craft rooms in the top 100 with their own level's stats: ${known} of ${weap} (others: older level, same-type room or default ammo)`);
}
function variant(i, tag, keep) {      // a copy of top-100 layout i with some rooms removed
  const c = JSON.parse(JSON.stringify(layouts[i]));
  c.rooms = c.rooms.filter((r) => keep(r));
  const s = BM.fromTop(c); s.id += tag; s.label += tag; return s;
}
{
  // missiles go around shields: none of their damage is soaked
  const mi = ships.map((s, i) => [s.weaponPower.missile, i]).sort((x, y) => y[0] - x[0])[0][1];
  const r = BM.duel(ships[mi], ships[mi === 10 ? 11 : 10], 400, 5);
  ok(r.a.role.missile.dmg > 0 && r.a.role.missile.shield === 0, `missiles bypass shields: ${ships[mi].label} missile damage soaked by shields ${r.a.role.missile.shield.toFixed(2)}`);
  // armor cuts laser damage, not boarders'
  const li = ships.map((s, i) => [s.weaponPower.laser, i]).sort((x, y) => y[0] - x[0])[0][1];
  const rl = BM.duel(ships[li], ships[li === 10 ? 11 : 10], 400, 5), bi = ships.findIndex((s) => s.weaponPower.board > 0);
  const rb = BM.duel(ships[bi], ships[bi === 10 ? 11 : 10], 400, 5);
  ok(rl.a.role.laser.armor > 0 && rb.a.role.board.armor === 0, `armor: laser damage cut ${rl.a.role.laser.armor.toFixed(2)}, boarding ${rb.a.role.board.armor.toFixed(2)}`);
}
{
  // cloak: shots miss while cloaked; an enemy radar ends the cloak
  const i = ships.findIndex((s) => s.cloak > 0 && s.radar > 0), j = ships.findIndex((s) => s.cloak === 0 && s.radar > 0 && s.weaponPower.laser > 0);
  const noRadar = variant(j, " -radar", (r) => r[4] !== "Radar");
  const missed = (r) => r.b.missed / Math.max(1, r.b.fired);
  const a = missed(BM.duel(ships[i], ships[j], 400, 9)), b = missed(BM.duel(ships[i], noRadar, 400, 9));
  ok(b > a, `cloak: ${ships[i].label}'s cloak makes ${pct(a)} of ${ships[j].label}'s shots miss, ${pct(b)} once it has no radar`);
}
{
  // power, shields and armor matter: a ship against a weakened copy of itself
  [["half the reactors", (s) => { let k = 0; return (r) => r[4] !== "Reactor" || k++ % 2 === 0; }, 0.65],
   ["no shields", () => (r) => r[4] !== "Shield", 0.55],
   ["no armor", () => (r) => r[4] !== "Armor" && r[4] !== "Wall", 0.5],
   ["no engines", () => (r) => r[4] !== "Engine", 0.5]].forEach(([what, mk, min]) => {
    let w = 0;
    const n = 8;
    for (let i = 0; i < n; i++) { const k = i * 12; w += BM.duel(ships[k], variant(k, " " + what, mk()), 300, 11).pA; }
    ok(w / n > min, `against a copy of itself with ${what} a ship wins ${pct(w / n)} on average (8 ships)`);
  });
}

// better-ranked ship win rate (for the README), 80 fights per pair
if (process.argv.includes("--rank")) {
  let w = 0, n = 0;
  for (let i = 0; i < ships.length; i++) for (let j = i + 1; j < ships.length; j++) { w += BM.duel(ships[i], ships[j], 80).pA; n++; }
  console.log(`better-ranked ship wins ${pct(w / n)} of ${n} pairs`);
}
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
