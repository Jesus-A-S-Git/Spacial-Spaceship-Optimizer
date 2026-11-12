#!/usr/bin/env python3
"""Write data/rooms.json (every room design: name, size, type, plus its combat stats) for the website.

    python3 tools/build_room_list.py                      # from the official game API (needs internet)
    python3 tools/build_room_list.py --source rooms.xml   # from a saved .json/.xml file
    # add combat stats from saved API responses to the existing data/rooms.json (keeps its rooms as they are):
    python3 tools/build_room_list.py --merge-into data/rooms.json --source ListRoomDesigns2.xml \\
        --missiles ListMissileDesigns.xml --crafts ListCraftDesigns.xml

The optimizer page uses it to fill in a room's real size and type when you type its name; the Ship vs ship page
(js/battle.js) uses the combat stats. The "Refresh ship and room lists" GitHub Action runs this every two weeks and
commits the result.

Combat fields (only written when the API gives them; times in seconds = game ticks / 40):
    reload, cooldown   ReloadTime, CooldownTime
    defBonus           DefaultDefenceBonus (the room's own armor)
    restore            shield rooms: shield points restored per reload (ManufactureCapacity / 100)
    shot               the room's built-in weapon (its MissileDesign), per projectile:
                       sh shield, hu hull, sy system, cr crew, ap direct-system (AP) damage, emp / fire seconds,
                       v volley, vd volley delay (s), t MissileType (Laser / Rocket), aoe explosion radius
    craft              the room's built-in craft (CraftDesign): hp, reload, v, vd, shot
Top level "ammo": missile designs (missile launcher / cannon ammo) and craft designs (hangar craft) from
RoomService/ListMissileDesigns and ListCraftDesigns: launchers and hangars fire whatever item the player loads,
so their damage is not part of the room design.
"""
import argparse, json, os, re, sys, time, urllib.parse
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "rooms.json")
TICKS = 40.0     # game ticks per second (ReloadTime, CooldownTime, VolleyDelay, EMPLength, FireLength are in ticks)


def grab_hull():
    """Reuse grab_hull.py's HTTP helper and XML reader (without running its command line)."""
    with open(os.path.join(HERE, "grab_hull.py"), encoding="utf-8") as f:
        src = f.read().rstrip()
    if src.endswith("main()"):
        src = src[: -len("main()")]
    mod = {"__name__": "grab_hull"}
    exec(compile(src, "grab_hull.py", "exec"), mod)
    return mod


def settings(g):
    import xml.etree.ElementTree as ET
    cfg = next((el.attrib for el in ET.fromstring(g["http"](g["SETTINGS"])).iter() if "ProductionServer" in el.attrib), {})
    return cfg.get("ProductionServer", "api.pixelstarships.com"), cfg


def fetch(g, src, endpoint, version_key, cfg_cache={}):
    """Text of an official endpoint (src == 'official'), a URL or a saved file."""
    if src == "official":
        if "v" not in cfg_cache:
            cfg_cache["v"] = settings(g)
        server, cfg = cfg_cache["v"]
        q = {"languageKey": "en"}
        if cfg.get(version_key):
            q["designVersion"] = cfg[version_key]
        return g["http"](f"https://{server}/RoomService/{endpoint}?" + urllib.parse.urlencode(q))
    if src.startswith(("http://", "https://")):
        return g["http"](src)
    with open(src, encoding="utf-8") as f:
        return f.read()


def elements(g, text, key):
    """Attribute dicts of every element that has `key`; a nested <MissileDesign> is kept as '_missile'."""
    import xml.etree.ElementTree as ET
    if text.lstrip().startswith("<"):
        out = []
        for el in ET.fromstring(text).iter():
            if key in el.attrib:
                d = dict(el.attrib)
                child = next((c.attrib for c in el if c.tag == "MissileDesign" and c.attrib), None)
                if child:
                    d["_missile"] = dict(child)
                out.append(d)
        return out
    return g["entries"](json.loads(text))


def num(v):
    """int/float from an API attribute, None if missing or not a number."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f == int(f) else round(f, 3)


def secs(v):
    n = num(v)
    return num(n / TICKS) if n else None


def shot_of(m):
    """Compact per-projectile stats of a MissileDesign (only the non-zero ones)."""
    if not m:
        return None
    out = {}
    for k, f in (("sh", "ShieldDamage"), ("hu", "HullDamage"), ("sy", "SystemDamage"), ("cr", "CharacterDamage"),
                 ("ap", "DirectSystemDamage"), ("hp%", "HullPercentageDamage"), ("cd", "CraftDamage")):
        v = num(m.get(f))
        if v:
            out[k] = v
    for k, f in (("emp", "EMPLength"), ("fire", "FireLength"), ("stun", "StunLength"), ("vd", "VolleyDelay")):
        v = secs(m.get(f))
        if v:
            out[k] = v
    v = num(m.get("Volley"))
    if v and v != 1:
        out["v"] = v
    if m.get("MissileType"):
        out["t"] = m["MissileType"]
    if m.get("FlightType") == "Immediate":
        out["beam"] = 1
    r = num(m.get("ExplosionRadius"))
    if r:
        out["aoe"] = r
    return out


def craft_of(c, missiles):
    if not c:
        return None
    out = {"hp": num(c.get("Hp")) or 0, "reload": secs(c.get("Reload")) or 0}
    v = num(c.get("Volley"))
    if v and v != 1:
        out["v"] = v
    vd = secs(c.get("VolleyDelay"))
    if vd:
        out["vd"] = vd
    if c.get("CraftAttackType") and c["CraftAttackType"] != "Default":
        out["attack"] = c["CraftAttackType"]
    s = shot_of(missiles.get(str(c.get("MissileDesignId"))))
    if s:
        out["shot"] = s
    return out


def combat(e, pick, missiles, crafts):
    """Combat fields of one room design (see the module docstring)."""
    out = {}
    for field, names in (("reload", ("reloadtime",)), ("cooldown", ("cooldowntime",))):
        v = secs(pick(e, *names))
        if v:
            out[field] = v
    v = num(pick(e, "defaultdefencebonus"))
    if v:
        out["defBonus"] = v
    if str(pick(e, "roomtype", "type") or "") == "Shield":
        v = num(pick(e, "manufacturecapacity"))
        if v:
            out["restore"] = num(v / 100.0)
    mid = str(pick(e, "missiledesignid") or "0")
    s = shot_of(e.get("_missile") or (missiles.get(mid) if mid != "0" else None))
    if s:
        out["shot"] = s
    cid = str(pick(e, "craftdesignid") or "0")
    if cid != "0" and cid in crafts:
        out["craft"] = craft_of(crafts[cid], missiles)
    return out


def ammo_table(missiles, crafts, used_ids):
    """Missile and craft designs a launcher / hangar can load (missile designs no room or craft has built in)."""
    ms = {}
    for mid, m in missiles.items():
        if mid in used_ids:
            continue
        s = shot_of(m)
        if s:
            ms[m.get("MissileDesignName") or mid] = s
    cs = {}
    for c in crafts.values():
        cs[c.get("CraftName") or c.get("CraftDesignId")] = craft_of(c, missiles)
    return {"missiles": ms, "crafts": cs}


def group_rooms(raw, pick, missiles, crafts):
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
        # what the website's room recommender needs: lowest ship level that can build the room, how many a
        # ship may have, power used / made, and capacity (crew for bedrooms, HP for shields ...)
        for field, names, agg in (("minShip", ("minshiplevel",), min), ("maxCount", ("maxcount",), max),
                                  ("power", ("maxsystempower",), max), ("powerGen", ("maxpowergenerated",), max),
                                  ("capacity", ("capacity",), max)):
            v = num(pick(e, *names))
            if v is not None and (v or field == "minShip"):
                rg[field] = v if field not in rg else agg(rg[field], v)
        # how the room is obtained (price, requirement, flags): tells shop rooms from event / reward rooms
        for field, names in (("price", ("pricestring",)), ("req", ("requirementstring",)), ("flags", ("flags",)),
                             ("rank", ("itemrank",))):
            v = pick(e, *names)
            if v not in (None, "", "0"):
                rg[field] = str(v)
        for k, v in combat(e, pick, missiles, crafts).items():
            rg.setdefault(k, v)      # same name and size twice: keep the first design's stats
    return sorted(groups.values(), key=lambda r: (r["name"].lower(), r["w"] * r["h"]))


COMBAT_KEYS = ("reload", "cooldown", "defBonus", "restore", "shot", "craft")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="official", help="official (default), a URL, or a saved .json/.xml ListRoomDesigns2 file")
    ap.add_argument("--missiles", default=None, help="ListMissileDesigns: official, a URL, a saved file or 'none' "
                    "(default: official when --source is official, else none)")
    ap.add_argument("--crafts", default=None, help="ListCraftDesigns, same choices as --missiles")
    ap.add_argument("--merge-into", default=None, help="an existing rooms.json: keep its rooms and add only the combat "
                    "fields of rooms with the same name and size in --source (for older saved API responses)")
    ap.add_argument("--note", default="", help="free text saved as combatSource (where the combat data came from)")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    out_path = a.out or a.merge_into or OUT
    g = grab_hull()
    pick = g["pick"]
    raw = elements(g, fetch(g, a.source, "ListRoomDesigns2", "RoomDesignVersion"), "RoomName")

    def side(arg, endpoint, ver, key):
        src = arg or ("official" if a.source == "official" else "none")
        if src == "none":
            return {}
        try:
            return {str(pick(x, key.lower())): x for x in elements(g, fetch(g, src, endpoint, ver), key)}
        except Exception as ex:     # the room list is still useful without the weapon tables
            print(f"warning: {endpoint} not loaded ({ex}); rooms are written without launcher / hangar ammo", file=sys.stderr)
            return {}
    missiles = side(a.missiles, "ListMissileDesigns", "MissileDesignVersion", "MissileDesignId")
    crafts = side(a.crafts, "ListCraftDesigns", "CraftDesignVersion", "CraftDesignId")
    rooms = group_rooms(raw, pick, missiles, crafts)
    if not rooms:
        sys.exit("No room designs with a size were found; data/rooms.json was not changed.")
    used = {str(pick(e, "missiledesignid") or "0") for e in raw} | {str(c.get("MissileDesignId")) for c in crafts.values()}
    ammo = ammo_table(missiles, crafts, used) if missiles or crafts else None
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    if a.merge_into:
        with open(a.merge_into, encoding="utf-8") as f:
            doc = json.load(f)
        by = {(r["name"], r["w"], r["h"]): r for r in rooms}
        hit = 0
        for r in doc["rooms"]:
            for k in COMBAT_KEYS:
                r.pop(k, None)
            src = by.get((r["name"], r["w"], r["h"]))
            if src and any(k in src for k in COMBAT_KEYS):
                hit += 1
                for k in COMBAT_KEYS:
                    if k in src:
                        r[k] = src[k]
        doc["combatSource"] = a.note or f"{a.source} (merged {stamp})"
        if ammo:
            doc["ammo"] = ammo
        print(f"Combat stats for {hit} of {len(doc['rooms'])} room designs (matched by name and size)")
    else:
        doc = {"updated": stamp, "source": a.source,
               "types": dict(Counter(r["type"] for r in rooms).most_common()),
               "fields": sorted(k for k in raw[0].keys() if not k.startswith("_")) if raw else [],
               "combatSource": a.note or a.source,
               "rooms": rooms}
        if ammo:
            doc["ammo"] = ammo
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
        f.write("\n")
    print(f"Wrote {len(doc['rooms'])} room designs to {out_path}")


if __name__ == "__main__":
    main()
