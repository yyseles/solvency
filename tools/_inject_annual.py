# -*- coding: utf-8 -*-
"""把「中再集团本级」的**年度（审计后）**数据写入 data.js。

规则（用户指定）：年度数据取次年一季度报告的「上季度数/期初」列——
该列即上年四季度，且通常为年度审计后数（Q4 报告多为未审计数）。
    2022年度 <- 2023Q1 期初   2023年度 <- 2024Q1 期初
    2024年度 <- 2025Q1 期初   2025年度 <- 2026Q1 期初

为什么不走 xlsx 管道：最低资本 xlsx 的期次格是「YYYY第N季度」，
无法表达年度 key（2022/2023...），故直接写 data.js。

手动改 data.js 两个铁律：
  1) 必须保留首行注释 + `let` 前缀；
  2) 不要 `import update_quarter`（会静默卡死）。
"""
import json
import os
import re
import sys

import json5

HERE = os.path.dirname(os.path.abspath(__file__))
SOLV = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from _parse_zhongzai import parse_pdf  # noqa: E402

DATA_JS = os.path.join(SOLV, "data.js")
PDF_DIR = os.path.join(SOLV, "data", "_pdf_tmp")
SEG, COMPANY = "reins", "中再集团本级"
# 年度 <- 次年一季度报告期初
YEAR_SRC = {"2022": "2023Q1", "2023": "2024Q1", "2024": "2025Q1", "2025": "2026Q1"}


def load_js(path):
    txt = open(path, encoding="utf-8").read()
    m = re.search(r"(?:let|const)\s+(\w+)\s*=\s*(\{.*\})\s*;", txt, re.S)
    if not m:
        raise SystemExit("解析失败: " + path)
    header = txt.split("\n", 1)[0]
    return m.group(1), json5.loads(m.group(2)), header


def save_js(path, var, obj, header):
    js = header + "\nlet " + var + " = " + json.dumps(
        obj, ensure_ascii=False, separators=(",", ":")) + ";\n"
    tmp = path + ".tmp"
    open(tmp, "w", encoding="utf-8").write(js)
    os.replace(tmp, path)  # 原子写


def main():
    var, D, header = load_js(DATA_JS)
    seg = D["segments"][SEG]
    if COMPANY not in seg["companies"]:
        raise SystemExit("%s 不在 %s 公司列表" % (COMPANY, SEG))
    data = seg["data"].setdefault(COMPANY, {})
    mcd = seg.setdefault("mcDetail", {}).setdefault(COMPANY, {})

    for year in sorted(YEAR_SRC):
        src = YEAR_SRC[year]
        pdf = os.path.join(PDF_DIR, src + ".pdf")
        if not os.path.exists(pdf):
            print("  [SKIP] 缺 PDF: %s" % pdf)
            continue
        rec, mc = parse_pdf(pdf, prior=True)
        # 附加资本：中再本级报表中恒为 '-'（即 0），与季度口径一致补 0
        if mc.get("mcAdd") is None:
            mc["mcAdd"] = 0.0
        rec = {k: v for k, v in rec.items() if v is not None}
        mc = {k: v for k, v in mc.items() if v is not None}
        data[year] = rec
        mcd[year] = mc
        print("  %s年度 <- %s期初: C=%s (%.2f%%)  I=%s  N=%s  | 主表%d字段 / mcDetail %d项"
              % (year, src, rec.get("C"), (rec.get("C") or 0) * 100,
                 rec.get("I"), rec.get("N"), len(rec), len(mc)))

    # 确保 periods 含年度期次
    appended = 0
    for year in YEAR_SRC:
        if not any(p.get("key") == year for p in seg["periods"]):
            seg["periods"].append({"key": year, "year": int(year), "q": 4,
                                   "kind": "year-end", "label": "%s年" % year,
                                   "source": "prelim"})
            appended += 1
            print("  periods 追加年度期次: %s" % year)
    if appended:
        seg["periods"].sort(key=lambda x: (x.get("year", 0), x.get("q", 0)))

    save_js(DATA_JS, var, D, header)
    print("已写出 data.js  (年度期次数=%d, mcDetail年度期次数=%d)"
          % (len([k for k in data if re.match(r"^\d{4}$", k)]),
             len([k for k in mcd if re.match(r"^\d{4}$", k)])))


if __name__ == "__main__":
    main()
