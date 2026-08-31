# -*- coding: utf-8 -*-
"""对比 0828 产险实际资本源文件 vs 已入库 property_capital_detail.js 2026Q2 值是否一致"""
import sys, os, json5
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from update_quarter import load_js, read_capital, rev_files, DATA, PROP_CAP_JS

p0828 = rev_files("产险实际资本", "0828")
recs = read_capital(p0828)
v2, CAP, h2 = load_js(PROP_CAP_JS)

diff_comp = []
sample = []
for comp, src in recs.items():
    cur = CAP["data"].get(comp, {}).get("2026Q2", {})
    diffs = [f for f in src if src[f] is not None and cur.get(f) != src[f]]
    missing = [f for f in src if src[f] is not None and f not in cur]
    if diffs or missing:
        diff_comp.append((comp, diffs[:6], missing[:4]))

print("0828 公司数:", len(recs))
print("值不一致或字段缺失的公司数:", len(diff_comp))
for c, d, m in diff_comp[:10]:
    print(" ", c, "| 值不同:", d, "| 缺失:", m)
if not diff_comp:
    print("==> 0828 与已入库完全一致，产险实际资本 26Q2 无需再更新")
