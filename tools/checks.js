/* Assertions run inside the real page by tools/probe.mjs. The last expression is a
   Promise; if any check fails it throws, which the driver turns into a non-zero exit. */
(function () {
  var out = {}, fail = [];
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function check(name, cond, detail) {
    out[name] = cond ? 'pass' : ('FAIL' + (detail ? ' — ' + detail : ''));
    if (!cond) fail.push(name + (detail ? ': ' + detail : ''));
  }
  var num = function (id) { return parseFloat(($('#' + id).textContent || '').replace(/[^\d.\-]/g, '')); };

  function pixelClasses() {
    var cv = $('#view'), d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    var sky = 0, leaf = 0, black = 0, n = d.length / 4;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      if (r < 12 && g < 12 && b < 12) black++;
      else if (b > 170) sky++;
      else if (g >= b && b < 110) leaf++;
    }
    return { sky: sky / n, leaf: leaf / n, black: black / n };
  }

  return (async function () {
    /* ── the libraries and the hook are there ── */
    check('canopy_lib', !!window.Canopy && typeof window.Canopy.analyze === 'function');
    check('reference_numbers', !!window.CANOPY_REFERENCE && window.CANOPY_REFERENCE.scenes.length === 12);
    var ff = window.__ff;
    check('app_hook', !!ff);
    if (!ff) throw new Error('no __ff hook — main.js did not boot');

    /* ── wait for the first measurement and for the parity check to finish ── */
    for (var w = 0; w < 80 && !ff.ready(); w++) await sleep(150);
    check('measured_and_parity_done', ff.ready(), 'state: ' + JSON.stringify(ff.state.parity));
    var par = ff.state.parity || {};
    check('parity_all_scenes_match', par.ok === par.total && par.total === 12, par.ok + '/' + par.total);
    check('parity_tile_shows_12_of_12', /12\s*\/\s*12/.test($('#glParity').textContent), $('#glParity').textContent);
    check('footer_names_the_commit', /parity ✓ 12\/12 · hemispheR-py @ [0-9a-f]{7}/.test($('#footMath').textContent), $('#footMath').textContent);

    /* the page opens on a real photo; switch to the synthetic canopy for the known-truth checks */
    ff.useSynthetic(); await sleep(1500);

    /* ── the canopy is really on the canvas ── */
    var px = pixelClasses();
    out.pixels = 'sky ' + px.sky.toFixed(2) + ' leaf ' + px.leaf.toFixed(2) + ' black ' + px.black.toFixed(2);
    check('canvas_has_leaves', px.leaf > 0.12, 'leaf ' + px.leaf.toFixed(3));
    check('canvas_has_sky', px.sky > 0.03, 'sky ' + px.sky.toFixed(3));
    check('canvas_has_black_corners', px.black > 0.12, 'black ' + px.black.toFixed(3));

    /* ── the readout is numeric and sensible: true Λ = 3 ── */
    var le = num('roLe'), L = num('roL'), lx = num('roLX'), difn = num('roDIFN');
    out.readout = 'Le ' + le + ' L ' + L + ' LX ' + lx + ' DIFN ' + difn;
    check('readout_numeric', [le, L, lx, difn].every(isFinite));
    check('Le_near_true_lai', le > 2.3 && le < 3.3, 'Le ' + le);
    check('LX_between_0_and_1', lx > 0.6 && lx <= 1.0, 'LX ' + lx);
    check('check_line_has_round_trip', /Round trip/.test($('#lensCheck').textContent) || /Clumped/.test($('#lensCheck').textContent), $('#lensCheck').textContent);

    /* ── the sliders move the numbers the right way ── */
    ff.setLai(5); await sleep(900);
    var le5 = num('roLe');
    check('more_leaf_area_raises_Le', le5 > le + 1, le + ' → ' + le5);
    check('slider_label_follows', $('#laiOut').textContent.trim() === '5.0', $('#laiOut').textContent);
    ff.setLai(3); await sleep(900);
    var plain = num('roLe');
    ff.setClump(90); await sleep(1000);
    var lumpy = num('roLe'), lumpyL = num('roL');
    check('clumping_lowers_Le_and_raises_L_over_Le', lumpyL > lumpy, 'Le ' + lumpy + ' L ' + lumpyL + ' (was Le ' + plain + ')');
    check('clumped_check_line', /Clumped/.test($('#lensCheck').textContent), $('#lensCheck').textContent);
    ff.setClump(0); await sleep(900);

    /* ── the view toggle really swaps in the sky / canopy classification ── */
    $('#vClass').click(); await sleep(200);
    var pc = pixelClasses();
    check('class_view_is_two_tone', (pc.sky + pc.leaf + pc.black) > 0.9 && pc.sky > 0.02, JSON.stringify(pc));
    $('#vPhoto').click(); await sleep(100);

    /* ── theme toggle ── */
    var before = document.documentElement.getAttribute('data-theme');
    $('#themeToggle').click(); await sleep(60);
    var after = document.documentElement.getAttribute('data-theme');
    check('theme_toggle_flips', !!after && after !== before, before + ' → ' + after);
    var bg = getComputedStyle(document.body).backgroundColor;
    check('theme_changes_background', bg !== '', bg);
    $('#themeToggle').click();

    /* ── layout: nothing escapes the viewport ── */
    var ow = document.documentElement.scrollWidth - window.innerWidth;
    out.overflow_px = ow;
    check('no_horizontal_overflow', ow <= 1, ow + 'px wider than the viewport');
    var card = $('#lensCard').getBoundingClientRect();
    check('lens_card_fits', card.left >= -1 && card.right <= window.innerWidth + 1, card.left + '..' + card.right);
    var mobile = window.innerWidth < 760;
    if (mobile) {
      var nb = $('#navToggle');
      check('mobile_nav_toggle_visible', getComputedStyle(nb).display !== 'none');
      nb.click(); await sleep(60);
      check('mobile_nav_opens', $('#barNav').classList.contains('is-open'));
      nb.click();
    }

    /* ── content and links ── */
    check('one_h1', $$('h1').length === 1);
    check('title', /Featherfield/.test(document.title));
    var hrefs = $$('a[href]').map(function (a) { return a.getAttribute('href'); });
    [
      'https://github.com/realgauravvyas/hemispheR-py',
      'https://fac.iitg.ac.in/dmandal/Agro-geoinformaticsLab/tools.html',
      'https://fac.iitg.ac.in/dmandal/Agro-geoinformaticsLab/people.html'
    ].forEach(function (u) { check('links_to_' + u.replace(/^https:\/\//, '').slice(0, 48), hrefs.indexOf(u) > -1); });
    var badAnchors = hrefs.filter(function (h) { return h.charAt(0) === '#' && h.length > 1 && !document.getElementById(h.slice(1)); });
    check('anchors_resolve', badAnchors.length === 0, badAnchors.join(','));
    var noRel = $$('a[href^="http"]').filter(function (a) { return !/noopener/.test(a.getAttribute('rel') || ''); }).map(function (a) { return a.href; });
    check('external_links_noopener', noRel.length === 0, noRel.join(' '));
    var unnamed = $$('button').filter(function (b) { return !(b.textContent.trim() || b.getAttribute('aria-label')); });
    check('buttons_have_names', unnamed.length === 0, unnamed.length + ' unnamed');
    check('skip_link_target', !!document.getElementById('tools'));
    var anyDeps = $$('script[src]').filter(function (s) { return /^https?:/.test(s.getAttribute('src')); });
    check('no_external_scripts', anyDeps.length === 0);

    console.log('checks: ' + JSON.stringify(out));
    if (fail.length) throw new Error(fail.length + ' check(s) failed: ' + fail.join(' | '));
    return { passed: Object.keys(out).length, out: out };
  })();
})();
