"use strict";
// Ship hull picker: browser port of tools/grab_hull.py.
// Finds a Pixel Starships ship design by name and turns its tile mask into hull rows (x = tile, . = outside).
// Ship list sources, tried in order:
//   1. data/ships.json in this site (refreshed by the "Refresh ship list" GitHub Action)
//   2. the official game API, straight from the browser (works only if the game server allows it)
//   3. a saved .json / .xml file the user picks (same formats grab_hull.py --source accepts)
const Hulls = (() => {
  const SETTINGS = "https://api.pixelstarships.com/SettingService/GetLatestVersion3?deviceType=DeviceTypeAndroid&languageKey=en";
  let ships = null, sourceLabel = "", loading = null;

  // ---- parsing (same rules as grab_hull.py) ----
  function fromXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("not valid XML");
    const out = [];
    doc.querySelectorAll("*").forEach((el) => {
      if (!el.hasAttribute("ShipDesignName")) return;
      const o = {};
      for (const a of el.attributes) o[a.name] = a.value;
      out.push(o);
    });
    return out;
  }
  function entries(data) {
    if (Array.isArray(data)) return data.filter((e) => e && typeof e === "object" && !Array.isArray(e));
    if (data && typeof data === "object") {
      for (const k of ["ships", "data", "results", "items"]) {
        if (data[k] && typeof data[k] === "object") return entries(data[k]);
      }
      return Object.entries(data).map(([k, v]) => (v && typeof v === "object" ? Object.assign({}, v, { _key: k }) : { _key: k }));
    }
    return [];
  }
  function pick(e, ...names) {
    const low = {};
    for (const [k, v] of Object.entries(e)) low[k.toLowerCase()] = v;
    for (const n of names) if (n in low && low[n] !== null && low[n] !== "") return low[n];
    return null;
  }
  const nameOf = (e) => String(pick(e, "shipdesignname", "name", "ship_name", "design_name", "_key") || "?");
  function toRows(e) {
    const rows = pick(e, "hull", "layout", "grid", "rows_list");
    if (Array.isArray(rows) && rows.length && typeof rows[0] === "string") {
      return rows.map((r) => [...r].filter((c) => !/\s/.test(c)).map((c) => (".0 -_#".includes(c) ? "." : "x")).join(""));
    }
    const mask = pick(e, "mask", "ship_mask", "layout_mask");
    const r = parseInt(pick(e, "rows", "height"), 10), c = parseInt(pick(e, "columns", "cols", "width"), 10);
    if (!(r > 0 && c > 0) || typeof mask !== "string" || mask.length !== r * c) return null;
    const out = [];
    for (let y = 0; y < r; y++) {
      let s = "";
      for (let x = 0; x < c; x++) s += "0.-".includes(mask[y * c + x]) ? "." : "x";
      out.push(s);
    }
    return out;
  }
  function normalise(data) {
    const seen = new Set(), list = [];
    for (const e of entries(data)) {
      const rows = toRows(e);
      if (!rows || !rows.length || !rows.some((r) => r.includes("x"))) continue;
      const name = nameOf(e), key = name + "|" + rows.join("/");
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ name, rows, tiles: rows.join("").split("x").length - 1 });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  function parseText(text) {
    return normalise(text.trimStart().startsWith("<") ? fromXml(text) : JSON.parse(text));
  }

  // ---- loading ----
  async function get(url, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || 20000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.text();
    } finally { clearTimeout(t); }
  }
  async function fromBundled() {
    const data = JSON.parse(await get("data/ships.json"));
    const list = normalise(data);
    if (!list.length) throw new Error("bundled list is empty");
    return [list, "ship list saved with this site" + (data.updated ? ` (${data.updated.slice(0, 10)})` : "")];
  }
  async function fromGame() {
    const cfgDoc = new DOMParser().parseFromString(await get(SETTINGS), "application/xml");
    const cfg = [...cfgDoc.querySelectorAll("*")].find((n) => n.hasAttribute("ProductionServer"));
    const server = (cfg && cfg.getAttribute("ProductionServer")) || "api.pixelstarships.com";
    const q = new URLSearchParams({ languageKey: "en" });
    if (cfg && cfg.getAttribute("ShipDesignVersion")) q.set("designVersion", cfg.getAttribute("ShipDesignVersion"));
    const list = parseText(await get(`https://${server}/ShipService/ListAllShipDesigns2?${q}`, 40000));
    if (!list.length) throw new Error("game returned no ship designs");
    return [list, "live from the game"];
  }
  function load(preferGame) {
    if (loading) return loading;
    loading = (async () => {
      const order = preferGame ? [fromGame, fromBundled] : [fromBundled, fromGame];
      const errs = [];
      for (const f of order) {
        try { [ships, sourceLabel] = await f(); return ships; } catch (e) { errs.push(e.message || String(e)); }
      }
      throw new Error("Could not load the ship list (" + errs.join("; ") + "). Use \"Load file\" with a saved ship list instead.");
    })().finally(() => { loading = null; });
    return loading;
  }
  async function loadFile(file) {
    const list = parseText(await file.text());
    if (!list.length) throw new Error("No ship designs with a grid found in " + file.name);
    ships = list; sourceLabel = "from " + file.name;
    return ships;
  }
  function search(q, limit) {
    if (!ships) return [];
    q = q.trim().toLowerCase();
    if (!q) return ships.slice(0, limit);
    const exact = [], starts = [], has = [];
    for (const s of ships) {
      const n = s.name.toLowerCase();
      if (n === q) exact.push(s); else if (n.startsWith(q)) starts.push(s); else if (n.includes(q)) has.push(s);
    }
    return exact.concat(starts, has).slice(0, limit);
  }
  return { load, loadFile, search, parseText, get count() { return ships ? ships.length : 0; }, get source() { return sourceLabel; } };
})();
