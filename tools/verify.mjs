/* The CI gate. The page claims its measurements come from the same algorithm as
   hemispheR-py and that it checks itself; this is that claim, enforced.
   Node 18+, no packages:   node tools/verify.mjs

   1. Analytic       — fed gap fractions that follow Beer–Lambert exactly, the
                       inversion must return the leaf area it was built from.
   2. Round trip     — canopies rendered from a known leaf area, measured as
                       photographs, must come back within a few percent; clumping
                       must pull the effective LAI down and the corrected LAI up.
   3. Reference      — the same canopies, fed to the REAL hemispheR-py, must give
                       the same thresholds, gap fractions and canopy attributes
                       as the JavaScript port (numbers in assets/js/reference.js).
   4. Determinism    — the same seed always paints the same pixels. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Canopy = require('../assets/js/canopy.js');
const REF = require('../assets/js/reference.js');

let failed = 0;
const rows = [];
function check(name, ok, detail = '') {
  rows.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  — ' + detail : ''}`);
}
const section = (t) => console.log(`\n${t}`);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ── 1. analytic ─────────────────────────────────────────────── */
section('1. The inversion, on exact Beer–Lambert gap fractions');
{
  const rings = [5, 15, 25, 35, 45, 55, 65];
  const make = (lai, floor = 0) => ({
    rings, nrings: 7, nseg: 8,
    gf: rings.map((c) => Array(8).fill(Math.max(floor, Math.exp(-0.5 * lai / Math.cos(c * Math.PI / 180))))),
  });
  let worst = 0;
  for (const lai of [0.25, 0.5, 1, 2, 3, 4, 5, 6]) {
    const m = Canopy.canopyMetrics(make(lai));
    worst = Math.max(worst, Math.abs(m.raw.Le - lai), Math.abs(m.raw.L - lai), Math.abs(m.raw.LX - 1));
  }
  check('Le = L = Λ and LX = 1 for a random canopy, Λ = 0.25 … 6', worst < 1e-9, `worst error ${worst.toExponential(1)}`);

  const m = Canopy.canopyMetrics(make(3));
  const sc = rings.map((c) => Math.sin(c * Math.PI / 180) * Math.cos(c * Math.PI / 180));
  const T = rings.map((c) => Math.exp(-1.5 / Math.cos(c * Math.PI / 180)));
  const difn = T.reduce((s, t, i) => s + t * sc[i], 0) / sc.reduce((a, b) => a + b, 0) * 100;
  check('DIFN is the sin·cos-weighted mean gap fraction', near(m.raw.DIFN, difn, 1e-9), `${m.raw.DIFN.toFixed(4)} vs ${difn.toFixed(4)}`);

  const z = make(2); z.gf[6][3] = 0;                       // one completely closed cell
  const mz = Canopy.canopyMetrics(z);
  check('a fully closed cell is floored (4.53e-5), not −∞', Number.isFinite(mz.raw.L) && mz.raw.L > mz.raw.Le);

  const h = new Float64Array(256); h[50] = 1000; h[200] = 1000;
  check('Otsu picks the first maximum, as the original does', Canopy.otsu(h, 2000) === 50);
  check('numpy-style rounding: 2.5 → 2, 3.5 → 4, −0.5 → −0', Canopy.roundHalfEven(2.5) === 2 && Canopy.roundHalfEven(3.5) === 4 &&
    Object.is(Canopy.roundHalfEven(-0.5) + 0, 0));
}

/* ── 2. round trip ───────────────────────────────────────────── */
section('2. Round trip: render a canopy of known leaf area, measure the photograph');
const SIZE = REF.size;
const measure = (seed, lai, clump = 0, opt = {}, maxLai = lai) => {
  const scene = Canopy.makeScene({ seed, maxLai, clump });
  const img = Canopy.render(scene, lai, SIZE);
  return Canopy.analyze(img.rgba, img.width, img.height, opt);
};
{
  const seeds = [1, 2, 3, 4, 5, 6];
  const ratios = {};
  for (const lai of [1, 2, 3, 4]) {
    const r = seeds.map((s) => measure(s, lai).Le / lai);
    ratios[lai] = mean(r);
    check(`random canopy, true Λ = ${lai}: mean Le/Λ within −10% … +4%`,
      ratios[lai] > 0.90 && ratios[lai] < 1.04, `${ratios[lai].toFixed(3)} over ${seeds.length} canopies`);
  }
  const le = [1, 2, 3, 4].map((lai) => mean(seeds.map((s) => measure(s, lai).Le)));
  check('Le rises with leaf area', le.every((v, i) => i === 0 || v > le[i - 1]), le.map((v) => v.toFixed(2)).join(' < '));

  // clumping: same leaf area, but gathered into clusters — more light gets through
  // between them, so a random-canopy inversion (Le) under-reads and the corrected L
  // should recover most of it. Clumped canopies vary more from seed to seed, so use more of them.
  const many = Array.from({ length: 16 }, (_, i) => 200 + i);
  const plainRuns = many.map((s) => measure(s, 3, 0));
  const lumpy = many.map((s) => measure(s, 3, 0.9));
  const plainLe = mean(plainRuns.map((r) => r.Le)), plainLX = mean(plainRuns.map((r) => r.LX));
  const lumpyLe = mean(lumpy.map((r) => r.Le)), lumpyL = mean(lumpy.map((r) => r.L)), lumpyLX = mean(lumpy.map((r) => r.LX));
  check('clumping lowers the effective LAI (same leaf area, more light gets through)',
    plainLe - lumpyLe > 0.08, `Le ${plainLe.toFixed(2)} → ${lumpyLe.toFixed(2)} over ${many.length} canopies each`);
  check('… and the corrected LAI L sits above Le and lands within ±10% of the true Λ = 3',
    lumpyL > lumpyLe + 0.2 && lumpyL > 2.7 && lumpyL < 3.3, `Le ${lumpyLe.toFixed(2)} < L ${lumpyL.toFixed(2)}`);
  check('clumping index LX = Le/L falls below the random-canopy value',
    lumpyLX < plainLX - 0.03, `LX ${plainLX.toFixed(2)} → ${lumpyLX.toFixed(2)}`);

  // the slider path: one scene thinned to a lower Λ must still be a fair canopy
  const thinned = [1, 2, 3, 4].map((s) => measure(s, 2, 0, {}, 6).Le / 2);
  check('thinning a Λ = 6 scene to Λ = 2 (the slider path) still measures ≈ 2',
    mean(thinned) > 0.88 && mean(thinned) < 1.06, `mean Le/Λ ${mean(thinned).toFixed(3)}`);

  const scene = Canopy.makeScene({ seed: 9, maxLai: 6 });
  const dark = (lai) => {
    const img = Canopy.render(scene, lai, 128);
    let d = 0, n = 0;
    for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i + 3] && (img.rgba[i] || img.rgba[i + 1] || img.rgba[i + 2])) { n++; if (img.rgba[i + 2] < 128) d++; }
    return d / n;
  };
  const d1 = dark(1), d3 = dark(3), d6 = dark(6);
  check('more leaf area, more canopy pixels', d1 < d3 && d3 < d6, `${(d1 * 100).toFixed(0)}% < ${(d3 * 100).toFixed(0)}% < ${(d6 * 100).toFixed(0)}%`);
}

/* ── 3. reference ────────────────────────────────────────────── */
section(`3. Parity with the real hemispheR-py (@ ${REF.commit.slice(0, 7)}, numpy ${REF.numpy}, pandas ${REF.pandas})`);
{
  let cellMax = 0, metricMax = { Le: 0, L: 0, LX: 0, DIFN: 0 }, thdOk = 0;
  REF.scenes.forEach((s, i) => {
    const scene = Canopy.makeScene({ seed: s.seed, maxLai: s.lai, clump: s.clump });
    const img = Canopy.render(scene, s.lai, s.size);
    const r = Canopy.analyze(img.rgba, img.width, img.height,
      { channel: s.channel, gamma: s.gamma, zonal: s.zonal, lens: s.lens, nrings: s.nrings, nseg: s.nseg });
    const thd = r.thd === s.py.thd;
    if (thd) thdOk++;
    let cm = 0;
    r.gf.forEach((row, a) => row.forEach((v, b) => { cm = Math.max(cm, Math.abs(v - s.py.cells[a][b])); }));
    cellMax = Math.max(cellMax, cm);
    for (const k of ['Le', 'L', 'LX', 'DIFN']) metricMax[k] = Math.max(metricMax[k], Math.abs(r[k] - s.py[k]));
    const label = `scene ${String(i + 1).padStart(2)} (Λ ${s.lai}, seed ${s.seed}${s.clump ? ', clump ' + s.clump : ''}${s.lens !== 'equidistant' ? ', ' + s.lens : ''}` +
      `${!s.zonal ? ', global' : ''}${s.channel !== 3 ? ', ch ' + s.channel : ''}${s.nrings !== 7 ? ', ' + s.nrings + 'x' + s.nseg : ''})`;
    const ok = thd && cm < 1e-6 && ['Le', 'L', 'LX'].every((k) => Math.abs(r[k] - s.py[k]) < 0.0101) && Math.abs(r.DIFN - s.py.DIFN) < 0.101;
    check(label, ok, `Le ${r.Le.toFixed(2)}/${s.py.Le.toFixed(2)}  L ${r.L.toFixed(2)}/${s.py.L.toFixed(2)}  LX ${r.LX.toFixed(2)}/${s.py.LX.toFixed(2)}  DIFN ${r.DIFN.toFixed(1)}/${s.py.DIFN.toFixed(1)}  thd ${r.thd}${thd ? '' : ' ≠ ' + s.py.thd}  max|Δ gap| ${cm.toExponential(1)}`);
  });
  check('thresholds identical on all scenes', thdOk === REF.scenes.length, `${thdOk}/${REF.scenes.length}`);
  check('every ring × segment gap fraction agrees to 1e-6', cellMax < 1e-6, `max |Δ| ${cellMax.toExponential(2)}`);
  check('Le, L, LX, DIFN agree to the original’s printed precision',
    metricMax.Le < 0.0101 && metricMax.L < 0.0101 && metricMax.LX < 0.0101 && metricMax.DIFN < 0.101,
    `max |Δ|  Le ${metricMax.Le.toFixed(3)}  L ${metricMax.L.toFixed(3)}  LX ${metricMax.LX.toFixed(3)}  DIFN ${metricMax.DIFN.toFixed(2)}`);
}

/* ── 4. determinism ──────────────────────────────────────────── */
section('4. Determinism');
{
  const fnv = (u8) => { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
  const a = Canopy.render(Canopy.makeScene({ seed: 42, maxLai: 3 }), 3, 160);
  const b = Canopy.render(Canopy.makeScene({ seed: 42, maxLai: 3 }), 3, 160);
  const c = Canopy.render(Canopy.makeScene({ seed: 43, maxLai: 3 }), 3, 160);
  check('same seed → identical pixels; different seed → different pixels', fnv(a.rgba) === fnv(b.rgba) && fnv(a.rgba) !== fnv(c.rgba));
}

console.log(`\n${failed ? '✗ ' + failed + ' check(s) failed' : '✓ all ' + rows.length + ' checks passed'}`);
process.exit(failed ? 1 : 0);
