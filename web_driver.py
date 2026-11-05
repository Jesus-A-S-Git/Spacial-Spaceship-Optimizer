"""
Browser driver for ship_layout_finder.py (runs inside Pyodide, but also works in plain CPython).

The original optimizer is NOT modified. It is configured through module-level constants, so this driver:
  1. reads the original source,
  2. injects the settings chosen on the web page just before its "END CONFIG" marker,
  3. executes the patched source as a fresh module,
  4. runs a single-process version of the optimizer's main() loop (population, crossover, learned
     move odds), and
  5. reports progress and results to the page as JSON strings through an `emit` callback.
"""
import json
import random
import time
import types

MARKER = "# --------------------------------------------------------------- END CONFIG -"

INT_KEYS = {"ARMOR_COUNT", "MAX_EMPTY_RUN", "LIFT_COST", "VENT_COUNT", "VENT_LINK_COST",
            "MIN_LIFTS", "MAX_LIFTS", "START_LIFTS"}
FLOAT_KEYS = {"PRIORITY_WEIGHT", "W_ARMOR", "W_UNARMORED", "W_PRIORITY_UNARMORED", "W_FLOAT",
              "W_TRAVEL", "W_CORNER", "W_DISC", "CORNER_UNREACHABLE", "W_LIFT", "W_LTOUCH",
              "W_LIFT_BALANCE", "W_LIFT_COUNT", "W_GAP", "W_EMPTY", "W_RUN", "W_ISO", "W_SPREAD",
              "SPREAD_CAP", "W_VENT", "W_ARMOR_UNDER", "PRIORITY_UNDER_MULT", "W_ARMOR_OVER"}


class _Stop(Exception):
    """Raised from the progress hook when the time limit is reached."""


def _num(v, name):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"Setting {name} must be a number.")
    return v


def _rooms(lst, name, with_symbol=False):
    out = []
    for row in lst:
        if with_symbol:
            n, s, w, h, c = row
            out.append((str(n), str(s), int(w), int(h), int(c)))
        else:
            w, h, c = row[:3]
            out.append((int(w), int(h), int(c)))
    return out


def build_injection(cfg):
    hull = [str(r).strip() for r in cfg["hull"] if str(r).strip()]
    if not hull or len({len(r) for r in hull}) != 1 or any(set(r) - {"x", "."} for r in hull):
        raise ValueError("Invalid hull: use equal-length rows containing only 'x' (inside) and '.' (outside).")
    if not any("x" in r for r in hull):
        raise ValueError("Invalid hull: at least one 'x' tile is required.")
    lines = [f"HULL = {hull!r}"]
    for key, val in cfg.get("settings", {}).items():
        if key in INT_KEYS:
            lines.append(f"{key} = {int(_num(val, key))}")
        elif key in FLOAT_KEYS:
            lines.append(f"{key} = {float(_num(val, key))}")
    pr = cfg.get("priority_range")
    if pr:
        lines.append(f"PRIORITY_ARMOR_RANGE = ({int(pr[0])}, {int(pr[1])})")
    cr = cfg.get("combat_range")
    if cr:
        lines.append(f"COMBAT_ARMOR_RANGE = ({int(cr[0])}, {int(cr[1])})")
    lines.append(f"PLACE_BONUS_ROOMS = {bool(cfg.get('place_bonus_rooms', True))}")
    lines.append(f"PRIORITY_ROOMS = {_rooms(cfg.get('priority_rooms', []), 'priority')!r}")
    lines.append(f"COMBAT_ROOMS = {_rooms(cfg.get('combat_rooms', []), 'combat')!r}")
    lines.append(f"NONCOMBAT_ROOMS = {_rooms(cfg.get('noncombat_rooms', []), 'noncombat', True)!r}")
    return "\n".join(lines)


def build_module(cfg, source_path):
    with open(source_path, "r", encoding="utf-8") as f:
        src = f.read()
    if MARKER not in src:
        raise RuntimeError("Optimizer source has no END CONFIG marker; cannot inject settings.")
    # multiprocessing is not available in the browser and the single-process driver never uses it
    src = src.replace("from multiprocessing import Pool, Value", "Pool = Value = None")
    src = src.replace(MARKER, build_injection(cfg) + "\n" + MARKER, 1)
    mod = types.ModuleType("ship_layout_finder")
    mod.__dict__["__file__"] = "ship_layout_finder.py"
    try:
        exec(compile(src, "ship_layout_finder.py", "exec"), mod.__dict__)
    except SystemExit as e:           # the optimizer reports bad config with SystemExit(message)
        raise ValueError(str(e.args[0]) if e.args else "Invalid configuration")
    need = sum(rm[2] * rm[3] for rm in mod.ROOMS) + mod.ARMOR_COUNT
    if need > len(mod.ALL_TILES):
        raise ValueError(f"Hull has {len(mod.ALL_TILES)} tiles but the rooms ({need - mod.ARMOR_COUNT}) plus "
                         f"armor ({mod.ARMOR_COUNT}) need at least {need}. Use a bigger hull or fewer rooms/armor.")
    if mod.MIN_LIFTS > mod.MAX_LIFTS:
        raise ValueError("Min lifts cannot exceed max lifts.")
    return mod


def layout_json(m, res):
    score, g, info = res
    st = info["state"]
    touch = info["touch"]
    rooms = []
    for r, (x, y) in enumerate(st["pos"]):
        n, sym, w, h, _, comb = m.ROOMS[r]
        rg = m.ARMOR_RANGES[r]
        rooms.append(dict(name=n, sym=sym, w=w, h=h, x=x, y=y, combat=bool(comb),
                          priority=r in m.PRIORITY_SET,
                          armor=touch.get(r, 0) if comb else None,
                          range=list(rg) if rg else None))
    bonus = [dict(name=n, sym=s, w=w, h=h, x=x, y=y) for n, s, w, h, x, y, c in info["out"][m.NR:]]
    legend = dict(m.SYMBOLS)
    legend.update(m.NONCOMBAT_SYMBOLS)
    stats = dict(
        armor_tiles=len(info["armor"]), weighted_touchpoints=info["arm_sum"],
        avg_travel=info["avg"], corner_travel_max=info["cmax"], corner_travel_avg=info["cavg"],
        unreachable_pairs=info["unreach"], corridor_tiles=info["corridor"],
        weak_lift_columns=info["lift_pen"], lift_tiles_touching_nothing=info["lift_touch_bad"],
        lifts=len(st["lifts"]), lift_usage={str(k): v for k, v in info["lift_usage"].items()},
        lift_imbalance=info["lift_balance_pen"], unused_open_tiles=info["empty_unused"],
        long_run_excess=info["long_extra"], isolation_violations=info["iso"],
        priority_spread=info["spread"], vents=len(st["vents"]), vents_unlinked=info["vent_pen"],
        armor_touching_no_room=info["floating"], combat_rooms_without_armor=info["unarmored_rooms"],
        priority_rooms_without_armor=info["unarmored_priority"],
        sweet_spot_shortfall=info["range_under"], sweet_spot_excess=info["range_over"],
    )
    return dict(score=score, width=m.W, height=m.H, grid=["".join(row) for row in g],
                rooms=rooms, bonus=bonus, lifts=[list(l) for l in st["lifts"]],
                vents=[list(v) for v in st["vents"]], armor=sorted([list(t) for t in info["armor"]], key=lambda t: (t[1], t[0])),
                legend=legend, stats=stats)


def run(cfg_json, source_path, emit_fn):
    """Entry point called by the web worker. emit_fn takes one JSON string."""
    def emit(obj):
        emit_fn(json.dumps(obj))

    try:
        cfg = json.loads(cfg_json)
        m = build_module(cfg, source_path)
    except (ValueError, KeyError, TypeError) as e:
        emit(dict(type="error", message=f"Configuration problem: {e}"))
        return

    sc = cfg.get("search", {})
    iters = max(1, int(sc.get("iters", 1200)))
    polish = max(0, int(sc.get("polish", 300)))
    restarts = max(0, int(sc.get("restarts", 0)))
    time_limit = max(0.0, float(sc.get("time_limit", 0)))
    base_seed = int(sc.get("seed", 1))
    stagnation = max(0, int(sc.get("stagnation", 0)))
    pop_size = max(1, int(sc.get("population", 12)))
    eps = 0.1
    BATCH = 4                                   # adapt move odds every few restarts
    upr = iters + polish

    t0 = time.time()
    units = [0]
    last_emit = [0.0]
    stale = [0]
    done = [0]
    best_box = [float("-inf")]

    def fraction():
        fr = []
        if restarts:
            fr.append(units[0] / (restarts * upr))
        if time_limit:
            fr.append((time.time() - t0) / time_limit)
        if stagnation:
            fr.append(stale[0] / stagnation)
        return min(1.0, max(fr)) if fr else None

    def progress(force=False):
        now = time.time()
        if force or now - last_emit[0] > 0.4:
            last_emit[0] = now
            emit(dict(type="progress", frac=fraction(), done=done[0], restarts=restarts,
                      best=best_box[0] if best_box[0] > float("-inf") else None, elapsed=now - t0))

    def tick(n):
        units[0] += n
        if time_limit and time.time() - t0 >= time_limit:
            raise _Stop()
        progress()

    m.tick = tick                                # the optimizer calls tick() as it works

    emit(dict(type="log", msg=f"Hull {m.W}x{m.H}, {len(m.ALL_TILES)} tiles, {m.NR} rooms. Building a starting layout..."))
    try:
        m.init_state(random.Random(base_seed))
    except RuntimeError as e:
        emit(dict(type="error", message=f"Cannot start: {e}"))
        return
    except _Stop:
        emit(dict(type="done", reason="time limit", layouts=[], restarts=0))
        return

    population = []
    best = None
    best_score = float("-inf")
    weights = list(m.OP_WEIGHTS)
    att_tot, succ_tot = [0.0] * m.NOPS, [0.0] * m.NOPS
    reason = "finished"

    def top_layouts():
        if best is None:
            return []
        others = sorted((p for p in population if p[1][2]["state"] != best[2]["state"]), key=lambda p: -p[0])
        return [layout_json(m, best)] + [layout_json(m, r) for _, r in others[:4]]

    while True:
        if restarts and done[0] >= restarts:
            reason = "restart limit reached"
            break
        if time_limit and time.time() - t0 >= time_limit:
            reason = "time limit reached"
            break
        if stagnation and stale[0] >= stagnation:
            reason = "no meaningful improvement"
            break
        seed = base_seed * 1_000_000 + done[0]
        jr = random.Random(seed ^ 0x5EED)
        fresh_p = 0.25 + (0.5 * min(1.0, stale[0] / stagnation) if stagnation else 0.0)
        start_state, start_t = None, 24.0
        if population and jr.random() > fresh_p:
            roll = jr.random()
            if len(population) >= 2 and roll < 0.35:                  # breed two elites
                pa = m.select_parent(population, jr)
                pb = m.select_parent(population, jr)
                for _ in range(3):
                    if pb is not pa:
                        break
                    pb = m.select_parent(population, jr)
                start_state = m.crossover(pa, pb, jr) or m.evolve_seed(pa, jr, pop_size)
                start_t = 9.0
            elif roll < 0.55 and best is not None:                    # refine the champion, very cool
                start_state, start_t = m.clone(best[2]["state"]), 4.0
            else:                                                     # mutate a ranked elite
                start_state = m.evolve_seed(m.select_parent(population, jr), jr, pop_size)
                start_t = 9.0
        try:
            _, score, res, att, succ, _ = m.run_restart((seed, iters, polish, start_state, start_t, weights))
        except _Stop:
            reason = "time limit reached"
            break
        except Exception as e:                                        # one bad restart should not kill the run
            emit(dict(type="log", msg=f"Restart {done[0] + 1} failed: {e}"))
            done[0] += 1
            stale[0] += 1
            continue
        done[0] += 1
        att_tot = [x + y for x, y in zip(att_tot, att)]
        succ_tot = [x + y for x, y in zip(succ_tot, succ)]
        if res:
            population = m.add_population(population, (score, res), pop_size)
        if res and score > best_score:
            improved = score > best_score + eps
            best, best_score = res, score
            best_box[0] = score
            stale[0] = 0 if improved else stale[0] + 1
            emit(dict(type="best", score=score, layouts=top_layouts(), restart=done[0]))
        else:
            stale[0] += 1
        if done[0] % BATCH == 0:
            weights = m.adapt_weights(att_tot, succ_tot)
            att_tot = [x * 0.9 for x in att_tot]
            succ_tot = [x * 0.9 for x in succ_tot]
        progress(force=True)

    odds = {n: w for n, w in zip(m.OP_NAMES, weights)}
    progress(force=True)
    emit(dict(type="done", reason=reason, restarts=done[0], elapsed=time.time() - t0,
              layouts=top_layouts(), odds=odds))
