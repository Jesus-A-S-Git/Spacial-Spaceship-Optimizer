# Ship Layout Optimizer (web)

A static website that runs the Python ship layout optimizer in your browser using
[Pyodide](https://pyodide.org). No server and no build step, so it hosts on GitHub Pages.

## Folder layout

```
ship-optimizer-site/
├── index.html                   optimizer page
├── analyze.html                 Top 100 analysis page
├── css/
│   └── style.css                styling
├── js/
│   ├── app.js                   settings forms, start/stop, SVG layout drawing, downloads
│   ├── hulls.js                 "Find a ship hull" box (browser version of tools/grab_hull.py)
│   ├── gamerooms.js             room-name autocomplete with real game sizes and types
│   ├── categories.js            room types and colours (shared by both pages)
│   ├── top.js                   top-100 data: hull matching, starting layouts
│   ├── analyze.js               Top 100 page charts and layout gallery
│   └── worker.js                Web Worker: loads Pyodide and runs the optimizer off the main thread
├── python/
│   ├── ship_layout_finder.py    YOUR optimizer, unmodified
│   └── web_driver.py            glue: injects web settings, runs the search loop, returns JSON
├── data/
│   ├── ships.json               every ship hull, built by tools/build_ship_list.py
│   ├── rooms.json               every room design (size, type), built by tools/build_room_list.py
│   ├── top_layouts.json         top-100 ladder layouts (compact), built by tools/analyze_top.py
│   └── top_analysis.json        top-100 statistics, learned patterns and calibrated weights
├── tools/
│   ├── grab_hull.py             command-line hull grabber
│   ├── build_ship_list.py       writes data/ships.json (reuses grab_hull.py)
│   ├── build_room_list.py       writes data/rooms.json
│   ├── pixyship_fetch_layouts.py   fetches the top-100 ladder layouts from PixyShip
│   ├── analyze_top.py           analyses them (patterns, priors)
│   └── benchmark_top.py         measures how close the optimizer gets to real top ships (16 ships, 4 setups)
├── .github/workflows/refresh-ships.yml   rebuilds all data weekly (ships, rooms, top 100)
├── .nojekyll                    tells GitHub Pages to serve files as-is
└── README.md
```

To update the optimizer, replace `python/ship_layout_finder.py` with the new version and push.
The driver only needs the `# ---- END CONFIG -` marker line and the config constant names to stay as they are.

Hull rows may use `x` (usable), `r` (resource space, only resource rooms go there) and `.` (outside).
The optional `--top50` and `--learn` (numpy) modes of the optimizer are command-line only and are not used by the web page.

## Rooms

All rooms live in one list (Settings > Rooms). Each room has a name, a type, width, height, quantity and
an optional armor sweet spot (e.g. `4-6`; empty = the default for its kind). The type decides how the
optimizer treats it:

| Kind | Types | Behaviour |
|---|---|---|
| Priority | Reactor, Shield generator, Other priority | gets the most armor |
| Combat | Laser, Anti-air, Missile, Hangar, Utility, Other combat | armored, linked for crew travel; anti-air is also pulled to the middle of the other combat rooms |
| Non-combat | Bedroom, Other non-combat | kept away from armor and lifts |
| Resource | Resource | placed on `r` hull tiles |

Type a game room's name (e.g. `Missile Launcher`) and pick it from the suggestions: its real size and
type are filled in from `data/rooms.json`. The game's room types map to the page's types in `TYPE_CAT` in
`js/gamerooms.js` (only shield *generators* count as priority; batteries and capacitors are utility).

Results show each room in its type's colour, labelled with the initials of its name, and the coordinates
table lists the type. The anti-air pull is `CENTER_GROUPS` / `W_CENTER` (section 9 of the optimizer config); its strength is
*Scoring weights > Anti-air placement* on the page. Types and colours are defined in `ROOM_CATEGORIES` in `js/app.js`.

## Learning from the top 100

Every Monday the **Refresh game data and top-100 layouts** Action fetches the top 100 ladder ships from
PixyShip and runs `tools/analyze_top.py` (run it by hand from the Actions tab any time). The **Top 100
analysis** page shows the hulls they fly, their layouts, rooms per ship, armor and lifts, and what the
optimizer learned:

* **Start from top layouts** (*Search*): if top-100 players fly your hull, the search starts from their
  layouts, with your rooms put where they placed rooms of the same type and size. Open a hull from the
  Top 100 page to get one of these. If nobody in the top 100 flies your hull, layouts are **borrowed from
  top hulls with a similar shape** (at least 60% overlap after lining the hulls up; many top hulls are the
  same shape under different names), shifted onto your hull; rooms that do not fit go into free space.
* **Learned patterns** (*Search > Score with patterns learned from the top 100*): which room types top ships
  put side by side and on the hull edge (optimizer section 10, `TAG_ADJ` / `TAG_EDGE` / `W_PATTERN`), plus
  the `--top50` habits (edge use per kind, grouped non-combat rooms, lift spacing).
* **Top-player style** (*Scoring weights > Style*, the default): armor-first weights. `tools/benchmark_top.py`
  gives the optimizer the same hull, rooms and armor count as real top-100 ships and compares its best layout
  with theirs; the original weights value crew reaching every room so much that layouts end up with about
  25% less armor value than top ships. The top-player style closes most of that gap (results on the Top 100
  page, re-measured weekly). Command line: `--style top` or `STYLE = "top"` (optimizer section 12).
* **Walking** (*Armor, lifts and vents*): game-like walking, on by default. Crew walk through every room
  (optimizer `WALK_NONCOMBAT`), and Service Vents follow the game (optimizer `VENT_GAME_LINKS`, section 13, from the
  Pixel Starships wiki): vents move crew sideways only, connect to a room only where they touch its bottom row, and
  may sit side by side as a passage (a passage beside a lift connects to it). Vents that do not help are removed after
  each search. With these rules the #1 ship is fully connected through its 9 vents.
* **Final clean-up** (always on): at the end of each search round the best layouts get a clean-up pass:
  whole decks and columns of rooms are slid by one tile where that scores better (for example moving an armor belt
  from the hull edge to between two decks, where each tile protects two rooms; lifts are stretched with the deck),
  cut-off combat rooms are reconnected, and vents that do not help are removed. A vent passage only counts if it
  serves a combat room or a lift: a bedroom-to-bedroom vent is always removed.
* **Connect every combat room** (*Armor, lifts and vents*, on by default; optimizer `CONNECT_ALL`, section 14): after
  each search the optimizer adds the vent or lift that reconnects the most cut-off combat rooms, until all are
  reachable (if the hull, vent count and lift count allow it).

## Ship hulls

In **Settings > Hull > Find a ship hull**, type part of a ship name, pick one from the list (or use the
arrow keys and Enter), check the preview and press **Use this hull**. **Undo hull change** puts your old hull back.
Change some `x` to `r` afterwards if you want resource space.

The list comes from `data/ships.json`. The **Refresh ship list** GitHub Action rebuilds it from the
official game API every Monday; run it by hand once from the repo's **Actions** tab to create it the first time.
If the file is missing, the page tries the game API directly, and **Load file** accepts a saved ship list
(.json or .xml, the same formats `grab_hull.py --source` reads).

Command line:

```
python3 tools/grab_hull.py "Ship Name"        # writes hull_<name>.txt
python3 tools/build_ship_list.py              # rebuilds data/ships.json
```

## Run locally

Browsers block `fetch` from `file://`, so serve the folder:

```
cd ship-optimizer-site
python3 -m http.server 8000
```

Open http://localhost:8000

## Publish on GitHub Pages

1. Create a repository, then push this folder's contents to the repo root (so `index.html` is at the top level).
2. Repo **Settings > Pages > Build and deployment > Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

## Notes

- The search runs one Python runtime per CPU core (*Search > CPU cores to use*, 0 = automatic). With
  restarts at 0 it runs in 45-second rounds; after each round every core continues from the best layouts
  of all cores. Use the time limit or Stop; the best layouts found so far stay on screen.
- The best layouts are saved in your browser. Tick *Continue from the best layouts of earlier searches* to
  pick up where you left off (saved layouts that no longer fit your hull or room list are skipped).
- Settings are remembered in your browser (localStorage).
- Pyodide is loaded from the jsDelivr CDN, pinned to v0.26.4 in `js/worker.js`.
