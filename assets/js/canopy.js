/* ═══════════════════════════════════════════════════════════════
   canopy.js — the science behind the page. No dependencies.
   Runs in the browser (window.Canopy) and under Node (module.exports).

   1. makeScene / render
        A synthetic hemispherical canopy photograph. Leaves are a Poisson
        (Boolean) point process on the sphere — or a Neyman–Scott cluster
        process when "clumped" — with intensity

            n(θ) = G·Λ / (ω·cos θ)      leaves per steradian,

        so a ray at zenith angle θ escapes with probability exp(−G·Λ / cos θ)
        (Beer–Lambert, spherical leaf-angle distribution, G = 0.5). Λ is the
        picture's known, true plant area index — which is what lets the page
        check the measurement against the answer.

   2. analyze
        A port of the hemispheR-py pipeline (core/hemispherR-py.py):
        import → binarize (Otsu) → gap fraction by zenith ring → LAI et al.
        It mirrors the Python arithmetic step for step — including numpy's
        round-half-to-even and the odd-looking gamma — so the two agree on
        the same pixels. tools/verify.mjs holds it to that.
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var PI = Math.PI, DEG = PI / 180;
  var G_SPHERICAL = 0.5;            // projection function of a spherical leaf-angle distribution

  /* ═════════════════ small helpers ═════════════════ */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rng) {
    var u = 1 - rng(), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * PI * v);
  }

  /* order-independent noise in [0,1) for pixel i — so a scene renders
     identically however the loops are ordered or split up */
  function hash01(i, s) {
    var h = Math.imul((i ^ s) | 0, 0x9E3779B1);
    h ^= h >>> 15; h = Math.imul(h, 0x85EBCA6B);
    h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /* numpy.round for a scalar: halves go to the even neighbour */
  function roundHalfEven(x) {
    var f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return (f % 2 === 0) ? f : f + 1;
  }
  function roundTo(x, dec) {          // numpy.round(x, dec) = rint(x·10^dec) / 10^dec
    var m = Math.pow(10, dec);
    return roundHalfEven(x * m) / m;
  }

  /* numpy.arange(start, stop, step) */
  function arange(start, stop, step) {
    var n = Math.max(0, Math.ceil((stop - start) / step)), a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = start + i * step;
    return a;
  }

  var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };

  /* ═════════════════ 1. THE SYNTHETIC CANOPY ═════════════════ */

  var SS = 2;                              // supersampling: anti-aliased leaf edges
  var LEAF_P = 0.75;                       // half-width profile (1 − u²)^P → pointed tips
  var LEAF_HALF = 7;                       // outline = 2·(LEAF_HALF + 1) vertices
  var NV = 2 * (LEAF_HALF + 1);
  var LEAF_A = 4.2 * DEG;                  // mean semi-length of a leaf on the sphere
  var LEAF_B = 2.1 * DEG;                  // mean semi-width
  var THETA_MAX = 88 * DEG;                // leaves are scattered out to here
  var CLUSTER_SIGMA = 7 * DEG;             // spread of a shoot / crown cluster

  /* ∫₋₁¹ (1−u²)^P du, by Simpson — the leaf's area is 2·a·b·this */
  var LEAF_I = (function () {
    var n = 2000, h = 2 / n, s = 0;
    for (var k = 0; k <= n; k++) {
      var u = -1 + k * h, v = Math.pow(Math.max(0, 1 - u * u), LEAF_P);
      s += (k === 0 || k === n) ? v : (k % 2 ? 4 * v : 2 * v);
    }
    return s * h / 3;
  })();
  var LEAF_OMEGA = 2 * LEAF_A * LEAF_B * LEAF_I;   // mean solid angle of one leaf, sr

  var LAYER_RGB = [[46, 96, 54], [30, 74, 40], [17, 52, 28]];   // far → near

  function theoryGap(thetaRad, lai) {
    return Math.exp(-G_SPHERICAL * lai / Math.cos(thetaRad));
  }

  /* Scatter the leaves once; render() then reveals as many as a given Λ needs.
     Thinning a Poisson process leaves a Poisson process, so every Λ ≤ maxLai
     is a legitimate canopy — which makes the slider cheap.

     Leaf outlines are stored in lens-normalised coordinates (the fisheye circle
     has radius 1), so the same scene renders at any resolution. */
  function makeScene(o) {
    o = o || {};
    var seed = (o.seed == null ? 1 : o.seed) >>> 0;
    var maxLai = o.maxLai || 6;
    var clump = clamp01(o.clump || 0);
    var rng = mulberry32(seed);

    var kpx = 1 / (PI / 2);                                   // normalised radius per radian, equidistant lens
    var cosMax = Math.cos(THETA_MAX), logCosMax = Math.log(cosMax);
    var meanLeaves = (G_SPHERICAL * maxLai / LEAF_OMEGA) * 2 * PI * (-logCosMax);
    var K = 1 + Math.round(clump * 11);                       // leaves per cluster
    var parentMean = meanLeaves / K;
    var nParents = Math.max(0, Math.round(parentMean + Math.sqrt(parentMean) * gauss(rng)));
    var cap = nParents * K;

    var verts = new Float32Array(cap * NV * 2);
    var rank = new Float32Array(cap), layerOf = new Uint8Array(cap);
    var base = new Uint8Array(cap * 3);
    var cx = new Float32Array(cap), cy = new Float32Array(cap);
    var ax = new Float32Array(cap), ay = new Float32Array(cap), semiW = new Float32Array(cap);
    var n = 0, vi = 0;
    var minUz = Math.cos(89 * DEG);

    for (var p = 0; p < nParents; p++) {
      var cosT = Math.pow(cosMax, rng());                     // pdf ∝ tan θ  ⇒  n(θ) ∝ 1/cos θ
      var sinT = Math.sqrt(1 - cosT * cosT);
      var phi = 2 * PI * rng();
      var px = sinT * Math.sin(phi), py = sinT * Math.cos(phi), pz = cosT;

      for (var c = 0; c < K; c++) {
        var ux = px, uy = py, uz = pz;
        if (K > 1) {                                          // Gaussian offset in the tangent plane
          var g1 = gauss(rng) * CLUSTER_SIGMA, g2 = gauss(rng) * CLUSTER_SIGMA;
          ux = px + g1 * Math.cos(phi) + g2 * cosT * Math.sin(phi);
          uy = py - g1 * Math.sin(phi) + g2 * cosT * Math.cos(phi);
          uz = pz - g2 * sinT;
          var nn = Math.sqrt(ux * ux + uy * uy + uz * uz);
          ux /= nn; uy /= nn; uz /= nn;
          if (uz < minUz) continue;                           // spilled below the horizon
        }

        var st = Math.sqrt(ux * ux + uy * uy);
        var sphi = st > 1e-9 ? ux / st : 0, cphi = st > 1e-9 ? uy / st : 1;
        var ephx = cphi, ephy = -sphi;                        // e_φ  (unit, tangent)
        var ethx = uz * sphi, ethy = uz * cphi, ethz = -st;   // e_θ  (unit, tangent)
        var psi = PI * rng(), cps = Math.cos(psi), sps = Math.sin(psi);
        var fa = 0.8 + 0.4 * rng(), fb = 0.8 + 0.4 * rng();   // E[fa·fb] = 1 → mean area stays LEAF_OMEGA
        var bend = (rng() - 0.5) * 0.5;
        var layer = (rng() * 3) | 0;
        var tint = rng();
        var lr = LAYER_RGB[layer];
        var young = rng() < 0.12;                             // paler, yellower leaves
        var j1 = (rng() - 0.5) * 20, j2 = (rng() - 0.5) * 20;

        var vOff = vi;
        for (var m = 0; m < NV; m++) {
          var side = m <= LEAF_HALF ? 1 : -1;
          var idx = m <= LEAF_HALF ? m : (NV - 1 - m);
          var u = -1 + 2 * idx / LEAF_HALF;
          var hw = Math.pow(Math.max(0, 1 - u * u), LEAF_P);
          var X = LEAF_A * fa * u;
          var Y = LEAF_B * fb * (side * hw + bend * (u * u - 1 / 3));
          var du = X * cps - Y * sps, dv = X * sps + Y * cps;
          var qx = ux + du * ephx + dv * ethx;
          var qy = uy + du * ephy + dv * ethy;
          var qz = uz + dv * ethz;
          var qn = Math.sqrt(qx * qx + qy * qy + qz * qz);
          qx /= qn; qy /= qn; qz /= qn;
          var qs = Math.sqrt(qx * qx + qy * qy), r = kpx * Math.atan2(qs, qz);
          verts[vi++] = qs > 1e-12 ? r * qx / qs : 0;         // equidistant projection, unit circle
          verts[vi++] = qs > 1e-12 ? r * qy / qs : 0;
        }

        /* long axis and extent in the image plane, for shading */
        var t1x = verts[vOff], t1y = verts[vOff + 1];
        var t2x = verts[vOff + 2 * LEAF_HALF], t2y = verts[vOff + 2 * LEAF_HALF + 1];
        var alx = t2x - t1x, aly = t2y - t1y, all = Math.sqrt(alx * alx + aly * aly) || 1;
        alx /= all; aly /= all;
        var mx = (t1x + t2x) / 2, my = (t1y + t2y) / 2, wmax = 1e-4;
        for (var q = 0; q < NV; q++) {
          var across = Math.abs((verts[vOff + 2 * q] - mx) * -aly + (verts[vOff + 2 * q + 1] - my) * alx);
          if (across > wmax) wmax = across;
        }
        cx[n] = mx; cy[n] = my; ax[n] = alx; ay[n] = aly; semiW[n] = wmax;
        rank[n] = rng();
        layerOf[n] = layer;
        if (young) {
          base[n * 3] = 96 + j1; base[n * 3 + 1] = 132 + j2; base[n * 3 + 2] = 44;
        } else {
          base[n * 3] = lr[0] + j1 + tint * 8;
          base[n * 3 + 1] = lr[1] + j2 + tint * 10;
          base[n * 3 + 2] = lr[2] + (tint - 0.5) * 8;
        }
        n++;
      }
    }

    /* painter's order: far layer first */
    var order = new Uint32Array(n), oi = 0;
    for (var ly = 0; ly < 3; ly++) for (var i = 0; i < n; i++) if (layerOf[i] === ly) order[oi++] = i;

    return {
      seed: seed, maxLai: maxLai, clump: clump, leaves: n,
      sun: { theta: (28 + 18 * rng()) * DEG, phi: 2 * PI * rng() },
      verts: verts, rank: rank, base: base, cx: cx, cy: cy, ax: ax, ay: ay, semiW: semiW,
      order: order, _id: null
    };
  }

  /* scanline fill, even–odd, sampling at integer positions of the supersampled grid.
     vs holds the leaf outline already mapped onto that grid. */
  var _scratch = new Float64Array(64);
  var _vs = new Float64Array(NV * 2);
  function fillPoly(vs, buf, W2, value) {
    var minY = Infinity, maxY = -Infinity, i, j;
    for (i = 0; i < NV; i++) {
      var yy = vs[2 * i + 1];
      if (yy < minY) minY = yy;
      if (yy > maxY) maxY = yy;
    }
    var y0 = Math.max(0, Math.ceil(minY)), y1 = Math.min(W2 - 1, Math.ceil(maxY) - 1);
    for (var y = y0; y <= y1; y++) {
      var nx = 0;
      for (i = 0, j = NV - 1; i < NV; j = i++) {
        var ay = vs[2 * j + 1], by = vs[2 * i + 1];
        if ((ay <= y && by > y) || (by <= y && ay > y)) {
          _scratch[nx++] = vs[2 * j] + (y - ay) * (vs[2 * i] - vs[2 * j]) / (by - ay);
        }
      }
      for (var a = 1; a < nx; a++) {                    // tiny insertion sort
        var t = _scratch[a], b = a - 1;
        while (b >= 0 && _scratch[b] > t) { _scratch[b + 1] = _scratch[b]; b--; }
        _scratch[b + 1] = t;
      }
      var row = y * W2;
      for (var s = 0; s + 1 < nx; s += 2) {
        var xs = Math.max(0, Math.ceil(_scratch[s])), xe = Math.min(W2 - 1, Math.ceil(_scratch[s + 1]) - 1);
        for (var x = xs; x <= xe; x++) buf[row + x] = value;
      }
    }
  }

  /* Draw the scene at leaf-area Λ = lai (≤ maxLai) as an RGBA fisheye "photograph",
     size × size pixels. The lens circle gets radius size/2 − 2 — the radius the
     pipeline auto-detects — and black corners, like a real frame. */
  function render(scene, lai, size) {
    size = size || 640;
    var W2 = size * SS;
    var xc = size / 2, yc = size / 2, rc = size / 2 - 2, kpx = rc / (PI / 2);
    var frac = Math.min(1, Math.max(0, lai / scene.maxLai));
    if (!scene._id || scene._id.length !== W2 * W2) scene._id = new Int32Array(W2 * W2);
    var idb = scene._id;
    idb.fill(0);

    var order = scene.order, rank = scene.rank, verts = scene.verts;
    var base = scene.base, ax = scene.ax, ay = scene.ay;
    var nLeaf = scene.leaves;
    var cx = new Float32Array(nLeaf), cy = new Float32Array(nLeaf), semiW = new Float32Array(nLeaf);
    for (var oi = 0; oi < order.length; oi++) {
      var L = order[oi];
      if (rank[L] >= frac) continue;
      var off = L * NV * 2;
      for (var q = 0; q < NV; q++) {
        _vs[2 * q]     = (xc + verts[off + 2 * q] * rc + 0.5) * SS - 0.5;
        _vs[2 * q + 1] = (yc + verts[off + 2 * q + 1] * rc + 0.5) * SS - 0.5;
      }
      cx[L] = (xc + scene.cx[L] * rc + 0.5) * SS - 0.5;
      cy[L] = (yc + scene.cy[L] * rc + 0.5) * SS - 0.5;
      semiW[L] = scene.semiW[L] * rc * SS;
      fillPoly(_vs, idb, W2, L + 1);
    }

    var out = new Uint8ClampedArray(size * size * 4);
    var outer = rc + 1.5, outer2 = outer * outer;
    var sTh = scene.sun.theta, sPh = scene.sun.phi;
    var sinS = Math.sin(sTh), cosS = Math.cos(sTh);
    var seed = scene.seed | 0, inv = 1 / (SS * SS);

    for (var py = 0; py < size; py++) {
      for (var px = 0; px < size; px++) {
        var o4 = (py * size + px) * 4;
        var dx = px - xc, dy = py - yc, r2 = dx * dx + dy * dy;
        if (r2 > outer2) { out[o4 + 3] = 255; continue; }    // black corners, as in a real fisheye frame

        var th = Math.sqrt(r2) / kpx, phi = Math.atan2(dx, dy);
        var sinT = Math.sin(th), cosT = Math.cos(th);
        var tt = th / (PI / 2); tt = tt * Math.sqrt(tt);
        var cg = cosT * cosS + sinT * sinS * Math.cos(phi - sPh);
        var gam = Math.acos(cg > 1 ? 1 : cg < -1 ? -1 : cg);
        var glow = Math.exp(-(gam / 0.3) * (gam / 0.3)) + (gam < 0.05 ? 1 : 0);
        var skyR = Math.min(255, 126 + 72 * tt + 96 * glow);
        var skyG = Math.min(255, 182 + 40 * tt + 72 * glow);
        var skyB = Math.min(255, 240 + 6 * tt + 16 * glow);

        var aR = 0, aG = 0, aB = 0;
        for (var sy = 0; sy < SS; sy++) {
          for (var sx = 0; sx < SS; sx++) {
            var cs = px * SS + sx, rs = py * SS + sy;
            var id = idb[rs * W2 + cs];
            if (id === 0) { aR += skyR; aG += skyG; aB += skyB; continue; }
            var Lf = id - 1;
            var ddx = cs - cx[Lf], ddy = rs - cy[Lf];
            var across = (ddx * -ay[Lf] + ddy * ax[Lf]) / semiW[Lf];
            var shade = 0.86 + 0.22 * (0.5 + 0.5 * (across > 1 ? 1 : across < -1 ? -1 : across));
            if (across < 0.09 && across > -0.09) shade *= 1.2;          // pale midrib
            aR += base[Lf * 3] * shade + 26 * glow;                      // backlit leaves warm up …
            aG += base[Lf * 3 + 1] * shade + 22 * glow;
            aB += base[Lf * 3 + 2] * shade;                              // … but stay dark in blue
          }
        }
        var nz = (hash01(py * size + px, seed) - 0.5) * 6;
        out[o4]     = aR * inv + nz;
        out[o4 + 1] = aG * inv + nz;
        out[o4 + 2] = aB * inv + nz;
        out[o4 + 3] = 255;
      }
    }
    return {
      rgba: out, width: size, height: size,
      xc: xc, yc: yc, rc: rc,
      lai: lai, clump: scene.clump, G: G_SPHERICAL
    };
  }

  /* ═════════════════ 2. THE hemispheR-py PIPELINE ═════════════════ */

  /* hemispherR-py.py: _apply_gamma — note it divides by (max − min) without
     subtracting min first. Reproduced as-is so the two agree. */
  function applyGamma(arr, g) {
    if (g === 1) return arr;
    var n = arr.length, mn = Infinity, mx = -Infinity, i;
    for (i = 0; i < n; i++) { var v = arr[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx === mn) return arr;
    var span = mx - mn, out = new Float64Array(n);
    for (i = 0; i < n; i++) out[i] = span * Math.pow(arr[i] / span, g);
    return out;
  }

  /* import_fisheye: pick a channel, gamma-correct, scale to 0–255, mask the circle. */
  function importFisheye(rgba, w, h, o) {
    o = o || {};
    var channel = o.channel == null ? 3 : o.channel;
    var gamma = o.gamma == null ? 0.85 : o.gamma;
    if (!(gamma > 0)) throw new Error('gamma must be positive');
    var n = w * h, i, vals;

    function plane(c) { var p = new Float64Array(n); for (var k = 0, j = c; k < n; k++, j += 4) p[k] = rgba[j]; return p; }

    if (typeof channel === 'number') {
      if (channel < 1 || channel > 3) throw new Error('channel must be 1 (red), 2 (green) or 3 (blue)');
      vals = applyGamma(plane(channel - 1), gamma);
    } else {
      var R = applyGamma(plane(0), gamma), G = applyGamma(plane(1), gamma), B = applyGamma(plane(2), gamma);
      vals = new Float64Array(n);
      if (channel === 'Luma') for (i = 0; i < n; i++) vals[i] = 0.3 * R[i] + 0.59 * G[i] + 0.11 * B[i];
      else if (channel === 'RGB') for (i = 0; i < n; i++) vals[i] = (R[i] + G[i] + B[i]) / 3;
      else if (channel === 'first') vals = R;
      else vals = B;
    }

    var mn = Infinity, mx = -Infinity;
    for (i = 0; i < n; i++) { var v = vals[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    var scaled = new Float64Array(n);
    if (mx > mn) for (i = 0; i < n; i++) scaled[i] = roundHalfEven(((vals[i] - mn) / (mx - mn)) * 255.0);

    var xc, yc, rc;
    if (o.mask) { xc = o.mask.xc; yc = o.mask.yc; rc = o.mask.rc; }
    else { xc = w / 2; yc = h / 2; rc = Math.min(xc, yc) - 2; }

    var rr = rc * rc;
    for (var y = 0, k2 = 0; y < h; y++) {
      var dy = y - yc, dy2 = dy * dy;
      for (var x = 0; x < w; x++, k2++) {
        var dx = x - xc;
        if (dx * dx + dy2 > rr) scaled[k2] = NaN;
      }
    }
    return { v: scaled, w: w, h: h, xc: xc, yc: yc, rc: rc };
  }

  /* hemispherR-py.py: _otsu_threshold — first maximum wins, as in the original. */
  function otsu(hist, total) {
    if (total === 0) return 0;
    var sumTotal = 0, t;
    for (t = 0; t < 256; t++) sumTotal += t * hist[t];
    var sumBg = 0, wBg = 0, maxVar = 0, best = 0;
    for (t = 0; t < 256; t++) {
      wBg += hist[t];
      if (wBg === 0) continue;
      var wFg = total - wBg;
      if (wFg === 0) break;
      sumBg += t * hist[t];
      var mBg = sumBg / wBg, mFg = (sumTotal - sumBg) / wFg;
      var v = wBg * wFg * (mBg - mFg) * (mBg - mFg);
      if (v > maxVar) { maxVar = v; best = t; }
    }
    return best;
  }

  var RAD2DEG = 180 / PI;
  /* compass zone of a pixel: 0 = N, 1 = E, 2 = S, 3 = W  (angle from +y, clockwise toward +x) */
  function zoneOf(angle) {
    if (angle >= 315 || angle < 45) return 0;
    if (angle >= 45 && angle < 135) return 1;
    if (angle >= 135 && angle < 225) return 2;
    return 3;
  }
  var ZONE_ORDER = [0, 3, 2, 1];       // the original thresholds N, W, S, E in that order

  /* binarize_fisheye: sky (1) vs canopy (0); −1 outside the mask. */
  function binarize(img, o) {
    o = o || {};
    var zonal = o.zonal == null ? false : !!o.zonal;
    var manual = o.manual == null ? null : o.manual;
    if (zonal && manual !== null) throw new Error('zonal and manual thresholds cannot be combined');
    var w = img.w, h = img.h, v = img.v, n = w * h, xc = img.xc, yc = img.yc;
    var b = new Int8Array(n), thresholds = [], i, x, y;

    function histOf(zoneMask, zone) {
      var hist = new Float64Array(256), total = 0;
      for (y = 0, i = 0; y < h; y++) {
        var dy = y - yc;
        for (x = 0; x < w; x++, i++) {
          var val = v[i];
          if (val !== val) continue;
          if (zoneMask) {
            var ang = Math.atan2(x - xc, dy) * RAD2DEG;
            if (ang < 0) ang += 360;
            if (zoneOf(ang) !== zone) continue;
          }
          var q = Math.round(val); q = q < 0 ? 0 : q > 255 ? 255 : q;   // values are already whole numbers
          hist[q]++; total++;
        }
      }
      return { hist: hist, total: total };
    }

    if (manual !== null) {
      thresholds.push(+manual);
      for (i = 0; i < n; i++) b[i] = v[i] !== v[i] ? -1 : (v[i] > manual ? 1 : 0);
    } else if (zonal) {
      var th = [0, 0, 0, 0];
      for (var zi = 0; zi < 4; zi++) {
        var z = ZONE_ORDER[zi], hh = histOf(true, z);
        th[z] = hh.total > 0 ? otsu(hh.hist, hh.total) : 0;
        thresholds.push(th[z]);
      }
      for (y = 0, i = 0; y < h; y++) {
        var dy2 = y - yc;
        for (x = 0; x < w; x++, i++) {
          var val2 = v[i];
          if (val2 !== val2) { b[i] = -1; continue; }
          var a2 = Math.atan2(x - xc, dy2) * RAD2DEG;
          if (a2 < 0) a2 += 360;
          b[i] = val2 > th[zoneOf(a2)] ? 1 : 0;
        }
      }
    } else {
      var g = histOf(false), t0 = g.total > 0 ? otsu(g.hist, g.total) : 0;
      thresholds.push(t0);
      for (i = 0; i < n; i++) b[i] = v[i] !== v[i] ? -1 : (v[i] > t0 ? 1 : 0);
    }
    return { b: b, w: w, h: h, xc: xc, yc: yc, rc: img.rc, thresholds: thresholds, zonal: zonal };
  }

  /* gapfrac_fisheye: mean sky fraction in each (zenith ring × azimuth segment). */
  function gapFraction(bin, o) {
    o = o || {};
    var maxVZA = o.maxVZA == null ? 90 : +o.maxVZA;
    var lens = o.lens || 'equidistant';
    var startVZA = o.startVZA == null ? 0 : o.startVZA, endVZA = o.endVZA == null ? 70 : o.endVZA;
    var nr = o.nrings || 7, ns = o.nseg || 8;
    var w = bin.w, h = bin.h, b = bin.b, xc = bin.xc, yc = bin.yc, rc = bin.rc;

    var seenSky = false, seenCanopy = false;
    for (var q = 0; q < b.length; q++) { if (b[q] === 1) seenSky = true; else if (b[q] === 0) seenCanopy = true; if (seenSky && seenCanopy) break; }
    if (!seenSky || !seenCanopy) {
      throw new Error('The image is all sky or all canopy after thresholding — gap fraction is undefined. Check the mask and exposure.');
    }

    var step = (endVZA - startVZA) / nr;
    var vzaBins = arange(startVZA, endVZA + 0.001, step);
    var centres = [], i, j;
    for (i = 0; i < nr; i++) centres.push((vzaBins[i] + vzaBins[i + 1]) / 2);

    function vzaToRadius(vza) {
      var x = vza / maxVZA;
      if (lens === 'FC-E8') return rc * (1.06 * x + 0.00498 * x * x - 0.0639 * x * x * x);
      return rc * x;                                    // equidistant (also the fallback, as in the original)
    }
    var rb = vzaBins.map(function (v) { return roundHalfEven(vzaToRadius(v)); });
    var segStep = 360 / ns, segBins = arange(0, 360 + 0.001, segStep);

    var sum = new Float64Array(nr * ns), cnt = new Float64Array(nr * ns);
    var rMin = rb[0], rMax = rb[nr];
    for (var y = 0, k = 0; y < h; y++) {
      var dy = y - yc;
      for (var x = 0; x < w; x++, k++) {
        var bv = b[k];
        if (bv < 0) continue;
        var dx = x - xc, rpx = Math.sqrt(dx * dx + dy * dy);
        if (rpx < rMin || rpx >= rMax) continue;
        var ri = -1;
        for (i = 0; i < nr; i++) if (rpx >= rb[i] && rpx < rb[i + 1]) { ri = i; break; }
        if (ri < 0) continue;
        var ang = Math.atan2(dx, dy) * RAD2DEG;
        if (ang < 0) ang += 360;
        var si = -1;
        for (j = 0; j < ns; j++) if (ang >= segBins[j] && ang < segBins[j + 1]) { si = j; break; }
        if (si < 0) continue;
        sum[ri * ns + si] += bv; cnt[ri * ns + si]++;
      }
    }
    var gf = [];
    for (i = 0; i < nr; i++) {
      var row = [];
      for (j = 0; j < ns; j++) row.push(cnt[i * ns + j] > 0 ? sum[i * ns + j] / cnt[i * ns + j] : NaN);
      gf.push(row);
    }
    return { rings: centres, gf: gf, nrings: nr, nseg: ns, rBounds: rb, vzaBins: vzaBins, lens: lens };
  }

  /* _calculate_canopy_metrics: effective LAI (Le), corrected LAI (L), clumping index
     (LX = Le / L) and diffuse non-interceptance (DIFN, % open sky). */
  function canopyMetrics(g) {
    var nr = g.nrings, ns = g.nseg, i, j;
    var cells = g.gf.map(function (row) {
      return row.map(function (v) { return v === 0 ? 0.00004530 : v; });   // the original's floor for empty gaps
    });
    var gapFr = cells.map(function (row) {                                  // pandas mean(axis=1): skips NaN
      var s = 0, c = 0;
      for (var q = 0; q < row.length; q++) if (row[q] === row[q]) { s += row[q]; c++; }
      return c ? s / c : NaN;
    });
    var sinth = [], costh = [], sumSin = 0, sumSC = 0;
    for (i = 0; i < nr; i++) {
      var rad = g.rings[i] * PI / 180;
      sinth.push(Math.sin(rad)); costh.push(Math.cos(rad));
      sumSin += sinth[i]; sumSC += sinth[i] * costh[i];
    }
    var Le = 0, L = 0, DIFN = 0;
    for (i = 0; i < nr; i++) {
      var w = sinth[i] / sumSin, W = (sinth[i] * costh[i]) / (2 * sumSC);
      Le += -Math.log(gapFr[i]) * w * costh[i];
      var ls = 0;
      for (j = 0; j < ns; j++) ls += -Math.log(cells[i][j]);                 // numpy mean: NaN propagates
      L += (ls / ns) * w * costh[i];
      DIFN += gapFr[i] * 2 * W;
    }
    Le *= 2; L *= 2; DIFN *= 100;
    var LX = L !== 0 ? Le / L : 0;
    return {
      Le: roundTo(Le, 2), L: roundTo(L, 2), LX: roundTo(LX, 2), DIFN: roundTo(DIFN, 1),
      raw: { Le: Le, L: L, LX: LX, DIFN: DIFN },
      gapFr: gapFr
    };
  }

  /* the whole thing: RGBA pixels in, canopy attributes out */
  function analyze(rgba, w, h, o) {
    o = o || {};
    var opt = {
      channel: o.channel == null ? 3 : o.channel,
      gamma: o.gamma == null ? 0.85 : o.gamma,
      mask: o.mask || null,
      zonal: o.zonal == null ? true : o.zonal,
      manual: o.manual == null ? null : o.manual,
      maxVZA: o.maxVZA == null ? 90 : o.maxVZA,
      lens: o.lens || 'equidistant',
      startVZA: o.startVZA == null ? 0 : o.startVZA,
      endVZA: o.endVZA == null ? 70 : o.endVZA,
      nrings: o.nrings || 7,
      nseg: o.nseg || 8
    };
    var img = importFisheye(rgba, w, h, opt);
    var bin = binarize(img, opt);
    var gf = gapFraction(bin, opt);
    var m = canopyMetrics(gf);
    return {
      Le: m.Le, L: m.L, LX: m.LX, DIFN: m.DIFN, raw: m.raw, gapFr: m.gapFr,
      rings: gf.rings, gf: gf.gf, rBounds: gf.rBounds,
      thresholds: bin.thresholds, thd: bin.thresholds.map(function (t) { return String(Math.trunc(t)); }).join('_'),
      mask: { xc: img.xc, yc: img.yc, rc: img.rc },
      bin: bin, options: opt
    };
  }

  /* One reference scene (assets/js/reference.js): re-render it, re-measure it, and
     compare with what the real hemispheR-py printed for the same pixels. The page
     and its worker use this; tools/verify.mjs applies stricter tolerances. */
  function checkScene(s, tol) {
    tol = tol || { cell: 5e-3, metric: 0.0101, difn: 0.101 };   // loose enough for cross-engine libm noise
    var scene = makeScene({ seed: s.seed, maxLai: s.lai, clump: s.clump });
    var img = render(scene, s.lai, s.size);
    var r = analyze(img.rgba, img.width, img.height,
      { channel: s.channel, gamma: s.gamma, zonal: s.zonal, lens: s.lens, nrings: s.nrings, nseg: s.nseg });
    var cell = 0, i, j;
    for (i = 0; i < r.gf.length; i++) for (j = 0; j < r.gf[i].length; j++) cell = Math.max(cell, Math.abs(r.gf[i][j] - s.py.cells[i][j]));
    var d = {
      thd: r.thd === s.py.thd, cell: cell,
      Le: Math.abs(r.Le - s.py.Le), L: Math.abs(r.L - s.py.L), LX: Math.abs(r.LX - s.py.LX), DIFN: Math.abs(r.DIFN - s.py.DIFN)
    };
    d.ok = d.thd && cell <= tol.cell && d.Le <= tol.metric && d.L <= tol.metric && d.LX <= tol.metric && d.DIFN <= tol.difn;
    return d;
  }

  var api = {
    version: '1.0.0',
    G: G_SPHERICAL,
    makeScene: makeScene, render: render, theoryGap: theoryGap,
    importFisheye: importFisheye, binarize: binarize, gapFraction: gapFraction,
    canopyMetrics: canopyMetrics, analyze: analyze, otsu: otsu, checkScene: checkScene,
    roundHalfEven: roundHalfEven, roundTo: roundTo, mulberry32: mulberry32
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Canopy = api;
})(typeof window !== 'undefined' ? window : globalThis);
