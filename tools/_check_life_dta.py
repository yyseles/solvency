# -*- coding: utf-8 -*-
"""检查 life 0831 与已入库 adj_dta 符号 + 0828 文件内原始值"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from update_quarter import load_js, read_capital, rev_files, DATA, LIFE_CAP_JS

pL = rev_files("人身险实际资本", "0831")
recsL = read_capital(pL)
v, CAP, h = load_js(LIFE_CAP_JS)
print("== life adj_dta 符号对比（源 0831 vs 已入库）==")
n_neg_src = n_neg_cur = 0
diff = 0
for comp, src in recsL.items():
    cur = CAP["data"].get(comp, {}).get("2026Q2", {})
    sv, cv = src.get("adj_dta"), cur.get("adj_dta")
    if sv is not None and sv < 0: n_neg_src += 1
    if cv is not None and cv < 0: n_neg_cur += 1
    if sv != cv: diff += 1
print(f"源文件 adj_dta 为负的公司: {n_neg_src} / {len(recsL)}")
print(f"已入库 adj_dta 为负的公司: {n_neg_cur} / {len(recsL)}")
print(f"值不一致公司数: {diff}")
# 打印几家
shown = 0
for comp, src in recsL.items():
    cur = CAP["data"].get(comp, {}).get("2026Q2", {})
    if src.get("adj_dta") != cur.get("adj_dta") and shown < 5:
        print(f"  {comp}: 源={src.get('adj_dta')} 已入库={cur.get('adj_dta')}")
        shown += 1
