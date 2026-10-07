/* ═══════════════════════════════════════════════════════════════
   main.js — the live canopy, and the rest of the page.
   No dependencies. Everything but the canopy works without JS.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var C = window.Canopy, REF = window.CANOPY_REFERENCE;
  var root = document.documentElement;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var $  = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var fmt = function (v, d) { return (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : '—'; };

  /* ═════════════════════ 1. CHROME: theme, nav, reveals ═════════════════════ */

  var themeBtn = $('#themeToggle');
  function isLight() {
    var t = root.getAttribute('data-theme');
    if (t) return t === 'light';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  }
  function syncThemeButton() {
    var light = isLight();
    themeBtn.setAttribute('aria-pressed', light ? 'true' : 'false');
    $('#themeIcon').textContent = light ? '☾' : '☀';
    $('#themeLabel').textContent = light ? 'Dark' : 'Light';
    var meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#f5f7f1' : '#070b09');
  }
  function setTheme(t) {
    root.setAttribute('data-theme', t);
    try { localStorage.setItem('ff-theme', t); } catch (e) { /* private mode */ }
    syncThemeButton();
  }
  themeBtn.addEventListener('click', function () { setTheme(isLight() ? 'dark' : 'light'); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 't' && e.key !== 'T') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
    setTheme(isLight() ? 'dark' : 'light');
  });
  syncThemeButton();

  var bar = $('#bar'), nav = $('#barNav'), navBtn = $('#navToggle');
  function onScroll() { bar.classList.toggle('is-stuck', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  navBtn.addEventListener('click', function () {
    var open = !nav.classList.contains('is-open');
    nav.classList.toggle('is-open', open);
    navBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $$('a', nav).forEach(function (a) {
    a.addEventListener('click', function () {
      nav.classList.remove('is-open'); navBtn.setAttribute('aria-expanded', 'false');
    });
  });

  if ('IntersectionObserver' in window) {
    var links = $$('a', nav), map = {};
    links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('is-current'); });
        var a = map[en.target.id]; if (a) a.classList.add('is-current');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(map).forEach(function (id) { var s = document.getElementById(id); if (s) spy.observe(s); });

    var rev = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-in'); rev.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    $$('.reveal').forEach(function (el) { rev.observe(el); });
  } else {
    $$('.reveal').forEach(function (el) { el.classList.add('is-in'); });
  }

  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      var done = function () { var old = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = old; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
      else {
        var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* nothing to do */ }
        document.body.removeChild(ta);
      }
    });
  });

  if (!C) return;                                     // canopy.js missing: the rest of the page still works

  /* ═════════════════════ 2. THE LIVE CANOPY ═════════════════════ */

  var FINAL = 560, PREVIEW = 300;

  var view = $('#view'), frame = $('#lensFrame');
  var vctx = view.getContext('2d');
  var photoCv = document.createElement('canvas'), clsCv = document.createElement('canvas');

  var S = {
    seed: 7, lai: 3, clump: 0,            // clump in percent
    view: 'photo', zonal: true, lens: 'equidistant',
    mode: 'synthetic',                    // 'synthetic' | 'photo'
    scene: null, img: null, res: null,
    side: FINAL,                          // side of the square currently on the canvas, in source pixels
    upload: null, preview: false,
    sweep: null, ringsOn: false, parity: null
  };
  var dirtyScene = true;

  /* ── pixels → canvases ── */

  function buildClass(b, w, h) {
    var out = new Uint8ClampedArray(w * h * 4);
    for (var i = 0, j = 0; i < b.length; i++, j += 4) {
      var v = b[i];
      out[j + 3] = 255;
      if (v < 0) continue;                                                  // outside the mask: black
      if (v === 1) { out[j] = 203; out[j + 1] = 232; out[j + 2] = 255; }     // sky
      else { out[j] = 14; out[j + 1] = 40; out[j + 2] = 26; }                // canopy
    }
    return new ImageData(out, w, h);
  }

  function setSquare(cv, size) { cv.width = size; cv.height = size; return cv.getContext('2d'); }

  function paintSynthetic(size) {
    if (dirtyScene) { S.scene = C.makeScene({ seed: S.seed, maxLai: 6, clump: S.clump / 100 }); dirtyScene = false; }
    S.img = C.render(S.scene, S.lai, size);
    S.res = null;
    try { S.res = C.analyze(S.img.rgba, size, size, { zonal: S.zonal, lens: 'equidistant' }); }
    catch (e) { say(String(e.message || e), true); }
    setSquare(photoCv, size).putImageData(new ImageData(S.img.rgba, size, size), 0, 0);
    if (S.res) setSquare(clsCv, size).putImageData(buildClass(S.res.bin.b, size, size), 0, 0);
    S.side = size;
  }

  /* ── drawing ── */

  function sizeView() {
    var r = frame.getBoundingClientRect();
    var dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    var px = Math.max(240, Math.round(r.width * dpr));
    if (view.width !== px) { view.width = px; view.height = px; }
  }

  function draw() {
    var W = view.width, ctx = vctx, dpr = W / Math.max(1, frame.getBoundingClientRect().width);
    ctx.clearRect(0, 0, W, W);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    var showClass = S.view === 'class' && S.res;
    ctx.drawImage(showClass ? clsCv : photoCv, 0, 0, W, W);

    if (S.sweep && S.res) {                                    // the intro: photo → sky/canopy, swept like a radar
      var p = S.sweep.p, a0 = -Math.PI / 2, a1 = a0 + p * 2 * Math.PI, c = W / 2;
      ctx.save(); ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, c, a0, a1); ctx.closePath(); ctx.clip();
      ctx.drawImage(clsCv, 0, 0, W, W); ctx.restore();
      ctx.save(); ctx.lineWidth = 2 * dpr; ctx.strokeStyle = 'rgba(255,210,122,.95)'; ctx.shadowColor = 'rgba(255,210,122,.8)'; ctx.shadowBlur = 12 * dpr;
      ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + c * Math.cos(a1), c + c * Math.sin(a1)); ctx.stroke(); ctx.restore();
    }

    if (S.res && S.ringsOn) drawRings(ctx, W, dpr);
  }

  function drawRings(ctx, W, dpr) {
    var res = S.res, k = W / S.side, c = W / 2, rb = res.rBounds, nseg = res.options.nseg;
    ctx.save();
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = 'rgba(255,210,122,.34)';
    for (var i = 1; i < rb.length; i++) {
      ctx.beginPath(); ctx.arc(c, c, rb[i] * k, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,210,122,.2)';
    for (var j = 0; j < nseg; j++) {
      var a = j * 2 * Math.PI / nseg;                                  // 0° points down, increasing toward +x — as in the pipeline
      ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.sin(a) * rb[rb.length - 1] * k, c + Math.cos(a) * rb[rb.length - 1] * k); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,210,122,.7)';
    ctx.beginPath(); ctx.arc(c, c, rb[rb.length - 1] * k, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillStyle = 'rgba(255,240,196,.9)'; ctx.font = '600 ' + Math.round(11 * dpr) + 'px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText('70°', c + rb[rb.length - 1] * k + 5 * dpr, c);
    ctx.restore();
  }

  /* ── readout ── */

  var ringEls = [];
  (function buildRings() {
    var host = $('#rings');
    for (var i = 0; i < 7; i++) {
      var rb = document.createElement('div'); rb.className = 'rb';
      rb.appendChild(document.createElement('i')); rb.appendChild(document.createElement('u'));
      host.appendChild(rb); ringEls.push(rb);
    }
  })();

  function ringTheory(lai, centres, half) {                    // ring-area-weighted mean of the Beer–Lambert gap fraction
    return centres.map(function (c) {
      var a = (c - half) * Math.PI / 180, b = (c + half) * Math.PI / 180, n = 24, num = 0, den = 0;
      for (var k = 0; k < n; k++) { var t = a + (k + 0.5) * (b - a) / n; num += C.theoryGap(t, lai) * t; den += t; }
      return num / den;
    });
  }

  function showReadout() {
    var r = S.res;
    $('#roLe').textContent = r ? fmt(r.Le, 2) : '—';
    $('#roL').textContent = r ? fmt(r.L, 2) : '—';
    $('#roLX').textContent = r ? fmt(r.LX, 2) : '—';
    $('#roDIFN').innerHTML = r ? fmt(r.DIFN, 1) + '<small>%</small>' : '—';
    $('#readout').style.opacity = S.preview ? '.55' : '1';

    /* the tick marks what a random canopy of this leaf area would let through, ring by ring;
       the axis is scaled to the data so the bars stay readable at any leaf area */
    var theory = (r && S.mode === 'synthetic') ? ringTheory(S.lai, r.rings, 5) : null;
    $('#lgTick').style.display = theory ? '' : 'none';
    var top = 0.02;
    if (r) r.gapFr.forEach(function (v) { if (isFinite(v) && v > top) top = v; });
    if (theory) theory.forEach(function (v) { if (v > top) top = v; });
    top = Math.min(1, top * 1.12);
    $('#ringsCap').textContent = 'gap fraction by zenith ring, 0° → 70° · axis 0–' + Math.round(top * 100) + '%';
    ringEls.forEach(function (el, i) {
      var v = r ? r.gapFr[i] : 0, bar = el.firstChild, tick = el.lastChild;
      bar.style.height = clamp((isFinite(v) ? v : 0) / top * 100, 0, 100) + '%';
      var th = theory ? theory[i] : null;
      tick.style.display = th == null ? 'none' : '';
      if (th != null) tick.style.bottom = clamp(th / top * 100, 0, 100) + '%';
      el.title = r ? (r.rings[i] + '° ring: gap fraction ' + fmt(v, 3) + (th != null ? ' (random-canopy expectation ' + fmt(th, 3) + ')' : '')) : '';
    });
  }

  var parityLine = '';
  function showCheck() {
    var el = $('#lensCheck'), r = S.res, line = '';
    if (!r) { el.innerHTML = '&nbsp;'; return; }
    if (S.mode === 'synthetic') {
      var err = (r.Le - S.lai) / S.lai * 100;
      if (S.clump === 0) {
        line = '<b>Round trip</b> true Λ ' + fmt(S.lai, 1) + ' → measured Le ' + fmt(r.Le, 2) +
          ' (<b>' + (err >= 0 ? '+' : '−') + fmt(Math.abs(err), 1) + '%</b>).';
      } else {
        line = '<b>Clumped</b> true Λ ' + fmt(S.lai, 1) + ': Le ' + fmt(r.Le, 2) + ' reads low by design; ' +
          'L ' + fmt(r.L, 2) + ' corrects it (LX ' + fmt(r.LX, 2) + ').';
      }
    } else {
      var u = S.upload;
      if (u.ref) {
        var same = S.zonal && r.thd === u.ref.thd && Math.abs(r.Le - u.ref.Le) < 0.011 && Math.abs(r.L - u.ref.L) < 0.011;
        line = '<b>Real photo</b> · measured here: Le ' + fmt(r.Le, 2) + ', L ' + fmt(r.L, 2) + ', DIFN ' + fmt(r.DIFN, 1) + '%<br>' +
          'hemispheR-py (Python) on the same pixels: Le ' + fmt(u.ref.Le, 2) + ', L ' + fmt(u.ref.L, 2) + ', DIFN ' + fmt(u.ref.DIFN, 1) + '% ' +
          (same ? '<span class="ok">✓ identical</span>' : '<span class="muted">(zonal settings differ)</span>');
        el.innerHTML = line; return;
      }
      line = '<b>Your photo</b> · ' + u.w + '×' + u.h + ' px · thresholds ' + r.thd.replace(/_/g, ' / ') + ' · measured in this tab, nothing uploaded.';
    }
    el.innerHTML = line + (parityLine ? '<br>' + parityLine : '');
  }

  function showTag() {
    var t = $('#lensTag');
    if (S.mode === 'synthetic') t.textContent = 'synthetic canopy · true leaf area ' + fmt(S.lai, 1) + ' · clumping ' + S.clump + '%';
    else t.textContent = S.upload.label || ('your photo · ' + S.upload.name + ' · centre crop, circle fills the short side');
  }

  function say(msg, bad) {
    var el = $('#lensCheck');
    el.innerHTML = '<span class="' + (bad ? 'bad' : 'ok') + '">' + msg + '</span>';
  }

  function refreshUI(final) {
    showReadout(); showCheck(); showTag();
    if (final && S.res) {
      var desc = S.mode === 'synthetic'
        ? 'Synthetic fisheye photograph of a tree canopy with true leaf area ' + fmt(S.lai, 1) + (S.clump ? ' and ' + S.clump + '% clumping' : '') + '.'
        : 'Your fisheye photograph.';
      var out = desc + ' Measured effective LAI ' + fmt(S.res.Le, 2) + ', corrected LAI ' + fmt(S.res.L, 2) +
        ', clumping index ' + fmt(S.res.LX, 2) + ', open sky ' + fmt(S.res.DIFN, 1) + ' percent.';
      view.setAttribute('aria-label', out);
      $('#srStatus').textContent = out;
    }
  }

  /* ── update paths ── */

  var raf = 0, finalTimer = 0;
  function cancelSweep() { S.sweep = null; S.ringsOn = true; }

  function updateSynthetic(size, final) {
    if (S.mode !== 'synthetic') return;
    S.preview = !final;
    paintSynthetic(size);
    refreshUI(final);
    draw();
  }
  function requestPreview() {
    cancelSweep();
    if (!raf) raf = requestAnimationFrame(function () { raf = 0; updateSynthetic(PREVIEW, false); });
    clearTimeout(finalTimer);
    finalTimer = setTimeout(function () { updateSynthetic(FINAL, true); }, 170);
  }

  var laiIn = $('#lai'), clumpIn = $('#clump');
  laiIn.addEventListener('input', function () {
    S.lai = parseFloat(laiIn.value); $('#laiOut').textContent = fmt(S.lai, 1); requestPreview();
  });
  clumpIn.addEventListener('input', function () {
    S.clump = parseInt(clumpIn.value, 10); $('#clumpOut').textContent = S.clump + '%'; dirtyScene = true; requestPreview();
  });

  function setView(v) {
    S.view = v; cancelSweep();
    $('#vPhoto').setAttribute('aria-pressed', v === 'photo' ? 'true' : 'false');
    $('#vClass').setAttribute('aria-pressed', v === 'class' ? 'true' : 'false');
    draw();
  }
  $('#vPhoto').addEventListener('click', function () { setView('photo'); });
  $('#vClass').addEventListener('click', function () { setView('class'); });

  function enableSliders(on) {
    laiIn.disabled = !on; clumpIn.disabled = !on;
    $('#lens').disabled = on;                                  // lens model only matters for real photos
  }

  $('#btnNew').addEventListener('click', function () {
    S.seed = (Math.random() * 1e6) | 0; dirtyScene = true; S.mode = 'synthetic'; S.upload = null;
    enableSliders(true); cancelSweep(); updateSynthetic(FINAL, true);
  });

  $('#zonal').addEventListener('change', function (e) {
    S.zonal = e.target.checked; cancelSweep();
    if (S.mode === 'synthetic') updateSynthetic(FINAL, true); else analyseUpload();
  });
  $('#lens').addEventListener('change', function (e) { S.lens = e.target.value; if (S.mode === 'photo') analyseUpload(); });

  /* ── measuring your own photo ── */

  function analyseUpload(precomputed) {
    var u = S.upload; if (!u) return;
    try {
      S.res = precomputed || C.analyze(u.data.data, u.w, u.h, { zonal: S.zonal, lens: u.lens || S.lens, mask: u.mask || null });
    } catch (e) { say(String(e.message || e), true); return; }
    var side = Math.min(u.w, u.h), sx = Math.floor((u.w - side) / 2), sy = Math.floor((u.h - side) / 2);
    var pc = setSquare(photoCv, side); pc.drawImage(u.cv, sx, sy, side, side, 0, 0, side, side);
    var tmp = document.createElement('canvas'); tmp.width = u.w; tmp.height = u.h;
    tmp.getContext('2d').putImageData(buildClass(S.res.bin.b, u.w, u.h), 0, 0);
    setSquare(clsCv, side).drawImage(tmp, sx, sy, side, side, 0, 0, side, side);
    S.side = side; S.preview = false;
    refreshUI(true); draw();
  }

  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { say('That does not look like an image file.', true); return; }
    if (file.size > 40 * 1024 * 1024) { say('That file is over 40 MB — please export a smaller JPG.', true); return; }
    var url = URL.createObjectURL(file), im = new Image();
    im.onload = function () {
      URL.revokeObjectURL(url);
      var k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
      var w = Math.max(32, Math.round(im.naturalWidth * k)), h = Math.max(32, Math.round(im.naturalHeight * k));
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(im, 0, 0, w, h);
      var cand = { cv: cv, data: cx.getImageData(0, 0, w, h), w: w, h: h, name: (file.name || 'photo').slice(0, 28) };
      var res;
      try { res = C.analyze(cand.data.data, w, h, { zonal: S.zonal, lens: S.lens }); }
      catch (e) { say(String(e.message || e), true); return; }   // e.g. all sky — leave the current view untouched
      S.upload = cand; S.mode = 'photo'; enableSliders(false); cancelSweep(); $('#adv').open = true;
      analyseUpload(res);
    };
    im.onerror = function () { URL.revokeObjectURL(url); say('This browser can’t read that image format — try a JPG or PNG.', true); };
    im.src = url;
  }
  $('#file').addEventListener('change', function (e) { loadFile(e.target.files && e.target.files[0]); e.target.value = ''; });

  ['dragenter', 'dragover'].forEach(function (ev) {
    frame.addEventListener(ev, function (e) { e.preventDefault(); $('#lensDrop').hidden = false; });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    frame.addEventListener(ev, function (e) { e.preventDefault(); $('#lensDrop').hidden = true; });
  });
  frame.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; loadFile(f); });

  /* ── real photographs from hemispheR-py's sample set ── */

  function loadSample(key, done) {
    var meta = window.FF_SAMPLES && window.FF_SAMPLES[key];
    if (!meta) { if (done) done(false); return; }
    var im = new Image();
    im.onload = function () {
      try {
        var cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
        var cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(im, 0, 0);
        var data = cx.getImageData(0, 0, cv.width, cv.height);          // throws on file:// (tainted canvas)
        S.zonal = true; $('#zonal').checked = true;
        S.upload = { cv: cv, data: data, w: cv.width, h: cv.height, name: key, mask: meta.mask, lens: meta.lens, ref: meta.py,
                     label: 'real photo · hemispheR-py sample ' + key + ' · FC-E8 lens' };
        S.mode = 'photo'; enableSliders(false); cancelSweep();
        analyseUpload();
        if (done) done(true);
      } catch (e) { if (done) done(false); }
    };
    im.onerror = function () { if (done) done(false); };
    im.src = 'assets/img/' + meta.file;
  }
  $('#sampleA').addEventListener('click', function () { loadSample('P072'); });
  $('#sampleB').addEventListener('click', function () { loadSample('P042b'); });

  /* ── the intro: sweep the photo into sky vs canopy ── */

  function runIntro() {
    if (reduceMotion || !S.res) { S.ringsOn = true; draw(); return; }
    var t0 = null, dur = 1700;
    S.ringsOn = false; S.sweep = { p: 0 };
    function frameFn(ts) {
      if (!S.sweep) return;                                    // interrupted by the user
      if (t0 === null) t0 = ts;
      var p = clamp((ts - t0) / dur, 0, 1);
      S.sweep.p = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      draw();
      if (p < 1) requestAnimationFrame(frameFn);
      else setTimeout(function () { if (S.sweep) { S.sweep = null; S.ringsOn = true; draw(); } }, 650);
    }
    setTimeout(function () { if (S.sweep) requestAnimationFrame(frameFn); }, 500);
  }

  /* ═════════════════════ 3. THE PAGE CHECKS ITSELF ═════════════════════ */

  function showParity(done, total, ok, worst, finished) {
    var tile = $('#glParity'), foot = $('#footMath');
    tile.textContent = done + ' / ' + total;
    if (!finished) {
      parityLine = 'Python parity: checking ' + done + '/' + total + '…';
      showCheck(); return;
    }
    var good = ok === total;
    tile.classList.toggle('is-live', good);
    parityLine = 'hemispheR-py parity: <span class="' + (good ? 'ok' : 'bad') + '">' + (good ? '✓' : '✗') + ' ' + ok + '/' + total + '</span> reference canopies identical.';
    if (!good) $('#glParityK').textContent = 'reference canopies match — some differ on this browser; please open an issue.';
    foot.textContent = 'Python parity ' + (good ? '✓' : '✗') + ' ' + ok + '/' + total + ' · hemispheR-py @ ' + String(REF.commit).slice(0, 7);
    S.parity = { ok: ok, total: total, finished: true };
    showCheck();
  }

  function startParity() {
    if (!REF || !REF.scenes || !REF.scenes.length) { return; }
    var total = REF.scenes.length, done = 0, ok = 0, worst = 0, settled = false;
    function tally(r) { done++; if (r && r.ok) ok++; if (r && isFinite(r.cell)) worst = Math.max(worst, r.cell); }

    function mainThread() {
      if (settled) return; settled = true;
      var i = 0;
      (function step() {
        if (i >= total) { showParity(done, total, ok, worst, true); return; }
        var r; try { r = C.checkScene(REF.scenes[i++]); } catch (e) { r = { ok: false }; }
        tally(r); showParity(done, total, ok, worst, false);
        setTimeout(step, 20);
      })();
    }

    var w = null;
    try { w = new Worker('assets/js/parity.worker.js'); } catch (e) { w = null; }
    if (!w) { mainThread(); return; }
    var bail = setTimeout(function () { try { w.terminate(); } catch (e) { /* gone */ } mainThread(); }, 9000);
    w.onmessage = function (m) {
      var d = m.data;
      if (d.type === 'scene') { if (settled) return; tally(d.res); showParity(done, total, ok, worst, false); }
      else if (d.type === 'done') { clearTimeout(bail); if (settled) return; settled = true; w.terminate(); showParity(done, total, ok, worst, true); }
      else if (d.type === 'error') { clearTimeout(bail); try { w.terminate(); } catch (e) { /* gone */ } done = 0; ok = 0; mainThread(); }
    };
    w.onerror = function () { clearTimeout(bail); try { w.terminate(); } catch (e) { /* gone */ } if (!settled) { done = 0; ok = 0; worst = 0; mainThread(); } };
    w.postMessage('go');
  }

  /* ═════════════════════ boot ═════════════════════ */

  if ('ResizeObserver' in window) new ResizeObserver(function () { sizeView(); draw(); }).observe(frame);
  window.addEventListener('resize', function () { sizeView(); draw(); });

  sizeView();
  enableSliders(true);
  S.ringsOn = true;
  updateSynthetic(FINAL, true);
  setTimeout(startParity, 250);
  /* open on a real photograph; the synthetic canopy (known truth) is one click away */
  loadSample('P072', function (ok) { if (ok) runIntro(); });
  if (!window.FF_SAMPLES) runIntro();

  /* test hooks: the check suite asserts against the live state instead of re-deriving it */
  window.__ff = {
    state: S,
    ready: function () { return !!(S.res && S.parity && S.parity.finished); },
    useSynthetic: function () { $('#btnNew').click(); },
    setLai: function (v) { laiIn.value = v; laiIn.dispatchEvent(new Event('input')); },
    setClump: function (v) { clumpIn.value = v; clumpIn.dispatchEvent(new Event('input')); }
  };
})();
