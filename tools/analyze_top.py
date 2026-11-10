#!/usr/bin/env python3
"""Analyse the top-100 ladder ships and teach the optimizer what they do.

    python3 tools/analyze_top.py --raw top_layouts/layouts.json      # after pixyship_fetch_layouts.py
    python3 tools/analyze_top.py                                     # re-analyse data/top_layouts.json

Writes:
  data/top_layouts.json   compact copy of every top layout (room positions, sizes, types), used by the
                          website's Top 100 page and to seed searches on the same hull
  data/top_analysis.json  statistics for the Top 100 page, plus what the optimizer learns:
    * patterns     which room types top ships put side by side / on the hull edge (TAG_ADJ, TAG_EDGE)
    * priors       the optimizer's --top50 numbers (edge use per kind, armor per room, lift spacing)
    * calibration  score weights fitted so that real top layouts score higher than scrambled copies of
                   themselves (checked on ships held out of the fit)
"""
import argparse, json, math, os, random, re, statistics, sys, time
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import web_driver  # noqa: E402

# game room type -> page room category (same table as js/gamerooms.js)
TYPE_CAT = {
    "Reactor": "reactor", "Shield": "shield",
    "Laser": "laser", "Cannon": "combat", "Missile": "missile", "StationMissile": "missile",
    "Carrier": "hangar", "AntiCraft": "antiair",
    "Engine": "antimissile", "AntiTeleport": "antitele", "Trap": "antitele", "Teleport": "boarding",
    "Android": "crewsupport", "Medical": "crewsupport", "Reviver": "crewsupport", "Stealth": "cloak", "Radar": "cloak",
    "Command": "command", "Bridge": "command", "Booster": "booster",
    "Bedroom": "crew", "Training": "noncombat", "Council": "noncombat", "Research": "noncombat",
    "Gas": "resource", "Mineral": "resource", "Storage": "resource", "Supply": "resource", "Printer": "resource",
    "Recycling": "resource",
}
STRUCT = {"Armor": "armor", "Lift": "lift", "Corridor": "corridor", "Wall": "armor"}
CAT_KIND = {"reactor": "priority", "shield": "priority", "priority": "priority",
            "laser": "combat", "antiair": "combat", "missile": "combat", "hangar": "combat",
            "antimissile": "combat", "antitele": "combat", "boarding": "combat", "crewsupport": "combat",
            "cloak": "combat", "shieldsupport": "combat", "command": "combat", "booster": "combat",
            "utility": "combat", "combat": "combat", "crew": "noncombat", "noncombat": "noncombat",
            "resource": "resource"}
KIND_ORDER = ["priority", "combat", "noncombat", "resource"]
CATS = list(CAT_KIND)


def cat_for(rtype, name):
    if rtype in STRUCT:
        return STRUCT[rtype]
    if rtype == "Shield" and "generator" not in name.lower():
        return "shieldsupport"
    return TYPE_CAT.get(rtype, "combat")


def base_name(n):
    return re.sub(r"\s+Lv\s*\d+$", "", str(n or "")).strip()


def ring_of(x, y, w, h):
    return ([(xx, y - 1) for xx in range(x, x + w)] + [(xx, y + h) for xx in range(x, x + w)]
            + [(x - 1, yy) for yy in range(y, y + h)] + [(x + w, yy) for yy in range(y, y + h)])


def q3(v):
    if not v:
        return [0, 0, 0]
    v = sorted(v)
    pick = lambda q: v[min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))]
    return [pick(0.25), pick(0.5), pick(0.75)]


# ------------------------------------------------------------------ loading
def compact(data, ships_by_id):
    """Raw PixyShip layouts (or an existing compact file) -> compact layouts with hull rows attached."""
    out = []
    for l in data["layouts"]:
        rooms = []
        for r in l["rooms"]:
            if isinstance(r, list):
                rooms.append(r)
                continue
            rooms.append([int(r["column"]), int(r["row"]), int(r["width"]), int(r["height"]), str(r["type"]),
                          str(r.get("short_name") or "").split(":")[0], base_name(r.get("name"))])
        rec = {k: l.get(k) for k in ("rank", "name", "trophies", "alliance", "ship_id", "ship_name", "ship_level")}
        rec["rooms"] = rooms
        out.append(rec)
    return out


def segments(cells):
    """Lift tiles -> vertical lift segments (x, y_top, y_bottom)."""
    by_x = defaultdict(list)
    for x, y in cells:
        by_x[x].append(y)
    segs = []
    for x, ys in sorted(by_x.items()):
        ys.sort()
        start = prev = ys[0]
        for y in ys[1:] + [None]:
            if y is not None and y == prev + 1:
                prev = y
                continue
            segs.append((x, start, prev))
            if y is not None:
                start = prev = y
    return segs


class Ship:
    """One top layout in the optimizer's terms."""

    def __init__(self, lay, hull):
        self.lay, self.hull = lay, hull
        self.rooms, self.armor, self.lift_cells, self.vents = [], [], [], []
        for x, y, w, h, typ, short, name in lay["rooms"]:
            c = cat_for(typ, name)
            if c == "armor":
                self.armor.append((x, y))
            elif c == "lift":
                self.lift_cells.append((x, y))
            elif c == "corridor":                        # PixyShip type "Corridor" = Service Vent
                self.vents.append((x, y))
            else:
                self.rooms.append(dict(x=x, y=y, w=w, h=h, cat=c, kind=CAT_KIND[c], type=typ, short=short, name=name))
        self.lifts = segments(self.lift_cells)
        self.inside = {(x, y) for y, row in enumerate(hull) for x, c in enumerate(row) if c != "."}

    def occupancy(self):
        occ = {}
        for i, r in enumerate(self.rooms):
            for yy in range(r["y"], r["y"] + r["h"]):
                for xx in range(r["x"], r["x"] + r["w"]):
                    occ[(xx, yy)] = i
        return occ


# ------------------------------------------------------------------ similar hulls
def hull_tiles(rows):
    return {(x, y) for y, r in enumerate(rows) for x, c in enumerate(r) if c != "."}


def best_alignment(target_rows, other_rows):
    """(overlap, dx, dy): how well `other` lines up with `target` (intersection over union of the hull
    tiles, 0..1) at its best shift. Tries lining up corners and centres, each nudged by up to 2 tiles."""
    A, B = hull_tiles(target_rows), hull_tiles(other_rows)
    if not A or not B:
        return 0.0, 0, 0
    ax0, ax1 = min(x for x, _ in A), max(x for x, _ in A)
    ay0, ay1 = min(y for _, y in A), max(y for _, y in A)
    bx0, bx1 = min(x for x, _ in B), max(x for x, _ in B)
    by0, by1 = min(y for _, y in B), max(y for _, y in B)
    bases = {(ax0 - bx0, ay0 - by0), (ax1 - bx1, ay1 - by1), (ax0 - bx0, ay1 - by1), (ax1 - bx1, ay0 - by0),
             (round((ax0 + ax1 - bx0 - bx1) / 2), round((ay0 + ay1 - by0 - by1) / 2))}
    best = (0.0, 0, 0)
    tried = set()
    for bdx, bdy in bases:
        for jx in range(-2, 3):
            for jy in range(-2, 3):
                dx, dy = bdx + jx, bdy + jy
                if (dx, dy) in tried:
                    continue
                tried.add((dx, dy))
                inter = sum(1 for x, y in B if (x + dx, y + dy) in A)
                iou = inter / (len(A) + len(B) - inter)
                if iou > best[0]:
                    best = (iou, dx, dy)
    return best


def similar_templates(target_rows, lays, ships_by_id, exclude_ship_ids=(), max_n=6, min_overlap=0.7):
    """Top layouts from OTHER hulls whose shape is close to the target hull, shifted onto it. Used when no
    top-100 player flies the target hull. Returns [(overlap, ship_name, template)]."""
    by_hull = defaultdict(list)
    for l in lays:
        if l["ship_id"] in ships_by_id and l["ship_id"] not in exclude_ship_ids:
            by_hull[l["ship_id"]].append(l)
    scored = []
    for sid, ls in by_hull.items():
        ov, dx, dy = best_alignment(target_rows, ships_by_id[sid]["hull"])
        if ov >= min_overlap:
            scored.append((ov, sid, dx, dy))
    out = []
    for ov, sid, dx, dy in sorted(scored, reverse=True):
        for l in sorted(by_hull[sid], key=lambda l: l["rank"]):
            sh = Ship(l, ships_by_id[sid]["hull"])
            out.append((ov, l["ship_name"], {
                "rooms": [[r["x"] + dx, r["y"] + dy, r["w"], r["h"], r["cat"]] for r in sh.rooms],
                "lifts": [[x + dx, y0 + dy, y1 + dy] for x, y0, y1 in sh.lifts],
                "vents": [[x + dx, y + dy] for x, y in sh.vents]}))
            if len(out) >= max_n:
                return out
    return out


# ------------------------------------------------------------------ statistics
def analyse(ships):
    hulls = defaultdict(lambda: {"count": 0, "best_rank": 999, "ranks": []})
    per = defaultdict(list)
    names = defaultdict(Counter)
    ships_with = defaultdict(Counter)
    edge = defaultdict(lambda: [0, 0])                 # cat -> [edge tiles, outline tiles]
    adj = Counter()                                    # (cat_a, cat_b) sorted -> touching pairs
    armor_touch = defaultdict(list)
    aa_center = []
    for s in ships:
        L = s.lay
        h = hulls[(L["ship_id"], L["ship_name"])]
        h["count"] += 1
        h["best_rank"] = min(h["best_rank"], L["rank"])
        h["ranks"].append(L["rank"])
        per["armor"].append(len(s.armor))
        per["lift_columns"].append(len({x for x, _, _ in s.lifts}))
        per["vents"].append(len(s.vents))
        per["rooms"].append(len(s.rooms))
        cnt = Counter(r["cat"] for r in s.rooms)
        for c in CATS:
            per["cat:" + c].append(cnt.get(c, 0))
        for r in s.rooms:
            names[r["cat"]][r["name"]] += 1
        for c, n in Counter((r["cat"], r["name"]) for r in s.rooms).items():
            ships_with[c[0]][c[1]] += 1
        occ = s.occupancy()
        armor = set(s.armor)
        for i, r in enumerate(s.rooms):
            ring = ring_of(r["x"], r["y"], r["w"], r["h"])
            edge[r["cat"]][0] += sum(1 for t in ring if t not in s.inside)
            edge[r["cat"]][1] += len(ring)
            if r["kind"] in ("priority", "combat"):
                armor_touch[r["cat"]].append(sum(1 for t in ring if t in armor))
            for o in {occ[t] for t in ring if t in occ and occ[t] > i}:
                a, b = sorted((r["cat"], s.rooms[o]["cat"]))
                adj[(a, b)] += 1
        aa = [r for r in s.rooms if r["cat"] == "antiair"]
        others = [r for r in s.rooms if r["kind"] in ("priority", "combat") and r["cat"] != "antiair"]
        if aa and others:
            cx = sum(r["x"] + r["w"] / 2 for r in others) / len(others)
            cy = sum(r["y"] + r["h"] / 2 for r in others) / len(others)
            aa_center.append(sum(abs(r["x"] + r["w"] / 2 - cx) + abs(r["y"] + r["h"] / 2 - cy) for r in aa) / len(aa))

    # learned patterns ------------------------------------------------------
    overall = sum(e for e, _ in edge.values()) / max(1, sum(p for _, p in edge.values()))
    tag_edge, edge_share = {}, {}
    for c, (e, p) in edge.items():
        edge_share[c] = e / p if p else 0
        if p >= 60:                                    # enough outline to trust
            tag_edge[c] = round(max(-2.0, min(2.0, math.log2(max(edge_share[c], 0.01) / overall))), 3)
    total = sum(adj.values())
    ends = Counter()
    for (a, b), n in adj.items():
        ends[a] += n
        ends[b] += n
    tag_adj, adj_table = {}, []
    for a in CATS:
        for b in CATS:
            if b < a:
                continue
            o = adj.get((a, b), 0)
            pa, pb = ends[a] / (2 * total) if total else 0, ends[b] / (2 * total) if total else 0
            e = total * pa * pb * (1 if a == b else 2)
            if e < 0.5 and o == 0:
                continue
            lo = math.log2((o + 1) / (e + 1))
            adj_table.append({"a": a, "b": b, "observed": o, "expected": round(e, 1), "log2": round(lo, 3)})
            if o + e >= 8:                              # ignore pairs too rare to say anything about
                tag_adj[a + "|" + b] = round(max(-1.5, min(1.5, lo)), 3)

    popular = {}
    for c, cnt in names.items():
        popular[c] = [[n, round(k / len(ships), 2), round(ships_with[c][n] / len(ships), 2)] for n, k in cnt.most_common(8)]
    return {
        "ships": len(ships),
        "hulls": sorted(({"ship_id": k[0], "ship_name": k[1], "count": v["count"], "best_rank": v["best_rank"],
                          "median_rank": statistics.median(v["ranks"])} for k, v in hulls.items()),
                        key=lambda h: (-h["count"], h["best_rank"])),
        "per_ship": {k: q3(v) for k, v in per.items()},
        "popular_rooms": popular,
        "edge_share": {c: round(v, 3) for c, v in edge_share.items()},
        "edge_overall": round(overall, 3),
        "armor_touch": {c: q3(v) for c, v in armor_touch.items()},
        "aa_center": q3(aa_center) if aa_center else None,
        "adjacency": adj_table,
        "patterns": {"adj": tag_adj, "edge": tag_edge},
    }


# ------------------------------------------------------------------ builds (offense / defense)
OFFENSE = [("laser", "Laser"), ("missile", "Missile"), ("hangar", "Hangar"), ("combat", "Cannon"), ("boarding", "Boarding")]
DEFENSE = [("antiair", "anti-air"), ("antimissile", "engines"), ("antitele", "anti-teleport"), ("cloak", "cloak/radar"),
           ("shieldsupport", "shield support"), ("crewsupport", "crew support"), ("armor", "armor")]


def ship_profile(s):
    """Room counts per offense / defense type for one top ship (cannons = the 'Other combat' category:
    EMP, Ion, Gamma beam ...; armor = armor tiles)."""
    cnt = Counter(r["cat"] for r in s.rooms)
    off = {k: cnt.get(k, 0) for k, _ in OFFENSE}
    dfn = {k: cnt.get(k, 0) for k, _ in DEFENSE if k != "armor"}
    dfn["armor"] = len(s.armor)
    return off, dfn


def build_label(off, dfn, spread):
    """'Laser build · light missiles · heavy anti-air · no cloak/radar' from room counts. spread = per defense
    type (q1, q3) over the top 100: >= q3 (and above the median) is heavy, <= q1 light, 0 = none."""
    total = sum(off.values())
    names = dict(OFFENSE)
    if not total:
        main, parts = "No-weapon", []
    else:
        order = sorted(off, key=lambda k: -off[k])
        top, second = order[0], order[1]
        if off[second] / total >= 0.25:
            main = f"{names[top]}/{names[second]} hybrid"
            rest = order[2:]
        else:
            main = f"{names[top]} build"
            rest = order[1:]
        parts = []
        for k in rest:
            if off[k]:
                share = off[k] / total
                parts.append(("some " if share >= 0.15 else "light ") + names[k].lower() + ("s" if names[k] not in ("Boarding",) else ""))
    dparts = []
    for k, label in DEFENSE:
        q1, med, q3 = spread[k]
        v = dfn[k]
        if v == 0 and q3 > 0:
            if k in ("antiair", "antimissile", "antitele"):
                dparts.append("no " + label)
        elif v >= q3 and v > med:
            dparts.append("heavy " + label)
        elif v <= q1 and v < med:
            dparts.append("light " + label)
    return main, parts, dparts


def builds(ships):
    """Offense / defense build of every top ship, plus what the builds have in common."""
    fam = room_designs()
    profiles = [(s, *ship_profile(s)) for s in ships]
    spread = {}
    for k, _ in DEFENSE:
        q = q3([d[k] for _, _, d in profiles])
        spread[k] = (q[0], q[1], q[2])
    per_ship, groups, members = [], defaultdict(list), defaultdict(list)
    for s, off, dfn in profiles:
        main, parts, dparts = build_label(off, dfn, spread)
        L = s.lay
        per_ship.append(dict(rank=L["rank"], name=L["name"], ship=L["ship_name"], trophies=L.get("trophies"),
                             build=main, label=" · ".join([main] + parts + dparts), offense=off, defense=dfn,
                             power={k: v for k, v in ship_power(s, fam).items() if k != "by_cat"} if fam else None))
        groups[main].append((L, off, dfn))
        members[main].append(s)
    summary = []
    for main, items in groups.items():
        ranks = [L["rank"] for L, _, _ in items]
        summary.append(dict(
            build=main, ships=len(items), best_rank=min(ranks), median_rank=statistics.median(ranks),
            trophies=round(statistics.mean(L.get("trophies") or 0 for L, _, _ in items)),
            offense={k: round(statistics.mean(o[k] for _, o, _ in items), 1) for k, _ in OFFENSE},
            defense={k: round(statistics.mean(d[k] for _, _, d in items), 1) for k, _ in DEFENSE},
            power=power_summary(members[main], fam) if fam else None))
    summary.sort(key=lambda b: (-b["ships"], b["best_rank"]))
    return dict(ships=per_ship, summary=summary,
                spread={k: list(v) for k, v in spread.items()},
                offense_types=[list(t) for t in OFFENSE], defense_types=[list(t) for t in DEFENSE])


# ------------------------------------------------------------------ room recommendations and deeper stats
def weapon_pair(off):
    """(primary, secondary) weapon keys of a ship, same rule as build_label: secondary = at least 25% of weapons."""
    total = sum(off.values())
    if not total:
        return None, None
    order = sorted(off, key=lambda k: -off[k])
    return order[0], (order[1] if off[order[1]] / total >= 0.25 else None)


def room_profile(group, fam=None):
    """What a group of top ships builds, per 100 usable hull tiles, so it scales to any hull size.
    cats: category -> [rooms per 100 tiles, room tiles per 100 tiles, ships with it (share)]
    families: category -> [[room name, w, h, rooms per ship, share of ships with it]] (most used first)"""
    designs = fam
    n = len(group)
    tiles = [len(s.inside) or 1 for s in group]
    cats, fam, has = defaultdict(lambda: [0.0, 0.0]), defaultdict(Counter), defaultdict(Counter)
    sizes = {}
    for s, t in zip(group, tiles):
        seen = set()
        for r in s.rooms:
            cats[r["cat"]][0] += 100 / t
            cats[r["cat"]][1] += 100 * r["w"] * r["h"] / t
            fam[r["cat"]][r["name"]] += 1
            sizes.setdefault(r["name"], (r["w"], r["h"]))
            seen.add((r["cat"], r["name"]))
        for c, nm in seen:
            has[c][nm] += 1
    with_cat = Counter(c for s in group for c in {r["cat"] for r in s.rooms})
    return dict(
        ships=n,
        ranks=sorted(s.lay["rank"] for s in group),
        hull_tiles=round(statistics.mean(tiles), 1),
        armor=round(100 * statistics.mean(len(s.armor) / t for s, t in zip(group, tiles)), 2),
        lifts=round(statistics.mean(len({x for x, _, _ in s.lifts}) for s in group), 2),
        vents=round(statistics.mean(len(s.vents) for s in group), 2),
        cats={c: [round(v[0] / n, 3), round(v[1] / n, 2), round(with_cat[c] / n, 2)] for c, v in cats.items()},
        families={c: [[nm, *sizes[nm], round(k / n, 2), round(has[c][nm] / n, 2)] for nm, k in cnt.most_common(10)]
                  for c, cnt in fam.items()},
        power=power_summary(group, designs) if designs else None,
    )


def room_designs(path=os.path.join(ROOT, "data", "rooms.json")):
    """room family name (no 'Lv N') -> [(level, minShip, power, powerGen)] from data/rooms.json."""
    try:
        with open(path, encoding="utf-8") as f:
            rooms = json.load(f)["rooms"]
    except (OSError, ValueError, KeyError):
        return {}
    fam = defaultdict(list)
    for r in rooms:
        fam[base_name(r["name"])].append((r["levels"][1], r.get("minShip"), r.get("power", 0), r.get("powerGen", 0)))
    return fam


def ship_power(s, fam):
    """Power of one top ship, every room at the best level the ship's level allows (room levels are not in
    the ladder data): make = what its reactors generate, use = what all its systems draw at full power,
    by_cat = the draw per room category. Cached on the ship."""
    if getattr(s, "power", None) is not None:
        return s.power
    lvl = s.lay.get("ship_level")
    use = make = 0
    by_cat = Counter()
    for r in s.rooms:
        ds = [d for d in fam.get(r["name"], []) if lvl is None or d[1] is None or d[1] <= lvl]
        if not ds:
            continue
        d = max(ds)
        use += d[2] or 0
        make += d[3] or 0
        if d[2]:
            by_cat[r["cat"]] += d[2]
    s.power = dict(make=make, use=use, ratio=round(make / use, 3) if use and make else None, by_cat=dict(by_cat))
    return s.power


def power_ratio(s, fam):
    """Power the reactors make / power all systems can draw (top players do not power every room at once)."""
    return ship_power(s, fam)["ratio"]


def power_summary(group, fam):
    """Average power made and needed by a group of top ships, the ratio (quartiles) and where the power goes."""
    ps = [ship_power(s, fam) for s in group]
    ps = [p for p in ps if p["use"] and p["make"]]
    if not ps:
        return None
    use = sum(p["use"] for p in ps)
    by_cat = Counter()
    for p in ps:
        by_cat.update(p["by_cat"])
    return dict(ships=len(ps), make=round(statistics.mean(p["make"] for p in ps), 1),
                use=round(statistics.mean(p["use"] for p in ps), 1),
                ratio=[round(v, 3) for v in q3([p["ratio"] for p in ps])],
                draw={c: round(v / use, 3) for c, v in by_cat.most_common()})


def recommendations(ships):
    """Room profiles for the website's room recommender: every top ship, each build (primary weapon +
    optional secondary weapon), and each primary weapon on its own."""
    by_pair, by_primary = defaultdict(list), defaultdict(list)
    for s in ships:
        p, q = weapon_pair(ship_profile(s)[0])
        if p is None:
            continue
        by_pair[p + ("+" + q if q else "")].append(s)
        by_primary[p].append(s)
    fam = room_designs()
    ratios = [v for v in (power_ratio(s, fam) for s in ships) if v]
    return dict(
        weapons=[list(t) for t in OFFENSE],
        all=room_profile(ships, fam),
        builds={k: room_profile(v, fam) for k, v in sorted(by_pair.items(), key=lambda kv: -len(kv[1]))},
        primary={k: room_profile(v, fam) for k, v in by_primary.items()},
        power_ratio=[round(v, 3) for v in q3(ratios)] if ratios else None,
    )


def insights(ships):
    """Deeper top-100 statistics for the analysis page."""
    ships = sorted(ships, key=lambda s: s.lay["rank"])
    out = {}
    # what separates the top 10 from ranks 11-100 (rooms per ship, armor, lifts, vents, fill rate)
    def summary(group):
        if not group:
            return None
        cnt = [Counter(r["cat"] for r in s.rooms) for s in group]
        fill = [(sum(r["w"] * r["h"] for r in s.rooms) + len(s.armor) + len(s.lift_cells) + len(s.vents)) / max(1, len(s.inside))
                for s in group]
        return dict(ships=len(group),
                    cats={c: round(statistics.mean(k.get(c, 0) for k in cnt), 2) for c in CATS},
                    armor=round(statistics.mean(len(s.armor) for s in group), 1),
                    rooms=round(statistics.mean(len(s.rooms) for s in group), 1),
                    lifts=round(statistics.mean(len({x for x, _, _ in s.lifts}) for s in group), 2),
                    vents=round(statistics.mean(len(s.vents) for s in group), 1),
                    hull_tiles=round(statistics.mean(len(s.inside) for s in group), 1),
                    fill=round(statistics.mean(fill), 3),
                    trophies=round(statistics.mean(s.lay.get("trophies") or 0 for s in group)))
    out["tiers"] = [dict(label=lab, **summary(ships[a:b])) for lab, a, b in
                    (("Top 10", 0, 10), ("Ranks 11-25", 10, 25), ("Ranks 26-50", 25, 50), ("Ranks 51-100", 50, 100))
                    if ships[a:b]]
    # trophies against a few build measures (rank correlation, -1..1)
    def spearman(xs, ys):
        def rk(v):
            order = sorted(range(len(v)), key=lambda i: v[i])
            r = [0.0] * len(v)
            i = 0
            while i < len(order):
                j = i
                while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                    j += 1
                for k in range(i, j + 1):
                    r[order[k]] = (i + j) / 2
                i = j + 1
            return r
        a, b = rk(xs), rk(ys)
        ma, mb = statistics.mean(a), statistics.mean(b)
        num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
        den = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
        return round(num / den, 3) if den else 0.0
    troph = [s.lay.get("trophies") or 0 for s in ships]
    measures = {
        "armor": [len(s.armor) for s in ships],
        "rooms": [len(s.rooms) for s in ships],
        "weapons": [sum(ship_profile(s)[0].values()) for s in ships],
        "lifts": [len({x for x, _, _ in s.lifts}) for s in ships],
        "vents": [len(s.vents) for s in ships],
        "hull_tiles": [len(s.inside) for s in ships],
    }
    for c in CATS:
        v = [sum(1 for r in s.rooms if r["cat"] == c) for s in ships]
        if sum(v) >= 10:
            measures["cat:" + c] = v
    out["trophy_corr"] = {k: spearman(v, troph) for k, v in measures.items()}
    # how builds do: share of each primary weapon in each rank band
    bands = (("Top 10", 0, 10), ("11-25", 10, 25), ("26-50", 25, 50), ("51-100", 50, 100))
    mix = []
    for lab, a, b in bands:
        prim = Counter(weapon_pair(ship_profile(s)[0])[0] or "none" for s in ships[a:b])
        mix.append(dict(label=lab, ships=len(ships[a:b]), primary=dict(prim)))
    out["weapon_mix"] = mix
    # rooms the top 10 run clearly more often than the rest (share of ships with the room)
    top, rest = ships[:10], ships[10:]
    def share(group):
        c = Counter()
        for s in group:
            for nm in {(r["cat"], r["name"]) for r in s.rooms}:
                c[nm] += 1
        return {k: v / max(1, len(group)) for k, v in c.items()}
    st, sr = share(top), share(rest)
    diff = sorted(((k, st.get(k, 0), sr.get(k, 0)) for k in set(st) | set(sr)), key=lambda t: -(t[1] - t[2]))
    out["top10_rooms"] = [[c, n, round(a, 2), round(b, 2)] for (c, n), a, b in diff[:12] if a - b >= 0.15]
    out["top10_rare"] = [[c, n, round(a, 2), round(b, 2)] for (c, n), a, b in diff[::-1][:8] if b - a >= 0.15]
    return out


# ------------------------------------------------------------------ anti-teleport gates
def gate_kind(name):
    """'interdictor' / 'security' / 'repulsor' for the anti-teleport rooms the patterns are about, else None.
    The same rule is in python/web_driver.py (gate_kind)."""
    n = str(name or "").lower()
    if "interdictor" in n:
        return "interdictor"
    if "security gate" in n:
        return "security"
    if "repulsor" in n:
        return "repulsor"
    return None


GATE_LABELS = {"interdictor": "Teleport Interdictor Gate", "security": "Security Gate", "repulsor": "Teleport Repulsor"}


def gate_analysis(ships):
    """Where top ships put their anti-teleport gates: what touches them (armor, hull edge, lifts, reactors,
    other gates), what sits left and right (crew walk through rooms sideways), how the two Interdictor
    Gates are placed, compared with every other combat room. Also the gate patterns the optimizer learns
    (patterns.gates: log2 of how much more often top ships do it than other combat rooms)."""
    recs, by_ship = [], defaultdict(list)
    for s in ships:
        occ = s.occupancy()
        armor, lifts, vents = set(s.armor), set(s.lift_cells), set(s.vents)

        def what(t):
            if t not in s.inside:
                return "edge"
            if t in armor:
                return "armor"
            if t in lifts:
                return "lift"
            if t in vents:
                return "vent"
            if t in occ:
                o = s.rooms[occ[t]]
                return gate_kind(o["name"]) or o["cat"]
            return "empty"
        H = [y for _, y in s.inside]
        y0, y1 = min(H), max(H)
        for i, r in enumerate(s.rooms):
            if r["kind"] not in ("priority", "combat"):
                continue
            x, y, w, h = r["x"], r["y"], r["w"], r["h"]
            L = [(x - 1, yy) for yy in range(y, y + h)]
            R = [(x + w, yy) for yy in range(y, y + h)]
            ring = ring_of(x, y, w, h)
            kinds = Counter(what(t) for t in ring)
            nb = {occ[t] for t in ring if t in occ and occ[t] != i}
            side = lambda ts: Counter(what(t) for t in ts)
            sl, sr = side(L), side(R)
            lift_side = sl if sl["lift"] else sr if sr["lift"] else None
            other = (sr if lift_side is sl else sl) if lift_side is not None else None
            rec = dict(rank=s.lay["rank"], kind=gate_kind(r["name"]), name=r["name"], cat=r["cat"], x=x, y=y, w=w, h=h,
                       armor=kinds["armor"] / len(ring),
                       sealed=all(what(t) in ("armor", "edge") for t in ring),
                       isolated=not nb,
                       edge=kinds["edge"] > 0, lift=bool(lift_side), any_lift=kinds["lift"] > 0,
                       reactor=any(s.rooms[o]["cat"] == "reactor" for o in nb),
                       lift_reactor=bool(other and other["reactor"]),
                       other_of_lift=(max(other, key=other.get) if other else None),
                       touches={k for k in (gate_kind(s.rooms[o]["name"]) for o in nb) if k},
                       same=any(s.rooms[o]["name"] == r["name"] for o in nb),
                       lr=" | ".join(sorted("/".join(sorted(c)) for c in (sl, sr))),
                       nb=Counter(s.rooms[o]["cat"] for o in nb),
                       ypos=(y - y0) / max(1, y1 - y0 + 1 - h))
            recs.append(rec)
            if rec["kind"]:
                by_ship[s.lay["rank"]].append(rec)
    base = [r for r in recs if not r["kind"]]
    share = lambda rs, f: (sum(1 for r in rs if f(r)) / len(rs)) if rs else 0.0

    def stats(rs):
        n = len(rs)
        nb = Counter()
        for r in rs:
            nb.update(set(r["nb"]))
        return dict(rooms=n, ships=len({r["rank"] for r in rs}),
                    armor=round(statistics.mean(r["armor"] for r in rs), 3) if rs else 0,
                    sealed=round(share(rs, lambda r: r["sealed"]), 3), isolated=round(share(rs, lambda r: r["isolated"]), 3),
                    edge=round(share(rs, lambda r: r["edge"]), 3), lift=round(share(rs, lambda r: r["lift"]), 3),
                    reactor=round(share(rs, lambda r: r["reactor"]), 3),
                    lift_reactor=round(share(rs, lambda r: r["lift_reactor"]), 3),
                    interdictor=round(share(rs, lambda r: "interdictor" in r["touches"]), 3),
                    security=round(share(rs, lambda r: "security" in r["touches"]), 3),
                    same=round(share(rs, lambda r: r["same"]), 3),
                    neighbours=[[c, round(k / n, 3)] for c, k in nb.most_common(8)] if n else [])
    out = dict(types={}, baseline=stats(base))
    for k in GATE_LABELS:
        rs = [r for r in recs if r["kind"] == k]
        if not rs:
            continue
        st = stats(rs)
        st["label"] = GATE_LABELS[k]
        st["per_ship"] = Counter(len([r for r in v if r["kind"] == k]) for v in by_ship.values() if any(r["kind"] == k for r in v)).most_common(4)
        st["left_right"] = [[m, round(c / len(rs), 3)] for m, c in Counter(r["lr"] for r in rs).most_common(6)]
        lifted = [r for r in rs if r["lift"]]
        st["lift_other_side"] = [[m, round(c / len(lifted), 3)] for m, c in Counter(r["other_of_lift"] for r in lifted).most_common(5)] if lifted else []
        out["types"][k] = st
    # how ships with two Interdictor Gates place them
    pair = Counter()
    for v in by_ship.values():
        t = sorted((r for r in v if r["kind"] == "interdictor"), key=lambda r: (r["y"], r["x"]))
        if len(t) != 2:
            continue
        a, b = t
        if a["y"] == b["y"] and abs(a["x"] - b["x"]) == a["w"]:
            pair["side by side (one 2x2 block)"] += 1
        elif a["x"] == b["x"] and abs(a["y"] - b["y"]) == a["h"]:
            pair["stacked"] += 1
        elif a["y"] == b["y"]:
            pair["same deck, apart"] += 1
        else:
            pair["different decks"] += 1
    out["interdictor_pairs"] = pair.most_common()
    # builds with boarding carry more gates
    boarding = {s.lay["rank"] for s in ships if ship_profile(s)[0].get("boarding", 0) >= 2}
    def per(group, k):
        return round(sum(1 for v in by_ship.items() if v[0] in group for r in v[1] if r["kind"] == k) / max(1, len(group)), 2)
    allr = {s.lay["rank"] for s in ships}
    out["boarding"] = {"ships": len(boarding), **{k: per(boarding, k) for k in GATE_LABELS}}
    out["other"] = {"ships": len(allr - boarding), **{k: per(allr - boarding, k) for k in GATE_LABELS}}
    top10 = {s.lay["rank"] for s in ships if s.lay["rank"] <= 10}
    out["top10"] = {"ships": len(top10), **{k: per(top10, k) for k in GATE_LABELS}}

    # learned patterns for the optimizer (section 16: GATE_PATTERNS): how much more often than other combat rooms
    def lift_ratio(a, b, floor=0.03):
        return round(max(0.0, min(2.0, math.log2((a + 0.01) / max(b, floor)))), 3)
    T, B = out["types"], out["baseline"]
    pats = {}
    if "security" in T:
        sg = T["security"]
        pats["security_lift"] = lift_ratio(sg["lift"], B["lift"])
        pats["security_lift_reactor"] = lift_ratio(sg["lift_reactor"], B["lift_reactor"])
        pats["security_reactor"] = lift_ratio(sg["reactor"], B["reactor"])
    if "interdictor" in T:
        ti = T["interdictor"]
        pats["interdictor_pair"] = lift_ratio(ti["same"], B["same"])
        pats["interdictor_security"] = lift_ratio(ti["security"], B["security"])
    out["patterns"] = {k: v for k, v in pats.items() if v > 0.25}
    return out


# ------------------------------------------------------------------ calibration
FEATURES = [  # (weight, feature from finalize info; score = sum(weight * feature) + extras)
    ("W_ARMOR", lambda i, s: i["arm_sum"]),
    ("W_UNARMORED", lambda i, s: -i["unarmored_rooms"]),
    ("W_PRIORITY_UNARMORED", lambda i, s: -i["unarmored_priority"]),
    ("W_ARMOR_UNDER", lambda i, s: -i["range_under"]),
    ("W_ARMOR_OVER", lambda i, s: -i["range_over"]),
    ("W_TRAVEL", lambda i, s: -i["avg"]),
    ("W_GAP", lambda i, s: -i["corridor"]),
    ("W_DISC", lambda i, s: -i["unreach"]),
    ("W_LIFT", lambda i, s: -i["lift_pen"]),
    ("W_RUN", lambda i, s: -i["long_extra"]),
    ("W_ISO", lambda i, s: -i["iso"]),
    ("W_LTOUCH", lambda i, s: -i["lift_touch_bad"]),
    ("W_FLOAT", lambda i, s: -i["floating"]),
    ("W_CORNER", lambda i, s: -0.5 * (i["cmax"] + i["cavg"])),
    ("W_SPREAD", lambda i, s: i["spread"]),
    ("W_EMPTY", lambda i, s: -i["empty_unused"]),
    ("W_LIFT_BALANCE", lambda i, s: -i["lift_balance_pen"]),
    ("W_LIFT_COUNT", lambda i, s: -len(s["lifts"])),
    ("W_CENTER", lambda i, s: -i.get("center_dist", 0.0)),
    ("W_PATTERN", lambda i, s: i.get("pattern", 0.0)),
]
BASE_PATTERN = 3.0          # starting W_PATTERN (the optimizer's own default is 0 = off)


def ship_cfg(ship, patterns, weights=None, settings=None):
    """Optimizer config for this ship's hull and room list, and the rooms in the optimizer's room order."""
    groups = {}                                   # identical rooms share one row (as on the page)
    for r in sorted(ship.rooms, key=lambda r: KIND_ORDER.index(r["kind"])):
        groups.setdefault((r["kind"], r["cat"], r["name"], r["w"], r["h"]), []).append(r)
    rooms = [r for g in groups.values() for r in g]
    rows = [dict(name=k[2], cat=k[1], catLabel=k[1], kind=k[0], w=k[3], h=k[4], count=len(g), armor="")
            for k, g in groups.items()]
    nl = len(ship.lifts)
    cfg = dict(hull=ship.hull, rooms=rows, resource_anywhere=True, place_bonus_rooms=False, patterns=patterns,
               walk_noncombat=True, vent_game_links=True, connect_all=True,
               settings=settings or dict(ARMOR_COUNT=len(ship.armor), MIN_LIFTS=min(nl, 1), MAX_LIFTS=max(nl, 1),
                                         START_LIFTS=max(1, min(nl, 2)), VENT_COUNT=len(ship.vents), W_PATTERN=1.0))
    if weights:
        cfg["settings"].update(weights)
    return cfg, rooms


def ship_module(ship, patterns, weights=None):
    """Build the optimizer for this ship's hull and room list; return (module, state)."""
    cfg, rooms = ship_cfg(ship, patterns, weights)
    m = web_driver.build_module(cfg, os.path.join(ROOT, "python", "ship_layout_finder.py"))
    state = dict(pos=[(r["x"], r["y"]) for r in rooms], lifts=list(ship.lifts), vents=[])
    state["vents"] = legal_vents(m, state, ship.vents)
    return m, state


def legal_vents(m, state, vents):
    """The real vents the optimizer's vent rules accept (game-like vents may only touch side by side)."""
    keep = []
    for v in vents:
        if m.occupancy(dict(state, vents=keep + [v])) is not None:
            keep.append(v)
    return keep


def features(m, state):
    res = m.finalize(state)
    if not res:
        return None
    info = res[2]
    return [f(info, state) for _, f in FEATURES]


def fit(pairs, w0, names, lam=0.02, iters=600):
    """Ranking fit: find w_i = w0_i * exp(th_i) so that sum(w * d) > 0 for each (weight, d) pair, staying
    close to the starting weights (L2 on th). W_ARMOR is fixed and sets the scale."""
    th = [0.0] * len(names)
    fixed = names.index("W_ARMOR")
    if not pairs:
        return list(w0)
    scale = max(1e-6, statistics.median([abs(sum(w * x for w, x in zip(w0, d))) for _, d in pairs]))
    tot = sum(pw for pw, _ in pairs)
    for _ in range(iters):
        ws = [w * math.exp(t) for w, t in zip(w0, th)]
        grad = [2 * lam * t for t in th]
        for pw, d in pairs:
            sc = sum(w * x for w, x in zip(ws, d)) / scale
            g = -pw / (1.0 + math.exp(min(50.0, sc))) / tot
            for i in range(len(th)):
                grad[i] += g * ws[i] * d[i] / scale
        for i in range(len(th)):
            if i != fixed and w0[i] > 0:
                th[i] = max(-3.0, min(3.0, th[i] - 0.5 * grad[i]))
    return [w * math.exp(t) for w, t in zip(w0, th)]


def optimize(ship, patterns, weights, seed, iters, polish):
    """The optimizer's own layout for this ship's hull and rooms, under the given weights."""
    m, _ = ship_module(ship, patterns, weights)
    m.init_state(random.Random(seed))
    _, sc, res, *_ = m.run_restart((seed, iters, polish, None, 24.0, list(m.OP_WEIGHTS)))
    return res[2]["state"] if res else None


def calibrate(ships, patterns, max_ships, perturb, rounds=2, iters=400, polish=100, seed=1, log=print):
    """Inverse optimisation: real top layouts should beat what the optimizer builds on the same hull with
    the same rooms. Each round: optimise every ship with the current weights, then refit the weights so
    the real layouts win (plus: real layouts should beat scrambled copies of themselves). Ships with an
    odd rank are used for fitting; even ranks only check the result."""
    rng = random.Random(seed)
    t0 = time.time()
    names = [n for n, _ in FEATURES]
    base = []                                   # (ship, feature module, state, real features)
    skipped = 0
    for s in ships[:max_ships]:
        try:
            fm, st = ship_module(s, patterns)
            fr = features(fm, st)
        except Exception as e:
            fr, fm, st = None, None, None
        if fr is None:
            skipped += 1
            continue
        base.append((s, fm, st, fr))
    if not base:
        return None
    defaults = {n: float(getattr(base[0][1], n)) for n in names}
    defaults["W_PATTERN"] = BASE_PATTERN
    w0 = [defaults[n] for n in names]

    pairs = {"train": [], "test": []}
    for s, fm, st, fr in base:                  # scrambled copies (weaker evidence: weight 0.3)
        part = "train" if s.lay["rank"] % 2 else "test"
        for steps in perturb:
            cur = fm.clone(st)
            try:
                for _ in range(steps):
                    cur = fm.neighbour(cur, rng)
                fp = features(fm, cur)
            except Exception:
                continue
            if fp is not None and fp != fr:
                pairs[part].append((0.3, [a - b for a, b in zip(fr, fp)]))

    def wins(ws, opt_pairs):
        return sum(1 for d in opt_pairs if sum(w * x for w, x in zip(ws, d)) > 0) / len(opt_pairs) if opt_pairs else None

    ws = list(w0)
    history = []
    for rnd in range(rounds):
        cur = dict(zip(names, ws))
        cur.pop("W_ARMOR", None)
        opt_pairs = {"train": [], "test": []}
        for k, (s, fm, st, fr) in enumerate(base):
            part = "train" if s.lay["rank"] % 2 else "test"
            try:
                ost = optimize(s, patterns, cur, seed + 1000 * rnd + k, iters, polish)
                fo = features(fm, ost) if ost else None
            except Exception as e:
                fo = None
            if fo is None:
                continue
            d = [a - b for a, b in zip(fr, fo)]
            opt_pairs[part].append(d)
            pairs[part].append((1.0, d))
        before = {p: wins(ws, opt_pairs[p]) for p in opt_pairs}
        ws = fit(pairs["train"], w0, names)
        after = {p: wins(ws, opt_pairs[p]) for p in opt_pairs}
        history.append({"round": rnd + 1, "ships": {p: len(v) for p, v in opt_pairs.items()},
                        "real_beats_optimizer_before_fit": before, "real_beats_optimizer_after_fit": after})
        log(f"  round {rnd + 1}: real layout beats the optimizer's on held-out ships "
            f"{before['test']} -> {after['test']} ({time.time() - t0:.0f}s)")
    return {
        "ships_used": len(base), "skipped": skipped, "rounds": history,
        "pairs": {p: len(v) for p, v in pairs.items()},
        "defaults": dict(zip(names, [round(w, 4) for w in w0])),
        "weights": dict(zip(names, [round(w, 4) for w in ws])),
        "search": {"iters": iters, "polish": polish},
    }


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", help="layouts.json from pixyship_fetch_layouts.py (default: re-use data/top_layouts.json)")
    ap.add_argument("--ships", default=os.path.join(ROOT, "data", "ships.json"))
    ap.add_argument("--out-dir", default=os.path.join(ROOT, "data"))
    ap.add_argument("--calibrate", type=int, default=0, help="how many ships to run the (old) weight calibration on; "
                    "0 = skip. tools/benchmark_top.py replaced it: it compares against the full-strength search")
    ap.add_argument("--rounds", type=int, default=2, help="optimise-then-refit rounds")
    ap.add_argument("--iters", type=int, default=400, help="search steps per ship and round")
    ap.add_argument("--perturb", default="1,2,4,8,16,32,1,3,6,12", help="scramble strengths (random moves) for the comparisons")
    a = ap.parse_args()
    src = a.raw or os.path.join(a.out_dir, "top_layouts.json")
    with open(src, encoding="utf-8") as f:
        data = json.load(f)
    with open(a.ships, encoding="utf-8") as f:
        ships_by_id = {s.get("id"): s for s in json.load(f)["ships"]}
    lays = compact(data, ships_by_id)
    ships, nohull = [], 0
    for l in lays:
        s = ships_by_id.get(l["ship_id"])
        if not s:
            nohull += 1
            continue
        ships.append(Ship(l, s["hull"]))
    print(f"{len(ships)} top layouts with a known hull ({nohull} without)")
    updated = data.get("updated") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(os.path.join(a.out_dir, "top_layouts.json"), "w", encoding="utf-8") as f:
        json.dump({"updated": updated, "fields": ["x", "y", "w", "h", "type", "short", "name"], "layouts": lays},
                  f, ensure_ascii=False, separators=(",", ":"))
    result = analyse(ships)
    result["builds"] = builds(ships)
    result["recommend"] = recommendations(ships)
    result["insights"] = insights(ships)
    result["gates"] = gate_analysis(ships)
    result["patterns"]["gates"] = result["gates"]["patterns"]
    result["levels"] = dict(Counter(l.get("ship_level") for l in lays if l.get("ship_level") is not None))
    result["updated"] = updated
    m0 = web_driver.build_module(dict(hull=["x" * 12] * 12, rooms=[], settings={"ARMOR_COUNT": 4}), os.path.join(ROOT, "python", "ship_layout_finder.py"))
    try:
        result["priors"] = m0.top50_priors([{"rooms": [dict(column=x, row=y, width=w, height=h, type=t)
                                                        for x, y, w, h, t, _, _ in l["rooms"]]} for l in lays])
    except SystemExit as e:
        result["priors"] = None
        print("priors skipped:", e)
    if a.calibrate:
        print("Calibrating score weights against the top layouts...")
        perturb = [int(v) for v in a.perturb.split(",") if v.strip()]
        result["calibration"] = calibrate(ships, result["patterns"], a.calibrate, perturb, rounds=a.rounds,
                                          iters=a.iters, polish=max(20, a.iters // 4))
    out = os.path.join(a.out_dir, "top_analysis.json")
    # keep the benchmark (tools/benchmark_top.py --into) of the same top-100 data when only re-analysing
    try:
        with open(out, encoding="utf-8") as f:
            prev = json.load(f)
        if "benchmark" in prev and prev.get("updated") == updated:
            result["benchmark"] = prev["benchmark"]
    except (OSError, ValueError):
        pass
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print("Wrote data/top_layouts.json and data/top_analysis.json")


if __name__ == "__main__":
    main()
