#!/usr/bin/env python3
"""Write data/ships.json (every ship hull) for the website's "Find a ship hull" box.

    python3 tools/build_ship_list.py                      # from the official game API (needs internet)
    python3 tools/build_ship_list.py --source ships.xml   # from a saved .json/.xml file

Reuses the loading and grid rules from grab_hull.py, so both always agree.
The "Refresh ship list" GitHub Action runs this every two weeks and commits the result.
"""
import argparse, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "ships.json")


def grab_hull():
    """Load grab_hull.py as a module without running its command-line main()."""
    with open(os.path.join(HERE, "grab_hull.py"), encoding="utf-8") as f:
        src = f.read()
    src = src.rstrip()
    if src.endswith("main()"):
        src = src[: -len("main()")]
    mod = {"__name__": "grab_hull"}
    exec(compile(src, "grab_hull.py", "exec"), mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="official", help="official (default), a URL, or a saved .json/.xml file")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    g = grab_hull()
    ships, seen, fields = [], set(), set()
    for e in g["entries"](g["load"](a.source)):
        try:
            rows = g["to_rows"](e)
        except SystemExit:            # mask does not match rows x columns: skip that design
            continue
        if not rows or not any("x" in r for r in rows):
            continue
        name = g["name_of"](e)
        key = (name, tuple(rows))
        if key in seen:
            continue
        seen.add(key)
        sid = g["pick"](e, "shipdesignid", "id")
        ship = {"name": name, "id": int(sid) if str(sid or "").isdigit() else None, "hull": rows}
        # ship level (hull tier): the website only recommends rooms this level can build
        lvl = g["pick"](e, "shiplevel", "level")
        if str(lvl or "").isdigit():
            ship["level"] = int(lvl)
        for field, names in (("race", ("raceid",)), ("type", ("shiptype",))):
            v = g["pick"](e, *names)
            if v not in (None, ""):
                ship[field] = int(v) if str(v).isdigit() else str(v)
        ships.append(ship)
        fields.update(e.keys())
    if not ships:
        sys.exit("No ship designs with a grid were found; data/ships.json was not changed.")
    ships.sort(key=lambda s: s["name"].lower())
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source": a.source,
                   "fields": sorted(fields), "ships": ships}, f, separators=(",", ":"))
        f.write("\n")
    print(f"Wrote {len(ships)} ship hulls to {a.out}")


if __name__ == "__main__":
    main()
