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
│   ├── recommend.js             room recommender: rooms for a build, scaled to the hull, limited to its ship level
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
│   └── benchmark_top.py         measures how close the optimizer gets to real top ships (16 ships, 4 setups); --save / --compare check engine changes
├── .github/workflows/refresh-ships.yml   rebuilds all data every two weeks (ships, rooms, top 100)
├── .nojekyll                    tells GitHub Pages to serve files as-is
└── README.md
```

To update the optimizer, replace `python/ship_layout_finder.py` with the new version and push.
The driver only needs the `# ---- END CONFIG -` marker line and the config constant names to stay as they are.

Hull rows may use `x` (usable), `r` (resource space, only resource rooms go there) and `.` (outside).
The optional `--top50` and `--learn` (numpy) modes of the optimizer are command-line only and are not used by the web page.

## Using the page

**Optimizer page.** The settings panel follows three steps, shown as tabs and in the steps bar at the top:
**1 Hull** (type the ship's name and press *Use this hull*; editing the grid by hand is folded away),
**2 Rooms** (the room recommender, then your room list; *Add a room by type* is folded away) and
**3 Search** (time buttons, a *Start search* button and the top-100 options). Each tab has a *Next* button.
**Advanced** holds armor/lift/vent settings, scoring weights and search details. Before the first search the results
area shows a short getting-started guide; afterwards it shows the layout, with *Copy coordinates* first.
The room list can be cleared, copied as text and pasted back (for example to keep several builds).

**Top 100 page.** Five tabs: **Overview** (key numbers, top 10 vs the rest, trophies), **Builds** (build explorer,
offense/defense builds, power), **Ships & layouts** (hulls and the layout gallery), **Room placement** (rooms per ship,
gates, hull edge, neighbours, armor and lifts) and **Optimizer check** (benchmark). Each tab starts with one line on
what it shows; long tabs have quick links to their sections. Links can point at a tab (`analyze.html#builds`) or a
section (`analyze.html#secGates`).

## Room recommender (rooms for a build)

*Settings > Rooms > Recommend rooms for a build*: pick a main weapon (lasers, missiles, hangars, cannons, boarding) and
optionally a second one (e.g. missiles + hangars = missile/hangar hybrid), or click one of the top-100 builds. The page:

* takes what the top-100 ships of that build run (rooms of each type per 100 hull tiles, the rooms they prefer for each
  type, armor per 100 tiles, lifts and vents; `recommend` in `data/top_analysis.json`). Builds flown by few top ships are
  blended with ships of the same main weapon and the whole top 100;
* scales it to your hull's size and keeps only rooms **your hull's ship level can build**, each at the best level it
  allows (the ship level comes from the hull you picked, or choose one). Rooms that unlock later are listed;
* checks power the way that build's top ships run it (made / needed at full power, e.g. about 51% for missile/hangar
  hybrids and 56% for missile builds; about half overall) and adds reactors when it is lower;
* makes it fit: rooms + armor + space for lifts and vents within the hull, leaving out the least important rooms first;
* skips event and premium rooms (starbux, rewards, one-level rooms) unless you tick *Include event and special rooms*.

*Use these rooms* replaces the room list and armor count (*Undo* puts yours back). The Top 100 page links here with
`index.html?build=missile%2Bhangar&ship=<id>`.

Ship levels (`level` in `data/ships.json`) and room tiers (`minShip`, `power`, `powerGen`, `capacity`, `price` in
`data/rooms.json`) come from the official game API with the data refresh. To refresh only the game data, run the
workflow from the Actions tab with *game_data_only* ticked.

## Rooms

All rooms live in one list (Settings > Rooms). Each room has a name, a type, width, height, quantity and
an optional armor sweet spot (e.g. `4-6`; empty = the default for its kind). The type decides how the
optimizer treats it:

| Kind | Types | Behaviour |
|---|---|---|
| Priority | Reactor, Shield generator, Other priority | gets the most armor |
| Combat | Laser, Anti-air, Missile, Hangar, Anti-missile (engines, ship thrusters), Anti-teleport (teleport interdictors, repulsors, security gates, traps), Boarding (teleports), Crew support (android studios, med bays, revivers), Cloak & radar, Shield support (batteries, capacitors, overchargers), Command (command center, computer room, mainframe, bridge), Booster, Other utility, Other combat | armored, linked for crew travel; anti-air is also pulled to the middle of the other combat rooms; a booster earns points for every room it boosts that touches it (Gunnery Core: lasers and cannons, Missile Matrix: missile rooms, Flight Controller: hangars, Auxiliary Booster: any combat room; optimizer `ROOM_BOOSTS` / `W_BOOST`, section 15) |
| Non-combat | Bedroom, Other non-combat | kept away from armor and lifts |
| Resource | Resource | placed on `r` hull tiles |

Type a game room's name (e.g. `Missile Launcher`) and pick it from the suggestions: its real size and
type are filled in from `data/rooms.json`. The game's room types map to the page's types in `TYPE_CAT` in
`js/gamerooms.js` (only shield *generators* count as priority; batteries and capacitors are utility).

Results show each room in its type's colour, labelled with the initials of its name, and the coordinates
table lists the type. The anti-air pull is `CENTER_GROUPS` / `W_CENTER` (section 9 of the optimizer config); its strength is
*Scoring weights > Anti-air placement* on the page. Types and colours are defined in `ROOM_CATEGORIES` in `js/app.js`.

## Learning from the top 100

On the 1st and 15th of every month the **Refresh game data and top-100 layouts** Action fetches the top 100 ladder ships from
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
* **Deck-structured starts** (*Search*, on by default): every search also starts from a few layouts built like top
  ships - 2-high decks with a free row between them (where armor goes, touching rooms above and below), combat rooms
  on the middle decks, non-combat rooms outside, lifts reserved first. On 16 top-100 hulls this gave every combat
  room a connection and raised armor value from 146 to 169 from scratch; together with top-player layouts on the
  same hull it reaches 191 against the real ships' 182.
* **Top-player style** (*Scoring weights > Style*, the default): armor-first weights. `tools/benchmark_top.py`
  gives the optimizer the same hull, rooms and armor count as real top-100 ships and compares its best layout
  with theirs; the original weights value crew reaching every room so much that layouts end up with about
  25% less armor value than top ships. The top-player style closes most of that gap (results on the Top 100
  page, re-measured every two weeks; armor 5, connectivity 20). Command line: `--style top` or `STYLE = "top"` (optimizer section 12).
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
  each search the optimizer adds the vent or lift, or makes the small move of a cut-off room, that reconnects the
  most cut-off combat rooms; when none helps, it closes a short gap in a floor row by sliding rooms sideways. This
  repeats until all are reachable (if the hull, vent count and lift count allow it).

## More on the Top 100 page

* **What the top 10 do differently**: rooms, armor, lifts, vents and hull use per rank band (top 10, 11-25, 26-50,
  51-100), the main weapon in each band, and the rooms the top 10 run more (and less) often than the rest.
* **Build explorer**: for each build, rooms of each type per 100 hull tiles and the rooms its ships prefer, with
  *Plan this build in the optimizer*.
* **What goes with more trophies**: rank correlation of trophies with armor, rooms, lifts, vents and each room type.
* **Power: made and needed**: for every top ship the power its reactors make and the power all its systems draw at
  full power (rooms counted at the best level the ship's level allows, since the ladder data has no room levels), the
  made/needed ratio for the whole top 100 and for each build (median and middle half), and where the power goes by
  room type. The *Every ship* table lists each ship's power. The room recommender uses the chosen build's ratio.
* Overview tiles include how much of their rooms' full power top ships make and how full their hulls are.

## Builds (Top 100 page)

Every top ship is classified by its offense and defense, e.g. "Laser build · light missiles · heavy anti-air".
Offense: the weapon type with the most rooms (lasers, missiles, hangars, cannons = EMP/Ion/Gamma and similar,
boarding = teleports) is the build; a second type with at least a quarter of the weapon rooms makes it a hybrid,
smaller amounts are listed as "some" / "light". Defense: anti-air, engines (anti-missile), anti-teleport,
cloak/radar, shield support, crew support and armor are compared with the rest of the top 100 (heavy = top
quarter, light = bottom quarter, "no" = none). The page shows how many ships run each build, what each build
runs on average, and every ship's build (`builds` in `data/top_analysis.json`, `tools/analyze_top.py`).

## Ship hulls

In **Settings > Hull > Find a ship hull**, type part of a ship name, pick one from the list (or use the
arrow keys and Enter), check the preview and press **Use this hull**. **Undo hull change** puts your old hull back.
Change some `x` to `r` afterwards if you want resource space.

The list comes from `data/ships.json`. The **Refresh ship list** GitHub Action rebuilds it from the
official game API on the 1st and 15th of every month; run it by hand once from the repo's **Actions** tab to create it the first time.
If the file is missing, the page tries the game API directly, and **Load file** accepts a saved ship list
(.json or .xml, the same formats `grab_hull.py --source` reads).

Command line:

```
python3 tools/grab_hull.py "Ship Name"        # writes hull_<name>.txt
python3 tools/build_ship_list.py              # rebuilds data/ships.json
```

## Checking an engine change

Before changing `python/ship_layout_finder.py` or `python/web_driver.py`, save a baseline with the unchanged
engine, then compare the changed engine against it. `--restarts` gives every ship a fixed amount of search work
(instead of seconds), so the numbers are the same on a busy or an idle machine and only change when the engine does:

```
export PYTHONHASHSEED=0
python3 tools/benchmark_top.py --ships 8 --restarts 6 --seed 1,2,3 --configs top,top+templates --jobs 4 --save /tmp/base.json
# ... change the engine ...
python3 tools/benchmark_top.py --ships 8 --restarts 6 --seed 1,2,3 --configs top,top+templates --jobs 4 --compare /tmp/base.json
```

`--compare` prints the score, armor and cut-off rooms per ship (before / after) and ends with `RESULT: not worse
than the baseline`, or `RESULT: REGRESSION` and exit status 1 when the mean score or armor drops by more than
`--tolerance` (default 1%) or more combat rooms are cut off. Keep a change only when it is not worse.

- `--seed 1,2,3` runs every ship once per seed. Any change to the search moves single ships a lot (hundreds of
  points either way), so one seed alone says little; three seeds (24 runs) is the minimum for a search change.
  A pure speed-up must give exactly the same numbers.
- `--jobs 4` runs that many ships at once (one process each, same results as one at a time).
- `--only 8,14` runs only those ranks (for looking into one ship).
- Changes that are about speed (more search in the same time, as on the page) also need time mode: run the old
  engine (`BENCH_SRC=old_ship_layout_finder.py`) and the new one at the same time, each with half the cores, e.g.
  `--seconds 45 --rounds 2 --jobs 2`. `--rounds` runs like the page: rounds of `--seconds`, each continuing from
  the best layouts found so far.

Resource space: only resource rooms may sit on `r` tiles (lifts, vents, armor and filler never do), and a
resource room never straddles `r` and ordinary tiles. When the hull has `r` tiles, every resource room on
ordinary tiles costs `W_RES_OFF` (default 50), and the search, the starting layouts and the deck / top-100
starts put resource rooms on `r` tiles first.

## Bonus rooms (filler)

After the search, *Fill leftover space with bonus rooms* (Advanced, on by default; `PLACE_BONUS_ROOMS`) fills
leftover space with filler bonus rooms, in this order:

1. **3x2** bonus rooms (`BONUS_SIZE`) wherever they fit without touching armor or a lift, then 3x2s that break up
   empty rows longer than *Max empty run*.
2. **2x2** bonus rooms (`BONUS_SIZE_2X2`, *Also place 2x2 bonus rooms*, `PLACE_BONUS_2X2`, on by default), the same
   two passes, only in the space that is left where no 3x2 fits.

Fillers never go on the corridor tiles crew need to reach every combat room, never on `r` tiles, and never on armor
tiles (armor is placed first). 2x2s also stay off the empty tiles on crew's shortest routes from the first combat
room, so a small filler never plugs the one gap crew walk through. On the page the 2x2s are a lighter green than the
3x2s, and the stats, the coordinates table and the TXT / copy output give the count of each ("Bonus rooms: 12 3x2,
3 2x2").

Scoring: filler tiles are used space, so they are not counted in *Unused open tiles* (`W_EMPTY` each). On top of that,
each filler room earns `W_BONUS_3X2` (default 10) or `W_BONUS_2X2` (default 5), shown under *Scoring weights > Space
and zoning*. A 2x2 earns less than a 3x2 per room and per tile, and the per-room reward only counts when every combat
room is reachable.

The 2x2s and the per-room reward are **added to the finished layouts only** (`finalize(state, final=True)`: the page's
results and the command line's printed layout). The search itself scores exactly as before (3x2 fillers, no per-room
reward), so it finds the same layouts and cannot trade armor, reach or travel for filler credit. On the page, the
**Score** shown above a layout and its stats include the 2x2s and the bonus reward. Layouts are still ranked by the
search's own score (`score` in the layout JSON; the shown one is `final_score`).

`tools/benchmark_top.py` runs with fillers off, like the real top ships it is compared with. With
`--set PLACE_BONUS_ROOMS=1` the search runs with the 3x2 fillers. Its per-ship numbers are the search's scores and are
judged without fillers, so the 2x2s never show there. To see them, finalize the saved best layouts with
`final=True`. The driver also accepts `PLACE_BONUS_ROOMS` and `PLACE_BONUS_2X2` as settings.

## Ship vs ship (mock win rate)

`battle.html` (`js/battle.js`, `css/battle.css`) lets you pick two ships (any top-100 ladder ship, or **My build**: the room
list and armor count the optimizer page saved in this browser) and shows an estimated chance of winning, the reasons, a
side-by-side breakdown and both layouts. Links keep the pair (`battle.html?a=r3&b=r60`, `mine` = my build).

**This is a mock estimate, not the game's battle engine.** Crew (boarding fights, repairs, abilities), AI and targeting,
research, equipment, the ammo players load, crew damage, area damage, stun and percentage hull damage are not modelled.
Each ship gets its rooms at the best level a level-14 ship can build. 2000 fights per match-up, in 0.25 s steps, up to
3 minutes each (then the ship with more hull left wins); each side's damage is scaled by a random +-25% per fight for what
is not modelled. The model has no DOM dependency (`node -e 'const B=require("./js/battle.js")'`), and every constant is in
one `BATTLE_CONSTANTS` block at the top of `js/battle.js`, tagged **[data]**, **[source]** or **[assumed]**.

How a fight runs:

- **Weapons** fire on their own reload + cooldown (+ volley time), slower when power is short (power made / needed below
  the top-100 median). Each projectile has its own shield, system, AP and hull damage, EMP and fire length. Lasers,
  cannons and craft shots hit the **shield** while it is up and only take shield points off it; **missiles go around
  shields**. Other hits land on a random room: system damage is cut by the room's **armor**, comes off the room and the
  hull; a destroyed room passes system damage to the hull; AP damage ignores armor; EMP switches the room off; fire burns
  AP damage each second.
- **Shields**: pool = the shield rooms' Capacity; each shield room restores its points every reload.
- **Armor**: room defence D = the room's own defence bonus + armor value x share of its outline touching armor;
  damage reduction = D / (100 + D).
- **Engines** dodge missiles from an evasion pool (sum of the engines' dodge modifiers) that refills 4% (Engine) or 3%
  (Ship Thrusters) per second; each dodge uses some of it, so a few missiles into many engines are nearly all dodged
  while a big missile load swamps a few engines (saturation).
- **Hangars** keep one craft out; it attacks on its own reload until the enemy's **anti-craft** rooms (decoys first)
  shoot down its HP, and is replaced after the hangar's reload.
- **Boarding**: each teleport lands a party that does a fixed amount of system damage, ignoring shields and armor, unless
  a ready **Interdictor Gate / Repulsor** stops it; **traps'** crew damage cuts what the party does.
- **Cloak** hides the ship (the enemy holds fire) for its duration every reload; an enemy **radar** ends it when it fires.

The **Weapon matchups** table shows, per weapon type, how much of its damage the enemy's counter stopped (dodged, shot
down, blocked, soaked by shields or lost to cloak).

**Real vs assumed.** From the game's own data (official API, `data/rooms.json`): per-room power, reload, cooldown,
volley, per-projectile shield / system / AP / hull damage, EMP and fire length, shield points and restore, engine dodge
modifiers, armor values and rooms' own defence bonus, anti-craft damage, trap crew damage, cloak and radar times, craft HP
and attack stats. From sources: ticks are 1/40 s and the defence formula D / (100 + D) (YaDc bot,
github.com/PieInTheSky-Inc/YaDc `src/pss_room.py`, `src/utils/convert.py`); missiles bypass shields, AP damage ignores
armor and does not reach the hull from a destroyed room, fire damage per second = remaining fire ticks / 500 (Pixel
Starships wiki, as quoted and checked against captured battles by github.com/TounSec/PSS-BattleStats
`crates/pss-designs/src/lib.rs`, `crates/pss-stats/src/lib.rs`); engine evasion regeneration 4% / Ship Thrusters 3%,
Teleport Repulsor reload 8 s, anti-craft shoots decoys first (official patch notes v0.999.60, 17 Aug 2026, as saved in
PSS-BattleStats `docs/blog_patch_notes_v0_999_60.xml`). **Assumed** (no source found): hull HP (35 for every ship: the
level-12 Titans' value; level-13/14 hull HP is not in any data we could read), room HP (1 per tile), the 3-minute limit,
that system damage on a room also comes off the hull, how armor adjacency counts, how the evasion pool is spent (10 points
per dodge, 90% at most), which shots engines can dodge (missiles only), gates' and traps' strength, boarding damage (2 per
landing), one craft per hangar, the default ammo (Rocket Level 7 in missile launchers, Ion Beam 6 in Ion Cannons,
Interceptor Lv9 in hangars, Decoy Drone in decoy bays: launchers and hangars fire the item the player loads), boosters
(+5% each), the power rule and the +-25% luck.

**Where the weapon data comes from.** `tools/build_room_list.py` now also keeps each room's combat fields (`reload`,
`cooldown`, `defBonus`, `restore`, `shot`, `craft`) and adds an `ammo` table from `RoomService/ListMissileDesigns` and
`ListCraftDesigns`, so the regular refresh from the live API fills them for every room. The current `data/rooms.json` was
built from the live official API (`api.pixelstarships.com`, `combatSource: "official"`): 695 of the 798 room designs have
combat stats, including every weapon, hangar and anti-craft design, and 1191 of the 1402 weapon / anti-craft rooms in the
top 100 have their own level's stats. The rest (rooms whose level has no stats, or launchers and hangars that fire
whatever the player loads) use the highest older level of the same room, a typical real room of the same type, or the
default ammo; the breakdown counts them ("Rooms with estimated combat stats"). Anti-craft damage is the API's
`CraftDamage` (`cd`); older recorded data had it in `SystemDamage`, and the model reads either.
`--merge-into` can still add combat fields from saved API responses (for example the 2024 recordings in
github.com/PSS-Tools-Development/pssapi.py test cassettes) when the live API cannot be reached.

Checks: `node tools/test_battle.js` (self-matches 48-52% at 1500 fights; each counter works in the right direction:
adding engines, Interdictor Gates, traps, anti-craft or shield generators stops more of the matching weapon and does not
lower the defender's win chance; engines dodge 91% of an 11-power missile load but 62% of a 41-power one; plus: the stats
come from the game data, missiles are never soaked by shields, armor cuts lasers but not boarders, cloak makes shots miss
and an enemy radar ends it; against a copy of itself with half the reactors a ship wins ~90%, without shields ~79%,
without engines ~63%, without armor ~53%).

Rank: the better-ranked ship wins **48.8%** of the 4950 top-100 pairs (`node tools/test_battle.js --rank`, 80 fights per
pair) on the live data; 48.4% on the 2024 recordings, 50.2% with the earlier made-up weapon numbers. Changing the main assumptions one at a time (room HP x3,
boarding damage x0.5 / x2, hull HP x2, 6-minute fights, dodge cost x0.5 / x2, no luck, armor x3, other craft ammo) kept it
at 47-49%, so nothing was tuned to it: the top 100 fly nearly the same rooms, and what separates them (crew, AI,
research, equipment) is what the model leaves out.

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
