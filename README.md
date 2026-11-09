# Ship Layout Optimizer (web)

A static website that runs the Python ship layout optimizer in your browser using
[Pyodide](https://pyodide.org). No server and no build step, so it hosts on GitHub Pages.

## Folder layout

```
ship-optimizer-site/
├── index.html                   page structure
├── css/
│   └── style.css                styling
├── js/
│   ├── app.js                   settings forms, start/stop, SVG layout drawing, downloads
│   ├── hulls.js                 "Find a ship hull" box (browser version of tools/grab_hull.py)
│   └── worker.js                Web Worker: loads Pyodide and runs the optimizer off the main thread
├── python/
│   ├── ship_layout_finder.py    YOUR optimizer, unmodified
│   └── web_driver.py            glue: injects web settings, runs the search loop, returns JSON
├── data/
│   └── ships.json               every ship hull, built by tools/build_ship_list.py
├── tools/
│   ├── grab_hull.py             command-line hull grabber
│   └── build_ship_list.py       writes data/ships.json (reuses grab_hull.py)
├── .github/workflows/refresh-ships.yml   rebuilds data/ships.json weekly
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

Results show each room in its type's colour, labelled with the initials of its name, and the coordinates
table lists the type. The anti-air pull is `CENTER_GROUPS` / `W_CENTER` (section 9 of the optimizer config); its strength is
*Scoring weights > Anti-air placement* on the page. Types and colours are defined in `ROOM_CATEGORIES` in `js/app.js`.

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

- A browser runs the search on one CPU core, so it is slower than the multiprocess command-line version.
  Use the time limit or Stop; the best layouts found so far stay on screen.
- Settings are remembered in your browser (localStorage).
- Pyodide is loaded from the jsDelivr CDN, pinned to v0.26.4 in `js/worker.js`.
