#!/usr/bin/env python3
"""Fetch ship layouts for the top-N Pixel Starships players from PixyShip.

Run on your own machine (standard library only, no pip install needed):

    python pixyship_fetch_layouts.py                      # top 100 into top_layouts/
    python pixyship_fetch_layouts.py --top 50 --out top_layouts

What it does (mirrors what pixyship.com/players does in the browser):
    1. GET  <base>/api/players?search=   -> ladder list, sorted by trophies (top N taken)
    2. GET  <base>/api/player/<name>     -> that player's ship: rooms, user, ship
       (name is URL-encoded; each room has column, row, design_id, short_name, ...)

Output (in --out):
    layouts.json   one record per player: rank, trophies, ship info, rooms[]
    raw/NN.json    the untouched API response for each player

NOTE: the per-player path (/api/player/) is taken from how the site's JS builds the
URL (playerEndpoint + name); the exact prefix is defined elsewhere in the site code.
If you get 404s, open a player on pixyship.com with DevTools > Network, copy the
request URL, and pass its prefix with --player-path (e.g. --player-path /api/player/).
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

UA = "layout-research-script/1.0"
CANDIDATE_PATHS = ["/api/players/", "/api/ship/", "/api/ships/", "/api/player/ship/", "/api/user/", "/api/players/ship/"]


def get_json(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Referer": "https://pixyship.com/players",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ValueError(f"HTTP {e.code} for {url}") from None


def main():
    # Windows consoles/pipes can default to a legacy codepage; player names are full of CJK/Cyrillic
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=100)
    ap.add_argument("--out", default="top_layouts")
    ap.add_argument("--base", default="https://pixyship.com")
    ap.add_argument("--player-path", default="auto", help="prefix before the URL-encoded player name, or 'auto' to probe likely paths")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests (be polite)")
    args = ap.parse_args()

    out = Path(args.out)
    (out / "raw").mkdir(parents=True, exist_ok=True)

    ladder = get_json(args.base + "/api/players?search=")
    if ladder.get("status") != "success":
        sys.exit(f"Ladder request failed: {str(ladder)[:200]}")
    players = sorted(ladder["data"], key=lambda p: p["trophies"], reverse=True)[: args.top]
    print(f"Ladder: taking top {len(players)} of {len(ladder['data'])}")

    player_path = args.player_path
    if player_path == "auto":
        first = urllib.parse.quote(players[0]["name"], safe="")
        player_path = None
        for cand in CANDIDATE_PATHS:
            try:
                r = get_json(args.base + cand + first)
                if r.get("status") == "success" and "rooms" in r.get("data", {}):
                    player_path = cand
                    print(f"Found player path: {cand}")
                    break
            except (ValueError, KeyError, json.JSONDecodeError):
                pass
            time.sleep(args.delay)
        if player_path is None:
            sys.exit("None of these paths worked: " + ", ".join(CANDIDATE_PATHS) +
                     "\nOpen a player on pixyship.com/players with DevTools > Network, copy the request URL,"
                     "\nand rerun with --player-path <everything before the player name>.")

    layouts, failed = [], []
    for rank, p in enumerate(players, start=1):
        name = p["name"]
        url = args.base + player_path + urllib.parse.quote(name, safe="")
        try:
            resp = get_json(url)
            if resp.get("status") != "success":
                raise ValueError(f"status={resp.get('status')}")
            d = resp["data"]
            (out / "raw" / f"{rank:02d}.json").write_text(json.dumps(resp, ensure_ascii=False), encoding="utf-8")
            ship = d.get("ship", {})
            layouts.append({
                "rank": rank,
                "name": name,
                "trophies": p["trophies"],
                "alliance": p.get("alliance"),
                "ship_id": ship.get("id"),
                "ship_name": ship.get("name"),
                "ship_level": ship.get("level"),
                "rooms": [
                    {k: v for k, v in r.items() if not k.endswith("sprite")}
                    for r in d.get("rooms", [])
                ],
            })
            print(f"  #{rank:>2} {name}: {len(layouts[-1]['rooms'])} rooms, ship {ship.get('name')}")
        except (urllib.error.URLError, ValueError, KeyError) as e:
            print(f"  #{rank:>2} {name}: FAILED ({e})")
            failed.append({"rank": rank, "name": name, "error": str(e)})
        time.sleep(args.delay)

    (out / "layouts.json").write_text(json.dumps({"layouts": layouts, "failed": failed}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nWrote {len(layouts)} layouts ({len(failed)} failed).")
    print("Upload this file:")
    print((out / "layouts.json").resolve())
    if failed and not layouts:
        print("Every player failed: check --player-path against the real request URL (see docstring).")


if __name__ == "__main__":
    main()