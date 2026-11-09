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
import os
import tempfile
import random
import sys
import time
import types

MARKER = "# --------------------------------------------------------------- END CONFIG -"

INT_KEYS = {"ARMOR_COUNT", "MAX_EMPTY_RUN", "LIFT_COST", "VENT_COUNT", "VENT_LINK_COST",
            "MIN_LIFTS", "MAX_LIFTS", "START_LIFTS"}
FLOAT_KEYS = {"PRIORITY_WEIGHT", "W_ARMOR", "W_UNARMORED", "W_PRIORITY_UNARMORED", "W_FLOAT",
              "W_TRAVEL", "W_CORNER", "W_DISC", "CORNER_UNREACHABLE", "W_LIFT", "W_LTOUCH",
              "W_LIFT_BALANCE", "W_LIFT_COUNT", "W_GAP", "W_EMPTY", "W_RUN", "W_ISO", "W_SPREAD",
              "SPREAD_CAP", "W_VENT", "W_ARMOR_UNDER", "PRIORITY_UNDER_MULT", "W_ARMOR_OVER", "W_SIDE", "W_CENTER", "W_PATTERN", "W_SHELL", "W_NC_CLUSTER", "W_LIFT_DENSITY"}
# room types the optimizer pulls toward the middle of the combat block (CENTER_GROUPS)
CENTER_CATS = {"antiair"}


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
    if not hull or len({len(r) for r in hull}) != 1 or any(set(r) - {"x", ".", "r"} for r in hull):
        raise ValueError("Invalid hull: use equal-length rows containing only 'x' (inside), 'r' (resource space) and '.' (outside).")
    if not any("x" in r or "r" in r for r in hull):
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
    lines.append(f"WALK_NONCOMBAT = {bool(cfg.get('walk_noncombat', False))}")
    lines.append(f"VENT_GAME_LINKS = {bool(cfg.get('vent_game_links', False))}")
    if "rooms" in cfg:
        groups, meta = categorized_rooms(cfg["rooms"])
    else:                                       # older page: separate tables per kind
        groups = dict(priority=_rooms(cfg.get('priority_rooms', []), 'priority'),
                      combat=_rooms(cfg.get('combat_rooms', []), 'combat'),
                      noncombat=_rooms(cfg.get('noncombat_rooms', []), 'noncombat', True),
                      resource=_rooms(cfg.get('resource_rooms', []), 'resource', True))
        meta = None
    lines.append(f"PRIORITY_ROOMS = {groups['priority']!r}")
    lines.append(f"COMBAT_ROOMS = {groups['combat']!r}")
    lines.append(f"CENTER_GROUPS = {groups.get('center', [])!r}")
    lines.append(f"NONCOMBAT_ROOMS = {groups['noncombat']!r}")
    lines.append(f"RESOURCE_ROOMS = {groups['resource']!r}")
    lines.append(f"RESOURCE_ANYWHERE = {bool(cfg.get('resource_anywhere', True))}")
    if meta is not None:
        lines.append(f"ROOM_TAGS = {[md['cat'] for md in meta]!r}")
    priors = cfg.get("top50_priors")
    if priors and isinstance(priors, dict) and "edge_pref" in priors:
        # the optimizer reads its top-50 numbers from a file at import time: hand them over as one
        fd, path = tempfile.mkstemp(prefix="top100_priors_", suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(priors, f)
        lines.append(f"TOP50_FILE = {path!r}")
    pat = cfg.get("patterns") or {}
    adj = {str(k): float(v) for k, v in (pat.get("adj") or {}).items()}
    edge = {str(k): float(v) for k, v in (pat.get("edge") or {}).items()}
    lines.append(f"TAG_ADJ = {adj!r}")
    lines.append(f"TAG_EDGE = {edge!r}")
    return "\n".join(lines), meta


KINDS = ("priority", "combat", "noncombat", "resource")
# symbols for non-combat / resource rows: upper case, never one the optimizer reserves (A L V P x . # ~)
NC_SYMBOLS = "XBCDEFGHIJKMNOQRSTUWYZ!$%&*+=?@^<>:;'\"(){}[]|/\\,_`"


def _armor_range(v, label):
    """'' / None = use the default sweet spot; '4-6' or [4, 6] = this room's own range."""
    if v in (None, "", "auto"):
        return None
    if isinstance(v, str):
        parts = v.replace(" ", "").replace("to", "-").split("-")
        if len(parts) != 2:
            raise ValueError(f"{label}: armor sweet spot must look like 4-6 (or be left empty).")
        v = parts
    try:
        lo, hi = int(v[0]), int(v[1])
    except (TypeError, ValueError, IndexError):
        raise ValueError(f"{label}: armor sweet spot must look like 4-6 (or be left empty).")
    if not 0 <= lo <= hi:
        raise ValueError(f"{label}: armor sweet spot needs low <= high.")
    return (lo, hi)


def categorized_rooms(rows):
    """Turn the page's room list (name, category, kind, size, count, armor) into the optimizer's room
    groups, one group per row, and return per-room labels in the order the optimizer builds ROOMS."""
    groups = {k: [] for k in KINDS}
    groups["center"] = []
    order = {k: [] for k in KINDS}
    syms = iter(NC_SYMBOLS)
    for i, row in enumerate(rows):
        kind = row.get("kind")
        if kind not in KINDS:
            raise ValueError(f"Room row {i + 1}: unknown room kind {kind!r}.")
        name = str(row.get("name") or row.get("catLabel") or "Room").strip()[:40]
        w, h, c = int(row.get("w", 0)), int(row.get("h", 0)), int(row.get("count", 0))
        if c <= 0:
            continue
        if w <= 0 or h <= 0:
            raise ValueError(f"{name}: width and height must be at least 1.")
        if kind == "combat" and str(row.get("cat")) in CENTER_CATS:
            groups["center"].append(len(groups["combat"]))      # index of the group about to be added
        if kind in ("priority", "combat"):
            rg = _armor_range(row.get("armor"), name)
            groups[kind].append((w, h, c) + ((rg,) if rg else ()))
        else:
            try:
                sym = next(syms)
            except StopIteration:
                raise ValueError(f"Too many non-combat / resource room rows (at most {len(NC_SYMBOLS)}).")
            groups[kind].append((name, sym, w, h, c))
        info = dict(name=name, short=str(row.get("short") or "")[:4], cat=str(row.get("cat", kind)), catLabel=str(row.get("catLabel", kind)), kind=kind)
        order[kind].extend(dict(info, n=j + 1, of=c) for j in range(c))
    meta = order["priority"] + order["combat"] + order["noncombat"] + order["resource"]
    return groups, meta


def build_module(cfg, source_path):
    with open(source_path, "r", encoding="utf-8") as f:
        src = f.read()
    if MARKER not in src:
        raise RuntimeError("Optimizer source has no END CONFIG marker; cannot inject settings.")
    # multiprocessing is not available in the browser and the single-process driver never uses it
    src = src.replace("from multiprocessing import Pool, Value", "Pool = Value = None")
    injection, meta = build_injection(cfg)
    src = src.replace(MARKER, injection + "\n" + MARKER, 1)
    sys.argv = ["ship_layout_finder.py"]     # the optimizer reads --hull/--top50 from argv at import time
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
    if meta is not None and len(meta) != mod.NR:
        raise RuntimeError(f"Room bookkeeping mismatch ({len(meta)} labels for {mod.NR} rooms).")
    mod.ROOM_META = meta
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
        meta = getattr(m, "ROOM_META", None)
        extra = {}
        if meta:
            md = meta[r]
            n = md["name"] + (f" #{md['n']}" if md["of"] > 1 else "")
            extra = dict(center=r in getattr(m, "CENTER_IDX", ()), label=md["name"], short=md.get("short", ""), cat=md["cat"], catLabel=md["catLabel"], kind=md["kind"])
        rooms.append(dict(extra, name=n, sym=sym, w=w, h=h, x=x, y=y, combat=bool(comb),
                          priority=r in m.PRIORITY_SET,
                          armor=touch.get(r, 0) if comb else None,
                          range=list(rg) if rg else None))
    for rm in rooms[m.NC:]:
        rm["resource"] = False
    for r in getattr(m, "RES_IDX", ()):
        rooms[r]["resource"] = True
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
        pattern=info.get("pattern", 0.0),
        sweet_spot_shortfall=info["range_under"], sweet_spot_excess=info["range_over"],
        center_rooms=len(getattr(m, "CENTER_IDX", ())), center_distance=info.get("center_dist", 0.0),
    )
    res_tiles = sorted([list(t) for t in getattr(m, "RES_TILES", ())], key=lambda t: (t[1], t[0]))
    cp = info.get("center_point") if getattr(m, "CENTER_IDX", None) else None
    state = dict(pos=[list(p) for p in st["pos"]], lifts=[list(l) for l in st["lifts"]], vents=[list(v) for v in st["vents"]])
    return dict(score=score, width=m.W, height=m.H, state=state, combat_center=list(cp) if cp else None, resource_tiles=res_tiles, grid=["".join(row) for row in g],
                rooms=rooms, bonus=bonus, lifts=[list(l) for l in st["lifts"]],
                vents=[list(v) for v in st["vents"]], armor=sorted([list(t) for t in info["armor"]], key=lambda t: (t[1], t[0])),
                legend=legend, stats=stats)


def template_state(m, tpl, rng):
    """A legal layout of the current rooms that copies a top player's room placement as far as it fits."""
    meta = getattr(m, "ROOM_META", None)
    if not meta:
        return None
    st = m.clone(m.init_state(rng))
    avail = [dict(x=int(r[0]), y=int(r[1]), w=int(r[2]), h=int(r[3]), cat=str(r[4])) for r in tpl.get("rooms", [])]
    used = [False] * len(avail)
    kind_of = {"reactor": "priority", "shield": "priority", "priority": "priority", "crew": "noncombat",
               "noncombat": "noncombat", "resource": "resource"}
    assigned = set()
    tests = (lambda md, t: md["cat"] == t["cat"],
             lambda md, t: md["kind"] == kind_of.get(t["cat"], "combat"),
             lambda md, t: True)
    for test in tests:
        for r in range(m.NR):
            if r in assigned:
                continue
            w, h = m.ROOMS[r][2], m.ROOMS[r][3]
            for i, t in enumerate(avail):
                if not used[i] and t["w"] == w and t["h"] == h and test(meta[r], t):
                    used[i] = True
                    assigned.add(r)
                    st["pos"][r] = (t["x"], t["y"])
                    break
    lifts = sorted((tuple(int(v) for v in l) for l in tpl.get("lifts", [])), key=lambda l: l[1] - l[2])
    lifts = [l for l in lifts if l[2] - l[1] >= 1][: m.MAX_LIFTS]
    if len(lifts) >= m.MIN_LIFTS:
        st["lifts"] = lifts
    st["vents"] = []
    tpl_vents = [tuple(int(v) for v in vt) for vt in tpl.get("vents", [])]
    # Rooms the top player did not have go into free space (largest first). If one does not fit, give up
    # a copied spot (non-combat first) and try again.
    release = sorted(assigned, key=lambda r: ({"resource": 0, "noncombat": 1, "combat": 2, "priority": 3}[meta[r]["kind"]],
                                             -m.ROOMS[r][2] * m.ROOMS[r][3]))
    for _ in range(len(release) + 1):
        if _fill_free(m, st, assigned):
            if m.occupancy(st) is None:
                return None
            for vt in tpl_vents:                      # the top player's vents, where they still fit
                if len(st["vents"]) >= m.VENT_COUNT:
                    break
                if m.occupancy(dict(st, vents=st["vents"] + [vt])) is not None:
                    st["vents"].append(vt)
            return st
        if not release:
            break
        assigned.discard(release.pop(0))
    return None


def _fill_free(m, st, anchored):
    occ = set()
    for r in anchored:
        x, y = st["pos"][r]
        occ.update((xx, yy) for yy in range(y, y + m.ROOMS[r][3]) for xx in range(x, x + m.ROOMS[r][2]))
    for x, y0, y1 in st["lifts"]:
        occ.update((x, y) for y in range(y0, y1 + 1))
    if len(occ) != sum(m.ROOMS[r][2] * m.ROOMS[r][3] for r in anchored) + sum(y1 - y0 + 1 for _, y0, y1 in st["lifts"]):
        return False                                  # copied rooms / lifts overlap each other
    for r in sorted((r for r in range(m.NR) if r not in anchored), key=lambda r: -m.ROOMS[r][2] * m.ROOMS[r][3]):
        w, h = m.ROOMS[r][2], m.ROOMS[r][3]
        spot = None
        for y in range(m.H - h + 1):
            for x in range(m.W - w + 1):
                if m.rect_ok(x, y, w, h, r) and not any((xx, yy) in occ for yy in range(y, y + h) for xx in range(x, x + w)):
                    spot = (x, y)
                    break
            if spot:
                break
        if spot is None:
            return False
        st["pos"][r] = spot
        occ.update((xx, yy) for yy in range(spot[1], spot[1] + h) for xx in range(spot[0], spot[0] + w))
    return True


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

    def top_layouts():
        if best is None:
            return []
        others = sorted((p for p in population if p[1][2]["state"] != best[2]["state"]), key=lambda p: -p[0])
        return [layout_json(m, best)] + [layout_json(m, r) for _, r in others[:4]]

    # Top-100 layouts on this hull: place the user's rooms where the top player put rooms of the same
    # type and size (then same kind and size, then same size), shove the rest out of the way, and use
    # them as starting layouts.
    tpl_states = []
    for k, tpl in enumerate(cfg.get("templates") or []):
        try:
            st = template_state(m, tpl, random.Random(base_seed * 7 + k))
        except _Stop:
            break
        except Exception:
            st = None
        if st:
            tpl_states.append(st)
    if tpl_states:
        emit(dict(type="log", msg=f"Starting from {len(tpl_states)} top-100 layout{'s' if len(tpl_states) > 1 else ''} on this hull."))
    page_seeds = list(cfg.get("seed_states") or [])

    # Starting layouts handed in by the page (previous run's best, or another core's best). Ones that do
    # not fit the current hull / room list are skipped.
    used = 0
    for si, sd in enumerate(page_seeds + [dict(pos=t["pos"], lifts=t["lifts"], vents=t["vents"]) for t in tpl_states]):
        try:
            st = dict(pos=[tuple(int(v) for v in p) for p in sd["pos"]],
                      lifts=[tuple(int(v) for v in l) for l in sd["lifts"]],
                      vents=[tuple(int(v) for v in vt) for vt in sd["vents"]])
            if len(st["pos"]) != m.NR:
                continue
            score, res = m.score_state(st)
        except _Stop:
            break
        except Exception:
            continue
        if not res:
            continue
        used += si < len(page_seeds)
        population = m.add_population(population, (score, res), pop_size)
        if score > best_score:
            best, best_score = res, score
            best_box[0] = score
    if used:
        emit(dict(type="log", msg=f"Continuing from {used} saved layout{'s' if used > 1 else ''}."))
    if best is not None:
        emit(dict(type="best", score=best_score, layouts=top_layouts(), restart=0))
    weights = list(m.OP_WEIGHTS)
    att_tot, succ_tot = [0.0] * m.NOPS, [0.0] * m.NOPS
    reason = "finished"

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
