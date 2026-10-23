#!/usr/bin/env python3
"""imgdiff.py a b [c d ...] -> percentage of pixels that differ, per pair."""
import sys
from PIL import Image

def diff(p, q):
    a = Image.open(p).convert("RGB")
    b = Image.open(q).convert("RGB")
    if a.size != b.size:
        b = b.resize(a.size)
    pa, pb = a.load(), b.load()
    w, h = a.size
    n = 0
    for y in range(h):
        for x in range(w):
            i, j = pa[x, y], pb[x, y]
            if abs(i[0] - j[0]) + abs(i[1] - j[1]) + abs(i[2] - j[2]) > 24:
                n += 1
    return 100.0 * n / (w * h)

args = sys.argv[1:]
for i in range(0, len(args), 2):
    print("%s vs %s: %.1f%%" % (args[i], args[i + 1], diff(args[i], args[i + 1])))
