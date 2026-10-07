# Featherfield

**Feather-light, open-source tools for the field** — lightweight alternatives to heavy field-measurement software, for farmers and ecologists.

**Live:** <https://realgauravvyas.github.io/featherfield/>

## The idea

The hero of the page is a canopy that actually computes. It is generated from a known leaf area Λ (a Poisson / Neyman–Scott leaf model on the sphere, so the true answer is known), rendered as a fisheye "photograph", and then measured in your browser by a step-for-step port of [hemispheR-py](https://github.com/realgauravvyas/hemispheR-py) — Featherfield's first tool.

## Nothing here is faked

`tools/verify.mjs` is the claim, enforced in CI (the deploy workflow will not publish if it fails):

1. **Analytic** — exact Beer–Lambert gap fractions return exactly the leaf area they were built from.
2. **Round trip** — rendered canopies of known leaf area are measured as photographs; random canopies read ≈ 6 % low (mixed pixels at leaf edges), and clumping lowers Le while the corrected L recovers most of it.
3. **Parity** — 12 canopies (other lenses, channels, global/zonal thresholds, ring counts) are run through the **real** hemispheR-py; thresholds, gap fractions and Le / L / LX / DIFN match. The reference numbers live in `assets/js/reference.js`; every visitor's browser repeats the comparison (in a Web Worker) and shows the result.
4. **Determinism** — a seed always paints the same pixels.

A synthetic canopy tests the arithmetic and the port, not your camera — see "What this does not prove" on the page.

## Run it

No build step, no dependencies.

```sh
start index.html                      # just open it

node tools/verify.mjs                 # maths + parity gate (Node 18+)
node tools/probe.mjs "file://$PWD/index.html" --w 1440 --h 900 --wait 6000 --eval tools/checks.js   # real-browser checks (Node 22+, Chrome)

# regenerate the Python reference numbers (needs numpy, pandas, Pillow)
node tools/make_reference.mjs path/to/hemispheR-py/core/hemispherR-py.py
```

## Layout

```
index.html              the page — all copy lives here
assets/css/style.css    one stylesheet (dark by default, light on request)
assets/js/canopy.js     the science: canopy generator + hemispheR-py port (also runs under Node)
assets/js/reference.js  numbers from the real Python tool (generated)
assets/js/main.js       canvas, controls, theme, photo upload
assets/js/parity.worker.js   re-runs the Python comparison off the main thread
tools/                  verify, probe, checks, reference generator, og.html
```

## Custom domain

Add a `CNAME` file containing the domain, point DNS at GitHub Pages, and update the `canonical` / `og:` URLs in `index.html`.

## Origin & credit

hemispheR-py began as a research project in the Agro-geoinformatics Lab, IIT Guwahati ([researcher page](https://fac.iitg.ac.in/dmandal/Agro-geoinformaticsLab/people.html), [tools page](https://fac.iitg.ac.in/dmandal/Agro-geoinformaticsLab/tools.html)) and builds on the R package [hemispheR](https://cran.r-project.org/package=hemispheR) by F. Chianucci & M. Macek. Featherfield is an independent venture, not an IIT Guwahati entity.

## Licence

Code MIT. Text and the description of the work are © Gaurav Vyas.
