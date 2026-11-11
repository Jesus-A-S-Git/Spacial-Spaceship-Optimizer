// Checks the Ship vs ship mock model (js/battle.js) on the real top-100 data:
//  - a ship against itself is close to 50%
//  - each counter works in the right direction: adding engines stops more missiles, Interdictor Gates stop boarders,
//    anti-air stops craft, more shields soak more lasers, and the ship that gets the counter wins more often
// Run: node tools/test_battle.js
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

// better-ranked ship win rate (for the README), 80 fights per pair
if (process.argv.includes("--rank")) {
  let w = 0, n = 0;
  for (let i = 0; i < ships.length; i++) for (let j = i + 1; j < ships.length; j++) { w += BM.duel(ships[i], ships[j], 80).pA; n++; }
  console.log(`better-ranked ship wins ${pct(w / n)} of ${n} pairs`);
}
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
