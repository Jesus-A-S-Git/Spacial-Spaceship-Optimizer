// Runs the Python optimizer in a Web Worker so the page stays responsive.
// Python comes from Pyodide (CPython compiled to WebAssembly), loaded from a CDN.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

const PY_FILES = ["ship_layout_finder.py", "web_driver.py"];
let pyPromise = null;

function getPython() {
  if (!pyPromise) {
    pyPromise = (async () => {
      postMessage({ type: "status", msg: "Loading Python runtime (first visit downloads ~10 MB, then it is cached)..." });
      const py = await loadPyodide();
      for (const name of PY_FILES) {
        const url = new URL("../python/" + name, self.location.href);
        const res = await fetch(url);
        if (!res.ok) throw new Error("Could not load " + url + " (" + res.status + ")");
        py.FS.writeFile("/home/pyodide/" + name, await res.text());
      }
      postMessage({ type: "ready" });
      return py;
    })();
    pyPromise.catch(() => { pyPromise = null; });
  }
  return pyPromise;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const py = await getPython();
    if (msg.type !== "start") return;
    py.globals.set("CFG_JSON", JSON.stringify(msg.cfg));
    py.globals.set("EMIT", (s) => postMessage(JSON.parse(s)));
    await py.runPythonAsync(`
import sys
sys.path.insert(0, "/home/pyodide")
import web_driver
web_driver.run(CFG_JSON, "/home/pyodide/ship_layout_finder.py", EMIT)
`);
  } catch (err) {
    postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};

// Start loading Python immediately so it is ready when the user presses Start.
getPython().catch((err) => postMessage({ type: "error", message: String((err && err.message) || err) }));
