#!/usr/bin/env python3
"""Turn a Pixel Starships ship design into a hull file for the optimizer.

    python3 grab_hull.py --list                       # list ship names found
    python3 grab_hull.py "Ship Name"                  # writes hull_<name>.txt and prints it
    python3 grab_hull.py "Ship Name" --source ships.json
    python3 grab_hull.py "Doom Sphere Extended"       # Extended hulls: tiles added to the base hull become 'r'
    python3 grab_hull.py "Doom Sphere Extended" --no-resource   # ...or keep them as plain 'x'
    python3 ship_layout_optimizer_user.py --hull-file hull_<name>.txt

By default it asks the official Pixel Starships game API for all ship designs (the same public data
Pixyship uses; Pixyship's own /api/ships only answers requests coming from its own website, which is why
it returned 404). Needs internet, so run it on your own machine. --source reads a saved .json/.xml file. The script looks for a name field and
a grid in any of these forms (case-insensitive): a "mask" string of 0/1 per tile together with
"rows"/"columns", or an already-split list of row strings. If the real field names differ, run with
--dump "Ship Name" to see the raw entry and tell me what it looks like.
"""
import argparse, json, re, sys, urllib.parse, urllib.request
import xml.etree.ElementTree as ET

SETTINGS = "https://api.pixelstarships.com/SettingService/GetLatestVersion3?deviceType=DeviceTypeAndroid&languageKey=en"

def http(url):
    req = urllib.request.Request(url, headers={"User-Agent": "hull-grabber"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def from_xml(text):
    """Official API XML: every ship design is an element with ShipDesignName / Rows / Columns / Mask attributes."""
    return [dict(el.attrib) for el in ET.fromstring(text).iter() if "ShipDesignName" in el.attrib]


def load(src):
    if src == "official":
        cfg = next((el.attrib for el in ET.fromstring(http(SETTINGS)).iter() if "ProductionServer" in el.attrib), {})
        server = cfg.get("ProductionServer", "api.pixelstarships.com")
        q = {"languageKey": "en"}
        if cfg.get("ShipDesignVersion"):
            q["designVersion"] = cfg["ShipDesignVersion"]
        text = http(f"https://{server}/ShipService/ListAllShipDesigns2?" + urllib.parse.urlencode(q))
    elif re.match(r"https?://", src):
        text = http(src)
    else:
        with open(src, encoding="utf-8") as f:
            text = f.read()
    if text.lstrip().startswith("<"):
        return from_xml(text)
    return json.loads(text)


def entries(data):
    if isinstance(data, dict):
        for k in ("ships", "data", "results", "items"):
            if isinstance(data.get(k), (list, dict)):
                return entries(data[k])
        return [dict(v, _key=k) if isinstance(v, dict) else {"_key": k} for k, v in data.items()]
    return [e for e in data if isinstance(e, dict)]

def pick(e, *names):
    low = {k.lower(): v for k, v in e.items()}
    for n in names:
        if n in low and low[n] not in (None, ""):
            return low[n]
    return None

def name_of(e):
    return str(pick(e, "shipdesignname", "name", "ship_name", "design_name", "_key") or "?")

def to_rows(e):
    rows = pick(e, "hull", "layout", "grid", "rows_list")
    if isinstance(rows, list) and rows and isinstance(rows[0], str):
        return ["".join("x" if c not in ".0 -_#" else "." for c in r if not c.isspace()) for r in rows]
    mask = pick(e, "mask", "ship_mask", "layout_mask")
    r, c = pick(e, "rows", "height"), pick(e, "columns", "cols", "width")
    try:
        r, c = int(r), int(c)
    except (TypeError, ValueError):
        return None
    if isinstance(mask, str) and len(mask) != r * c:
        sys.exit(f"Mask length {len(mask)} does not match rows x columns = {r} x {c}. Run with --dump and send me the entry.")
    if isinstance(mask, str):
        return ["".join("x" if mask[y * c + x] not in "0.-" else "." for x in range(c)) for y in range(r)]
    return None

EXT_RE = re.compile(r"\s+extended\s*$", re.I)


def level_of(e):
    lv = pick(e, "shiplevel", "level")
    return int(lv) if str(lv or "").isdigit() else None


def align_inside(base, ext):
    """Every offset (dy, dx) that puts all usable base tiles on usable ext tiles."""
    E = {(y, x) for y, r in enumerate(ext) for x, c in enumerate(r) if c != "."}
    B = [(y, x) for y, r in enumerate(base) for x, c in enumerate(r) if c != "."]
    if not B:
        return []
    return [(ey - B[0][0], ex - B[0][1]) for ey, ex in sorted(E)
            if all((y + ey - B[0][0], x + ex - B[0][1]) in E for y, x in B)]


def extended_resources(e, ents):
    """An Extended hull is its base hull plus extra tiles, and in the game those extra tiles are resource space.
    Finds the base design (same name without " Extended", same ship level when there is one), aligns the grids and
    returns (rows with the extra tiles as 'r', info dict) or (None, reason) when it cannot tell."""
    name, rows, level = name_of(e), to_rows(e), level_of(e)
    if not EXT_RE.search(name):
        return None, "not an Extended hull"
    base_label = EXT_RE.sub("", name).strip()
    cands = []
    for b in ents:
        if b is e or name_of(b).strip().lower() != base_label.lower():
            continue
        try:
            brows = to_rows(b)
        except SystemExit:
            continue
        if brows and any("x" in r for r in brows) and all(brows != c[1] for c in cands):
            cands.append((b, brows))
    if not cands:
        return None, f'no base hull named "{base_label}" in the ship list'
    same = [c for c in cands if level is not None and level_of(c[0]) == level]
    fits, ambiguous = [], 0
    for b, brows in same or cands:
        offs = align_inside(brows, rows)
        if not offs:
            continue
        # several positions fit (e.g. a plain rectangle): the game draws both grids from the same corner, so take (0, 0)
        off = offs[0] if len(offs) == 1 else ((0, 0) if (0, 0) in offs else None)
        if off is None:
            ambiguous = len(offs)
            continue
        def base_has(y, x):
            by, bx = y - off[0], x - off[1]
            return 0 <= by < len(brows) and 0 <= bx < len(brows[by]) and brows[by][bx] != "."
        out = ["".join("r" if c == "x" and not base_has(y, x) else c for x, c in enumerate(r)) for y, r in enumerate(rows)]
        fits.append((sum(r.count("x") for r in brows), b, off, out))
    if not fits:
        if ambiguous:
            return None, f"the {base_label} hull fits inside the Extended one in {ambiguous} places, so it is unclear which tiles were added"
        return None, f"the {base_label} hull{'' if same else ' (any level)'} does not fit inside the Extended hull's tiles"
    fits.sort(key=lambda f: -f[0])
    tiles, b, off, out = fits[0]
    if any(f[0] == tiles and f[3] != out for f in fits[1:]):
        return None, f"several {base_label} hulls match equally well and mark different tiles"
    count = sum(r.count("r") for r in out)
    if not count:
        return None, f"the Extended hull adds no tiles to {base_label}"
    warn = ""
    if not same and level is not None and level_of(b) not in (None, level):
        warn = (f"no level {level} {base_label} in the ship list, so the level {level_of(b)} one was used: "
                f"tiles the level {level} upgrade added may be marked too. Check the grid.")
    return out, {"count": count, "base": name_of(b), "base_level": level_of(b), "offset": off, "warn": warn}


def show(e, ents=(), resources=True):
    rows = to_rows(e)
    if not rows:
        print(f"Found '{name_of(e)}' but no recognisable grid. Fields: {', '.join(e.keys())}. Try --dump.")
        return
    note = "(resource space: change some 'x' to 'r' by hand if you want it)"
    if EXT_RE.search(name_of(e)):
        if not resources:
            note = "(Extended hull: resource tiles not marked because of --no-resource)"
        else:
            marked, info = extended_resources(e, ents)
            if marked:
                rows = marked
                note = (f"({info['count']} resource tiles marked 'r' (added by the Extended version of {info['base']}"
                        + (f", level {info['base_level']}" if info["base_level"] is not None else "")
                        + "). Use --no-resource to keep them as plain 'x'.)")
                if info["warn"]:
                    note += "\nWarning: " + info["warn"]
            else:
                note = f"(Extended hull, but resource tiles were not marked: {info}. Change some 'x' to 'r' by hand.)"
    out = "hull_" + re.sub(r"\W+", "_", name_of(e)).strip("_").lower() + ".txt"
    open(out, "w").write("\n".join(rows) + "\n")
    print(f"\n=== {name_of(e)}  ({len(rows[0])} x {len(rows)}) ===")
    print("\n".join(rows))
    print(f"\nSaved {out}. Run the optimizer with:\n    python3 ship_layout_optimizer_user.py --hull-file {out}")
    print("\nOr paste this into DEFAULT_HULL in the optimizer:\nDEFAULT_HULL = [")
    for y, r in enumerate(rows):
        print(f'    "{r}",  # y{y}')
    print("]\n" + note + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", nargs="?", help="ship name; leave out to be asked")
    ap.add_argument("--source", default="official", help="official (default), a URL, or a saved .json/.xml file")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dump", action="store_true", help="print the raw entry instead of converting")
    ap.add_argument("--no-resource", action="store_true",
                    help="Extended hulls: do not mark the tiles added to the base hull as resource space 'r'")
    a = ap.parse_args()
    print("Loading ship designs...")
    ents = entries(load(a.source))
    if a.list:
        print("\n".join(sorted(name_of(e) for e in ents)))
        return
    name = a.name
    while True:
        if not name:
            try:
                name = input("Hull / ship name (part of a name is fine, blank to quit): ").strip()
            except EOFError:
                return
            if not name:
                return
        hit = [e for e in ents if name_of(e).lower() == name.lower()] or [e for e in ents if name.lower() in name_of(e).lower()]
        if not hit:
            print(f"No ship matching '{name}'. Type part of the name, or run with --list.")
        elif len(hit) > 1 and name_of(hit[0]).lower() != name.lower():
            print(f"{len(hit)} ships match:")
            for i, e in enumerate(hit, 1):
                print(f"  {i}. {name_of(e)}")
            pick_ = input("Number to use (blank to search again): ").strip()
            if pick_.isdigit() and 1 <= int(pick_) <= len(hit):
                e = hit[int(pick_) - 1]
                print(json.dumps(e, indent=1)[:4000]) if a.dump else show(e, ents, not a.no_resource)
        else:
            print(json.dumps(hit[0], indent=1)[:4000]) if a.dump else show(hit[0], ents, not a.no_resource)
        if a.name:
            return
        name = None


main()
