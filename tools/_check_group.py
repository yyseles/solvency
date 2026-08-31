# -*- coding: utf-8 -*-
"""临时检查：group 板块 26Q2 覆盖 + 产险实际资本 0828 vs 0831 对比"""
import sys, os, json, re, json5
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from update_quarter import load_js, read_capital, read_solvency, rev_files, DATA, DATA_JS, PROP_CAP_JS

var, D, header = load_js(DATA_JS)
g = D["segments"]["group"]
print("group periods keys:", [p["key"] for p in g["periods"]])
cnt = sum(1 for c in g["companies"] if g["data"].get(c, {}).get("2026Q2"))
print("group companies:", len(g["companies"]), "| 2026Q2 有值公司数:", cnt)

# 旧集团文件里有没有 26Q2
p_old = rev_files("集团偿付能力", "2026")
print("\n集团偿付能力 2026* 文件:", os.path.basename(p_old) if p_old else None)
if p_old:
    recs = read_solvency(p_old)
    print("旧集团文件公司数:", len(recs), "样例:", list(recs.items())[:2])

# 产险实际资本 0828
p0828 = rev_files("产险实际资本", "0828")
print("\n产险实际资本 0828 文件:", os.path.basename(p0828) if p0828 else None)
if p0828:
    recs0828 = read_capital(p0828)
    print("0828 公司数:", len(recs0828))
    # 对比 property_capital_detail.js 里 2026Q2 已有数据
    v2, CAP, h2 = load_js(PROP_CAP_JS)
    print("property capital periods:", CAP["periods"])
    print("property capital companies:", len(CAP["companies"]))
    exist = [c for c in CAP["companies"] if CAP["data"].get(c, {}).get("2026Q2")]
    print("已入库 2026Q2 公司数:", len(exist))
    new = [c for c in recs0828 if c not in exist]
    upd = [c for c in recs0828 if c in exist]
    print("0828 中新增公司:", len(new), new[:10])
    print("0828 中已有公司(将覆盖):", len(upd), upd[:10])
