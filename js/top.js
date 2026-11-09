"use strict";
// Top-100 ladder data (data/top_layouts.json + data/top_analysis.json, built weekly by the GitHub Action
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
  return {
    load, parse, forShip, templates,
    get layouts() { return layouts || []; },
    get analysis() { return analysis; },
  };
})();
