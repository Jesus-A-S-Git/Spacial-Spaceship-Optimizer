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
│   └── worker.js                Web Worker: loads Pyodide and runs the optimizer off the main thread
├── python/
│   ├── ship_layout_finder.py    YOUR optimizer, unmodified
│   └── web_driver.py            glue: injects web settings, runs the search loop, returns JSON
├── .nojekyll                    tells GitHub Pages to serve files as-is
└── README.md
```

To update the optimizer, replace `python/ship_layout_finder.py` with the new version and push.
The driver only needs the `# ---- END CONFIG -` marker line and the config constant names to stay as they are.

Hull rows may use `x` (usable), `r` (resource space, only resource rooms go there) and `.` (outside).
The optional `--top50` and `--learn` (numpy) modes of the optimizer are command-line only and are not used by the web page.

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
