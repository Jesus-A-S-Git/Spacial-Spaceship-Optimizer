#!/usr/bin/env python3
"""How close does the optimizer get to real top-100 ships?

For top ships the calibration did not fit on (even ranks), give the optimizer the SAME hull and the SAME
rooms as the real player, with the website's default settings, and compare its best layout with the real
one: score, and how "top-like" it is (lifts, edge use, armor on priority rooms, grouped non-combat rooms,
learned room-pair patterns, reachability).

    python3 tools/benchmark_top.py                                   # original vs top style, 8 ships x 40 s
    python3 tools/benchmark_top.py --into data/top_analysis.json     # also store the results for the Top 100 page

Checking an engine change (is it better or worse?). Use a fixed amount of search work (restarts, not seconds)
so the numbers do not depend on how busy the machine is, save a baseline with the unchanged engine, then
compare the changed engine against it. --compare prints per-ship differences and exits with status 1 when
the changed engine is worse (lower mean score, less armor or more cut-off rooms beyond the tolerance):

    python3 tools/benchmark_top.py --ships 8 --restarts 6 --seed 1,2,3 --configs top,top+templates --jobs 4 --save /tmp/base.json
    # ... change python/ship_layout_finder.py or python/web_driver.py ...
    python3 tools/benchmark_top.py --ships 8 --restarts 6 --seed 1,2,3 --configs top,top+templates --jobs 4 --compare /tmp/base.json

(--seed 1,2,3: every ship once per seed, less noise; --jobs 4: four ships at once, same results.)

Also: BENCH_SRC=/path/to/other/ship_layout_finder.py runs another engine version with the same driver.
"""
import argparse, json, os, statistics, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))
import analyze_top as A  # noqa: E402
import web_driver  # noqa: E402

ROUNDS = 1                       # --rounds (time mode only)
SRC = os.environ.get("BENCH_SRC") or os.path.join(ROOT, "python", "ship_layout_finder.py")
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
    return dict(score=score, vents=len(state["vents"]), vents_useless=info["vent_pen"], armor_sum=info["arm_sum"], empty=info["empty_unused"], corridor=info["corridor"], lifts=len({x for x, _, _ in state["lifts"]}), unreach=info["unreach"],
                travel=info["avg"], pattern=info.get("pattern", 0.0),
                edge_pri=edge["priority"][0] / max(1, edge["priority"][1]),
                edge_com=edge["combat"][0] / max(1, edge["combat"][1]),
                edge_nc=edge["noncombat"][0] / max(1, edge["noncombat"][1]),
                nc_grouped=1 - nc_alone / nc if nc else 1.0,
                armor_pri=statistics.mean(pri) if pri else 0.0, armor_float=info["floating"])


def run_bench(lays, data, an, ships_by_id, seconds, overrides, templates, log=print, similar=False, restarts=0, seed=1, jobs=1):
    """Run every ship (once per seed when `seed` is a list); with jobs > 1 several runs at once (one process
    each; same results as one at a time)."""
    seeds = seed if isinstance(seed, (list, tuple)) else [seed]
    args = [(l, data, an, ships_by_id, seconds, overrides, templates, similar, restarts, sd) for sd in seeds for l in lays]
    rows = []
    if jobs > 1 and len(args) > 1:
        import multiprocessing as mp
        with mp.get_context("fork").Pool(min(jobs, len(args))) as pool:
            results = pool.imap(_bench_one, args)
            for row, lines in results:
                for line in lines:
                    log(line, flush=True)
                if row:
                    rows.append(row)
    else:
        for a in args:
            row, lines = _bench_one(a, log)
            if row:
                rows.append(row)
    return rows


def _bench_one(args, log=None):
    """One ship: (row or None, log lines). Lines are printed at once when `log` is given."""
    l, data, an, ships_by_id, seconds, overrides, templates, similar, restarts, seed = args
    lines = []

    def say(msg, **_):
        if log:
            log(msg, flush=True)
        else:
            lines.append(msg)
    ship = A.Ship(l, ships_by_id[l["ship_id"]]["hull"])
    settings = dict(SITE, ARMOR_COUNT=len(ship.armor), VENT_COUNT=len(ship.vents))   # same armor and vents as the real ship
    if os.environ.get("BENCH_VENTS"):
        settings["VENT_COUNT"] = int(os.environ["BENCH_VENTS"])
    cfg, rooms = A.ship_cfg(ship, an["patterns"], settings=settings)
    cfg["top50_priors"] = an.get("priors")
    m = web_driver.build_module(cfg, SRC)                       # judge: website defaults, original weights
    real_state = dict(pos=[(r["x"], r["y"]) for r in rooms], lifts=list(ship.lifts), vents=[])
    real_state["vents"] = A.legal_vents(m, real_state, ship.vents)
    real = shape(m, real_state)
    if real is None:
        say(f"#{l['rank']}: real layout not legal in the model, skipped")
        return None, lines
    search = dict(iters=1200, polish=300, restarts=0, time_limit=seconds, seed=seed, population=24)
    if restarts:                    # fixed amount of work: same result on a busy or an idle machine
        search.update(restarts=restarts, time_limit=0, cleanup_seconds=3600)
    run_cfg = dict(cfg, settings=dict(cfg["settings"], **overrides), search=search)
    if templates:
        others = [o for o in data["layouts"] if o["ship_id"] == l["ship_id"] and o["rank"] != l["rank"]][:6]
        run_cfg["templates"] = [{"rooms": [[r["x"], r["y"], r["w"], r["h"], r["cat"]] for r in A.Ship(o, ship.hull).rooms],
                                 "lifts": [list(s) for s in A.Ship(o, ship.hull).lifts],
                                 "vents": [list(v) for v in A.Ship(o, ship.hull).vents]} for o in others]
    decks = os.environ.get("BENCH_DECKS", "always")          # the website default: always
    if decks != "0":
        run_cfg["deck_starts"] = "always" if decks == "always" else True
    if similar:                     # borrowed from OTHER hulls with a similar shape (never this hull)
        sim = A.similar_templates(ship.hull, data["layouts"], ships_by_id, exclude_ship_ids={l["ship_id"]},
                                  max_n=6, min_overlap=float(os.environ.get("BENCH_MIN_OVERLAP", "0.6")))
        run_cfg["templates"] = [t for _, _, t in sim]
        say(f"  #{l['rank']}: {len(sim)} borrowed layouts" + (f", best overlap {sim[0][0]:.2f} ({sim[0][1]})" if sim else ""))
    out = []
    t_run = time.time()
    if ROUNDS > 1 and not restarts:
        # like the page: several rounds of `seconds`; each round starts from the best layouts found so far
        found = {}
        for rnd in range(1, ROUNDS + 1):
            rc = dict(run_cfg, search=dict(search, seed=seed * 1000 + rnd * 37),
                      seed_states=[v[1] for v in sorted(found.values(), key=lambda v: -v[0])[:6]])
            if rnd > 1:
                rc["templates"] = []
            web_driver.run(json.dumps(rc), SRC, lambda s: out.append(json.loads(s)))
            for lay in (next((o for o in reversed(out) if o.get("layouts")), {}) or {}).get("layouts", []):
                found[json.dumps(lay["state"])] = (lay["score"], lay["state"], lay)
        if found:
            out.append(dict(layouts=[v[2] for v in sorted(found.values(), key=lambda v: -v[0])]))
    else:
        web_driver.run(json.dumps(run_cfg), SRC, lambda s: out.append(json.loads(s)))
    t_run = time.time() - t_run
    best = next((o for o in reversed(out) if o.get("layouts")), None)
    if not best:
        say(f"#{l['rank']}: optimizer found nothing")
        return None, lines
    st = best["layouts"][0]["state"]
    opt = shape(m, dict(pos=[tuple(p) for p in st["pos"]], lifts=[tuple(x) for x in st["lifts"]], vents=[tuple(v) for v in st["vents"]]))
    if opt is None:
        return None, lines
    # run_score: the best layout's score under the settings the search ran with (what the engine maximises)
    row = dict(rank=l["rank"], seed=seed, ship=l["ship_name"], rooms=m.NR, real=real, opt=opt,
               run_score=best["layouts"][0]["score"], seconds=round(t_run, 1))
    say(f"  #{l['rank']:>3}{'' if seed == 1 else f'/s{seed}'} {l['ship_name'][:26]:26} armor real {real['armor_sum']:>4.0f} opt {opt['armor_sum']:>4.0f}"
        f" | unreachable {real['unreach']}/{opt['unreach']} | lifts {real['lifts']}/{opt['lifts']}"
        f" | score {row['run_score']:.1f} ({t_run:.0f}s)")
    return row, lines


KEYS = ["vents", "vents_useless", "armor_sum", "armor_pri", "armor_float", "lifts", "unreach", "travel", "nc_grouped", "edge_nc", "edge_com", "edge_pri", "empty"]


def summary(rows):
    med = lambda k, w: round(statistics.median(r[w][k] for r in rows), 3)
    return dict(ships=len(rows), real={k: med(k, "real") for k in KEYS}, optimizer={k: med(k, "opt") for k in KEYS},
                armor_at_least_real=sum(1 for r in rows if r["opt"]["armor_sum"] >= r["real"]["armor_sum"]),
                mean_score=round(statistics.mean(r["run_score"] for r in rows), 2),
                mean_armor=round(statistics.mean(r["opt"]["armor_sum"] for r in rows), 2),
                total_unreach=sum(r["opt"]["unreach"] for r in rows),
                seconds=round(sum(r.get("seconds", 0) for r in rows), 1))


def compare(results, base, tol):
    """Print how `results` differ from a saved baseline; return a list of regressions (empty = not worse)."""
    bad = []
    old = {c["name"]: c for c in base.get("configs", [])}
    print("\n=== compared with baseline ===")
    for c in results:
        b = old.get(c["name"])
        if not b:
            print(f"{c['name']}: not in the baseline, skipped")
            continue
        key = lambda r: (r["rank"], r.get("seed", 1))
        brows = {key(r): r for r in b.get("rows", [])}
        print(f"{c['name']}:")
        print(f"  {'ship':32} {'score base':>11} {'score now':>10} {'diff':>8} | armor base/now | cut-off base/now")
        for r in c.get("rows", []):
            o = brows.get(key(r))
            if not o:
                continue
            d = r["run_score"] - o["run_score"]
            print(f"  #{r['rank']:>3}{'' if r.get('seed', 1) == 1 else '/s' + str(r['seed']):4} {r['ship'][:23]:23} {o['run_score']:>11.1f} {r['run_score']:>10.1f} {d:>+8.1f} |"
                  f" {o['opt']['armor_sum']:>5.0f}/{r['opt']['armor_sum']:<5.0f}    | {o['opt']['unreach']}/{r['opt']['unreach']}")
        ranks = set(brows) & {key(r) for r in c.get("rows", [])}
        if not ranks:
            continue
        pick = lambda rows, f: [f(r) for r in sorted(rows, key=key) if key(r) in ranks]
        ms_b = statistics.mean(pick(b["rows"], lambda r: r["run_score"]))
        ms_n = statistics.mean(pick(c["rows"], lambda r: r["run_score"]))
        ar_b = statistics.mean(pick(b["rows"], lambda r: r["opt"]["armor_sum"]))
        ar_n = statistics.mean(pick(c["rows"], lambda r: r["opt"]["armor_sum"]))
        un_b = sum(pick(b["rows"], lambda r: r["opt"]["unreach"]))
        un_n = sum(pick(c["rows"], lambda r: r["opt"]["unreach"]))
        wins = sum(1 for n, o in zip(pick(c["rows"], lambda r: r["run_score"]), pick(b["rows"], lambda r: r["run_score"])) if n > o + 1e-6)
        loss = sum(1 for n, o in zip(pick(c["rows"], lambda r: r["run_score"]), pick(b["rows"], lambda r: r["run_score"])) if n < o - 1e-6)
        print(f"  mean score {ms_b:.1f} -> {ms_n:.1f} ({ms_n - ms_b:+.1f}); better on {wins}, worse on {loss} of {len(ranks)} runs")
        print(f"  mean armor {ar_b:.1f} -> {ar_n:.1f}; cut-off pairs {un_b} -> {un_n}; time {b.get('seconds', 0):.0f}s -> {c.get('seconds', 0):.0f}s")
        slack = tol * max(1.0, abs(ms_b))
        if ms_n < ms_b - slack:
            bad.append(f"{c['name']}: mean score dropped {ms_b:.1f} -> {ms_n:.1f}")
        if ar_n < ar_b * (1 - tol) - 1e-9:
            bad.append(f"{c['name']}: mean armor dropped {ar_b:.1f} -> {ar_n:.1f}")
        if un_n > un_b:
            bad.append(f"{c['name']}: more cut-off room pairs {un_b} -> {un_n}")
    print("\nRESULT: " + ("REGRESSION\n  " + "\n  ".join(bad) if bad else "not worse than the baseline"))
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ships", type=int, default=16)
    ap.add_argument("--seconds", type=float, default=40, help="search time per ship (one core)")
    ap.add_argument("--configs", default="original,top,top+similar,top+templates",
                    help="comma list of: original, top, top+similar (borrowed from similar hulls), top+templates")
    ap.add_argument("--set", action="append", default=[], help="extra setting override for every config, e.g. --set W_DISC=50")
    ap.add_argument("--into", default=None, help="add the results to this top_analysis.json as 'benchmark'")
    ap.add_argument("--restarts", type=int, default=0,
                    help="fixed search work per ship (restarts) instead of --seconds: repeatable, use for --save/--compare")
    ap.add_argument("--seed", default="1", help="search seed (default 1), or a comma list: every ship once per seed "
                                               "(less noise for --compare: one seed alone often moves a ship a lot)")
    ap.add_argument("--save", default=None, help="write the results (per ship) to this JSON file, e.g. as a baseline")
    ap.add_argument("--compare", default=None, help="baseline JSON from --save: report differences, exit 1 if worse")
    ap.add_argument("--rounds", type=int, default=1,
                    help="time mode: run like the page, in this many rounds of --seconds, each continuing from the best so far")
    ap.add_argument("--jobs", type=int, default=1, help="ships run at once (processes); results do not change")
    ap.add_argument("--only", default=None, help="comma list of ranks: run only these ships (of the --ships picked)")
    ap.add_argument("--tolerance", type=float, default=0.01, help="allowed drop for --compare (share, default 0.01 = 1%%)")
    a = ap.parse_args()
    global ROUNDS
    ROUNDS = max(1, a.rounds)
    seeds = [int(v) for v in str(a.seed).split(",") if v.strip()]
    a.seed = seeds[0] if len(seeds) == 1 else seeds
    data = json.load(open(os.path.join(ROOT, "data", "top_layouts.json"), encoding="utf-8"))
    an = json.load(open(os.path.join(ROOT, "data", "top_analysis.json"), encoding="utf-8"))
    ships_by_id = {s["id"]: s for s in json.load(open(os.path.join(ROOT, "data", "ships.json"), encoding="utf-8"))["ships"]}
    lays = [l for l in data["layouts"] if l["rank"] % 2 == 0 and l["ship_id"] in ships_by_id][: a.ships]
    if a.only:
        keep = {int(v) for v in a.only.split(",") if v.strip()}
        lays = [l for l in lays if l["rank"] in keep]
    probe = web_driver.build_module(dict(hull=["x" * 12] * 12, rooms=[], settings={"ARMOR_COUNT": 4}), SRC)
    styles = {"original": {}, "top": dict(probe.TOP_STYLE)}
    extra = {k: float(v) for k, v in (x.split("=", 1) for x in a.set)}
    results = []
    for name in [c.strip() for c in a.configs.split(",") if c.strip()]:
        style, _, tpl = name.partition("+")
        print(f"{name}: {len(lays)} ships x " + (f"{a.restarts} restarts" if a.restarts else f"{a.seconds:.0f}s"), flush=True)
        rows = run_bench(lays, data, an, ships_by_id, a.seconds, dict(styles[style], **extra), tpl == "templates",
                         similar=tpl == "similar", restarts=a.restarts, seed=a.seed, jobs=a.jobs)
        if rows:
            sm = summary(rows)
            sm.update(name=name, style=style, templates=tpl in ("templates", "similar"))
            if a.save or a.compare:
                sm["rows"] = rows
            results.append(sm)
            print(f"  -> armor {sm['optimizer']['armor_sum']:.0f} vs real {sm['real']['armor_sum']:.0f}, "
                  f"at least real on {sm['armor_at_least_real']}/{sm['ships']} | unreachable {sm['optimizer']['unreach']:.0f} "
                  f"vs real {sm['real']['unreach']:.0f} | priority armor {sm['optimizer']['armor_pri']:.2f} vs {sm['real']['armor_pri']:.2f}"
                  f" | wasted armor {sm['optimizer']['armor_float']:.0f} | lifts {sm['optimizer']['lifts']:.1f} | vents {sm['optimizer']['vents']:.0f} (useless {sm['optimizer']['vents_useless']:.0f})", flush=True)
    if a.save and results:
        with open(a.save, "w", encoding="utf-8") as f:
            json.dump(dict(updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), ships=a.ships, seconds=a.seconds,
                           restarts=a.restarts, rounds=a.rounds, seed=a.seed, src=SRC, configs=results), f, indent=1)
        print(f"saved {a.save}")
    if a.into and results:
        results = [{k: v for k, v in c.items() if k != "rows"} for c in results]
        with open(a.into, encoding="utf-8") as f:
            doc = json.load(f)
        doc["benchmark"] = dict(updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), seconds=a.seconds, configs=results)
        with open(a.into, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    if a.compare:
        with open(a.compare, encoding="utf-8") as f:
            base = json.load(f)
        if base.get("restarts") != a.restarts or base.get("ships") != a.ships or base.get("seed", 1) != a.seed:
            print(f"warning: baseline used ships={base.get('ships')} restarts={base.get('restarts')}, "
                  f"this run ships={a.ships} restarts={a.restarts}: compare like with like")
        if compare(results, base, a.tolerance):
            sys.exit(1)


if __name__ == "__main__":
    main()
