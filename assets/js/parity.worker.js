/* parity.worker.js — repeats the hemispheR-py comparison off the main thread,
   so the page stays smooth while it re-checks itself. */
importScripts('canopy.js', 'reference.js');

self.onmessage = function () {
  var REF = self.CANOPY_REFERENCE, C = self.Canopy;
  if (!REF || !C) { self.postMessage({ type: 'error', message: 'scripts missing' }); return; }
  for (var i = 0; i < REF.scenes.length; i++) {
    var res;
    try { res = C.checkScene(REF.scenes[i]); }
    catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
    self.postMessage({ type: 'scene', i: i, total: REF.scenes.length, res: res });
  }
  self.postMessage({ type: 'done' });
};
