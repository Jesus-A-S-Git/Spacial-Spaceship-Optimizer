#!/usr/bin/env python3
"""How close does the optimizer get to real top-100 ships?

For top ships the calibration did not fit on (even ranks), give the optimizer the SAME hull and the SAME
rooms as the real player, with the website's default settings, and compare its best layout with the real
one: score, and how "top-like" it is (lifts, edge use, armor on priority rooms, grouped non-combat rooms,
learned room-pair patterns, reachability).

    python3 tools/benchmark_top.py                                   # original vs top style, 8 ships x 40 s
    python3 tools/benchmark_top.py --into data/top_analysis.json     # also store the results for the Top 100 page
"""
import argparse, json, os, statistics, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import analyze_top as A  # noqa: E402
import web_driver  # noqa: E402

SRC = os.path.join(ROOT, "python", "ship_layout_finder.py")
# the website's defaults (js/app.js DEFAULTS.settings), armor count taken from the real ship
SITE = dict(MIN_LIFTS=2, MAX_LIFTS=6, START_LIFTS=2, VENT_COUNT=8, VENT_LINK_COST=1, LIFT_COST=2, MAX_EMPTY_RUN=3,
            W_PATTERN=3, W_SHELL=3, W_NC_CLUSTER=15, W_LIFT_DENSITY=20)


def shape(m, state):
    """Top-likeness measures of one layout (same definitions for real and optimized layouts)."""
    res = m.finalize(state)
    if not res:
        return None
    score, g, info = res
    tiles = info["tiles"]
    pos = state["pos"]
    edge = {"priority": [0, 0], "combat": [0, 0], "noncombat": [0, 0]}
    nc_alone = nc = 0
    for r in range(m.NR):
        x, y = pos[r]
        ring = m.ring_of(x, y, m.ROOMS[r][2], m.ROOMS[r][3])
        k = m.ROOM_KIND[r]
        e = edge["noncombat" if k not in edge else k]
        e[0] += sum(1 for t in ring if not m.ok_tile(*t))
        e[1] += len(ring)
        if r >= m.NC:
            nc += 1
            if not any(tiles.get(t, -1) >= m.NC and tiles[t] != r for t in ring):
                nc_alone += 1
    pri = [info["touch"].get(r, 0) for r in m.PRIORITY_IDX]
    return dict(score=score, vents=len(state["vents"]), armor_sum=info["arm_sum"], empty=info["empty_unused"], corridor=info["corridor"], lifts=len({x for x, _, _ in state["lifts"]}), unreach=info["unreach"],
                travel=info["avg"], pattern=info.get("pattern", 0.0),
                edge_pri=edge["priority"][0] / max(1, edge["priority"][1]),
                edge_com=edge["combat"][0] / max(1, edge["combat"][1]),
                edge_nc=edge["noncombat"][0] / max(1, edge["noncombat"][1]),
                nc_grouped=1 - nc_alone / nc if nc else 1.0,
                armor_pri=statistics.mean(pri) if pri else 0.0, armor_float=info["floating"])


def run_bench(lays, data, an, ships_by_id, seconds, overrides, templates, log=print):
    rows = []
    for l in lays:
        ship = A.Ship(l, ships_by_id[l["ship_id"]]["hull"])
        settings = dict(SITE, ARMOR_COUNT=len(ship.armor), VENT_COUNT=len(ship.vents))   # same armor and vents as the real ship
        cfg, rooms = A.ship_cfg(ship, an["patterns"], settings=settings)
        cfg["top50_priors"] = an.get("priors")
        m = web_driver.build_module(cfg, SRC)                       # judge: website defaults, original weights
        real = shape(m, dict(pos=[(r["x"], r["y"]) for r in rooms], lifts=list(ship.lifts), vents=list(ship.vents)))
        if real is None:
            log(f"#{l['rank']}: real layout not legal in the model, skipped")
            continue
        run_cfg = dict(cfg, settings=dict(cfg["settings"], **overrides),
                       search=dict(iters=1200, polish=300, restarts=0, time_limit=seconds, seed=1, population=24))
        if templates:
            others = [o for o in data["layouts"] if o["ship_id"] == l["ship_id"] and o["rank"] != l["rank"]][:6]
            run_cfg["templates"] = [{"rooms": [[r["x"], r["y"], r["w"], r["h"], r["cat"]] for r in A.Ship(o, ship.hull).rooms],
                                     "lifts": [list(s) for s in A.Ship(o, ship.hull).lifts],
                                     "vents": [list(v) for v in A.Ship(o, ship.hull).vents]} for o in others]
        out = []
        web_driver.run(json.dumps(run_cfg), SRC, lambda s: out.append(json.loads(s)))
        best = next((o for o in reversed(out) if o.get("layouts")), None)
        if not best:
            log(f"#{l['rank']}: optimizer found nothing")
            continue
        st = best["layouts"][0]["state"]
        opt = shape(m, dict(pos=[tuple(p) for p in st["pos"]], lifts=[tuple(x) for x in st["lifts"]], vents=[tuple(v) for v in st["vents"]]))
        if opt is None:
            continue
        rows.append(dict(rank=l["rank"], ship=l["ship_name"], rooms=m.NR, real=real, opt=opt))
        log(f"  #{l['rank']:>3} {l['ship_name'][:26]:26} armor real {real['armor_sum']:>4.0f} opt {opt['armor_sum']:>4.0f}"
            f" | unreachable {real['unreach']}/{opt['unreach']} | lifts {real['lifts']}/{opt['lifts']}")
    return rows


KEYS = ["vents", "armor_sum", "armor_pri", "armor_float", "lifts", "unreach", "travel", "nc_grouped", "edge_nc", "edge_com", "edge_pri", "empty"]


def summary(rows):
    med = lambda k, w: round(statistics.median(r[w][k] for r in rows), 3)
    return dict(ships=len(rows), real={k: med(k, "real") for k in KEYS}, optimizer={k: med(k, "opt") for k in KEYS},
                armor_at_least_real=sum(1 for r in rows if r["opt"]["armor_sum"] >= r["real"]["armor_sum"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ships", type=int, default=8)
    ap.add_argument("--seconds", type=float, default=40, help="search time per ship (one core)")
    ap.add_argument("--configs", default="original,top,top+templates",
                    help="comma list of: original, top, original+templates, top+templates")
    ap.add_argument("--set", action="append", default=[], help="extra setting override for every config, e.g. --set W_DISC=50")
    ap.add_argument("--into", default=None, help="add the results to this top_analysis.json as 'benchmark'")
    a = ap.parse_args()
    data = json.load(open(os.path.join(ROOT, "data", "top_layouts.json"), encoding="utf-8"))
    an = json.load(open(os.path.join(ROOT, "data", "top_analysis.json"), encoding="utf-8"))
    ships_by_id = {s["id"]: s for s in json.load(open(os.path.join(ROOT, "data", "ships.json"), encoding="utf-8"))["ships"]}
    lays = [l for l in data["layouts"] if l["rank"] % 2 == 0 and l["ship_id"] in ships_by_id][: a.ships]
    probe = web_driver.build_module(dict(hull=["x" * 12] * 12, rooms=[], settings={"ARMOR_COUNT": 4}), SRC)
    styles = {"original": {}, "top": dict(probe.TOP_STYLE)}
    extra = {k: float(v) for k, v in (x.split("=", 1) for x in a.set)}
    results = []
    for name in [c.strip() for c in a.configs.split(",") if c.strip()]:
        style, _, tpl = name.partition("+")
        print(f"{name}: {len(lays)} ships x {a.seconds:.0f}s", flush=True)
        rows = run_bench(lays, data, an, ships_by_id, a.seconds, dict(styles[style], **extra), tpl == "templates")
        if rows:
            sm = summary(rows)
            sm.update(name=name, style=style, templates=tpl == "templates")
            results.append(sm)
            print(f"  -> armor {sm['optimizer']['armor_sum']:.0f} vs real {sm['real']['armor_sum']:.0f}, "
                  f"at least real on {sm['armor_at_least_real']}/{sm['ships']} | unreachable {sm['optimizer']['unreach']:.0f} "
                  f"vs real {sm['real']['unreach']:.0f} | priority armor {sm['optimizer']['armor_pri']:.2f} vs {sm['real']['armor_pri']:.2f}"
                  f" | wasted armor {sm['optimizer']['armor_float']:.0f} | lifts {sm['optimizer']['lifts']:.1f} | vents {sm['optimizer']['vents']:.0f}", flush=True)
    if a.into and results:
        with open(a.into, encoding="utf-8") as f:
            doc = json.load(f)
        doc["benchmark"] = dict(updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), seconds=a.seconds, configs=results)
        with open(a.into, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
