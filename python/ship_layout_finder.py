#!/usr/bin/env python3
"""
Ship layout FINDER, free-form version (no fixed decks).

    python3 ship_layout_finder_free.py
    python3 ship_layout_finder_free.py --seed 3 --iters 20000 --restarts 30

Every room (combat AND non-combat) gets its own (x, y); lifts are vertical segments
(x, y_top, y_bottom); vents are single 1x1 tiles that link the rooms on their left and right.
The search decides how many "decks" there are, and where.

Walking model:
  * a combat room's floor = its bottom row of tiles (non-combat rooms are not walkable)
  * you can walk sideways between floor tiles, lift tiles and empty tiles
  * you can only move up/down along lift tiles (each vertical step costs 1 + LIFT_COST)
  * a VENT is a 1x1 tile in the gap between two combat rooms, on the floor row of BOTH (it touches
    the bottom-right corner of the room on its left and the bottom-left corner of the one on its
    right); it joins those two floor tiles (cost 1 per side). Upper corners never connect.
    Vents may not touch each other (not even diagonally) and are never used for anything else.
  * armor, other rooms and hull block walking
  * every lift tile must touch a combat room or an armor tile; lift ends must sit beside a floor

Engine:
  * validity-preserving moves: every mutation places/moves something and then a small physics-style
    "shove" pushes any overlapping room out of the way (minimal displacement), so almost every
    candidate is a legal layout instead of being thrown away
  * non-combat rooms (beds etc.) live inside the search array with armor weight 0
  * walking distances run Dijkstra over a compressed node graph (rooms, lift tiles, vent links),
    not over every tile
  * population diversity uses a translation-invariant adjacency signature, so a deck that merely
    slid one tile is recognised as the same design
  * LEARNING: every restart reports which move types improved the layout; the search shifts its
    move odds toward what works (printed at the end). New starts are bred from the elite population:
    mutate an elite, CROSSOVER two elites (left part of one + right part of the other), or refine the
    champion at a low temperature; the share of brand-new random starts grows when progress stalls.
    The checkpoint stores the population and the learned odds, and the next run resumes from it
    (--fresh ignores it). Lift moves include 'lift_fit', which places a lift straight between two decks.
  * ARMOR: tiles are allocated by marginal gain so every room lands in its sweet-spot range when it can

Score = weighted armor touchpoints (Shield + Reactors count PRIORITY_WEIGHT times)
        - W_TRAVEL * average walking time between combat rooms
        - W_CORNER * travel time between the rooms nearest the 4 hull corners (mean of max and avg)
        - W_GAP    * empty corridor tiles that the walking network needs
        - W_DISC   * pairs of combat rooms that cannot reach each other
        - W_LIFT   * lift columns that do not link at least two different floor rows
        - W_LIFT_COUNT * number of lifts (the search ADDS/REMOVES lifts between MIN_LIFTS and MAX_LIFTS)
        - W_VENT   * vents that do not link two different combat rooms
        - W_FLOAT  * armor tiles that touch no combat room (heavy)
        - W_ARMOR_UNDER / W_ARMOR_OVER * armor 'sweet spot' misses per room (see PRIORITY_ARMOR_RANGE, COMBAT_ARMOR_RANGE)
        - W_RUN    * empty horizontal run length beyond MAX_EMPTY_RUN
        - W_ISO    * non-combat rooms touching armor/lifts
        + W_SPREAD * average distance between priority rooms (capped)
        - W_CENTER * distance of each CENTER room (e.g. anti-air) from the middle of the other combat rooms
        + W_PATTERN * room patterns learned from top ships (which room types sit next to each other,
                      which sit on the hull edge; see section 10 and tools/analyze_top.py)
  With --top50 layouts.json (lessons learned from the top-50 ladder ships, see section 8 of the config):
        + W_SHELL  * hull-edge contact, weighted per room kind by how top ships use the edge
                     (non-combat rooms form the outer shell, combat rooms stay inside)
        - W_NC_CLUSTER   * non-combat rooms that touch no other non-combat room
        - W_LIFT_DENSITY * lifts outside the top-50 'hull width per lift column' band
        and the armor sweet spots are set from how much armor top ships put around each room kind.

    python3 ship_layout_optimizer_user.py --top50 layouts.json
Pure Python 3, no dependencies.
"""
import argparse
import heapq
import json
import math
import os
import random
import threading
import time
import sys
from collections import Counter, defaultdict
from multiprocessing import Pool, Value

try:                      # numpy is only needed for the optional --learn (GNN + RL) mode
    import numpy as np
except ImportError:
    np = None

# ----------------------------------------------------------------- CONFIG ---
DEFAULT_HULL = [
    "..................................................",  # y0
    "..................................................",  # y1
    ".........xxxx...xxxx...xxxx...xxxxxxxxxx..........",  # y2
    ".........xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx..........",  # y3
    ".........xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx..........",  # y4
    ".........xxxx...xxxx...xxxx...xxxxxxxxxx..........",  # y5
    ".........xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx..........",  # y6
    ".........xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx..........",  # y7
    ".........xxxx...xxxx...xxxx...xxxxxxxxxx..........",  # y8
    ".........xxxx...xxxx...xxxx...xxxxxxxxxx..........",  # y9
    ".........xxxx...xxxx...xxxx...xxxxxxxxxx..........",  # y10
    ".........xxxx...xxxx...xxxx...xxxxxxxxxx..........",  # y11
    ".........xxxx...xxxx...xxxx...xxxxxxxxxx..........",  # y12
    ".........xxxx...xxxx...xxxx...xxxxxxxxxx..........",  # y13
    "..................................................",  # y14
    "..................................................",  # y15
]

def _hull_from_cli(default):
    """Read hull override before geometry globals are built, so every subsystem uses it."""
    rows = None
    for i, arg in enumerate(sys.argv):
        if arg == "--hull" and i + 1 < len(sys.argv):
            rows = sys.argv[i + 1].split("/")
        elif arg.startswith("--hull="):
            rows = arg.split("=", 1)[1].split("/")
        elif arg == "--hull-file" and i + 1 < len(sys.argv):
            with open(sys.argv[i + 1], "r", encoding="utf-8") as f:
                rows = [line.strip() for line in f if line.strip() and not line.lstrip().startswith(";")]
    if rows is None:
        return ["".join(r.split()) for r in default]
    rows = ["".join(row.split()) for row in rows if row.strip()]        # tabs/spaces between tiles are ignored
    if not rows or len({len(row) for row in rows}) != 1 or any(set(row) - {"x", ".", "r"} for row in rows):
        raise SystemExit("Invalid hull: use equal-length rows containing only 'x' (inside), 'r' (resource space) and '.' (outside).")
    if not any(("x" in row or "r" in row) for row in rows):
        raise SystemExit("Invalid hull: at least one 'x' tile is required.")
    return rows

HULL = _hull_from_cli(DEFAULT_HULL)
ARMOR_COUNT = 45
MAX_EMPTY_RUN = 3
LIFT_COST = 1           # extra cost per vertical step on a lift
VENT_COUNT = 8          # maximum number of vents (0 disables vents)
VENT_LINK_COST = 1      # cost to step between a vent and the adjacent room (plus the drop to its floor)
PRIORITY_WEIGHT = 3.0   # armor touchpoint weight for PRIORITY rooms (normal combat rooms = 1)
PLACE_BONUS_ROOMS = True
SA_SOURCES = 6          # preliminary scoring source count (full score uses all rooms)
POPULATION_SIZE = 12
DEFAULT_STAGNATION = 20
IMPROVEMENT_EPSILON = 0.1
DUP_DISTANCE = 2        # layouts whose adjacency signatures differ by <= this count as duplicates

# ==============================================================================
# OPTIMIZATION WEIGHTS — EDIT THIS SECTION TO TUNE THE LAYOUT
# Larger values make the corresponding score term matter more.
# Positive weights are rewards; penalties are subtracted from the final score.
# These are grouped by purpose and each weight is on its own line for easy editing.
# ==============================================================================

# 1) Armor and room protection
W_ARMOR = 1.0                 # Reward for armor touchpoints around combat rooms
W_UNARMORED = 250.0            # VERY LARGE penalty for EACH combat room with zero armor
W_PRIORITY_UNARMORED = 500.0   # EXTRA penalty for each unarmored priority room
W_FLOAT = 45.0                 # Penalty per armor tile that protects no combat room
PRIORITY_WEIGHT = 3.0          # Armor touchpoint reward multiplier for priority rooms

# 2) Crew travel and connectivity
W_TRAVEL = 5.0                 # Penalty multiplier for average combat-room travel time
W_CORNER = 4.0                 # Penalty for long travel between extreme hull corners
W_DISC = 500.0                 # Huge penalty for disconnected combat-room pairs
CORNER_UNREACHABLE = 60.0      # Assumed travel time for an unreachable corner pair

# 3) Lifts and traffic flow
W_LIFT = 35.0                  # Penalty for short, broken, or useless lift components
W_LTOUCH = 25.0                # Penalty for lift tiles that touch nothing useful
W_LIFT_BALANCE = 50.0          # Penalty when shortest-path traffic overuses one lift
# Side preference (e.g. weapons toward the enemy-facing end). Maps a room symbol to -1..+1:
# +1 = wants the RIGHT end of the hull, -1 = the LEFT end, 0 = indifferent. {} switches it off.
# Symbols: "P" priority rooms, or the size digit of a combat group ("2", "3", "4", "5").
SIDE_PREF = {}                  # example: {"P": -1.0, "3": 1.0}
W_SIDE = 4.0                    # score per room at full preference (scaled by how far toward that end it sits)
W_LIFT_COUNT = 8.0            # Cost PER LIFT: the search only keeps a lift if it earns more than this
MIN_LIFTS = 2                  # Fewest lift columns the search may use (set 1 to allow a single lift)
MAX_LIFTS = 6                  # Most lift columns the search may use
START_LIFTS = 2                # Lifts in the initial random layouts (the search adds/removes from here)
LIFT_COST = 2                  # Extra travel cost per vertical step on a lift

# 4) Corridors, empty space, and room zoning
W_GAP = 12.0                   # Cost per corridor tile reserved for walking
W_EMPTY = 6                  # Penalty per unused interior hull tile outside corridors
W_RUN = 6.0                    # Penalty for horizontal empty runs longer than MAX_EMPTY_RUN
W_ISO = 25.0                   # Penalty for undesirable mixing of non-combat and combat zones
MAX_EMPTY_RUN = 3              # Longest horizontal empty run before W_RUN applies

# 5) Priority-room spacing and vents
W_SPREAD = 1.5                 # Reward for spacing priority systems apart (0 disables)
SPREAD_CAP = 24.0              # Maximum average distance that earns spacing reward
W_VENT = 15.0                  # Penalty per vent that fails to link two combat rooms
VENT_COUNT = 8                 # Maximum vents (0 disables vents)
VENT_LINK_COST = 1             # Cost to step between a vent and adjacent room / floor

# 6) Search behavior (not score weights)
ARMOR_COUNT = 45               # Number of armor tiles available
PLACE_BONUS_ROOMS = True       # Automatically place bonus rooms
SA_SOURCES = 12                 # Source count used by preliminary annealing scoring
POPULATION_SIZE = 24           # Maximum number of diverse elite layouts retained
DEFAULT_STAGNATION = 50        # Stop after this many batches without meaningful progress
IMPROVEMENT_EPSILON = 0.01      # Minimum score gain counted as meaningful progress
DUP_DISTANCE = 3                # Adjacency-signature distance used to identify duplicates

CORNER_UNREACHABLE = 60.0   # travel time assumed for an unreachable corner pair

# 7) Armor "sweet spot": how many armor tiles touching a room is good ENOUGH.
#    A range is (low, high) = armor tiles orthogonally touching ONE room.
#      * below low  : penalized, per missing tile
#      * low..high  : fully rewarded (each touching tile earns armor reward)
#      * above high : no extra reward AND a small penalty (that armor is better spent on another room)
#    Use None instead of a range to switch the sweet spot off (more armor is then always better).
#    These are the defaults for each kind of room; any single room group below can override them by
#    adding a 4th item:  (width, height, count, (low, high))
PRIORITY_ARMOR_RANGE = (3, 6)      # every PRIORITY room group (unless it gives its own range)
COMBAT_ARMOR_RANGE = (2, 6)        # every normal combat room group (unless it gives its own range)
W_ARMOR_UNDER = 25.0               # penalty per armor tile a room is short of its low end
PRIORITY_UNDER_MULT = 2.0          # ...times this for priority rooms
W_ARMOR_OVER = 2.0                 # penalty per armor tile above a room's high end

# 8) Lessons from the top-50 ladder ships. Only active when a top-50 file is given
#    (--top50 layouts.json on the command line, or set TOP50_FILE below). The file can be the
#    layouts.json from pixyship_fetch_layouts.py; the numbers below are then measured from it.
TOP50_FILE = None                  # e.g. "layouts.json"; the --top50 option overrides this
TOP50_ARMOR_RANGES = False         # True: replace PRIORITY/COMBAT_ARMOR_RANGE with the top-50 armor-per-room
                                   # range (top ships give priority rooms the same 2-4 tiles as other combat
                                   # rooms; False keeps your own sweet spots and only reports the comparison)
W_SHELL = 3.0                      # per hull-edge tile a room touches, times that room kind's learned edge
                                   # preference (non-combat rooms on the edge are rewarded, combat penalized)
W_NC_CLUSTER = 15.0                # penalty per non-combat room that touches no other non-combat room
W_LIFT_DENSITY = 20.0              # penalty per lift outside the top-50 band of lifts for this hull's width

# 9) CENTER rooms (e.g. anti-air): pulled toward the middle of all the OTHER combat rooms, so they sit
#    in the heart of the combat block. The middle is the average centre of every other combat room
#    (priority rooms included); the penalty is the Manhattan distance, in tiles, from that point.
#    List COMBAT_ROOMS groups by position (0 = first line). [] switches it off.
CENTER_GROUPS = []                 # example: [2] if the 3rd COMBAT_ROOMS line is your anti-air
W_CENTER = 3.0                     # penalty per tile a center room sits away from the combat middle

# 10) Room PATTERNS learned from top ships (tools/analyze_top.py measures them from the top-100 ladder).
#     Every room has a tag (its type: reactor, laser, bedroom ...). TAG_ADJ scores each pair of touching
#     rooms by how much more (+) or less (-) often top ships put those two types side by side than chance;
#     TAG_EDGE scores how much of a room's outline is hull edge, by type. W_PATTERN = 0 switches it off.
ROOM_TAGS = []                     # one tag per room, in room order; [] = tag rooms by kind
TAG_ADJ = {}                       # {"laser|reactor": 0.8, ...}  two tags in alphabetical order joined by |
TAG_EDGE = {}                      # {"crew": 1.1, "reactor": -0.9, ...}  score at a fully edge-facing outline
W_PATTERN = 0.0                    # strength of the learned patterns

# 15) BOOSTERS only help the rooms they touch. ROOM_BOOSTS gives, per room (same order as ROOM_TAGS), the room
#     tags that room boosts ([] for rooms that are not boosters). Measured on the top-100 ships: Gunnery Core
#     sits by lasers and cannons, Missile Matrix by missile rooms, Flight Controller by hangars, Auxiliary
#     Booster by any combat room. W_BOOST is earned for every boosted room touching a booster.
ROOM_BOOSTS = []
W_BOOST = 0.0

# 11) Walking through non-combat rooms. In the game crew walk along the floor of EVERY room; this
#     optimizer's original model only lets them use combat-room floors. True = game-like walking:
#     bedrooms, storage etc. become walkable floor too (needed to score real top ships as connected).
WALK_NONCOMBAT = False

# 13) Game-like Service Vents (Pixel Starships wiki, "Service Vent"):
#       * horizontal movement only: vents carry crew sideways across the ship, as lifts carry them up and down
#       * a vent connects to a room only where it touches that room's BOTTOM row (its floor)
#       * vents may sit side by side to form a longer horizontal passage; a passage that ends beside a lift
#         connects to it
#       * a passage counts as useful only if it joins two different rooms/lifts; vents that do not help
#         crew reach rooms are removed after each search (prune_vents)
#     False = this optimizer's original vents (single vents between two combat rooms; vents may not touch).
VENT_GAME_LINKS = False

# 14) CONNECT_ALL: after each search, add vents (where allowed) and lifts until every combat room can be
#     reached from every other one, if that is possible; vents are never removed if that would cut a room off.
CONNECT_ALL = False

# 12) STYLE. "original" = the weights above. "top" = armor-first weights that bring layouts close to the
#     top-100 ladder ships (tools/benchmark_top.py: same hull and rooms as real top ships, ~95% of their armor
#     value, more armor on priority rooms, 2 lifts like them; crew reach is traded away the way top players do).
#     Also on the command line:  --style top
STYLE = "original"
TOP_STYLE = dict(W_ARMOR=4.0, W_DISC=30.0, W_TRAVEL=0.75, W_CORNER=0.4, W_GAP=2.5,
                 MIN_LIFTS=1, MAX_LIFTS=4, W_LIFT_COUNT=18.0)

# ---- ROOMS: (width, height, how_many[, (armor_low, armor_high)]) ----------------------------------------------
# Priority combat rooms: armor is concentrated on these (e.g. Reactors + Shield).
PRIORITY_ROOMS = [
    (3, 2, 4),      # 3 Reactors + 1 Shield Room
]
# Normal combat rooms, by size.
COMBAT_ROOMS = [
    (2, 2, 4),      # 2x Photon Phaser Android Studio, Shield Battery
    (3, 2, 6),      # 2x Mining Laser,2x Plasma Discharger, GDS, CLoak
    (4, 2, 1),      # Freeze Ray
    (4, 2, 1),      # Reactor
    (3, 3, 1),      # ION
    (5, 2, 2),      # Drone Hangar, Fighter Hangar
]
# Non-combat rooms (kept away from armor/lifts). Fully customizable: add, remove or rename
# categories freely. Each entry is (name, symbol, width, height, how_many).
#   * symbol: one unused character (not . # A L V x P, not a digit, not a letter used by combat rooms)
#   * they take part in the layout search with armor weight 0 (they never attract armor)
NONCOMBAT_ROOMS = [
    ("Bedroom", "X", 3, 2, 9),
    # ("Cargo Bay", "C", 4, 2, 2),
    # ("Medbay", "M", 2, 2, 3),
]
# Resource rooms (reactors, mines, storage ... anything that belongs in RESOURCE SPACE). Mark resource
# space in the hull with 'r' (inside the hull, like 'x'). Rules:
#   * ONLY resource rooms may be placed on 'r' tiles: every other room, lift, vent, armor and filler is
#     kept off them
#   * resource rooms are scored exactly like non-combat rooms (never attract armor, never walkable)
#   * with RESOURCE_ANYWHERE = True they may also sit on ordinary 'x' tiles (never straddling both kinds);
#     False confines them to 'r' space
# Each entry is (name, symbol, width, height, how_many); symbols must be unused (not . # A L V x ~ P, digits...)
RESOURCE_ROOMS = [
    # ("Reactor", "R", 2, 2, 3),
    # ("Storage", "S", 3, 2, 2),
]
RESOURCE_ANYWHERE = True
BONUS_SIZE = (3, 2)     # filler rooms placed wherever they fit after the search
# --------------------------------------------------------------- END CONFIG -

# ------------------------------------------------------- top-50 priors ----
# Room kinds in the PixyShip data, mapped onto this optimizer's three kinds of room.
_T50_PRIORITY = {"Reactor", "Shield"}
_T50_NONCOMBAT = {"Bedroom", "Storage", "Council", "Research", "Training", "Recycling", "Printer",
                  "Gas", "Bridge", "Medical", "Reviver"}


def _t50_kind(room_type):
    if room_type in _T50_PRIORITY:
        return "priority"
    if room_type in _T50_NONCOMBAT:
        return "noncombat"
    if room_type in ("Armor", "Lift", "Corridor"):
        return room_type.lower()
    return "combat"


def ring_of(x, y, w, h):
    """Tiles orthogonally touching a w x h rectangle (corners excluded)."""
    return ([(xx, y - 1) for xx in range(x, x + w)] + [(xx, y + h) for xx in range(x, x + w)]
            + [(x - 1, yy) for yy in range(y, y + h)] + [(x + w, yy) for yy in range(y, y + h)])


def _pct(values, q):
    v = sorted(values)
    return v[min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))]


def top50_priors(layouts):
    """Measure how top ladder ships arrange their hulls. Empty tiles next to a room count as the hull
    edge (top ships are packed, so an unoccupied neighbour is almost always outside the hull)."""
    kinds = ("priority", "combat", "noncombat")
    armor = {k: [] for k in kinds}
    edge = {k: [0, 0] for k in kinds}             # [edge tiles, perimeter tiles]
    nc_touch, width_per_lift, armor_rooms = [], [], Counter()
    for lay in layouts:
        rooms = lay["rooms"]
        rect = [(int(r["column"]), int(r["row"]), int(r["width"]), int(r["height"])) for r in rooms]
        kind = [_t50_kind(r["type"]) for r in rooms]
        occ = {}
        for i, (x, y, w, h) in enumerate(rect):
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    occ[(xx, yy)] = i
        for i, (x, y, w, h) in enumerate(rect):
            k = kind[i]
            if k == "armor":
                armor_rooms[min(3, len({occ[t] for t in ring_of(x, y, w, h)
                                        if t in occ and kind[occ[t]] in ("priority", "combat")}))] += 1
            if k not in armor:
                continue
            ring = ring_of(x, y, w, h)
            armor[k].append(sum(1 for t in ring if t in occ and kind[occ[t]] == "armor"))
            edge[k][0] += sum(1 for t in ring if t not in occ)
            edge[k][1] += len(ring)
            if k == "noncombat":
                nc_touch.append(any(t in occ and occ[t] != i and kind[occ[t]] == "noncombat" for t in ring))
        cols = {x for (x, _, _, _), k in zip(rect, kind) if k == "lift"}
        if cols:
            span = max(x + w for x, _, w, _ in rect) - min(x for x, _, _, _ in rect)
            width_per_lift.append(span / len(cols))
    if not width_per_lift or not all(armor.values()):
        raise SystemExit("--top50: the file has too few rooms/lifts to learn from.")
    overall = sum(e for e, _ in edge.values()) / sum(p for _, p in edge.values())
    share = {k: e / p for k, (e, p) in edge.items()}
    n_arm = sum(armor_rooms.values()) or 1
    return {
        "ships": len(layouts),
        "armor_touch": {k: [_pct(v, 0.25), _pct(v, 0.5), _pct(v, 0.75)] for k, v in armor.items()},
        "armor_range": {k: [max(1, _pct(armor[k], 0.25)), max(1, _pct(armor[k], 0.75))]
                        for k in ("priority", "combat")},
        "edge_share": share,
        # log2(this kind's edge share / everyone's): + = top ships put this kind on the edge more than average
        "edge_pref": {k: math.log2(max(share[k], 1e-3) / overall) for k in kinds},
        "nc_cluster_share": sum(nc_touch) / len(nc_touch) if nc_touch else 1.0,
        "width_per_lift": [_pct(width_per_lift, 0.25), _pct(width_per_lift, 0.5), _pct(width_per_lift, 0.75)],
        "armor_shared_share": (armor_rooms[2] + armor_rooms[3]) / n_arm,
    }


def _top50_path():
    for i, arg in enumerate(sys.argv):
        if arg == "--top50" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
        if arg.startswith("--top50="):
            return arg.split("=", 1)[1]
    return TOP50_FILE


def _load_top50(path):
    """Priors from a PixyShip layouts.json (measured here) or a saved priors file. Read at import
    time, like --hull, so worker processes get the same settings on every platform."""
    if not path:
        return None
    cache = path + ".priors.json"
    try:
        if os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(path):
            with open(cache, encoding="utf-8") as f:
                return json.load(f)
    except (OSError, ValueError):
        pass
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise SystemExit(f"--top50: cannot read {path}: {e}")
    if isinstance(data, dict) and "edge_pref" in data:
        return data                                   # already a priors file
    layouts = data.get("layouts") if isinstance(data, dict) else data
    if not layouts:
        raise SystemExit(f"--top50: {path} has no 'layouts' list (expected the layouts.json from the fetch script).")
    pri = top50_priors(layouts)
    try:                                              # cache, so worker processes skip the 12 MB parse
        with open(cache, "w", encoding="utf-8") as f:
            json.dump(pri, f, indent=1)
    except OSError:
        pass
    return pri


for _i, _a in enumerate(sys.argv):                       # --style top / --style=top (read at import, like --hull)
    if _a == "--style" and _i + 1 < len(sys.argv):
        STYLE = sys.argv[_i + 1]
    elif _a.startswith("--style="):
        STYLE = _a.split("=", 1)[1]
if STYLE == "top":
    globals().update(TOP_STYLE)
elif STYLE != "original":
    raise SystemExit(f"STYLE must be 'original' or 'top', not {STYLE!r}")

TOP50 = _load_top50(_top50_path())
if TOP50 and TOP50_ARMOR_RANGES:
    PRIORITY_ARMOR_RANGE = tuple(TOP50["armor_range"]["priority"])
    COMBAT_ARMOR_RANGE = tuple(TOP50["armor_range"]["combat"])

H, W = len(HULL), len(HULL[0])
ROOMS = []  # (name, symbol, w, h, armor_weight, is_combat)
ARMOR_RANGES = []   # per room: (low, high) armor sweet spot, or None
SYMBOLS = {}
_pool = iter("abcdefghijkmnopqrstuvwyz")
CENTER_IDX = set()    # combat rooms that want the middle of the combat block (CENTER_GROUPS)
for kind, groups in (("Priority", PRIORITY_ROOMS), ("Combat", COMBAT_ROOMS)):
    _default_range = PRIORITY_ARMOR_RANGE if kind == "Priority" else COMBAT_ARMOR_RANGE
    for _gi, grp in enumerate(groups):
        w, h, c = grp[:3]
        _arange = grp[3] if len(grp) > 3 else _default_range
        if _arange is not None and not (0 <= _arange[0] <= _arange[1]):
            raise SystemExit(f"Armor range {_arange} for {kind} room {w}x{h} must be (low, high) with low <= high.")
        if c <= 0:
            continue
        sym = "P" if kind == "Priority" else (str(w) if h == 2 and w < 10 else next(_pool))
        SYMBOLS[sym] = f"{kind} room {w}x{h}"
        for i in range(c):
            ROOMS.append((f"{kind} room {w}x{h} #{i + 1}", sym, w, h,
                          PRIORITY_WEIGHT if kind == "Priority" else 1.0, True))
            ARMOR_RANGES.append(tuple(_arange) if _arange is not None else None)
            if kind == "Combat" and _gi in CENTER_GROUPS:
                CENTER_IDX.add(len(ROOMS) - 1)
NC = len(ROOMS)                       # combat rooms occupy indices 0..NC-1
PRIORITY_IDX = [i for i, rm in enumerate(ROOMS) if rm[1] == "P"]

_reserved_syms = set(SYMBOLS) | set(".#ALVx~")
NONCOMBAT_SYMBOLS = {}
for _n, _s, _w, _h, _c in NONCOMBAT_ROOMS:
    if len(_s) != 1 or _s in _reserved_syms or _s in NONCOMBAT_SYMBOLS:
        raise SystemExit(f"Non-combat room '{_n}': symbol '{_s}' is invalid or already in use "
                         f"(taken: {''.join(sorted(_reserved_syms | set(NONCOMBAT_SYMBOLS)))})")
    NONCOMBAT_SYMBOLS[_s] = _n
    for _i in range(_c):
        ROOMS.append((f"{_n} #{_i + 1}", _s, _w, _h, 0.0, False))
        ARMOR_RANGES.append(None)
RES_IDX = set()
for _n, _s, _w, _h, _c in RESOURCE_ROOMS:
    if len(_s) != 1 or _s in _reserved_syms or _s in NONCOMBAT_SYMBOLS:
        raise SystemExit(f"Resource room '{_n}': symbol '{_s}' is invalid or already in use")
    NONCOMBAT_SYMBOLS[_s] = _n
    for _i in range(_c):
        RES_IDX.add(len(ROOMS))
        ROOMS.append((f"{_n} #{_i + 1}", _s, _w, _h, 0.0, False))
        ARMOR_RANGES.append(None)
NR = len(ROOMS)
PRIORITY_SET = set(PRIORITY_IDX)


def _build_gain_tables():
    """gain[r][k] = score gained by giving combat room r its (k+1)-th touching armor tile."""
    tables = []
    for r in range(NR):
        if r >= NC:
            tables.append([0.0] * 32)
            continue
        wgt = ROOMS[r][4] * W_ARMOR
        rg = ARMOR_RANGES[r]
        pri = r in PRIORITY_SET
        under = W_ARMOR_UNDER * (PRIORITY_UNDER_MULT if pri else 1.0)
        first = W_UNARMORED + (W_PRIORITY_UNARMORED if pri else 0.0)
        col = []
        for k in range(32):
            if rg is None:
                g = wgt
            elif k < rg[1]:
                g = wgt + (under if k < rg[0] else 0.0)
            else:
                g = -W_ARMOR_OVER
            if k == 0:
                g += first                   # a room with no armor at all is the worst case
            col.append(g)
        tables.append(col)
    return tables


GAIN = _build_gain_tables()
NEIGH = ((1, 0), (-1, 0), (0, 1), (0, -1))
ALL_TILES = [(x, y) for y in range(H) for x in range(W) if HULL[y][x] in "xr"]      # every hull tile
RES_TILES = {(x, y) for (x, y) in ALL_TILES if HULL[y][x] == "r"}      # resource space
ROOM_KIND = ["priority" if r in PRIORITY_SET else ("combat" if r < NC else "noncombat") for r in range(NR)]
NNC = NR - NC
HULL_WIDTH = max(x for x, _ in ALL_TILES) - min(x for x, _ in ALL_TILES) + 1
# Preferred number of lift columns for this hull, from the top-50 'hull width per lift' quartiles
LIFT_BAND = (HULL_WIDTH / TOP50["width_per_lift"][2], HULL_WIDTH / TOP50["width_per_lift"][0]) if TOP50 else None
OFFSETS = sorted(((dx, dy) for dx in range(-6, 7) for dy in range(-4, 5) if dx or dy),
                 key=lambda d: abs(d[0]) + abs(d[1]))


OKG = [[c in "xr" for c in row] for row in HULL]
PS = None
def _sat(cell):
    t = [[0] * (W + 1) for _ in range(H + 1)]
    for _y in range(H):
        for _x in range(W):
            t[_y + 1][_x + 1] = t[_y][_x + 1] + t[_y + 1][_x] - t[_y][_x] + (1 if cell(_x, _y) else 0)
    return t


PS = _sat(lambda x, y: OKG[y][x])                      # summed-area table of hull tiles
PR = _sat(lambda x, y: HULL[y][x] == "r")              # summed-area table of resource tiles


def ok_tile(x, y):
    return 0 <= x < W and 0 <= y < H and OKG[y][x]


_OK_SET = None           # set of hull tiles, built on first use (same answer as ok_tile, much faster in loops)


def ok_set():
    global _OK_SET
    if _OK_SET is None:
        _OK_SET = frozenset((x, y) for y in range(H) for x in range(W) if OKG[y][x])
    return _OK_SET


def free_tile(x, y):
    """Hull tile that is NOT resource space (lifts, vents, armor and filler live here)."""
    return 0 <= x < W and 0 <= y < H and OKG[y][x] and (x, y) not in RES_TILES


def rect_ok(x, y, w, h, r=None):
    """True if the w x h rectangle lies on hull tiles AND respects resource space (O(1)): only resource
    rooms (room index r in RES_IDX) may use 'r' tiles; they never straddle resource and ordinary tiles."""
    if x < 0 or y < 0 or x + w > W or y + h > H:
        return False
    if PS[y + h][x + w] - PS[y][x + w] - PS[y + h][x] + PS[y][x] != w * h:
        return False
    if not RES_TILES:
        return True
    n = PR[y + h][x + w] - PR[y][x + w] - PR[y + h][x] + PR[y][x]
    if r is not None and r in RES_IDX:
        return n == w * h or (n == 0 and RESOURCE_ANYWHERE)
    return n == 0


def clone(st):
    return dict(pos=list(st["pos"]), lifts=list(st["lifts"]), vents=list(st["vents"]))


# ------------------------------------------------------------- geometry ----
def occupancy(state):
    """(tiles: tile->room idx, lifts: set, vents: set). None if illegal."""
    tiles = {}
    for r, (x, y) in enumerate(state["pos"]):
        w, h = ROOMS[r][2], ROOMS[r][3]
        if not rect_ok(x, y, w, h, r):
            return None
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                if (xx, yy) in tiles:
                    return None
                tiles[(xx, yy)] = r
    lifts = set()
    for x, y0, y1 in state["lifts"]:
        for y in range(y0, y1 + 1):
            t = (x, y)
            if not free_tile(x, y) or t in tiles or t in lifts:
                return None
            lifts.add(t)
    vents = set()
    for x, y in state["vents"]:
        t = (x, y)
        if not free_tile(x, y) or t in tiles or t in lifts or t in vents:
            return None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if (dx or dy) and (x + dx, y + dy) in vents and not (VENT_GAME_LINKS and dy == 0):
                    return None          # vents may not touch (game-like: only side by side, in a passage)
        vents.add(t)
    return tiles, lifts, vents


def reps_of(pos):
    """Walking anchor of every COMBAT room: middle of its floor row."""
    return [(pos[r][0] + (ROOMS[r][2] - 1) // 2, pos[r][1] + ROOMS[r][3] - 1) for r in range(NC)]


def vent_links(pos, vents, tiles):
    """For each vent: [(floor_tile, cost, room)] for rooms on its left/right whose floor row it sits on."""
    res = []
    for vx, vy in vents:
        links = []
        if VENT_GAME_LINKS:
            # rooms left and right whose bottom row the vent touches (any walkable room)
            for dx in (-1, 1):
                r = tiles.get((vx + dx, vy))
                if r is not None and (r < NC or WALK_NONCOMBAT) and pos[r][1] + ROOMS[r][3] - 1 == vy:
                    links.append(((vx + dx, vy), VENT_LINK_COST, r))
            res.append(((vx, vy), links))
            continue
        for dx in (-1, 1):
            r = tiles.get((vx + dx, vy))
            if r is not None and r < NC:
                fy = pos[r][1] + ROOMS[r][3] - 1
                if fy == vy:             # vents only attach at a room's bottom-left / bottom-right corner
                    links.append(((vx + dx, fy), VENT_LINK_COST, r))
        res.append(((vx, vy), links))
    return res


def vent_runs(vents):
    """Vents grouped into horizontal passages (runs of side-by-side vents), each sorted left to right."""
    vs = set(vents)
    runs = []
    for v in sorted(vs, key=lambda t: (t[1], t[0])):
        if (v[0] - 1, v[1]) in vs:
            continue
        run = [v]
        while (run[-1][0] + 1, v[1]) in vs:
            run.append((run[-1][0] + 1, v[1]))
        runs.append(run)
    return runs


def useless_vents(vlinks, lifts=()):
    """Game-like vents: the vents of every passage that does not join two different rooms/lifts, or that
    joins only non-combat rooms (crew never need a bedroom-to-bedroom passage)."""
    links = dict(vlinks)
    out = []
    for run in vent_runs(links):
        ends = set()
        for v in run:
            ends.update(("r", r) for _, _, r in links[v])
        x0, y = run[0]
        x1 = run[-1][0]
        ends.update(("l", t) for t in ((x0 - 1, y), (x1 + 1, y)) if t in lifts)
        serves_combat = any(k == "l" or v < NC for k, v in ends)
        if len(ends) < 2 or not serves_combat:
            out.extend(run)
    return out


def vent_penalty(vlinks, lifts=()):
    if VENT_GAME_LINKS:              # every vent of a passage that is not useful (see useless_vents)
        return len(useless_vents(vlinks, lifts))
    return sum(1 for _, links in vlinks if len({r for _, _, r in links}) < 2)


def walk_set(pos, lifts, vents, blocked):
    """Walkable tiles: ONLY combat-room floor rows and lift tiles. Empty hull cells, armor and
    non-combat rooms are never walkable; crew cross between rooms only along touching floors, lifts
    and vents (vents are joined separately in build_graph)."""
    walk = set(lifts)
    for r, (x, y) in enumerate(pos):
        if ROOMS[r][5] or WALK_NONCOMBAT:
            fy = y + ROOMS[r][3] - 1
            for xx in range(x, x + ROOMS[r][2]):
                walk.add((xx, fy))
    return walk


def build_graph(walk, lifts, extra_nodes, vlinks):
    """Compress the walkable grid into a small node graph.

    Nodes = room anchors, vent attachment tiles, lift tiles, vent tiles. Consecutive nodes inside
    one horizontal run of walkable tiles are joined by one edge of cost = distance. Lift tiles in the
    same column are joined vertically at 1 + LIFT_COST. Vents join their two floor tiles.
    """
    nodes = set(lifts) | set(extra_nodes)
    adj = defaultdict(list)
    for y in range(H):
        last = None
        for x in range(W):
            t = (x, y)
            if t not in walk:
                last = None
                continue
            if t in nodes:
                if last is not None:
                    a = (last, y)
                    d = x - last
                    adj[a].append((t, d))
                    adj[t].append((a, d))
                last = x
    c = 1 + LIFT_COST
    for (x, y) in lifts:
        n = (x, y + 1)
        if n in lifts:
            adj[(x, y)].append((n, c))
            adj[n].append(((x, y), c))
    for vt, links in vlinks:
        for ft, cost, _ in links:
            adj[vt].append((ft, cost))
            adj[ft].append((vt, cost))
    if VENT_GAME_LINKS:                                    # horizontal passages, and passages beside lifts
        vset = {vt for vt, _ in vlinks}
        for (x, y) in vset:
            for n in ((x + 1, y), (x - 1, y)):
                if (n in vset and n > (x, y)) or n in lifts:
                    adj[(x, y)].append((n, VENT_LINK_COST))
                    adj[n].append(((x, y), VENT_LINK_COST))
    return adj


def dijkstra(src, adj):
    dist, par = {src: 0}, {}
    pq = [(0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for v, c in adj.get(u, ()):
            nd = d + c
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                par[v] = u
                heapq.heappush(pq, (nd, v))
    return dist, par


def make_graph(pos, lifts, vents, tiles, walk):
    reps = reps_of(pos)
    vl = vent_links(pos, vents, tiles)
    extra = set(reps)
    for _, links in vl:
        for ft, _, _ in links:
            extra.add(ft)
    return build_graph(walk, lifts, extra, vl), reps, vl


def walking_metrics(pos, lifts, vents, tiles, blocked, nsrc):
    walk = walk_set(pos, lifts, vents, blocked)
    adj, reps, vl = make_graph(pos, lifts, vents, tiles, walk)
    total = cnt = unreach = 0
    first_par = None
    for i in range(min(nsrc, NC)):
        dist, par = dijkstra(reps[i], adj)
        if i == 0:
            first_par = par
        for j in range(NC):
            if j == i or (j < nsrc and j < i):
                continue
            d = dist.get(reps[j])
            if d is None:
                unreach += 1
            else:
                total += d
                cnt += 1
    return (total / cnt if cnt else 99.0), unreach, first_par, reps, adj


def corner_rooms(pos):
    """Combat room nearest each hull corner (all distinct)."""
    used, res = set(), []
    for px, py in ((0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)):
        best, bd = None, None
        for r in range(NC):
            if r in used:
                continue
            cx = pos[r][0] + ROOMS[r][2] / 2.0
            cy = pos[r][1] + ROOMS[r][3] / 2.0
            d = (cx - px) ** 2 + (cy - py) ** 2
            if bd is None or d < bd:
                best, bd = r, d
        if best is not None:
            used.add(best)
            res.append(best)
    return res


def corner_stats(dists, reps, cr):
    """(max, mean) walking time over all pairs of the corner rooms. dists: room idx -> dist map."""
    vals = []
    for a in range(len(cr)):
        for b in range(a + 1, len(cr)):
            d = dists[cr[a]].get(reps[cr[b]])
            vals.append(CORNER_UNREACHABLE if d is None else d)
    if not vals:
        return 0.0, 0.0
    return max(vals), sum(vals) / len(vals)


def lift_penalty(state, tiles):
    pen = 0
    for x, y0, y1 in state["lifts"]:
        rows = set()
        for y in range(y0, y1 + 1):
            for nx in (x - 1, x + 1):
                r = tiles.get((nx, y))
                if r is not None and r < NC and state["pos"][r][1] + ROOMS[r][3] - 1 == y:
                    rows.add(y)
        pen += max(0, 2 - len(rows))
    return pen


def corridor_tiles(first_par, reps, tiles, lifts, vents):
    """Free tiles on the shortest-path tree from room 0 (none now: empty cells are not walkable)."""
    res = set()
    if first_par is None:
        return res
    for t in reps[1:]:
        cur = t
        while cur in first_par:
            p = first_par[cur]
            if cur[1] == p[1] and cur not in vents and p not in vents:
                a, b = sorted((cur[0], p[0]))
                for xx in range(a, b + 1):
                    q = (xx, cur[1])
                    if q not in tiles and q not in lifts:
                        res.add(q)
            cur = p
    return res


def floor_tiles(pos):
    f = set()
    for r in range(NR if WALK_NONCOMBAT else NC):
        x, y = pos[r]
        for xx in range(x, x + ROOMS[r][2]):
            f.add((xx, y + ROOMS[r][3] - 1))
    return f


def trim_lifts(state):
    """Lift ends must sit beside a combat-room floor tile; otherwise the end is cut off."""
    f = floor_tiles(state["pos"])
    out = []
    for x, y0, y1 in state["lifts"]:
        while y0 <= y1 and (x - 1, y0) not in f and (x + 1, y0) not in f:
            y0 += 1
        while y1 >= y0 and (x - 1, y1) not in f and (x + 1, y1) not in f:
            y1 -= 1
        if y1 - y0 < 1:
            return None
        out.append((x, y0, y1))
    return dict(pos=state["pos"], lifts=out, vents=state["vents"])


def noncombat_halo(tiles):
    """Free-looking tiles orthogonally touching a non-combat room (armor is kept off them)."""
    halo = set()
    for (x, y), r in tiles.items():
        if r >= NC:
            for dx, dy in NEIGH:
                t = (x + dx, y + dy)
                if t not in tiles:
                    halo.add(t)
    return halo


def near_combat(tiles):
    """Tiles orthogonally touching a combat room."""
    near = set()
    for (x, y), r in tiles.items():
        if r < NC:
            for dx, dy in NEIGH:
                near.add((x + dx, y + dy))
    return near


def armor_pick(tiles, lifts, vents, reserved, noarmor):
    """Choose ARMOR_COUNT armor tiles by marginal score gain (lazy greedy). A tile's gain is the sum,
    over the rooms it touches, of that room's next-tile gain: big while a room is below its sweet
    spot, normal inside it, negative once it is above. Gains only shrink as rooms fill up, so lazy
    re-evaluation is exact. Returns ([(tile, gain)], number_of_candidate_tiles)."""
    occ = set(tiles) | lifts | vents
    touch = defaultdict(list)
    for (x, y), r in tiles.items():
        if ROOMS[r][4] <= 0:
            continue
        for dx, dy in NEIGH:
            t = (x + dx, y + dy)
            if t not in occ and free_tile(*t) and t not in reserved and t not in noarmor:
                touch[t].append(r)
    cnt = defaultdict(int)

    def gain(t):
        return sum(GAIN[r][min(cnt[r], 31)] for r in touch[t])

    heap = [(-gain(t), t[1], t[0], t) for t in touch]
    heapq.heapify(heap)
    chosen = []
    while heap and len(chosen) < ARMOR_COUNT:
        _, _, _, t = heapq.heappop(heap)
        g = gain(t)
        if heap and g < -heap[0][0] - 1e-9:          # stale entry: re-queue with its fresh gain
            heapq.heappush(heap, (-g, t[1], t[0], t))
            continue
        chosen.append((t, g))
        for r in touch[t]:
            cnt[r] += 1
    return chosen, len(touch)


def ring_hits(x, y, w, h, bad):
    """True if any tile orthogonally touching the rectangle is in `bad` (corners excluded)."""
    for yy in range(y - 1, y + h + 1):
        for xx in range(x - 1, x + w + 1):
            inside = x <= xx < x + w and y <= yy < y + h
            corner = xx in (x - 1, x + w) and yy in (y - 1, y + h)
            if not inside and not corner and (xx, yy) in bad:
                return True
    return False


def priority_spread(pos):
    """Average pairwise Manhattan distance between priority-room centres (capped)."""
    if len(PRIORITY_IDX) < 2:
        return 0.0
    cs = [(pos[r][0] + ROOMS[r][2] / 2.0, pos[r][1] + ROOMS[r][3] / 2.0) for r in PRIORITY_IDX]
    tot = cnt = 0
    for i in range(len(cs)):
        for j in range(i + 1, len(cs)):
            tot += abs(cs[i][0] - cs[j][0]) + abs(cs[i][1] - cs[j][1])
            cnt += 1
    return min(SPREAD_CAP, tot / cnt)


def combat_center(pos):
    """(x, y) middle of the combat block: average centre of every combat room that is not a CENTER room."""
    others = [r for r in range(NC) if r not in CENTER_IDX]
    if not others:
        return None
    return (sum(pos[r][0] + ROOMS[r][2] / 2.0 for r in others) / len(others),
            sum(pos[r][1] + ROOMS[r][3] / 2.0 for r in others) / len(others))


def center_distance(pos):
    """Total Manhattan distance (tiles) from each CENTER room's centre to the middle of the combat block."""
    if not CENTER_IDX:
        return 0.0
    c = combat_center(pos)
    if c is None:
        return 0.0
    return sum(abs(pos[r][0] + ROOMS[r][2] / 2.0 - c[0]) + abs(pos[r][1] + ROOMS[r][3] / 2.0 - c[1])
               for r in CENTER_IDX)


def _center_note(info):
    if not CENTER_IDX:
        return ""
    return f" | center rooms off the combat middle {info.get('center_dist', 0.0):.1f} tiles"


def _room_tags():
    return list(ROOM_TAGS) if len(ROOM_TAGS) == NR else list(ROOM_KIND)


_TAGS = _room_tags()


def boost_count(pos, tiles):
    """Rooms touching a booster that the booster boosts (each booster/room pair counts once)."""
    if not ROOM_BOOSTS or len(ROOM_BOOSTS) != NR:
        return 0
    tags = _TAGS
    n = 0
    for r, targets in enumerate(ROOM_BOOSTS):
        if not targets:
            continue
        x, y = pos[r]
        near = {tiles.get(t) for t in ring_of(x, y, ROOMS[r][2], ROOMS[r][3])}
        n += sum(1 for o in near if o is not None and o != r and tags[o] in targets)
    return n


def pattern_score(pos, tiles):
    """Learned top-ship patterns: touching room types (TAG_ADJ) plus edge-facing share by type (TAG_EDGE)."""
    if not (TAG_ADJ or TAG_EDGE):
        return 0.0
    tags = _TAGS
    tot = 0.0
    for r in range(NR):
        x, y = pos[r]
        ring = ring_of(x, y, ROOMS[r][2], ROOMS[r][3])
        if TAG_EDGE:
            pe = TAG_EDGE.get(tags[r])
            if pe:
                ok = ok_set()
                tot += pe * sum(1 for t in ring if t not in ok) / len(ring)
        if TAG_ADJ:
            seen = set()
            for t in ring:
                o = tiles.get(t, -1)
                if o > r and o not in seen:
                    seen.add(o)
                    a, b = tags[r], tags[o]
                    tot += TAG_ADJ.get(a + "|" + b if a <= b else b + "|" + a, 0.0)
    return tot


def cheap_score(state):
    """Fast approximate score (no filler rooms, no real post-armor walking)."""
    occ = occupancy(state)
    if occ is None:
        return -1e9
    tiles, lifts, vents = occ
    pos = state["pos"]
    avg, unreach, par, reps, adj = walking_metrics(pos, lifts, vents, tiles, set(), SA_SOURCES)
    res = corridor_tiles(par, reps, tiles, lifts, vents)
    halo = noncombat_halo(tiles)
    top, ncand = armor_pick(tiles, lifts, vents, res, halo)
    bad = {t for t, _ in top} | lifts
    iso = sum(1 for r in range(NC, NR) if ring_hits(pos[r][0], pos[r][1], ROOMS[r][2], ROOMS[r][3], bad))
    cr = corner_rooms(pos)
    cmax, cavg = corner_stats({i: dijkstra(reps[i], adj)[0] for i in cr}, reps, cr)
    vl = vent_links(pos, vents, tiles)
    s = (W_ARMOR * sum(v for _, v in top) - W_TRAVEL * avg - W_GAP * len(res)
         - W_DISC * unreach - W_LIFT * lift_penalty(state, tiles) - W_ISO * iso
         - W_VENT * vent_penalty(vl, lifts) - W_CORNER * 0.5 * (cmax + cavg)
         + W_SPREAD * priority_spread(pos) - W_CENTER * center_distance(pos)
         + (W_PATTERN * pattern_score(pos, tiles) if W_PATTERN else 0.0))
    s -= 60 * max(0, ARMOR_COUNT - ncand)
    return s


# ------------------------------------------------------------- progress -----
TICK = 25                # workers report progress every TICK search steps
_PROGRESS = None         # shared work-unit counter (set in each worker by _init_worker)


def _init_worker(counter):
    global _PROGRESS
    _PROGRESS = counter


def tick(n):
    """Report n finished search steps to the main process (no-op outside the worker pool)."""
    if _PROGRESS is not None and n > 0:
        with _PROGRESS.get_lock():
            _PROGRESS.value += n


# ------------------------------------------------------------- search ------
def pick_floors(rng, slack):
    """Choose deck floor rows from the hull itself (not hard-coded): rank candidate rows by how many
    columns of 2-high room space they offer, then take spaced rows until the decks can hold every
    room with `slack` spare."""
    need = sum(ROOMS[r][2] for r in range(NR))
    cap = {f: sum(1 for x in range(W) if ok_tile(x, f - 1) and ok_tile(x, f)) for f in range(1, H)}
    order = sorted(cap, key=lambda f: -(cap[f] + rng.random() * 6))
    floors, total = [], 0
    for f in order:
        if all(abs(f - g) >= 2 for g in floors) and cap[f] >= 6:
            floors.append(f)
            total += cap[f]
            if len(floors) >= 2 and total >= need * slack:
                return sorted(floors), cap
    return (sorted(floors), cap) if len(floors) >= 2 else (None, cap)


def pick_lift_cols(rng, cols, n):
    """Choose n lift columns, favoring the edges of usable column runs (they waste the least room
    space) and keeping lifts apart from each other where possible."""
    colset = set(cols)
    pool = list(cols)
    chosen = []
    while pool and len(chosen) < n:
        w = [4.0 if (x - 1 not in colset or x + 1 not in colset) else 1.0 for x in pool]
        x = rng.choices(pool, weights=w, k=1)[0]
        chosen.append(x)
        pool = [q for q in pool if abs(q - x) > 1] or [q for q in cols if q not in chosen]
    return chosen if len(chosen) == n else None


START_BUILD_SECONDS = 25      # give up building a starting layout from scratch after this long


def init_state_decks(rng, deadline=None):
    """Random multi-deck start laid out on rows chosen from the actual hull shape."""
    combat = list(range(NC))
    other = list(range(NC, NR))
    for attempt in range(400):
        if deadline and time.time() > deadline:
            return None
        shove = attempt % 2 == 1     # odd attempts: place rooms ignoring lift columns, then shove them legal
        floors, cap = pick_floors(rng, 1.15 + 0.4 * min(1.0, attempt / 400))
        if floors is None:
            return None
        cols = [x for x in range(W) if all(free_tile(x, y) for y in range(floors[0], floors[-1] + 1))]
        if len(cols) < START_LIFTS:
            continue
        lx = pick_lift_cols(rng, cols, START_LIFTS)
        if lx is None:
            continue
        rng.shuffle(combat)
        rng.shuffle(other)
        rows, widths = [[] for _ in floors], [0] * len(floors)
        for r in combat + other:
            d = min(range(len(floors)), key=lambda k: widths[k] / max(1, cap[floors[k]]) + rng.random() * 0.03)
            rows[d].append(r)
            widths[d] += ROOMS[r][2]
        pos = [None] * NR
        okk = True
        for d, floor in enumerate(floors):
            x = 0
            for r in rows[d]:
                w, h = ROOMS[r][2], ROOMS[r][3]
                while x + w <= W:
                    if (not shove and any(x <= L < x + w for L in lx)) or not rect_ok(x, floor - h + 1, w, h, r):
                        x += 1
                    else:
                        break
                if x + w > W:
                    okk = False
                    break
                pos[r] = (x, floor - h + 1)
                x += w + (1 if rng.random() < 0.15 else 0)
            if not okk:
                break
        if not okk:
            continue
        s = dict(pos=pos, lifts=[(L, floors[0], floors[-1]) for L in lx], vents=[])
        if shove and not legalize(s, set(), rng, 120):
            continue
        st = trim_lifts(s)
        if st and occupancy(st):
            return st
    return None


def init_state_packed(rng, deadline=None):
    """Fallback for awkward hull shapes: pack rooms bottom-up into the first free spots, then add lifts."""
    for _ in range(200):
        if deadline and time.time() > deadline:
            return None
        order = sorted(range(NR), key=lambda r: (r not in RES_IDX, -ROOMS[r][2] * ROOMS[r][3] + rng.random() * 3))   # resource rooms first: they have the fewest legal spots
        used, pos, okk = set(), [None] * NR, True
        for r in order:
            w, h = ROOMS[r][2], ROOMS[r][3]
            spots = [(x, y) for y in range(H - h, -1, -1) for x in range(W - w + 1)
                     if rect_ok(x, y, w, h, r)
                     and not any((xx, yy) in used for yy in range(y, y + h) for xx in range(x, x + w))]
            if not spots:
                okk = False
                break
            x, y = spots[rng.randrange(min(len(spots), 4))]
            pos[r] = (x, y)
            used.update((xx, yy) for yy in range(y, y + h) for xx in range(x, x + w))
        if not okk:
            continue
        lifts = []
        for _ in range(START_LIFTS):
            for _ in range(80):
                r = rng.randrange(NC)
                x, y = pos[r]
                fl = y + ROOMS[r][3] - 1
                lx = x - 1 if rng.random() < 0.5 else x + ROOMS[r][2]
                cand = (lx, fl - rng.choice([0, 2, 4]), fl + rng.choice([0, 2, 3, 4]))
                st = trim_lifts(dict(pos=pos, lifts=lifts + [cand], vents=[]))
                if st and occupancy(st):
                    lifts = list(st["lifts"])
                    break
        if len(lifts) == START_LIFTS:
            return dict(pos=pos, lifts=lifts, vents=[])
    return None


_START_POOL = []         # a few valid base layouts per process; further starts are random walks from them


def init_state(rng):
    """A valid random starting layout. Building one from scratch can be slow on tight or gappy hulls,
    so each process builds a few base layouts and derives later starts by shuffling them with legal moves."""
    if len(_START_POOL) >= 3 or (_START_POOL and rng.random() < 0.8):
        st = clone(rng.choice(_START_POOL))
        for _ in range(rng.randint(40, 120)):
            st = neighbour(st, rng)
        return st
    deadline = time.time() + START_BUILD_SECONDS
    st = init_state_decks(rng, deadline) or init_state_packed(rng, deadline)
    if st is None:
        raise RuntimeError(f"could not build a starting layout for this hull within {START_BUILD_SECONDS}s "
                           f"(rooms + {ARMOR_COUNT} armor + {START_LIFTS} lifts may not fit; "
                           f"try a smaller START_LIFTS, fewer rooms, or a bigger hull)")
    _START_POOL.append(clone(st))
    return st


def legalize(s, anchors, rng, max_iter=60):
    """Minimal physics-style separation. Rooms in `anchors` stay put; whatever overlaps them (or a
    lift, vent, or the hull edge) is shoved to the nearest legal spot. Mutates s['pos'] in place.
    Returns True when the layout is overlap-free.

    Same decisions as a full rescan every pass (first conflicting room in index order, first conflicting
    tile in row order), but the tile map is kept up to date incrementally, so a pass only re-checks the
    rooms a move can affect."""
    pos = s["pos"]
    fixed = {}
    for x, y0, y1 in s["lifts"]:
        rect = (x, y0, 1, y1 - y0 + 1)
        for y in range(y0, y1 + 1):
            fixed[(x, y)] = rect
    for vx, vy in s["vents"]:
        fixed[(vx, vy)] = (vx, vy, 1, 1)

    def free_spot(r, x, y):
        w, h = ROOMS[r][2], ROOMS[r][3]
        return rect_ok(x, y, w, h, r) and not any(
            (xx, yy) in fixed for yy in range(y, y + h) for xx in range(x, x + w))

    occ = defaultdict(set)                 # tile -> rooms on it

    def tiles_of(r):
        x, y = pos[r]
        return [(xx, yy) for yy in range(y, y + ROOMS[r][3]) for xx in range(x, x + ROOMS[r][2])]

    def first_conflict(r):
        """(blocker_room, blocker_rect) for room r against fixed tiles and LOWER-numbered rooms, in tile
        order; (None, None) if r is off the hull; False if r is fine."""
        x, y = pos[r]
        if not rect_ok(x, y, ROOMS[r][2], ROOMS[r][3], r):
            return (None, None)
        for t in tiles_of(r):
            if t in fixed:
                return (None, fixed[t])
            lower = [o for o in occ[t] if o < r]
            if lower:
                return (lower[0], None)
        return False

    bad = set()
    for r in range(NR):                    # one pass, rooms in index order (lower rooms already placed)
        x, y = pos[r]
        ts = tiles_of(r)
        if not rect_ok(x, y, ROOMS[r][2], ROOMS[r][3], r) or any(t in fixed or occ.get(t) for t in ts):
            bad.add(r)
        for t in ts:
            occ[t].add(r)

    for _ in range(max_iter):
        if not bad:
            return True
        r = min(bad)
        o, blk = first_conflict(r)
        mover = r
        if o is not None:
            if o in anchors and r not in anchors:
                mover = r
            elif r in anchors and o not in anchors:
                mover = o
            elif rng.random() < 0.5:
                mover = o
            other = o if mover == r else r
            blk = (pos[other][0], pos[other][1], ROOMS[other][2], ROOMS[other][3])
        mx, my = pos[mover]
        w, h = ROOMS[mover][2], ROOMS[mover][3]
        cands = []
        if blk is not None:
            bx, by, bw, bh = blk
            cands = [(bx - w, my), (bx + bw, my), (mx, by - h), (mx, by + bh)]
            cands.sort(key=lambda c: abs(c[0] - mx) + abs(c[1] - my) + rng.random() * 0.6)
        target = None
        for cx, cy in cands:
            if free_spot(mover, cx, cy):
                target = (cx, cy)
                break
        if target is None:
            for dx, dy in OFFSETS:
                if free_spot(mover, mx + dx, my + dy):
                    target = (mx + dx, my + dy)
                    break
        if target is None:
            return False
        old_tiles = tiles_of(mover)
        for t in old_tiles:
            occ[t].discard(mover)
        pos[mover] = target
        new_tiles = tiles_of(mover)
        for t in new_tiles:
            occ[t].add(mover)
        touched = {mover}
        for t in old_tiles + new_tiles:
            touched.update(occ[t])
        for q in touched:
            if first_conflict(q) is False:
                bad.discard(q)
            else:
                bad.add(q)
    return not bad and False


def vent_gap_spots(s):
    """Free tiles with a different combat room left and right, both on their floor row: vent sites."""
    owner = {}
    for r, (x, y) in enumerate(s["pos"]):
        for yy in range(y, y + ROOMS[r][3]):
            for xx in range(x, x + ROOMS[r][2]):
                owner[(xx, yy)] = r
    blocked = set(owner)
    for x, y0, y1 in s["lifts"]:
        for y in range(y0, y1 + 1):
            blocked.add((x, y))
    blocked.update(tuple(v) for v in s["vents"])
    spots = []
    if VENT_GAME_LINKS:
        # free tiles in a horizontal gap: left and right are each a room's BOTTOM row, a lift or a vent
        # (extending a passage), and at least one side is a room floor or a lift
        vset = {tuple(v) for v in s["vents"]}
        lset = {(x, y) for x, y0, y1 in s["lifts"] for y in range(y0, y1 + 1)}

        def side(n):
            r = owner.get(n)
            if r is not None and (r < NC or WALK_NONCOMBAT) and s["pos"][r][1] + ROOMS[r][3] - 1 == n[1]:
                return ("r", r)
            if n in lset:
                return ("l", n)
            if n in vset:
                return ("v", n)
            return None
        for y in range(H):
            for x in range(1, W - 1):
                t = (x, y)
                if t in blocked or not free_tile(x, y):
                    continue
                a, b = side((x - 1, y)), side((x + 1, y))
                if a and b and a != b and (a[0] != "v" or b[0] != "v"):
                    spots.append(t)
        return spots
    for y in range(H):
        for x in range(1, W - 1):
            t = (x, y)
            if t in blocked or not free_tile(x, y):
                continue
            a, b = owner.get((x - 1, y)), owner.get((x + 1, y))
            if (a is not None and b is not None and a != b and a < NC and b < NC
                    and s["pos"][a][1] + ROOMS[a][3] - 1 == y and s["pos"][b][1] + ROOMS[b][3] - 1 == y):
                spots.append(t)
    return spots


OP_NAMES = ["nudge", "snap", "relocate", "swap", "slide", "reorder",
            "lift_move", "lift_snap", "lift_fit", "lift_addrem", "vent"]
OP_WEIGHTS = [0.13, 0.19, 0.05, 0.10, 0.10, 0.08, 0.08, 0.05, 0.08, 0.06, 0.08]   # starting odds, then adapted
NOPS = len(OP_NAMES)
ROOM_OPS = (0, 1, 2, 3, 4, 5)            # moves that only touch rooms (used in the combat-only phase)
ROOM_ALL = list(range(NR))
ROOM_COMBAT = list(range(NC))


def fit_lift(st, rng):
    """A lift that directly links two floor rows: pick two combat floor rows (neighbouring decks most
    of the time), then a free column between them that touches a floor tile at BOTH ends."""
    occ = occupancy(st)
    if occ is None:
        return None
    tiles, lift_tiles, _ = occ
    pos = st["pos"]
    floors = defaultdict(set)
    for r in range(NC):
        x, y = pos[r]
        fy = y + ROOMS[r][3] - 1
        for xx in range(x, x + ROOMS[r][2]):
            floors[fy].add(xx)
    rows = sorted(floors)
    if len(rows) < 2:
        return None
    if rng.random() < 0.65:
        i = rng.randrange(len(rows) - 1)
        a, b = rows[i], rows[i + 1]
    else:
        a, b = sorted(rng.sample(rows, 2))
    cols = [x for x in range(W)
            if ((x - 1 in floors[a]) or (x + 1 in floors[a])) and ((x - 1 in floors[b]) or (x + 1 in floors[b]))
            and all(free_tile(x, y) and (x, y) not in tiles and (x, y) not in lift_tiles for y in range(a, b + 1))]
    return (rng.choice(cols), a, b) if cols else None


def apply_op(st, rng, op, combat_only=False, node=None):
    """node (optional, from the learned policy) names the room (0..NR-1) or lift (NR+i) the move acts on."""
    s = clone(st)
    pos = s["pos"]
    pool = ROOM_COMBAT if combat_only else ROOM_ALL
    nr = node if (node is not None and node < NR) else None
    nl = node - NR if (node is not None and node >= NR and node - NR < len(s["lifts"])) else None
    anchors = set()
    if op == 0:                       # local nudge
        r = nr if nr is not None else rng.choice(pool)
        x, y = pos[r]
        pos[r] = (x + rng.randint(-3, 3), y + rng.randint(-2, 2))
        anchors = {r}
    elif op == 1:                     # snap a room beside/above/below another (sometimes leaving a 1-tile gap)
        r, t = rng.sample(pool, 2)
        if nr is not None and r != nr:
            r = nr
            if t == r:
                t = rng.choice([q for q in pool if q != r])
        tx, ty = pos[t]
        tw, th = ROOMS[t][2], ROOMS[t][3]
        w, rh = ROOMS[r][2], ROOMS[r][3]
        gap = rng.choice([0, 0, 0, 1])
        if rng.random() < 0.7:        # same floor row, to the left or right
            x = tx - w - gap if rng.random() < 0.5 else tx + tw + gap
            pos[r] = (x, ty + th - rh)
        else:                         # stacked above/below, aligned left or right edge
            y = ty - rh - gap if rng.random() < 0.5 else ty + th + gap
            x = tx if rng.random() < 0.5 else tx + tw - w
            pos[r] = (x, y)
        anchors = {r}
    elif op == 2:                     # broad relocation to explore different hull regions
        r = nr if nr is not None else rng.choice(pool)
        pos[r] = (rng.randrange(W), rng.randrange(H))
        anchors = {r}
    elif op == 3:                     # swap two rooms (mostly equal-size ones, which can never overlap)
        a = nr if nr is not None else rng.choice(pool)
        if rng.random() < 0.7:
            same = [q for q in pool if q != a and ROOMS[q][2:4] == ROOMS[a][2:4]]
            b = rng.choice(same) if same else rng.choice(pool)
        else:
            b = rng.choice(pool)
        if a == b:
            return st
        pos[a], pos[b] = pos[b], pos[a]
        anchors = {a, b}
    elif op == 4:                     # slide a room and everything beyond it on the same rows
        r = nr if nr is not None else rng.choice(pool)
        x, y = pos[r]
        h = ROOMS[r][3]
        d = rng.choice([-2, -1, 1, 1, 2])
        group = [q for q in pool
                 if pos[q][1] < y + h and pos[q][1] + ROOMS[q][3] > y
                 and (pos[q][0] >= x if d > 0 else pos[q][0] <= x)]
        for q in group:
            pos[q] = (pos[q][0] + d, pos[q][1])
        anchors = set(group)
    elif op == 5:                     # reorder: swap a room with its right-hand neighbour on the same floor
        r = nr if nr is not None else rng.choice(pool)
        x, y = pos[r]
        w, h = ROOMS[r][2], ROOMS[r][3]
        bot = y + h - 1
        nb = [t for t in range(NR) if t != r and pos[t][0] == x + w and pos[t][1] + ROOMS[t][3] - 1 == bot]
        if not nb:
            return st
        t = rng.choice(nb)
        wt, ht = ROOMS[t][2], ROOMS[t][3]
        pos[t] = (x, bot - ht + 1)
        pos[r] = (x + wt, y)
        anchors = {r, t}
    elif op == 6:                     # move / resize a lift
        i = nl if nl is not None else rng.randrange(len(s["lifts"]))
        x, y0, y1 = s["lifts"][i]
        k = rng.random()
        if k < 0.4:
            x += rng.choice([-3, -2, -1, 1, 2, 3])
        elif k < 0.7:
            y0 += rng.choice([-2, -1, 1, 2])
        else:
            y1 += rng.choice([-2, -1, 1, 2])
        if y1 - y0 < 1:
            return st
        s["lifts"][i] = (x, y0, y1)
    elif op == 7:                     # put a lift beside a room, spanning its floor row
        i = nl if nl is not None else rng.randrange(len(s["lifts"]))
        r = rng.randrange(NC)
        x, y = pos[r]
        lx = x - 1 if rng.random() < 0.5 else x + ROOMS[r][2]
        fl = y + ROOMS[r][3] - 1
        y0 = fl - rng.choice([0, 0, 2, 4])
        y1 = fl + rng.choice([0, 2, 3, 4])
        if y1 - y0 < 1:
            return st
        s["lifts"][i] = (lx, y0, y1)
    elif op == 8:                     # re-fit a lift so it links two floor rows directly
        cand = fit_lift(st, rng)
        if cand is None:
            return st
        s["lifts"][nl if nl is not None else rng.randrange(len(s["lifts"]))] = cand
    elif op == 9:                     # add a new lift, or remove one: the lift COUNT is searched too
        n = len(s["lifts"])
        can_add, can_remove = n < MAX_LIFTS, n > MIN_LIFTS
        if not (can_add or can_remove):
            return st
        if can_add and (not can_remove or rng.random() < 0.5):
            cand = fit_lift(st, rng)
            if cand is None:
                return st
            s["lifts"].append(cand)
        else:
            s["lifts"].pop(rng.randrange(n))
    else:                             # vents: add / move / remove
        if VENT_COUNT <= 0:
            return st
        vents = s["vents"]
        if vents and rng.random() < 0.2:
            vents.pop(rng.randrange(len(vents)))
        else:
            spots = vent_gap_spots(s)
            if not spots:
                return st
            t = rng.choice(spots)
            if len(vents) < VENT_COUNT and (not vents or rng.random() < 0.5):
                vents.append(t)
            else:
                vents[rng.randrange(len(vents))] = t
    if not legalize(s, anchors, rng):
        return st
    s = trim_lifts(s)
    return s if s and occupancy(s) else st


def crossover(a, b, rng, tries=8):
    """Breed two layouts; retries with different cut lines because dense hulls reject many children."""
    for _ in range(tries):
        child = _crossover_once(a, b, rng)
        if child is not None:
            return child
    return None


def propose(st, rng, weights=None, combat_only=False):
    """Pick a move type by the (adaptive) odds and apply it. Returns (state, op_index)."""
    w = weights or OP_WEIGHTS
    if combat_only:               # first phase: only room-placement moves on combat rooms
        op = rng.choices(ROOM_OPS, weights=[w[i] for i in ROOM_OPS])[0]
    else:
        op = rng.choices(range(NOPS), weights=w)[0]
    return apply_op(st, rng, op, combat_only), op


def neighbour(st, rng, combat_only=False):
    """Mutate a layout (default move odds)."""
    return propose(st, rng, None, combat_only)[0]


def adapt_weights(att, succ):
    """Blend the prior odds with each move type's observed improvement rate."""
    raw = [(succ[i] + 1.0) / (att[i] + 12.0) for i in range(NOPS)]
    tot = sum(raw)
    w = [max(0.02, 0.5 * OP_WEIGHTS[i] + 0.5 * raw[i] / tot) for i in range(NOPS)]
    t = sum(w)
    return [x / t for x in w]


def _crossover_once(a, b, rng):
    """Left part of parent A + right part of parent B, matched by room type, then shoved legal."""
    cut = rng.randint(max(1, W // 4), max(2, 3 * W // 4))
    pa, pb = a["pos"], b["pos"]

    def cx(p, r):
        return p[r][0] + ROOMS[r][2] / 2.0

    groups = defaultdict(list)
    for r in range(NR):
        groups[ROOMS[r][1:4]].append(r)
    pos = [None] * NR
    anchors = set()
    for idxs in groups.values():
        left = [(pa[r], True) for r in idxs if cx(pa, r) < cut]
        right = [(pb[r], False) for r in idxs if cx(pb, r) >= cut]
        take = left + right
        rng.shuffle(take)
        n = len(idxs)
        if len(take) > n:
            take = take[:n]
        elif len(take) < n:
            rest = ([(pa[r], True) for r in idxs if cx(pa, r) >= cut]
                    + [(pb[r], False) for r in idxs if cx(pb, r) < cut])
            rng.shuffle(rest)
            take += rest[:n - len(take)]
        for r, (p, from_a) in zip(idxs, take):
            pos[r] = tuple(p)
            if from_a:
                anchors.add(r)
    lifts = [tuple(l) for l in a["lifts"] if l[0] < cut] + [tuple(l) for l in b["lifts"] if l[0] >= cut]
    rng.shuffle(lifts)
    extra = [tuple(l) for l in list(a["lifts"]) + list(b["lifts"])]
    rng.shuffle(extra)
    while len(lifts) < MIN_LIFTS and extra:
        lifts.append(extra.pop())
    lifts = lifts[:MAX_LIFTS]
    lift_tiles = {(x, y) for x, y0, y1 in lifts for y in range(y0, y1 + 1)}
    vents = []
    cand_v = [tuple(v) for v in a["vents"] if v[0] < cut] + [tuple(v) for v in b["vents"] if v[0] >= cut]
    rng.shuffle(cand_v)
    for v in cand_v:
        if (len(vents) < VENT_COUNT and v not in lift_tiles and free_tile(*v)
                and not any(abs(v[0] - u[0]) <= 1 and abs(v[1] - u[1]) <= 1 for u in vents)):
            vents.append(v)
    s = dict(pos=pos, lifts=lifts, vents=vents)
    if not legalize(s, anchors, rng, 150):
        return None
    # Keep every lift that still works on its own; drop broken/overlapping ones, then top up with
    # freshly fitted lifts so the child always has at least MIN_LIFTS.
    kept, used = [], set()
    for l in s["lifts"]:
        t = trim_lifts(dict(pos=pos, lifts=[l], vents=[]))
        if not t:
            continue
        x, y0, y1 = t["lifts"][0]
        tl = {(x, y) for y in range(y0, y1 + 1)}
        if used.isdisjoint(tl) and all(free_tile(*q) for q in tl):
            kept.append((x, y0, y1))
            used |= tl
    s = dict(pos=pos, lifts=kept, vents=vents)
    for _ in range(12):
        if len(s["lifts"]) >= MIN_LIFTS:
            break
        cand = fit_lift(s, rng)
        if cand:
            s["lifts"].append(cand)
    s = trim_lifts(s) if len(s["lifts"]) >= MIN_LIFTS else None
    return s if s and occupancy(s) else None


_CACHE = {}


def score_only(state):
    """Full finalized score, cached per process by layout hash. -inf for illegal layouts."""
    k = hash((tuple(state["pos"]), tuple(state["lifts"]), tuple(state["vents"])))
    v = _CACHE.get(k)
    if v is None:
        r = finalize(state)
        v = r[0] if r else float("-inf")
        if len(_CACHE) > 150000:
            _CACHE.clear()
        _CACHE[k] = v
    return v


def score_state(state):
    """Score using the complete finalized layout, including armor and bonus rooms."""
    result = finalize(state)
    return (result[0], result) if result else (float("-inf"), None)


def anneal(rng, iters, start=None, t0=24.0, weights=None, phase_frac=0.4, policy=None):
    """Simulated annealing driven by the full finalized-layout score.
    Returns (best_state, best_score, attempts_per_move, improvements_per_move)."""
    cur = start if start is not None else init_state(rng)
    cs = score_only(cur)
    best, bs = cur, cs
    T0, T1 = t0, 0.12
    combat_phase_end = int(iters * phase_frac)    # early phase: combat geometry only (fresh starts only)
    att, succ = [0] * NOPS, [0] * NOPS
    for i in range(iters):
        if i % TICK == TICK - 1:
            tick(TICK)
        T = T0 * (T1 / T0) ** (i / max(1, iters))
        co = i < combat_phase_end
        if policy is None:
            nxt, op = propose(cur, rng, weights, combat_only=co)
        else:
            nxt, op, act = policy.propose(cur, rng, co)
        if nxt is cur:
            if policy is not None:
                policy.record(act, NOOP_REWARD)
            continue
        att[op] += 1
        ns = score_only(nxt)
        if ns == float("-inf"):
            if policy is not None:
                policy.record(act, BAD_REWARD)
            continue
        d = ns - cs
        if policy is not None:
            policy.record(act, max(-1.0, min(1.0, d / REWARD_SCALE)))
        if d > 1e-9:
            succ[op] += 1
        if d >= 0 or rng.random() < math.exp(max(-700.0, d / T)):
            cur, cs = nxt, ns
            if cs > bs:
                best, bs = cur, cs
    tick(iters % TICK)
    return best, bs, att, succ


def finalize(state):
    occ = occupancy(state)
    if occ is None:
        return None
    tiles, lifts, vents = occ
    pos = state["pos"]
    # only the shortest-path tree from room 0 is needed here (it marks the corridor tiles)
    walk0 = walk_set(pos, lifts, vents, set())
    adj0, reps, _ = make_graph(pos, lifts, vents, tiles, walk0)
    par = dijkstra(reps[0], adj0)[1] if NC else None
    reserved = corridor_tiles(par, reps, tiles, lifts, vents)
    halo = noncombat_halo(tiles)
    top, _ = armor_pick(tiles, lifts, vents, reserved, halo)
    armor = [t for t, _ in top]
    g = [["#" if c == "." else ("~" if c == "r" else ".") for c in r] for r in HULL]
    out = []
    for r, (x, y) in enumerate(pos):
        n, s, w, h, _, comb = ROOMS[r]
        out.append((n, s, w, h, x, y, comb))
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                g[yy][xx] = s
    for t in lifts:
        g[t[1]][t[0]] = "L"
    for t in vents:
        g[t[1]][t[0]] = "V"
    near_c = None
    if len(armor) < ARMOR_COUNT:
        taken = set(armor)
        free = [(x, y) for (x, y) in ALL_TILES if g[y][x] == "." and (x, y) not in taken and (x, y) not in reserved]
        near = near_c = near_combat(tiles)
        # prefer tiles that at least touch a combat room, and avoid non-combat rooms where possible
        free.sort(key=lambda t: (t not in near, t in halo))
        armor += free[: ARMOR_COUNT - len(armor)]
    for x, y in armor:
        g[y][x] = "A"
    # every lift tile must touch a combat room or an armor tile (not counting other lift tiles)
    combat_chars = set(SYMBOLS) | {"A"}
    lift_touch_bad = 0
    for (lx_, ly_) in lifts:
        if not any(0 <= lx_ + dx < W and 0 <= ly_ + dy < H and g[ly_ + dy][lx_ + dx] in combat_chars
                   for dx, dy in NEIGH):
            lift_touch_bad += 1

    def adj_bad(x, y, w, h):
        for yy in range(y - 1, y + h + 1):
            for xx in range(x - 1, x + w + 1):
                inside = x <= xx < x + w and y <= yy < y + h
                corner = xx in (x - 1, x + w) and yy in (y - 1, y + h)
                if not inside and not corner and 0 <= xx < W and 0 <= yy < H and g[yy][xx] in "AL":
                    return True
        return False

    def tuck(x, y, w, h):
        c = 0
        for yy in range(y - 1, y + h + 1):
            for xx in range(x - 1, x + w + 1):
                if x <= xx < x + w and y <= yy < y + h:
                    continue
                if xx in (x - 1, x + w) and yy in (y - 1, y + h):
                    continue
                if not (0 <= xx < W and 0 <= yy < H) or g[yy][xx] != ".":
                    c += 1
        return c

    def cands(w, h, strict):
        # run[y][x] = number of consecutive free tiles starting at (x, y) going right
        run = []
        for y in range(H):
            row, rr, cur = g[y], [0] * (W + 1), 0
            for x in range(W - 1, -1, -1):
                cur = cur + 1 if row[x] == "." else 0
                rr[x] = cur
            run.append(rr)
        res = []
        for y in range(H - h + 1):
            for x in range(W - w + 1):
                if all(run[yy][x] >= w for yy in range(y, y + h)):
                    if strict and adj_bad(x, y, w, h):
                        continue
                    res.append((tuck(x, y, w, h), x, -y, x, y))
        return sorted(res, reverse=True)

    def drop(name, sym, w, h, x, y):
        out.append((name, sym, w, h, x, y, False))
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                g[yy][xx] = sym

    def free_of_corridor(k, w, h):
        return not any((xx, yy) in reserved for yy in range(k[4], k[4] + h) for xx in range(k[3], k[3] + w))

    # Filler "bonus" rooms soak up leftover space (never on corridor tiles the walkers need)
    kw, kh = BONUS_SIZE
    if PLACE_BONUS_ROOMS:
        while True:
            c = [k for k in cands(kw, kh, True) if free_of_corridor(k, kw, kh)]
            if not c:
                break
            drop("Bonus Room", "x", kw, kh, c[0][3], c[0][4])
        for _ in range(60):
            fixed = False
            for y in range(H):
                run = 0
                for x in range(W + 1):
                    if x < W and g[y][x] == ".":
                        run += 1
                    else:
                        if run > MAX_EMPTY_RUN:
                            for yy in range(y - kh + 1, y + 1):
                                for xx in range(x - run, x - kw + 1):
                                    if (rect_ok(xx, yy, kw, kh) and all(g[a][b] == "." for a in range(yy, yy + kh) for b in range(xx, xx + kw))
                                            and not any((b, a) in reserved for a in range(yy, yy + kh) for b in range(xx, xx + kw))):
                                        drop("Bonus Room", "x", kw, kh, xx, yy)
                                        fixed = True
                                        break
                                if fixed:
                                    break
                        run = 0
                    if fixed:
                        break
                if fixed:
                    break
            if not fixed:
                break

    long_extra = 0
    for y in range(H):
        run = 0
        for x in range(W + 1):
            if x < W and g[y][x] == ".":
                run += 1
            else:
                long_extra += max(0, run - MAX_EMPTY_RUN)
                run = 0
    iso = sum(1 for n, s, w, h, x, y, c in out if not c and adj_bad(x, y, w, h))

    # True walking metrics on the finished grid (armor, fillers and non-combat rooms now block)
    walk = set(lifts)
    walk |= floor_tiles(pos)
    walk |= {(x, y) for y in range(H) for x in range(W) if g[y][x] == "."}
    adj, reps, vl = make_graph(pos, lifts, vents, tiles, walk)
    dists, parents_of = [], []
    total = cnt = unreach = 0
    for i in range(NC):
        d, pr = dijkstra(reps[i], adj)
        dists.append(d)
        parents_of.append(pr)
        for j in range(i + 1, NC):
            dj = d.get(reps[j])
            if dj is None:
                unreach += 1
            else:
                total += dj
                cnt += 1
    avg = total / cnt if cnt else 99.0
    cr = corner_rooms(pos)
    cmax, cavg = corner_stats({i: dists[i] for i in cr}, reps, cr)

    # Estimate lift traffic by reconstructing each combat-room pair's shortest path.
    # Count vertical transitions in each lift column, then penalize imbalanced use.
    lift_columns = sorted({x for x, _, _ in state["lifts"]})
    lift_usage = {x: 0 for x in lift_columns}
    for i in range(NC):
        parents = parents_of[i]                       # same shortest-path trees as above
        for j in range(i + 1, NC):
            target = reps[j]
            if target not in parents and target != reps[i]:
                continue
            node = target
            while node != reps[i] and node in parents:
                prev = parents[node]
                if prev in lifts and node in lifts and prev[0] == node[0] and prev[1] != node[1]:
                    lift_usage[prev[0]] = lift_usage.get(prev[0], 0) + 1
                node = prev
    traffic_total = sum(lift_usage.values())
    if len(lift_usage) > 1 and traffic_total:
        shares = [v / traffic_total for v in lift_usage.values()]
        target_share = 1.0 / len(shares)
        lift_balance_pen = sum((share - target_share) ** 2 for share in shares)
    else:
        lift_balance_pen = 0.0

    # Empty interior cells not reserved for walking are genuinely underused space.
    # Required corridors stay exempt so the optimizer doesn't fill in its own routes.
    empty_unused = sum(1 for y in range(H) for x in range(W)
                       if g[y][x] == "." and (x, y) not in reserved)
    # Armor touching each room, judged against that room's sweet-spot range.
    touch = Counter()
    for x, y in armor:
        for dx, dy in NEIGH:
            r = tiles.get((x + dx, y + dy))
            if r is not None:
                touch[r] += 1
    arm_sum = 0.0
    under_units = 0.0
    over_units = 0
    for r in range(NC):
        t, rg = touch[r], ARMOR_RANGES[r]
        arm_sum += ROOMS[r][4] * (min(t, rg[1]) if rg else t)     # reward stops at the top of the range
        if rg:
            if t < rg[0]:
                under_units += (rg[0] - t) * (PRIORITY_UNDER_MULT if r in PRIORITY_SET else 1.0)
            elif t > rg[1]:
                over_units += t - rg[1]
    side_bonus = 0.0
    if SIDE_PREF:
        for r in range(NC):
            pref = SIDE_PREF.get(ROOMS[r][1], 0.0)
            if pref:
                side_bonus += W_SIDE * pref * 2.0 * ((pos[r][0] + ROOMS[r][2] / 2.0) / W - 0.5)
    if near_c is None:
        near_c = near_combat(tiles)
    floating = sum(1 for t in armor if t not in near_c)
    spread = priority_spread(pos)
    vpen = vent_penalty(vl, lifts)
    unarmored_rooms = [r for r in range(NC) if touch[r] == 0]
    unarmored_priority = sum(1 for r in unarmored_rooms if r in PRIORITY_SET)
    center_dist = center_distance(pos)
    pattern = pattern_score(pos, tiles) if W_PATTERN else 0.0
    boosted = boost_count(pos, tiles)
    # Top-50 lessons: outer shell of non-combat rooms, non-combat rooms grouped, lifts spaced like top ships
    shell = 0.0
    nc_alone = 0
    lift_density_pen = 0.0
    edge_tiles, ring_tiles = Counter(), Counter()
    if TOP50:
        pref = TOP50["edge_pref"]
        for r, (x, y) in enumerate(pos):
            k = ROOM_KIND[r]
            ring = ring_of(x, y, ROOMS[r][2], ROOMS[r][3])
            e = sum(1 for t in ring if t not in ok_set())
            edge_tiles[k] += e
            ring_tiles[k] += len(ring)
            shell += pref[k] * e
            if k == "noncombat" and NNC > 1 and not any(tiles.get(t, -1) >= NC and tiles[t] != r for t in ring):
                nc_alone += 1
        nl = len(state["lifts"])
        lift_density_pen = max(0.0, LIFT_BAND[0] - nl, nl - LIFT_BAND[1])
    score = (W_ARMOR * arm_sum - W_UNARMORED * len(unarmored_rooms)
             - W_PRIORITY_UNARMORED * unarmored_priority
             - W_ARMOR_UNDER * under_units - W_ARMOR_OVER * over_units
             - W_TRAVEL * avg - W_GAP * len(reserved) - W_DISC * unreach
             - W_LIFT * lift_penalty(state, tiles) - W_RUN * long_extra - W_ISO * iso - W_LTOUCH * lift_touch_bad
             - W_VENT * vpen - W_FLOAT * floating - W_CORNER * 0.5 * (cmax + cavg) + W_SPREAD * spread
             - W_EMPTY * empty_unused - W_LIFT_BALANCE * lift_balance_pen
             - W_LIFT_COUNT * len(state["lifts"])
             + side_bonus
             - W_CENTER * center_dist
             + W_PATTERN * pattern
             + W_BOOST * boosted
             # top-50 style points only count once every combat room is reachable, so they never pull
             # the search toward a layout with a cut-off room
             + (W_SHELL * shell - W_NC_CLUSTER * nc_alone - W_LIFT_DENSITY * lift_density_pen if unreach == 0 else 0.0))
    info = dict(floating=floating, spread=spread, cmax=cmax, cavg=cavg, vent_pen=vpen, tiles=tiles, lifts=lifts, out=out,
                armor=armor, long_extra=long_extra, iso=iso, avg=avg, arm_sum=arm_sum, unreach=unreach,
                corridor=len(reserved), state=state, lift_pen=lift_penalty(state, tiles),
                lift_touch_bad=lift_touch_bad, unarmored_rooms=len(unarmored_rooms),
                unarmored_priority=unarmored_priority, empty_unused=empty_unused,
                lift_usage=lift_usage, lift_balance_pen=lift_balance_pen,
                touch=dict(touch), range_under=under_units, range_over=over_units,
                shell=shell, nc_alone=nc_alone, lift_density_pen=lift_density_pen,
                edge_tiles=dict(edge_tiles), ring_tiles=dict(ring_tiles),
                center_dist=center_dist, center_point=combat_center(pos), pattern=pattern,
                boosted=boosted)
    return score, g, info


def polish(state, rng, steps, weights=None, policy=None):
    """Hill-climb on the full score. Returns (state, result, attempts_per_move, improvements_per_move)."""
    res = finalize(state)
    cur, cs = state, (res[0] if res else float("-inf"))
    att, succ = [0] * NOPS, [0] * NOPS
    for i in range(steps):
        if i % TICK == TICK - 1:
            tick(TICK)
        if policy is None:
            n, op = propose(cur, rng, weights)
        else:
            n, op, act = policy.propose(cur, rng, False)
        if n is cur:
            if policy is not None:
                policy.record(act, NOOP_REWARD)
            continue
        att[op] += 1
        sc = score_only(n)
        if policy is not None:
            policy.record(act, BAD_REWARD if sc == float("-inf") else max(-1.0, min(1.0, (sc - cs) / REWARD_SCALE)))
        if sc != float("-inf") and sc >= cs:
            r = finalize(n)
            if r:
                if sc > cs + 1e-9:
                    succ[op] += 1
                cur, cs, res = n, r[0], r
    tick(steps % TICK)
    return cur, res, att, succ


def topology(state):
    """Translation-invariant signature: counts of touching room-type pairs, plus what each lift and
    vent touches. A deck that slides sideways keeps the same signature."""
    cached = state.get("_topo")
    if cached is not None:
        return cached
    pos = state["pos"]
    rects = [(pos[r][0], pos[r][1], pos[r][0] + ROOMS[r][2], pos[r][1] + ROOMS[r][3]) for r in range(NR)]
    sig = Counter()
    for i in range(NR):
        ax0, ay0, ax1, ay1 = rects[i]
        for j in range(i + 1, NR):
            bx0, by0, bx1, by1 = rects[j]
            yo = min(ay1, by1) - max(ay0, by0)
            xo = min(ax1, bx1) - max(ax0, bx0)
            side = (ax1 == bx0 or bx1 == ax0) and yo > 0
            stack = (ay1 == by0 or by1 == ay0) and xo > 0
            if side or stack:
                a, b = sorted((ROOMS[i][1], ROOMS[j][1]))
                sig[("h" if side else "v", a, b)] += 1
    owner = {}
    for r, (x0, y0, x1, y1) in enumerate(rects):
        for yy in range(y0, y1):
            for xx in range(x0, x1):
                owner[(xx, yy)] = r
    for x, y0, y1 in state["lifts"]:
        near = sorted({ROOMS[owner[(nx, y)]][1] for y in range(y0, y1 + 1) for nx in (x - 1, x + 1) if (nx, y) in owner})
        sig[("lift", tuple(near))] += 1
    for vx, vy in state["vents"]:
        near = sorted({ROOMS[owner[(nx, vy)]][1] for nx in (vx - 1, vx + 1) if (nx, vy) in owner})
        sig[("vent", tuple(near))] += 1
    state["_topo"] = sig
    return sig


def state_distance(a, b):
    """Distance between layouts by relative adjacency (not by absolute coordinates)."""
    ta, tb = topology(a), topology(b)
    return sum(abs(ta[k] - tb[k]) for k in set(ta) | set(tb))


def add_population(population, candidate, max_size):
    """Retain strong layouts while pruning redundant neighbors before diverse candidates."""
    if candidate is None:
        return population
    score, res = candidate
    state = res[2]["state"]

    # Replace an almost-identical member only when the candidate is better.
    for i, (old_score, old_res) in enumerate(population):
        if state_distance(state, old_res[2]["state"]) <= DUP_DISTANCE:
            if score > old_score:
                population[i] = candidate
                population.sort(key=lambda item: item[0], reverse=True)
            return population

    population.append(candidate)
    if len(population) <= max_size:
        population.sort(key=lambda item: item[0], reverse=True)
        return population

    # Keep the best solution, then remove redundancy: find the closest pair and
    # discard the lower-scoring member.
    population.sort(key=lambda item: item[0], reverse=True)
    while len(population) > max_size:
        closest_pair = None
        closest_distance = float("inf")
        for i in range(len(population)):
            for j in range(i + 1, len(population)):
                d = state_distance(population[i][1][2]["state"], population[j][1][2]["state"])
                if d < closest_distance:
                    closest_distance, closest_pair = d, (i, j)
        i, j = closest_pair
        remove_idx = j if i == 0 else (i if j == 0 else (i if population[i][0] < population[j][0] else j))
        population.pop(remove_idx)
    population.sort(key=lambda item: item[0], reverse=True)
    return population


def select_parent(population, rng):
    """Fitness + novelty selection: strong elites are favored without collapsing diversity."""
    if not population:
        return None
    scores = [item[0] for item in population]
    lo, hi = min(scores), max(scores)
    span = max(1e-9, hi - lo)
    weights = []
    for i, (score, res) in enumerate(population):
        novelty = sum(state_distance(res[2]["state"], other[1][2]["state"])
                      for j, other in enumerate(population) if i != j) / max(1, len(population) - 1)
        fitness = 0.35 + 0.65 * ((score - lo) / span)
        weights.append(fitness * (1.0 + min(3.0, novelty / 8.0)))
    chosen = rng.choices(population, weights=weights, k=1)[0]
    return chosen[1][2]["state"]


def evolve_seed(parent, rng, population_size):
    """Create a mutated offspring seed; mutation depth grows as the population grows."""
    if parent is None:
        return None
    child = clone(parent)
    # A few legal mutation attempts before annealing improve exploration of the basin.
    attempts = rng.randint(2, min(12, 3 + max(1, population_size)))
    for _ in range(attempts):
        candidate = neighbour(child, rng)
        if candidate is not child:
            child = candidate
    return child


# ======================================================================================
# GNN + REINFORCEMENT LEARNING (optional: --learn, needs numpy)
#
# The layout is turned into a graph (rooms and lifts are nodes; touching rooms, rooms on the same
# floor, and lift-room contacts are edges). A graph neural network reads it and a policy chooses the
# NEXT MOVE: (move type, which room or lift to act on). The policy is trained with PPO from the
# search's own experience: reward = score change of the proposed move. Inference runs in numpy inside
# the worker processes; training (hand-written backprop + Adam) runs in the main process between
# batches. A fraction EXPLORE of moves still comes from the classic adaptive move odds, so the policy
# can only help, never trap, the search. The trained weights are saved next to the checkpoint and are
# reused by later runs (the network is size-agnostic, so it can also warm-start a different hull).
# ======================================================================================
GNN_F = 20                       # features per node
GNN_D = 48                       # hidden width
GNN_L = 3                        # message-passing layers
NN = NR + MAX_LIFTS              # node slots: every room, then every possible lift
NEEDS_NODE = [True] * 9 + [False, False]          # moves 0-8 act on one room/lift; add/remove lift, vent do not
REWARD_SCALE = 20.0              # a 20-point score change = reward 1.0
NOOP_REWARD = -0.05              # wasted proposal (no legal change)
BAD_REWARD = -0.3                # proposal that produced an illegal layout
LOGP0 = np.log(np.array(OP_WEIGHTS) / sum(OP_WEIGHTS)) if np is not None else None   # policy = prior odds + learned correction


def _need_numpy():
    if np is None:
        raise SystemExit("--learn needs numpy:  pip install numpy")


def init_policy(seed=0):
    _need_numpy()
    r = np.random.default_rng(seed)
    D, F = GNN_D, GNN_F

    def w(i, o, s=None):
        return r.normal(0.0, (s if s is not None else (2.0 / i) ** 0.5), (i, o))

    p = {"Win": w(F, D), "bin": np.zeros(D)}
    for l in range(GNN_L):
        p[f"Ws{l}"], p[f"Wn{l}"], p[f"b{l}"] = w(D, D, 0.5 * (2.0 / D) ** 0.5), w(D, D, 0.5 * (2.0 / D) ** 0.5), np.zeros(D)
    p.update({"Wo1": w(D, D), "bo1": np.zeros(D), "Wo2": w(D, NOPS, 0.01), "bo2": np.zeros(NOPS),
              "Wnode": w(D, NOPS, 0.01), "bnode": np.zeros(NOPS),
              "Wv1": w(D, D), "bv1": np.zeros(D), "Wv2": w(D, 1, 0.01), "bv2": np.zeros(1)})
    return p


def norm_adj(A):
    A = A.astype(np.float64)
    return A / np.maximum(A.sum(-1, keepdims=True), 1.0)


def gnn_forward(p, X, A, M):
    """X [B,N,F], A [B,N,N] (row-normalised), M [B,N] (1 = real node). Returns outputs and a cache."""
    Mc = M[..., None]
    Z0 = X @ p["Win"] + p["bin"]
    H = np.maximum(Z0, 0.0) * Mc
    layers = []
    for l in range(GNN_L):
        Msg = A @ H
        Z = H @ p[f"Ws{l}"] + Msg @ p[f"Wn{l}"] + p[f"b{l}"]
        Hn = (np.maximum(Z, 0.0) + H) * Mc
        layers.append((H, Msg, Z))
        H = Hn
    cnt = np.maximum(M.sum(1, keepdims=True), 1.0)
    g = H.sum(1) / cnt
    o1p = g @ p["Wo1"] + p["bo1"]
    o1 = np.maximum(o1p, 0.0)
    op_logits = o1 @ p["Wo2"] + p["bo2"]
    node_logits = H @ p["Wnode"] + p["bnode"]
    v1p = g @ p["Wv1"] + p["bv1"]
    v1 = np.maximum(v1p, 0.0)
    value = (v1 @ p["Wv2"] + p["bv2"])[:, 0]
    cache = (X, A, M, Z0, layers, H, g, o1p, o1, v1p, v1, cnt)
    return op_logits, node_logits, value, cache


def gnn_backward(p, cache, d_op, d_node, d_val):
    X, A, M, Z0, layers, Hf, g, o1p, o1, v1p, v1, cnt = cache
    Mc = M[..., None]
    G = {k: np.zeros_like(v) for k, v in p.items()}
    G["Wo2"] = o1.T @ d_op
    G["bo2"] = d_op.sum(0)
    do1 = (d_op @ p["Wo2"].T) * (o1p > 0)
    G["Wo1"] = g.T @ do1
    G["bo1"] = do1.sum(0)
    dg = do1 @ p["Wo1"].T
    dv = d_val[:, None]
    G["Wv2"] = v1.T @ dv
    G["bv2"] = dv.sum(0)
    dv1 = (dv @ p["Wv2"].T) * (v1p > 0)
    G["Wv1"] = g.T @ dv1
    G["bv1"] = dv1.sum(0)
    dg = dg + dv1 @ p["Wv1"].T
    G["Wnode"] = np.einsum("bnd,bnk->dk", Hf, d_node)
    G["bnode"] = d_node.sum((0, 1))
    dH = d_node @ p["Wnode"].T + (dg / cnt)[:, None, :] * Mc
    for l in range(GNN_L - 1, -1, -1):
        H, Msg, Z = layers[l]
        dHn = dH * Mc
        dZ = dHn * (Z > 0)
        G[f"Ws{l}"] = np.einsum("bnd,bne->de", H, dZ)
        G[f"Wn{l}"] = np.einsum("bnd,bne->de", Msg, dZ)
        G[f"b{l}"] = dZ.sum((0, 1))
        dH = dHn + dZ @ p[f"Ws{l}"].T + np.swapaxes(A, 1, 2) @ (dZ @ p[f"Wn{l}"].T)
    dZ0 = dH * Mc * (Z0 > 0)
    G["Win"] = np.einsum("bnf,bnd->fd", X, dZ0)
    G["bin"] = dZ0.sum((0, 1))
    return G


def masks_for(ntype, combat_only):
    """Which moves / which nodes are allowed for a graph. Returns (op_valid[NOPS], node_valid[NOPS, NN])."""
    node_valid = np.zeros((NOPS, NN), bool)
    rooms = (ntype == 1) if combat_only else ((ntype == 1) | (ntype == 2))
    for o in range(NOPS):
        if o in ROOM_OPS:
            node_valid[o] = rooms
        elif o in (6, 7, 8):
            node_valid[o] = ntype == 3
    op_valid = np.ones(NOPS, bool)
    for o in range(NOPS):
        if NEEDS_NODE[o] and not node_valid[o].any():
            op_valid[o] = False
    if combat_only:
        keep = np.zeros(NOPS, bool)
        keep[list(ROOM_OPS)] = True
        op_valid &= keep
    if VENT_COUNT <= 0:
        op_valid[10] = False
    return op_valid, node_valid


def msoftmax(z, valid):
    z = np.where(valid, z, -1e9)
    z = z - z.max(-1, keepdims=True)
    e = np.exp(z) * valid
    return e / np.maximum(e.sum(-1, keepdims=True), 1e-300)


def graph_of(info):
    """Layout -> (features [NN,F], raw adjacency uint8 [NN,NN], node types [NN]: 1 combat, 2 other room, 3 lift)."""
    st = info["state"]
    pos, lifts = st["pos"], st["lifts"][:MAX_LIFTS]
    touch, corners = info["touch"], set(corner_rooms(pos))
    usage = info["lift_usage"]
    utot = float(sum(usage.values())) or 1.0
    X = np.zeros((NN, GNN_F), np.float32)
    A = np.zeros((NN, NN), np.uint8)
    nt = np.zeros(NN, np.int8)
    rects = []
    for r in range(NR):
        x, y = pos[r]
        w, h = ROOMS[r][2], ROOMS[r][3]
        rects.append((x, y, x + w, y + h))
        comb = ROOMS[r][5]
        nt[r] = 1 if comb else 2
        f = X[r]
        t, rg = touch.get(r, 0), ARMOR_RANGES[r]
        f[0], f[1], f[3] = (1.0 if comb else 0.0), (0.0 if comb else 1.0), (1.0 if r in PRIORITY_SET else 0.0)
        f[4], f[5], f[6], f[7] = w / 6.0, h / 4.0, (x + w / 2.0) / W, (y + h / 2.0) / H
        f[16], f[19] = (y + h - 1) / H, 1.0
        if comb:
            f[8], f[11] = t / 10.0, (1.0 if t == 0 else 0.0)
            if rg:
                f[9], f[10], f[12], f[13] = (1.0 if t < rg[0] else 0.0), (1.0 if t > rg[1] else 0.0), rg[0] / 10.0, rg[1] / 10.0
            f[15] = 1.0 if r in corners else 0.0
    for i in range(NR):
        ax0, ay0, ax1, ay1 = rects[i]
        for j in range(i + 1, NR):
            bx0, by0, bx1, by1 = rects[j]
            yo = min(ay1, by1) - max(ay0, by0)
            xo = min(ax1, bx1) - max(ax0, bx0)
            if (((ax1 == bx0 or bx1 == ax0) and yo > 0) or ((ay1 == by0 or by1 == ay0) and xo > 0)
                    or (i < NC and j < NC and ay1 == by1)):          # touching, or on the same floor row
                A[i, j] = A[j, i] = 1
    for k, (lx, y0, y1) in enumerate(lifts):
        n = NR + k
        nt[n] = 3
        f = X[n]
        f[2], f[5], f[6], f[7] = 1.0, (y1 - y0 + 1) / float(H), lx / float(W), (y0 + y1 + 1) / 2.0 / H
        f[8], f[19] = usage.get(lx, 0) / utot, 1.0
        near = 0
        for r in range(NR):
            rx0, ry0, rx1, ry1 = rects[r]
            if (rx0 == lx + 1 or rx1 == lx) and ry0 <= y1 and ry1 > y0:
                A[n, r] = A[r, n] = 1
                near += 1
        f[17] = near / 8.0
    deg = A.sum(1)
    for r in range(NR):
        X[r, 18] = deg[r] / 8.0
        X[r, 17] = 1.0 if A[r, NR:].any() else 0.0
    return X, A, nt


class PolicyRuntime:
    """Worker-side: proposes moves from the GNN policy and records (state, action, reward) experience."""

    def __init__(self, params, eps, weights):
        self.p, self.eps = params, eps
        self.prior_w = np.array(weights or OP_WEIGHTS, dtype=np.float64)
        self.states, self.trans = [], []
        self.cur = None
        self.sidx = -1

    def _graph(self, cur):
        if self.cur is cur:
            return True
        res = finalize(cur)
        if res is None:
            return False
        X, Ar, nt = graph_of(res[2])
        M = (nt > 0).astype(np.float64)[None]
        opl, nl, _, _ = gnn_forward(self.p, X[None].astype(np.float64), norm_adj(Ar)[None], M)
        self.opl, self.nl, self.nt = opl[0], nl[0], nt
        self.cur, self.cache = cur, {}
        self.sidx = len(self.states)
        self.states.append((X, Ar, nt))
        return True

    def _dist(self, combat_only):
        d = self.cache.get(combat_only)
        if d is None:
            opv, nodev = masks_for(self.nt, combat_only)
            op_p = msoftmax(self.opl + LOGP0, opv)
            node_p = msoftmax(self.nl.T, nodev)                    # [NOPS, NN]
            prior = np.where(opv, self.prior_w, 0.0)
            prior = prior / max(prior.sum(), 1e-12)
            d = self.cache[combat_only] = (opv, nodev, op_p, node_p, prior)
        return d

    @staticmethod
    def _sample(p, rng):
        c = np.cumsum(p)
        return int(min(np.searchsorted(c, rng.random() * c[-1], side="right"), len(p) - 1))

    def propose(self, cur, rng, combat_only):
        if not self._graph(cur):
            nxt, op = propose(cur, rng, self.prior_w.tolist(), combat_only)
            return nxt, op, None
        opv, nodev, op_p, node_p, prior = self._dist(combat_only)
        explore = rng.random() < self.eps
        op = self._sample(prior if explore else op_p, rng)
        needs = NEEDS_NODE[op]
        node = -1
        if needs:
            node = self._sample(nodev[op].astype(np.float64) if explore else node_p[op], rng)
        pi = op_p[op] * (node_p[op][node] if needs else 1.0)
        pr = prior[op] / (nodev[op].sum() if needs else 1.0)
        p_exec = (1.0 - self.eps) * pi + self.eps * pr
        nxt = apply_op(cur, rng, op, combat_only, node if needs else None)
        return nxt, op, (self.sidx, op, node, p_exec, pr, self.eps, 1 if combat_only else 0)

    def record(self, act, reward):
        if act is not None:
            self.trans.append(act + (reward,))

    def export(self):
        if not self.trans:
            return None
        T = np.array(self.trans, dtype=np.float64)
        return {"X": np.stack([s[0] for s in self.states]), "A": np.stack([s[1] for s in self.states]),
                "nt": np.stack([s[2] for s in self.states]), "T": T.astype(np.float32)}


class PolicyTrainer:
    """Main-process PPO trainer (hand-written backprop + Adam)."""

    def __init__(self, params, seed=0, cap=60000):
        self.p = params
        self.m = {k: np.zeros_like(v) for k, v in params.items()}
        self.v = {k: np.zeros_like(v) for k, v in params.items()}
        self.t = 0
        self.rng = np.random.default_rng(seed)
        self.chunks, self.cap, self.total = [], cap, 0
        self.updates = 0
        self.stats = {}
        self._cat = None

    def ingest(self, exp):
        if exp is None:
            return
        T = exp["T"]
        nt = exp["nt"]
        opv = np.zeros((len(T), NOPS), bool)
        nodev = np.zeros((len(T), NN), bool)
        cache = {}
        for i in range(len(T)):
            s, op, c = int(T[i, 0]), int(T[i, 1]), int(T[i, 6])
            k = (s, c)
            if k not in cache:
                cache[k] = masks_for(nt[s], bool(c))
            ov, nv = cache[k]
            opv[i] = ov
            nodev[i] = nv[op]
        self.chunks.append({"X": exp["X"], "A": exp["A"], "nt": nt, "T": T, "opv": opv, "nodev": nodev})
        self.total += len(T)
        while self.total > self.cap and len(self.chunks) > 1:
            self.total -= len(self.chunks.pop(0)["T"])
        self._cat = None

    def _build(self):
        if self._cat is None:
            off, Xs, As, nts, Ts, ov, nv = 0, [], [], [], [], [], []
            for c in self.chunks:
                t = c["T"].copy()
                t[:, 0] += off
                off += len(c["X"])
                Xs.append(c["X"]); As.append(c["A"]); nts.append(c["nt"]); Ts.append(t); ov.append(c["opv"]); nv.append(c["nodev"])
            self._cat = (np.concatenate(Xs), np.concatenate(As), np.concatenate(nts), np.concatenate(Ts),
                         np.concatenate(ov), np.concatenate(nv))
        return self._cat

    def train(self, budget=0.6, mb=384, lr=2e-3, clip=0.2, beta=0.01, cv=0.5, min_buffer=1500):
        if self.total < min_buffer:
            return
        Xa, Aa, nta, Ta, opva, nodeva = self._build()
        t0 = time.time()
        stats = []
        while time.time() - t0 < budget:
            idx = self.rng.choice(len(Ta), size=min(mb, len(Ta)), replace=False)
            us, inv = np.unique(Ta[idx, 0].astype(np.int64), return_inverse=True)
            batch = {"X": Xa[us].astype(np.float64), "A": norm_adj(Aa[us]), "M": (nta[us] > 0).astype(np.float64),
                     "inv": inv, "op": Ta[idx, 1].astype(np.int64), "node": Ta[idx, 2].astype(np.int64),
                     "p_old": Ta[idx, 3].astype(np.float64), "prior": Ta[idx, 4].astype(np.float64),
                     "eps": Ta[idx, 5].astype(np.float64), "r": Ta[idx, 7].astype(np.float64),
                     "opv": opva[idx], "nodev": nodeva[idx]}
            loss, G, st = ppo_grads(self.p, batch, clip=clip, beta=beta, cv=cv)
            gn = (sum(float((g * g).sum()) for g in G.values())) ** 0.5
            sc = 1.0 if gn < 1.0 else 1.0 / gn
            self.t += 1
            for k in self.p:
                g = G[k] * sc
                self.m[k] = 0.9 * self.m[k] + 0.1 * g
                self.v[k] = 0.999 * self.v[k] + 0.001 * g * g
                self.p[k] -= lr * (self.m[k] / (1 - 0.9 ** self.t)) / ((self.v[k] / (1 - 0.999 ** self.t)) ** 0.5 + 1e-8)
            stats.append(st)
            self.updates += 1
        if stats:
            self.stats = {k: float(np.mean([s[k] for s in stats])) for k in stats[0]}
            self.stats["mean_reward"] = float(Ta[:, 7].mean())

    def save(self, path):
        np.savez(path, **self.p)


def ppo_grads(p, b, clip=0.2, beta=0.01, cv=0.5, adv=None):
    """PPO-clip loss and its gradients for a batch of transitions (see PolicyTrainer.train)."""
    opl_u, nl_u, v_u, cache = gnn_forward(p, b["X"], b["A"], b["M"])
    inv, op, node, T = b["inv"], b["op"], b["node"], len(b["op"])
    ar = np.arange(T)
    needs = np.array(NEEDS_NODE)[op]
    pop = msoftmax(opl_u[inv] + LOGP0, b["opv"])
    nlT = nl_u[inv][ar, :, op]
    pn = msoftmax(nlT, b["nodev"])
    nodei = np.where(needs, node, 0)
    pi = pop[ar, op] * np.where(needs, pn[ar, nodei], 1.0)
    p_new = (1.0 - b["eps"]) * pi + b["eps"] * b["prior"]
    ratio = p_new / b["p_old"]
    v = v_u[inv]
    if adv is None:
        adv = b["r"] - v
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
    active = ((adv >= 0) & (ratio <= 1 + clip)) | ((adv < 0) & (ratio >= 1 - clip))
    dpi = -adv * (1.0 - b["eps"]) / b["p_old"] * active
    coef = dpi * pi
    H_op = -(pop * np.log(pop + 1e-12)).sum(1)
    H_nd = -(pn * np.log(pn + 1e-12)).sum(1) * needs
    loss = float(np.mean(-np.minimum(ratio * adv, np.clip(ratio, 1 - clip, 1 + clip) * adv)
                         + cv * 0.5 * (v - b["r"]) ** 2 - beta * (H_op + H_nd)))
    one_op = np.zeros_like(pop)
    one_op[ar, op] = 1.0
    dz_op = coef[:, None] * (one_op - pop) + beta * pop * (np.log(pop + 1e-12) + H_op[:, None])
    one_nd = np.zeros_like(pn)
    one_nd[ar, nodei] = 1.0
    dz_nd = (coef[:, None] * (one_nd - pn) + beta * pn * (np.log(pn + 1e-12) + H_nd[:, None] / np.maximum(needs, 1)[:, None])) * needs[:, None]
    d_op_u = np.zeros_like(opl_u)
    np.add.at(d_op_u, inv, dz_op / T)
    tmp = np.zeros((T,) + nl_u.shape[1:])
    tmp[ar, :, op] = dz_nd / T
    d_node_u = np.zeros_like(nl_u)
    np.add.at(d_node_u, inv, tmp)
    d_val_u = np.zeros_like(v_u)
    np.add.at(d_val_u, inv, cv * (v - b["r"]) / T)
    G = gnn_backward(p, cache, d_op_u, d_node_u, d_val_u)
    st = {"loss": loss, "entropy": float(H_op.mean()), "clipfrac": float(1.0 - active.mean()),
          "value_err": float(np.mean((v - b["r"]) ** 2))}
    return loss, G, st


def prune_vents(st, res):
    """Remove every vent the layout does not need: one at a time, drop a vent when the layout scores at
    least as well without it (its tile then goes to armor). With CONNECT_ALL a vent that keeps a room
    reachable always stays. Repeats until no vent can go."""
    cur, best = st, res
    if VENT_GAME_LINKS and cur["vents"]:
        occ = occupancy(cur)
        if occ:
            tiles, lifts, vents = occ
            bad = set(useless_vents(vent_links(cur["pos"], vents, tiles), lifts))
            if bad:
                cand = dict(pos=cur["pos"], lifts=cur["lifts"], vents=[v for v in cur["vents"] if tuple(v) not in bad])
                r = finalize(cand)
                if r:
                    cur, best = cand, r
    changed = True
    while changed and cur["vents"]:
        changed = False
        for v in list(cur["vents"]):
            cand = dict(pos=cur["pos"], lifts=cur["lifts"], vents=[x for x in cur["vents"] if x != v])
            r = finalize(cand)
            if r and r[0] >= best[0] - 1e-9 and not (CONNECT_ALL and r[2]["unreach"] > best[2]["unreach"]):
                cur, best, changed = cand, r, True
                break
    return cur, best


def shift_band(st, axis, at, d, lo=None, hi=None):
    """Slide a deck (axis 1: rows) or a column of rooms (axis 0) by one tile. d = +1 moves the rooms whose
    top/left edge is at or after `at` towards the bottom/right; d = -1 moves the rooms whose bottom/right edge
    is at or before `at` towards the top/left. lo..hi optionally limits the rooms to a stretch of the other
    axis (e.g. between two lifts). Rooms that cannot move (hull edge, a lift, a vent or a room that stays in
    the way) stay where they are, and so do the rooms they block. Typical use: move an empty row - where armor
    goes - from the hull edge to between two decks, where each armor tile protects two rooms."""
    pos = st["pos"]

    def lead(r):                                   # coordinate that decides which side of the cut a room is on
        x, y = pos[r]
        w, h = ROOMS[r][2], ROOMS[r][3]
        if axis == 1:
            return y if d > 0 else y + h - 1
        return x if d > 0 else x + w - 1

    def across(r):                                 # extent along the other axis
        x, y = pos[r]
        return (y, y + ROOMS[r][3] - 1) if axis == 0 else (x, x + ROOMS[r][2] - 1)

    moving = {r for r in range(NR) if (lead(r) >= at if d > 0 else lead(r) <= at)
              and (lo is None or (across(r)[0] >= lo and across(r)[1] <= hi))}
    if not moving:
        return dict(pos=pos, lifts=st["lifts"], vents=st["vents"])
    fixed = set()
    for x, y0, y1 in st["lifts"]:
        fixed.update((x, y) for y in range(y0, y1 + 1))
    fixed.update(tuple(v) for v in st["vents"])
    dx, dy = (0, d) if axis == 1 else (d, 0)
    changed = True
    while changed:                                 # drop rooms that cannot move until the moving set is stable
        changed = False
        stay = set()
        for r in range(NR):
            if r not in moving:
                x, y = pos[r]
                stay.update((xx, yy) for yy in range(y, y + ROOMS[r][3]) for xx in range(x, x + ROOMS[r][2]))
        for r in sorted(moving):
            x, y = pos[r]
            nx, ny = x + dx, y + dy
            w, h = ROOMS[r][2], ROOMS[r][3]
            if (not rect_ok(nx, ny, w, h, r)
                    or any((xx, yy) in stay or (xx, yy) in fixed for yy in range(ny, ny + h) for xx in range(nx, nx + w))):
                moving.discard(r)
                changed = True
                break
    new = [(x + dx, y + dy) if r in moving else (x, y) for r, (x, y) in enumerate(pos)]
    return dict(pos=new, lifts=st["lifts"], vents=st["vents"])


def stretch_lifts(st, d):
    """Every lift one tile longer at its top (d = -1) or bottom (d = +1) end, where that tile is free."""
    occ = occupancy(dict(st, lifts=[]))
    if occ is None:
        return None
    tiles = occ[0]
    lifts, changed = [], False
    for x, y0, y1 in st["lifts"]:
        ny = y0 - 1 if d < 0 else y1 + 1
        if free_tile(x, ny) and (x, ny) not in tiles and (x, ny) not in occ[2]:
            lifts.append((x, ny, y1) if d < 0 else (x, y0, ny))
            changed = True
        else:
            lifts.append((x, y0, y1))
    return dict(pos=st["pos"], lifts=lifts, vents=st["vents"]) if changed else None


def band_polish(st, res, deadline=None, rounds=8):
    """Try sliding every deck / column of rooms by one tile (shift_band) and keep the best improvement,
    repeatedly. Fixes what single-room moves cannot, like an armor belt on the hull edge that would protect
    twice as much between two decks."""
    cur, best = st, res
    for _ in range(rounds):
        top = None
        # stretches of the other axis between lift columns (for decks) as well as the whole width
        cols = sorted({x for x, _, _ in cur["lifts"]})
        cuts = [-1] + cols + [W]
        spans = [(None, None)] + [(cuts[i] + 1, cuts[i + 1] - 1) for i in range(len(cuts) - 1) if cuts[i + 1] - cuts[i] > 2]
        for axis, n in ((1, H), (0, W)):
            for at in range(n):
                for d in (1, -1):
                    for lo, hi in (spans if axis == 1 else [(None, None)]):
                        if deadline and time.time() > deadline:
                            return cur, best
                        cand = shift_band(cur, axis, at, d, lo, hi)
                        if cand["pos"] == cur["pos"] or occupancy(cand) is None:
                            continue
                        r = finalize(cand)
                        if not r:
                            continue
                        if r[0] <= best[0] + 1e-6 and r[2]["arm_sum"] > best[2]["arm_sum"]:
                            # more armor but worse overall (usually rooms cut off from their lift): stretch the
                            # lifts into the moved deck, then reconnect what is still cut off, and judge again
                            if axis == 1:
                                ext = stretch_lifts(cand, d)
                                if ext is not None:
                                    re = finalize(ext)
                                    if re and re[0] > r[0]:
                                        cand, r = ext, re
                            if r[2]["unreach"] > best[2]["unreach"]:
                                cand, r = repair_connections(cand, r, random.Random(at * 7 + d))
                        if r[0] > best[0] + 1e-6 and (top is None or r[0] > top[1][0]):
                            top = (cand, r)
        if top is None:
            break
        cur, best = top
    return cur, best


def final_touch(st, res, rng, deadline=None):
    """Clean-up for a finished layout: slide decks/columns, reconnect combat rooms, drop unneeded vents."""
    st, res = band_polish(st, res, deadline)
    if CONNECT_ALL:
        st, res = repair_connections(st, res, rng)
    if st["vents"]:
        st, res = prune_vents(st, res)
    return st, res


def cut_off(state):
    """Combat rooms outside the biggest connected group (0 = every combat room reaches every other)."""
    occ = occupancy(state)
    if occ is None:
        return None
    tiles, lifts, vents = occ
    walk = walk_set(state["pos"], lifts, vents, set())
    adj, reps, _ = make_graph(state["pos"], lifts, vents, tiles, walk)
    comp, sizes = {}, []
    for rp in reps:
        if rp in comp:
            continue
        k = len(sizes)
        sizes.append(0)
        comp[rp] = k
        stack = [rp]
        while stack:
            u = stack.pop()
            for v, _ in adj.get(u, ()):
                if v not in comp:
                    comp[v] = k
                    stack.append(v)
    for rp in reps:
        sizes[comp[rp]] += 1
    return len(reps) - max(sizes) if sizes else 0


def repair_connections(st, res, rng, rounds=12):
    """CONNECT_ALL: while combat rooms are cut off, add the vent or lift that reconnects the most."""
    cur, cut = st, cut_off(st)
    for _ in range(rounds):
        if not cut:
            break
        cands = []
        if len(cur["vents"]) < VENT_COUNT:
            cands += [dict(pos=cur["pos"], lifts=cur["lifts"], vents=list(cur["vents"]) + [sp]) for sp in vent_gap_spots(cur)]
        if len(cur["lifts"]) < MAX_LIFTS:
            seen = set()
            for _ in range(60):
                lf = fit_lift(cur, rng)
                if lf and lf not in seen:
                    seen.add(lf)
                    cands.append(dict(pos=cur["pos"], lifts=list(cur["lifts"]) + [lf], vents=cur["vents"]))
        best_c, best_cut = None, cut
        for c in cands:
            k = cut_off(c)
            if k is not None and k < best_cut:
                best_c, best_cut = c, k
        if best_c is None:
            break
        cur, cut = best_c, best_cut
    if cur is st:
        return st, res
    r = finalize(cur)
    return (cur, r) if r else (st, res)


def run_restart(args):
    seed, iters, steps, start, t0, weights = args[:6]
    pol = args[6] if len(args) > 6 else None            # (policy params, explore share) or None
    rng = random.Random(seed)
    policy = PolicyRuntime(pol[0], pol[1], weights) if pol else None
    try:
        st, _, a1, s1 = anneal(rng, iters, start=start, t0=t0, weights=weights,
                               phase_frac=0.4 if start is None else 0.0, policy=policy)
    except RuntimeError:              # no starting layout could be built: report it, never hang
        tick(iters + steps)
        return seed, float("-inf"), None, [0] * NOPS, [0] * NOPS, None
    st, res, a2, s2 = polish(st, rng, steps, weights, policy=policy)
    if res and CONNECT_ALL:
        st, res = repair_connections(st, res, rng)
    if res and st["vents"]:
        st, res = prune_vents(st, res)
    att = [x + y for x, y in zip(a1, a2)]
    succ = [x + y for x, y in zip(s1, s2)]
    return seed, (res[0] if res else float("-inf")), res, att, succ, (policy.export() if policy else None)


def report(res, color=True):
    score, g, info = res

    # ANSI background colors make room types easy to distinguish in a terminal.
    # The grid remains readable in monochrome terminals with --no-color.
    bg = {
        "A": "\033[43;30m",  # armor: yellow
        "L": "\033[46;30m",  # lifts: cyan
        "V": "\033[107;30m", # vents: bright white
        "X": "\033[45;97m",  # bedrooms: magenta
        "x": "\033[42;30m",  # bonus rooms: green
        "P": "\033[41;97m",  # priority combat: red
        ".": "\033[100;97m", # empty space (not walkable): gray
        "#": "\033[90m",     # outside hull: dim
        "~": "\033[44;97m",  # empty resource space: blue
    }
    reset = "\033[0m"
    # Extra non-combat categories each get their own color (cycled), distinct from combat blue.
    nc_palette = ["\033[105;30m", "\033[103;30m", "\033[102;30m", "\033[106;30m", "\033[47;30m"]
    nc_styles = {s: nc_palette[i % len(nc_palette)]
                 for i, s in enumerate(s for s in NONCOMBAT_SYMBOLS if s != "X")}

    def cell(ch):
        # Combat rooms use their own symbol; digits and letters get a blue tint.
        if ch in NONCOMBAT_SYMBOLS and ch != "X":
            style = nc_styles[ch]
        else:
            style = bg.get(ch, "\033[44;97m" if ch not in (".", "#") else "")
        content = f" {ch} "
        return f"{style}{content}{reset}" if color and style else content

    print("\nBEST SHIP LAYOUT — color-coded grid")
    print("     " + "   ".join(f"{i:02}" for i in range(W)))
    print("     ┌" + "───┬" * (W - 1) + "───┐")
    for y in range(H):
        print(f"y{y:<3} │" + "│".join(cell(ch) for ch in g[y]) + "│")
        if y < H - 1:
            print("     ├" + "───┼" * (W - 1) + "───┤")
    print("     └" + "───┴" * (W - 1) + "───┘")

    print(f"\nScore {score:.1f} | armor {len(info['armor'])} (weighted touchpoints {info['arm_sum']:.0f})"
          f" | avg travel {info['avg']:.1f} | corner travel max {info['cmax']:.0f} / avg {info['cavg']:.1f}"
          f" | unreachable room pairs {info['unreach']}"
          f" | corridor tiles {info['corridor']} | weak lift columns {info['lift_pen']}"
          f" | lift tiles touching nothing {info['lift_touch_bad']}"
          f" | lifts {len(info['state']['lifts'])}"
          f" | lift usage {dict(sorted(info.get('lift_usage', {}).items()))}"
          f" | lift imbalance penalty {info.get('lift_balance_pen', 0.0):.3f}"
          f" | unused open tiles {info.get('empty_unused', 0)}"
          f" | long-run excess {info['long_extra']} | isolation violations {info['iso']}"
          f" | priority spread {info['spread']:.1f}"
          f"{_center_note(info)}"
          f" | vents {len(info['state']['vents'])} (unlinked {info['vent_pen']})"
          f" | armor touching no room {info['floating']}"
          f" | combat rooms without armor {info.get('unarmored_rooms', 0)}"
          f" | priority rooms without armor {info.get('unarmored_priority', 0)}"
          f" | armor sweet-spot shortfall {info.get('range_under', 0):.0f} / excess {info.get('range_over', 0)}")
    tiles = info["tiles"]
    per = defaultdict(int)
    for x, y in info["armor"]:
        for dx, dy in NEIGH:
            r = tiles.get((x + dx, y + dy))
            if r is not None:
                per[r] += 1
    st = info["state"]
    print("\nCoordinate inventory (Top-Left X, Y) [armor touchpoints]:")
    for r, (x, y) in sorted(enumerate(st["pos"]), key=lambda kv: (kv[1][1], kv[1][0])):
        n, sym, w, h, _, comb = ROOMS[r]
        rg = ARMOR_RANGES[r]
        if comb and rg:
            mark = "ok" if rg[0] <= per[r] <= rg[1] else ("UNDER" if per[r] < rg[0] else "over")
            tag = f"   [{per[r]}]  sweet spot {rg[0]}-{rg[1]}: {mark}"
        else:
            tag = f"   [{per[r]}]" if comb else ""
        print(f"  {n} ({w}x{h}) -> {x}, {y}{tag}")
    for n, sym, w, h, x, y, combat in info["out"][NR:]:
        print(f"  {n} ({w}x{h}) -> {x}, {y}")
    for x, y0, y1 in st["lifts"]:
        print(f"  Lift column x={x}: y {y0}-{y1}")
    for x, y in st["vents"]:
        print(f"  Vent (1x1) -> {x}, {y}")
    ax = sorted(info["armor"], key=lambda t: (t[1], t[0]))
    print(f"  Armor ({len(ax)}): " + " ".join(f"({x},{y})" for x, y in ax))
    if TOP50:
        top50_report(info)
    key = dict(SYMBOLS)
    key.update(NONCOMBAT_SYMBOLS)
    key.update({"x": "Bonus room", "A": "Armor", "L": "Lift", "V": "Vent", ".": "empty (not walkable)", "~": "empty resource space (resource rooms only)", "#": "outside hull"})
    print("\nLegend:")
    for symbol, meaning in key.items():
        print(f"  {cell(symbol)}  {symbol} = {meaning}")


def top50_report(info):
    """Side-by-side: this layout vs how the top-50 ladder ships arrange theirs."""
    T, tiles = TOP50, info["tiles"]
    touch = info.get("touch", {})

    def med(v):
        return _pct(v, 0.5) if v else 0
    shared = sum(1 for (x, y) in info["armor"]
                 if len({tiles[t] for t in ring_of(x, y, 1, 1) if t in tiles and tiles[t] < NC}) >= 2)
    et, rt = info.get("edge_tiles", {}), info.get("ring_tiles", {})

    def edge(k):
        return f"{et.get(k, 0) / rt[k]:.0%}" if rt.get(k) else "-"
    nl = len(info["state"]["lifts"])
    rows = [
        ("armor tiles around each priority room (median)", med([touch.get(r, 0) for r in PRIORITY_IDX]),
         f"{T['armor_touch']['priority'][1]} (middle half {T['armor_touch']['priority'][0]}-{T['armor_touch']['priority'][2]})"),
        ("armor tiles around each combat room (median)", med([touch.get(r, 0) for r in range(NC) if r not in PRIORITY_SET]),
         f"{T['armor_touch']['combat'][1]} (middle half {T['armor_touch']['combat'][0]}-{T['armor_touch']['combat'][2]})"),
        ("armor tiles shared by 2+ combat rooms", f"{shared / max(1, len(info['armor'])):.0%}",
         f"{T['armor_shared_share']:.0%}"),
        ("non-combat room perimeter on the hull edge", edge("noncombat"), f"{T['edge_share']['noncombat']:.0%}"),
        ("combat room perimeter on the hull edge", edge("combat"), f"{T['edge_share']['combat']:.0%}"),
        ("priority room perimeter on the hull edge", edge("priority"), f"{T['edge_share']['priority']:.0%}"),
        ("  edge ratio non-combat / combat (fair across hulls)",
         f"{(et.get('noncombat', 0) / rt['noncombat']) / max(1e-9, et.get('combat', 0) / rt['combat']):.1f}x"
         if rt.get("noncombat") and rt.get("combat") and et.get("combat") else "-",
         f"{T['edge_share']['noncombat'] / T['edge_share']['combat']:.1f}x"),
        ("non-combat rooms touching another non-combat room",
         f"{1 - info.get('nc_alone', 0) / NNC:.0%}" if NNC > 1 else "-", f"{T['nc_cluster_share']:.0%}"),
        ("hull width per lift column", f"{HULL_WIDTH / nl:.1f}" if nl else "-",
         f"{T['width_per_lift'][1]:.1f} (middle half {T['width_per_lift'][0]:.1f}-{T['width_per_lift'][2]:.1f})"),
    ]
    print(f"\nCompared with the top-{T['ships']} ladder ships:")
    print(f"  {'':<52}{'this layout':>12}   top ships")
    for label, mine, theirs in rows:
        print(f"  {label:<52}{str(mine):>12}   {theirs}")
    print(f"  top-50 terms in the score: shell {W_SHELL * info.get('shell', 0):+.1f} | "
          f"lonely non-combat rooms {-W_NC_CLUSTER * info.get('nc_alone', 0):+.1f} | "
          f"lift spacing {-W_LIFT_DENSITY * info.get('lift_density_pen', 0):+.1f}")


def fmt_time(sec):
    sec = int(max(0, sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02}:{s:02}" if h else f"{m:02}:{s:02}"


class Progress:
    """Live progress bar for the whole run, refreshed several times per second.

    Percent = the furthest-along of whichever stop conditions are active:
      * work done / total work       (when --restarts is set; counts every annealing/polish step)
      * elapsed / --time-limit       (when --time-limit is set)
      * stale batches / --stagnation (stagnation-based early stop)
    The displayed percentage never moves backwards. With no stop condition at all the run is
    open-ended, so a moving marker is shown instead of a percentage.
    """

    def __init__(self, counter, units_per_restart, restarts, time_limit, stagnation, t0, width=30):
        self.counter, self.upr = counter, units_per_restart
        self.restarts, self.time_limit, self.stagnation = restarts, time_limit, stagnation
        self.t0, self.width = t0, width
        self.done = 0
        self.best = float("-inf")
        self.stale = 0
        self.shown = 0.0
        self.finished = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def fraction(self):
        elapsed = time.time() - self.t0
        fr = []
        if self.restarts:
            fr.append(self.counter.value / (self.restarts * self.upr))
        if self.time_limit:
            fr.append(elapsed / self.time_limit)
        if self.stagnation:
            fr.append(self.stale / self.stagnation)
        if not fr:
            return None
        self.shown = max(self.shown, min(1.0, max(fr)))
        return self.shown

    def line(self):
        elapsed = time.time() - self.t0
        f = 1.0 if self.finished else self.fraction()
        best = f"{self.best:.1f}" if self.best > float("-inf") else "--"
        runs = f"{self.done}/{self.restarts}" if self.restarts else f"{self.done}"
        if f is None:
            pos = int(elapsed * 4) % (2 * (self.width - 3))
            pos = pos if pos < self.width - 3 else 2 * (self.width - 3) - pos
            bar = "-" * pos + "<=>" + "-" * (self.width - 3 - pos)
            return f"[{bar}] open-ended | restarts {runs} | best {best} | {fmt_time(elapsed)} elapsed"
        filled = int(self.width * f)
        bar = "#" * filled + "-" * (self.width - filled)
        eta = f" | ETA {fmt_time(elapsed * (1 - f) / f)}" if 0.02 < f < 1.0 else ""
        return (f"[{bar}] {f * 100:5.1f}% | restarts {runs} | best {best} | "
                f"{fmt_time(elapsed)} elapsed{eta}")

    def draw(self):
        text = self.line()
        print("\r" + text + " " * 6, end="", flush=True)

    def log(self, msg):
        """Print a message on its own line without corrupting the bar."""
        print("\r" + " " * 110 + "\r" + msg, flush=True)
        self.draw()

    def _loop(self):
        while not self._stop.wait(0.25):
            self.draw()

    def start(self):
        self.draw()
        self._thread.start()

    def stop(self, finished=False):
        self.finished = finished
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join()
        self.draw()
        print(flush=True)


# ------------------------------------------------------------ checkpoint ---
def state_json(st):
    return {"pos": [list(p) for p in st["pos"]], "lifts": [list(l) for l in st["lifts"]],
            "vents": [list(v) for v in st["vents"]]}


def state_from_json(d):
    st = dict(pos=[tuple(p) for p in d["pos"]], lifts=[tuple(l) for l in d["lifts"]],
              vents=[tuple(v) for v in d.get("vents", [])])
    return st if len(st["pos"]) == NR and MIN_LIFTS <= len(st["lifts"]) <= MAX_LIFTS else None


def save_checkpoint(path, best_score, total_done, t0, best, population, weights):
    data = {
        "score": best_score,
        "completed_restarts": total_done,
        "elapsed_seconds": round(time.time() - t0, 2),
        "hull": HULL,
        "n_rooms": NR,
        "state": state_json(best[2]["state"]),
        "population": [state_json(res[2]["state"]) for _, res in population],
        "op_weights": weights,
    }
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, path)


def load_checkpoint(path):
    """Returns (list of (score, result), op_weights or None, message). Layouts are re-scored with the
    CURRENT settings, so changed weights never leave stale scores behind."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return [], None, None
    if data.get("hull") != HULL or data.get("n_rooms") != NR:
        return [], None, f"Ignoring {path}: it was made for a different hull or room list (use --fresh to silence)."
    found = []
    for d in [data.get("state")] + list(data.get("population", [])):
        try:
            st = state_from_json(d)
        except (KeyError, TypeError, ValueError):
            st = None
        res = finalize(st) if st else None
        if res:
            found.append((res[0], res))
    w = data.get("op_weights")
    if not (isinstance(w, list) and len(w) == NOPS):
        w = None
    return found, w, None


def main():
    ap = argparse.ArgumentParser(
        description="Search ship layouts continuously, learning from the best layouts found."
    )
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--hull-file", default=None,
                    help="text file defining hull rows with x=inside and .=outside; overrides built-in hull")
    ap.add_argument("--hull", default=None,
                    help="inline hull rows separated by '/'; use only x and . characters")
    ap.add_argument("--iters", type=int, default=2000, help="annealing steps per restart")
    ap.add_argument("--restarts", type=int, default=0,
                    help="total restarts; 0 means keep searching until stopped or --time-limit expires")
    ap.add_argument("--polish", type=int, default=600, help="full-score hill-climb steps per restart")
    ap.add_argument("--procs", type=int, default=os.cpu_count() or 1)
    ap.add_argument("--time-limit", type=float, default=0,
                    help="stop after this many seconds; 0 means no time limit")
    ap.add_argument("--batch-size", type=int, default=0,
                    help="restarts per batch (default: number of processes)")
    ap.add_argument("--checkpoint", default="best_ship_layout.json",
                    help="file to save the best state and score to")
    ap.add_argument("--population", type=int, default=POPULATION_SIZE,
                    help="maximum number of diverse elite layouts retained")
    ap.add_argument("--stagnation", type=int, default=DEFAULT_STAGNATION,
                    help="stop after this many batches without meaningful best-score improvement; 0 disables")
    ap.add_argument("--improvement-epsilon", type=float, default=IMPROVEMENT_EPSILON,
                    help="minimum score gain counted as meaningful convergence progress")
    ap.add_argument("--top", type=int, default=1,
                    help="also print this many of the best DIFFERENT layouts found (alternatives to compare)")
    ap.add_argument("--learn", action="store_true",
                    help="enable the GNN + reinforcement-learning move policy (needs numpy)")
    ap.add_argument("--policy-file", default="ship_policy.npz",
                    help="where the trained GNN policy weights are saved / loaded (with --learn)")
    ap.add_argument("--explore", type=float, default=0.25,
                    help="share of moves still drawn from the classic adaptive odds while learning")
    ap.add_argument("--train-share", type=float, default=0.15,
                    help="training time as a share of each batch's time (with --learn)")
    ap.add_argument("--fresh", action="store_true",
                    help="ignore an existing checkpoint instead of resuming from its saved population")
    ap.add_argument("--no-color", action="store_true",
                    help="disable terminal colors in the final layout grid")
    ap.add_argument("--style", default=None, choices=["original", "top"],
                    help="weights: 'top' = armor-first, close to the top-100 ladder ships (read at import, see STYLE)")
    ap.add_argument("--top50", default=None,
                    help="layouts.json from pixyship_fetch_layouts.py: score layouts with lessons from top ladder ships")
    a = ap.parse_args()

    if (a.iters < 1 or a.polish < 0 or a.procs < 1 or a.restarts < 0
            or a.population < 1 or a.stagnation < 0 or a.improvement_epsilon < 0):
        ap.error("--iters and --procs must be positive; --polish and --restarts cannot be negative")
    need = sum(rm[2] * rm[3] for rm in ROOMS) + ARMOR_COUNT
    if need > len(ALL_TILES):
        raise SystemExit(f"Hull has {len(ALL_TILES)} tiles but the rooms ({need - ARMOR_COUNT}) plus armor "
                         f"({ARMOR_COUNT}) need at least {need}. Use a bigger hull or fewer rooms/armor.")
    try:
        init_state(random.Random(a.seed))          # preflight: can this hull take a starting layout at all?
    except RuntimeError as e:
        raise SystemExit(f"Cannot start: {e}")
    batch_size = max(1, a.batch_size or a.procs)
    t0 = time.time()
    best = None
    best_score = float("-inf")
    total_done = 0
    stale_batches = 0
    population = []

    print(f"Hull: {W} x {H} | inside tiles: {len(ALL_TILES)} | armor target: {ARMOR_COUNT}", flush=True)
    if TOP50:
        ep = TOP50["edge_pref"]
        src = "top-50" if TOP50_ARMOR_RANGES else "yours"
        print(f"Top-50 lessons ON ({TOP50['ships']} ships): armor sweet spots ({src}) priority "
              f"{PRIORITY_ARMOR_RANGE[0]}-{PRIORITY_ARMOR_RANGE[1]}, combat {COMBAT_ARMOR_RANGE[0]}-{COMBAT_ARMOR_RANGE[1]} | "
              f"hull-edge preference non-combat {ep['noncombat']:+.2f}, combat {ep['combat']:+.2f}, "
              f"priority {ep['priority']:+.2f} | preferred lifts for this {HULL_WIDTH}-wide hull "
              f"{LIFT_BAND[0]:.1f}-{LIFT_BAND[1]:.1f}", flush=True)
    print("Continuous optimization enabled." if a.restarts == 0
          else f"Optimizing across {a.restarts} restarts.", flush=True)
    print(f"Workers: {a.procs} | full-score iterations/restart: {a.iters} | "
          f"polish: {a.polish} | diverse population: {a.population} | "
          f"stagnation batches: {a.stagnation or 'disabled'}", flush=True)
    weights = list(OP_WEIGHTS)
    att_tot, succ_tot = [0.0] * NOPS, [0.0] * NOPS
    if not a.fresh:
        found, lw, msg = load_checkpoint(a.checkpoint)
        if msg:
            print(msg, flush=True)
        for sc, res in found:
            population = add_population(population, (sc, res), a.population)
            if sc > best_score:
                best, best_score = res, sc
        if found:
            print(f"Resumed {len(found)} layouts from {a.checkpoint} (best {best_score:.1f}).", flush=True)
        if lw:
            weights = lw
    trainer = None
    if a.learn:
        _need_numpy()
        params = init_policy(a.seed)
        if not a.fresh and os.path.exists(a.policy_file):
            try:
                with np.load(a.policy_file) as z:
                    loaded = {k: z[k] for k in params}
                if all(loaded[k].shape == params[k].shape for k in params):
                    params = loaded
                    print(f"Loaded trained policy from {a.policy_file}.", flush=True)
                else:
                    print(f"Ignoring {a.policy_file}: network shape differs.", flush=True)
            except (OSError, KeyError, ValueError):
                print(f"Ignoring unreadable {a.policy_file}.", flush=True)
        trainer = PolicyTrainer(params, seed=a.seed)
        print(f"GNN policy on: {GNN_L} message-passing layers, width {GNN_D}, explore share {a.explore:.0%}.", flush=True)
    counter = Value("q", 0)
    prog = Progress(counter, a.iters + a.polish, a.restarts, a.time_limit, a.stagnation, t0)
    prog.best = best_score
    prog.start()
    interrupted = False

    try:
        with Pool(a.procs, initializer=_init_worker, initargs=(counter,)) as pool:
            while a.restarts == 0 or total_done < a.restarts:
                if a.time_limit and time.time() - t0 >= a.time_limit:
                    break
                count = batch_size if a.restarts == 0 else min(batch_size, a.restarts - total_done)
                # Share of brand-new random starts grows when progress stalls.
                fresh_p = 0.25 + (0.5 * min(1.0, stale_batches / a.stagnation) if a.stagnation else 0.0)
                jobs = []
                for k in range(count):
                    seed = a.seed * 1_000_000 + total_done + k
                    jr = random.Random(seed ^ 0x5EED)
                    start_state, start_t = None, 24.0
                    if population and jr.random() > fresh_p:
                        roll = jr.random()
                        if len(population) >= 2 and roll < 0.35:          # breed two elites
                            pa = select_parent(population, jr)
                            pb = select_parent(population, jr)
                            for _ in range(3):
                                if pb is not pa:
                                    break
                                pb = select_parent(population, jr)
                            start_state = crossover(pa, pb, jr) or evolve_seed(pa, jr, a.population)
                            start_t = 9.0
                        elif roll < 0.55 and best is not None:             # refine the champion, very cool
                            start_state, start_t = clone(best[2]["state"]), 4.0
                        else:                                              # mutate a ranked elite
                            start_state = evolve_seed(select_parent(population, jr), jr, a.population)
                            start_t = 9.0
                    jobs.append((seed, a.iters, a.polish, start_state, start_t, weights,
                                 (trainer.p, a.explore) if trainer else None))

                batch_improved = False
                batch_t = time.time()
                previous_best = best_score
                att_tot = [x * 0.9 for x in att_tot]
                succ_tot = [x * 0.9 for x in succ_tot]
                for seed, sc, res, att, succ, exp in pool.imap_unordered(run_restart, jobs):
                    total_done += 1
                    if trainer:
                        trainer.ingest(exp)
                    prog.done = total_done
                    att_tot = [x + y for x, y in zip(att_tot, att)]
                    succ_tot = [x + y for x, y in zip(succ_tot, succ)]
                    if res:
                        population = add_population(population, (sc, res), a.population)
                    if res and sc > best_score:
                        best, best_score = res, sc
                        prog.best = sc
                        if sc > previous_best + a.improvement_epsilon:
                            batch_improved = True
                        save_checkpoint(a.checkpoint, best_score, total_done, t0, best, population, weights)
                        prog.log(f"  NEW BEST {best_score:.1f} saved to {a.checkpoint}")
                weights = adapt_weights(att_tot, succ_tot)
                if trainer:
                    trainer.train(budget=max(0.2, a.train_share * (time.time() - batch_t)))
                    if trainer.stats:
                        s = trainer.stats
                        prog.log(f"  policy: {trainer.updates} updates | mean reward {s['mean_reward']:+.3f} | "
                                 f"entropy {s['entropy']:.2f} | clipped {s['clipfrac']:.0%}")
                stale_batches = 0 if batch_improved else stale_batches + 1
                prog.stale = stale_batches
                if a.stagnation and stale_batches >= a.stagnation:
                    prog.log("Stopping: best score has not meaningfully improved during the configured stagnation window.")
                    break
    except KeyboardInterrupt:
        interrupted = True
        prog.log("Stop requested; reporting best layout found so far.")
    finally:
        prog.stop(finished=not interrupted)

    if best is None:
        raise SystemExit("No feasible layout found. Try increasing --iters or changing --seed.")
    try:
        save_checkpoint(a.checkpoint, best_score, total_done, t0, best, population, weights)
        if trainer:
            trainer.save(a.policy_file)
    except OSError:
        pass
    print(f"\nSearch complete: {total_done} restarts in {time.time() - t0:.1f}s; "
          f"best full score {best_score:.1f}.")
    print("Learned move odds: " + ", ".join(f"{n} {w:.0%}" for n, w in zip(OP_NAMES, weights)))
    report(best, color=not a.no_color)
    if a.top > 1:
        others = sorted((p for p in population if p[1][2]["state"] != best[2]["state"]), key=lambda p: -p[0])
        for k, (sc, res) in enumerate(others[:a.top - 1], 2):
            print(f"\n==================== ALTERNATIVE #{k}  (score {sc:.1f}) ====================")
            report(res, color=not a.no_color)


if __name__ == "__main__":
    main()
