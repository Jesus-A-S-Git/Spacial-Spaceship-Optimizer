#!/usr/bin/env python3
"""Turn a Pixel Starships ship design into a hull file for the optimizer.

    python3 grab_hull.py --list                       # list ship names found
    python3 grab_hull.py "Ship Name"                  # writes hull_<name>.txt and prints it
    python3 grab_hull.py "Ship Name" --source ships.json
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

def show(e):
    rows = to_rows(e)
    if not rows:
        print(f"Found '{name_of(e)}' but no recognisable grid. Fields: {', '.join(e.keys())}. Try --dump.")
        return
    out = "hull_" + re.sub(r"\W+", "_", name_of(e)).strip("_").lower() + ".txt"
    open(out, "w").write("\n".join(rows) + "\n")
    print(f"\n=== {name_of(e)}  ({len(rows[0])} x {len(rows)}) ===")
    print("\n".join(rows))
    print(f"\nSaved {out}. Run the optimizer with:\n    python3 ship_layout_optimizer_user.py --hull-file {out}")
    print("\nOr paste this into DEFAULT_HULL in the optimizer:\nDEFAULT_HULL = [")
    for y, r in enumerate(rows):
        print(f'    "{r}",  # y{y}')
    print("]\n(resource space: change some 'x' to 'r' by hand if you want it)\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("name", nargs="?", help="ship name; leave out to be asked")
    ap.add_argument("--source", default="official", help="official (default), a URL, or a saved .json/.xml file")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dump", action="store_true", help="print the raw entry instead of converting")
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
                print(json.dumps(e, indent=1)[:4000]) if a.dump else show(e)
        else:
            print(json.dumps(hit[0], indent=1)[:4000]) if a.dump else show(hit[0])
        if a.name:
            return
        name = None


main()
