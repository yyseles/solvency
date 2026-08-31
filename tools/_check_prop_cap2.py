# -*- coding: utf-8 -*-
"""看 0828 与已入库 adj_dta 差异细节（前6家）"""
import sys, os, json5
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from update_quarter import load_js, read_capital, rev_files, DATA, PROP_CAP_JS

p0828 = rev_files("产险实际资本", "0828")
recs = read_capital(p0828)
v2, CAP, h2 = load_js(PROP_CAP_JS)

shown = 0
for comp, src in recs.items():
    cur = CAP["data"].get(comp, {}).get("2026Q2", {})
    diffs = [f for f in src if src[f] is not None and cur.get(f) != src[f]]
    if diffs and shown < 6:
        for f in diffs[:5]:
            print(f"{comp}  {f}: 已入库={cur.get(f)}  0828={src[f]}")
        shown += 1
        print()
