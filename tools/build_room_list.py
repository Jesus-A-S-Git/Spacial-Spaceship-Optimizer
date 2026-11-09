#!/usr/bin/env python3
"""Write data/rooms.json (every room design: name, size, type) for the website's room list.

    python3 tools/build_room_list.py                      # from the official game API (needs internet)
    python3 tools/build_room_list.py --source rooms.xml   # from a saved .json/.xml file

The page uses it to fill in a room's real size and type when you type its name.
The "Refresh ship and room lists" GitHub Action runs this every two weeks and commits the result.
"""
import argparse, json, os, sys, time, urllib.parse
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "rooms.json")


def grab_hull():
    """Reuse grab_hull.py's HTTP helper and XML reader (without running its command line)."""
    with open(os.path.join(HERE, "grab_hull.py"), encoding="utf-8") as f:
        src = f.read().rstrip()
    if src.endswith("main()"):
        src = src[: -len("main()")]
    mod = {"__name__": "grab_hull"}
    exec(compile(src, "grab_hull.py", "exec"), mod)
    return mod


def load(g, src):
    import xml.etree.ElementTree as ET
    if src == "official":
        cfg = next((el.attrib for el in ET.fromstring(g["http"](g["SETTINGS"])).iter() if "ProductionServer" in el.attrib), {})
        server = cfg.get("ProductionServer", "api.pixelstarships.com")
        q = {"languageKey": "en"}
        if cfg.get("RoomDesignVersion"):
            q["designVersion"] = cfg["RoomDesignVersion"]
        text = g["http"](f"https://{server}/RoomService/ListRoomDesigns2?" + urllib.parse.urlencode(q))
    elif src.startswith(("http://", "https://")):
        text = g["http"](src)
    else:
        with open(src, encoding="utf-8") as f:
            text = f.read()
    if text.lstrip().startswith("<"):
        return [dict(el.attrib) for el in ET.fromstring(text).iter() if "RoomName" in el.attrib]
    data = json.loads(text)
    return g["entries"](data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="official", help="official (default), a URL, or a saved .json/.xml file")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    g = grab_hull()
    raw = load(g, a.source)
    pick = g["pick"]
    groups = {}
    for e in raw:
        name = str(pick(e, "roomname", "name") or "").strip()
        try:
            w = int(pick(e, "columns", "width", "cols"))
            h = int(pick(e, "rows", "height"))
        except (TypeError, ValueError):
            continue
        if not name or w <= 0 or h <= 0:
            continue
        typ = str(pick(e, "roomtype", "type") or "")
        try:
            lvl = int(pick(e, "level") or 0)
        except ValueError:
            lvl = 0
        key = (name, w, h)
        rg = groups.setdefault(key, {"name": name, "short": str(pick(e, "roomshortname", "shortname") or ""),
                                     "type": typ, "category": str(pick(e, "categorytype", "category") or ""),
                                     "w": w, "h": h, "levels": [lvl, lvl]})
        rg["levels"] = [min(rg["levels"][0], lvl), max(rg["levels"][1], lvl)]
    rooms = sorted(groups.values(), key=lambda r: (r["name"].lower(), r["w"] * r["h"]))
    if not rooms:
        sys.exit("No room designs with a size were found; data/rooms.json was not changed.")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source": a.source,
                   "types": dict(Counter(r["type"] for r in rooms).most_common()),
                   "fields": sorted(raw[0].keys()) if raw else [],
                   "rooms": rooms}, f, separators=(",", ":"))
        f.write("\n")
    print(f"Wrote {len(rooms)} room designs to {a.out}")


if __name__ == "__main__":
    main()
