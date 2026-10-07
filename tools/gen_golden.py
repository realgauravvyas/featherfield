"""Run the real hemispheR-py on a set of synthetic canopy photographs.

Called by tools/make_reference.mjs — you normally don't run this by hand.

    python tools/gen_golden.py <path/to/hemispherR-py.py> <dir with scenes.json + PNGs>

Prints one JSON document on stdout: for every scene, the numbers the Python
tool produces (thresholds, the full ring x segment gap-fraction matrix, and the
canopy attributes). The JavaScript port in assets/js/canopy.js is held to these.
"""
import importlib.util
import json
import os
import sys

import numpy as np
import pandas as pd
import PIL


def load_core(path):
    spec = importlib.util.spec_from_file_location("hemispherR_py", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main(core_path, scene_dir):
    core = load_core(core_path)
    with open(os.path.join(scene_dir, "scenes.json"), encoding="utf-8") as fh:
        scenes = json.load(fh)

    out = []
    for i, sc in enumerate(scenes):
        png = os.path.join(scene_dir, f"scene_{i:02d}.png")
        img = core.import_fisheye(
            filename=png, channel=sc["channel"], circ_mask=None, circular=True,
            gamma=sc["gamma"], stretch=False, display=False, message=False,
        )
        binary = core.binarize_fisheye(
            img, method="Otsu", zonal=sc["zonal"], manual=None, display=False, export=False,
        )
        gap = core.gapfrac_fisheye(
            binary, maxVZA=90, lens=sc["lens"], startVZA=0, endVZA=70,
            nrings=sc["nrings"], nseg=sc["nseg"], display=False, message=False,
        )
        res = core.canopy_fisheye(gap).iloc[0]

        gf_cols = [c for c in gap.columns if c.startswith("GF")]
        cells = [[round(float(v), 6) for v in row] for row in gap[gf_cols].values]
        out.append({
            **sc,
            "py": {
                "thd": str(res["thd"]),
                "Le": float(res["Le"]), "L": float(res["L"]),
                "LX": float(res["LX"]), "DIFN": float(res["DIFN"]),
                "cells": cells,
            },
        })

    json.dump({
        "python": sys.version.split()[0],
        "numpy": np.__version__, "pandas": pd.__version__, "pillow": PIL.__version__,
        "scenes": out,
    }, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
