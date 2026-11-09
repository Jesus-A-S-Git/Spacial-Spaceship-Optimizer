"use strict";
// Top-100 ladder data (data/top_layouts.json + data/top_analysis.json, built every two weeks by the GitHub Action
// with tools/pixyship_fetch_layouts.py and tools/analyze_top.py).
const Top100 = (() => {
  let layouts = null, analysis = null, loading = null;

  function load() {
    if (!loading) {
      loading = Promise.all([
        fetch("data/top_layouts.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch("data/top_analysis.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]).then(([l, a]) => {
        layouts = l && Array.isArray(l.layouts) ? l.layouts : [];
        analysis = a;
        return { layouts, analysis };
      });
    }
    return loading;
  }
  // lift tiles -> vertical segments [x, y_top, y_bottom]
  function liftSegments(cells) {
    const byX = new Map();
    cells.forEach(([x, y]) => { if (!byX.has(x)) byX.set(x, []); byX.get(x).push(y); });
    const segs = [];
    for (const [x, ys] of byX) {
      ys.sort((a, b) => a - b);
      let s = ys[0], p = ys[0];
      for (let i = 1; i <= ys.length; i++) {
        if (i < ys.length && ys[i] === p + 1) { p = ys[i]; continue; }
        segs.push([x, s, p]);
        if (i < ys.length) { s = p = ys[i]; }
      }
    }
    return segs;
  }
  // one top layout -> {rooms: [[x, y, w, h, cat]], lifts, armor, rank, player}
  function parse(l) {
    const rooms = [], lifts = [], armor = [], vents = [];
    for (const [x, y, w, h, type, short, name] of l.rooms) {
      const c = GameRooms.catOf(type, name);
      if (c === "armor") armor.push([x, y]);
      else if (c === "lift") lifts.push([x, y]);
      else if (c === "corridor") vents.push([x, y]);          // PixyShip "Corridor" = Service Vent
      else rooms.push([x, y, w, h, c, short, name, type]);
    }
    return { rooms, lifts: liftSegments(lifts), armor, vents, rank: l.rank, player: l.name, ship: l.ship_name, shipId: l.ship_id };
  }
  function forShip(id) { return (layouts || []).filter((l) => l.ship_id === id).sort((a, b) => a.rank - b.rank); }
  // templates for the optimizer: the best-ranked top layouts on this hull
  function templates(shipIds, max) {
    const out = [];
    shipIds.forEach((id) => forShip(id).forEach((l) => out.push(l)));
    return out.sort((a, b) => a.rank - b.rank).slice(0, max || 6).map((l) => {
      const p = parse(l);
      return { rank: p.rank, rooms: p.rooms.map((r) => r.slice(0, 5)), lifts: p.lifts, vents: p.vents };
    });
  }
  // ---- borrowing from similar hulls (tools/analyze_top.py similar_templates does the same in Python) ----
  function tileSet(rows) {
    const set = new Set(), list = [];
    rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] !== ".") { set.add(x + "," + y); list.push([x, y]); } });
    return { set, list };
  }
  // [overlap 0..1, dx, dy]: how well `other` lines up with `target` at its best shift (corners / centres, +-2)
  function bestAlignment(target, other) {
    const A = tileSet(target), B = tileSet(other);
    if (!A.list.length || !B.list.length) return [0, 0, 0];
    const ext = (l) => [Math.min(...l.map((t) => t[0])), Math.max(...l.map((t) => t[0])), Math.min(...l.map((t) => t[1])), Math.max(...l.map((t) => t[1]))];
    const [ax0, ax1, ay0, ay1] = ext(A.list), [bx0, bx1, by0, by1] = ext(B.list);
    const bases = [[ax0 - bx0, ay0 - by0], [ax1 - bx1, ay1 - by1], [ax0 - bx0, ay1 - by1], [ax1 - bx1, ay0 - by0],
      [Math.round((ax0 + ax1 - bx0 - bx1) / 2), Math.round((ay0 + ay1 - by0 - by1) / 2)]];
    let best = [0, 0, 0];
    const tried = new Set();
    for (const [bdx, bdy] of bases) for (let jx = -2; jx <= 2; jx++) for (let jy = -2; jy <= 2; jy++) {
      const dx = bdx + jx, dy = bdy + jy, k = dx + "," + dy;
      if (tried.has(k)) continue;
      tried.add(k);
      let inter = 0;
      for (const [x, y] of B.list) if (A.set.has((x + dx) + "," + (y + dy))) inter++;
      const iou = inter / (A.list.length + B.list.length - inter);
      if (iou > best[0]) best = [iou, dx, dy];
    }
    return best;
  }
  // top layouts from other hulls with a similar shape, shifted onto this hull
  function similar(rows, max, minOverlap) {
    const byShip = new Map();
    (layouts || []).forEach((l) => { if (!byShip.has(l.ship_id)) byShip.set(l.ship_id, []); byShip.get(l.ship_id).push(l); });
    const scored = [];
    for (const [id, ls] of byShip) {
      const ship = Hulls.byId(id);
      if (!ship) continue;
      const [ov, dx, dy] = bestAlignment(rows, ship.rows);
      if (ov >= (minOverlap || 0.6)) scored.push({ ov, dx, dy, name: ship.name, ls: ls.slice().sort((a, b) => a.rank - b.rank) });
    }
    scored.sort((a, b) => b.ov - a.ov);
    const out = [];
    for (const h of scored) for (const l of h.ls) {
      if (out.length >= (max || 6)) break;
      const p = parse(l);
      out.push({ rank: l.rank, ship: h.name, overlap: h.ov,
        rooms: p.rooms.map((r) => [r[0] + h.dx, r[1] + h.dy, r[2], r[3], r[4]]),
        lifts: p.lifts.map(([x, a, b]) => [x + h.dx, a + h.dy, b + h.dy]),
        vents: p.vents.map(([x, y]) => [x + h.dx, y + h.dy]) });
    }
    return out;
  }
  return {
    load, parse, forShip, templates, similar,
    get layouts() { return layouts || []; },
    get analysis() { return analysis; },
  };
})();
