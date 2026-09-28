# -*- coding: utf-8 -*-
"""为 solvency 保险集团(group)板块注入数据：
1) segments.group.mcDetail   <- 集团偿付能力22-25.xlsx 的最低资本分解（13家 x 8期）
2) group_capital_detail.js   <- 集团实际资本22-25.xlsx 的实际资本明细（GROUP_CAP_DETAIL，9家 x 8期）

口径（用户定稿 2026-09-28）：
- 集团半年度：期次 = Q2 与「年度」，年度=源"第四季度"（2022 源另有"2022年度"，同值取年度优先）；
  实际资本文件期次无"年度"，第4季度充当年度。
- 最低资本分解：量化风险(O) = 母公司 + 保险类/银行类/证券类/信托类成员公司 + 集团特有风险 + 风险分散效应扣减；
  集团特有风险 = 风险传染 + 集中度；集中度 = 交易对手 + 行业 + 客户 + 集中度分散效应。
- 实际资本明细缺 4 家（国寿集团/大家保险集团/富德控股/中再集团），按用户确认"9家明细+4家留空"，GROUP_CAP_DETAIL 只含 9 家。
"""
import os, re
import openpyxl
import json5

HERE = os.path.dirname(os.path.abspath(__file__))
SOLV = os.path.dirname(HERE)
DATA_JS = os.path.join(SOLV, "data.js")
DATA_DIR = os.path.join(SOLV, "data")
SOLV_FILE = os.path.join(DATA_DIR, "集团偿付能力22-25.xlsx")
CAP_FILE = os.path.join(DATA_DIR, "集团实际资本22-25.xlsx")
CAP_JS = os.path.join(SOLV, "group_capital_detail.js")

CN_Q = {"一": "1", "二": "2", "三": "3", "四": "4"}


def norm_solv_period(s):
    """'2022第二季度'->2022Q2 ; '2022年度'->2022 ; '2022第四季度'->2022(Y 标记 Q4)"""
    s = str(s).strip()
    m = re.match(r"(\d{4})第?([一二三四1-4])季度", s)
    if m:
        return "%sQ%s" % (m.group(1), CN_Q.get(m.group(2), m.group(2)))
    m = re.match(r"(\d{4})", s)
    return m.group(1)


def norm_cap_period(s):
    """实际资本文件期次: '2022第2季度'/'2022第4季度' -> 2022Q2 / 2022Y4"""
    s = str(s).strip()
    m = re.match(r"(\d{4})第([1-4])季度", s)
    if m:
        return "%sQ%s" % (m.group(1), m.group(2))
    return s


# 集团最低资本分解：列标题 -> mc 字段
SOLV_MC_MAP = {
    "母公司最低资本": "mcParent",
    "保险类成员公司的最低资本": "mcIns",
    "银行类成员公司的最低资本": "mcBank",
    "证券类成员公司的最低资本": "mcSec",
    "信托类成员公司的最低资本": "mcTrust",
    "集团层面可量化的特有风险最低资本": "mcSpec",
    "风险传染最低资本": "mcContagion",
    "集中度风险最低资本": "mcConc",
    "交易对手集中度风险最低资本": "mcConcCc",
    "行业集中度风险最低资本": "mcConcInd",
    "客户集中度风险最低资本": "mcConcCust",
    "集中度风险分散效应": "mcConcDiv",
    "风险分散效应的资本要求减少": "mcDivReq",
}

# 集团实际资本明细：行标签 -> 字段
CAP_ROW_MAP = {
    "核心一级资本": "core1",
    "集团合并财务报表的净资产": "net",
    "保险类成员公司的调整项": "adj_ins",
    "各项非认可资产的账面价值": "adj_nonrec",
    "长期股权投资的认可价值与账面价值的差额": "adj_lti",
    "投资性房地产（包括保险公司以物权方式或通过子公司等方式持有的投资性房地产）的认可价值与账面价值的差额（扣除所得税影响）": "adj_invprop",
    "递延所得税资产（由经营性亏损引起的递延所得税资产除外）": "adj_dta",
    "对农业保险提取的大灾风险准备金": "adj_cat",
    "计入核心一级资本的保单未来盈余": "adj_fvs",
    "符合核心一级资本标准的负债类资本工具且按规定可计入核心一级资本的金额": "adj_liab",
    "银保监会规定的其他调整项目": "adj_other",
    "银行类成员公司的调整项": "adj_bank",
    "信托类成员公司的调整项": "adj_trust",
    "证券、期货类成员公司的调整项": "adj_sec",
    "商誉": "adj_gw",
    "银保监会规定的其他调整项目（集团合并层面）": "adj_grp",
    "核心二级资本": "core2",
    "保险类成员公司的核心二级资本": "c2_ins",
    "优先股": "c2_pref",
    "计入核心二级资本的保单未来盈余": "c2_fvm",
    "其他核心二级资本": "c2_oth",
    "减：超限额应扣除的部分": "c2_ded",
    "银行类成员公司的其他一级资本": "c2_bankat1",
    "银行类成员公司的二级资本工具": "c2_bankt2",
    "附属一级资本": "sub1",
    "次级定期债务": "s1_subdebt",
    "资本补充债券": "s1_cb",
    "可转换次级债": "s1_conv",
    "其他附属一级资本": "s1_oth",
    "附属二级资本": "sub2",
    "应急资本等其他附属二级资本": "s2_oth",
    "计入附属二级资本的保单未来盈余": "s2_fvm",
    "实际资本合计": "total",
}


def read_solvency_mc(path):
    """读偿付能力文件最低资本分解 -> {公司:{期次key:{mc字段}}}"""
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["风险数据"]
    col_idx = {}
    for c in range(1, ws.max_column + 1):
        v = ws.cell(row=2, column=c).value
        if v and str(v).strip() in SOLV_MC_MAP:
            col_idx[SOLV_MC_MAP[str(v).strip()]] = c
    out = {}
    for r in range(3, ws.max_row + 1):
        comp = ws.cell(row=r, column=1).value
        per = ws.cell(row=r, column=2).value
        if not comp or not per:
            continue
        comp = str(comp).strip()
        pk0 = norm_solv_period(per)
        # 2022Q4 与 2022年度 同值，统一归入年度 key '2022'；其余 Q4 也充当年度
        main_key = pk0  # 如 2022Q2
        if re.match(r"^\d{4}Q4$", pk0):
            main_key = pk0[:4]  # Q4 -> 年度(2022)
        if pk0.endswith("Q3") or pk0.endswith("Q1"):
            continue  # 集团半年度无 Q1/Q3
        vals = {}
        for f, ci in col_idx.items():
            v = ws.cell(row=r, column=ci).value
            if v is not None:
                try:
                    vals[f] = float(v)
                except (TypeError, ValueError):
                    pass
        if vals:
            out.setdefault(comp, {})[main_key] = vals
    wb.close()
    return out


def read_cap_detail(path):
    """读实际资本文件 -> {公司:{期次key:{cap字段}}}，期次Q4充当年度"""
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["实际资本"]
    col_comp = {}
    cur = None
    for ci in range(ws.max_column):
        c = ws.cell(row=1, column=ci + 1).value
        if c and str(c).strip():
            cur = str(c).strip()
        col_comp[ci] = cur
    col_period = {}
    for ci in range(ws.max_column):
        p = ws.cell(row=2, column=ci + 1).value
        if p:
            pk = norm_cap_period(str(p).strip())
            main_key = pk[:4] if re.match(r"^\d{4}Q4$", pk) else pk  # Q4充当年度
            col_period[ci] = main_key
    row_key = {}
    for ri in range(3, ws.max_row + 1):
        lab = ws.cell(row=ri, column=1).value
        if lab and str(lab).strip() in CAP_ROW_MAP:
            row_key[ri] = CAP_ROW_MAP[str(lab).strip()]
    out = {}
    for ri, fld in row_key.items():
        for ci in range(1, ws.max_column):
            comp = col_comp.get(ci)
            pk = col_period.get(ci)
            if not comp or not pk:
                continue
            v = ws.cell(row=ri, column=ci + 1).value
            if v is None:
                continue
            try:
                val = float(v)
            except (TypeError, ValueError):
                continue
            out.setdefault(comp, {}).setdefault(pk, {})[fld] = val
    wb.close()
    return out


def main():
    solv_mc = read_solvency_mc(SOLV_FILE)
    cap = read_cap_detail(CAP_FILE)

    # ---- 1) 写 data.js 的 segments.group.mcDetail ----
    txt = open(DATA_JS, encoding="utf-8").read()
    m = re.search(r"(?:let|const)\s+(\w+)\s*=\s*(\{.*\})\s*;", txt, re.S)
    var, D, header = m.group(1), json5.loads(m.group(2)), txt.split("\n", 1)[0]

    seg = D["segments"]["group"]
    # 只保留存在于主表 data 的期次（避免引入 Q3/Q1 等主表没有的期次）
    new_mcd = {}
    for comp, per in solv_mc.items():
        dkeys = set(seg["data"].get(comp, {}).keys())
        kept = {k: v for k, v in per.items() if k in dkeys}
        if kept:
            new_mcd[comp] = kept
    seg["mcDetail"] = new_mcd
    print("=== data.js segments.group.mcDetail 注入 ===")
    print("公司数:", len(new_mcd), "/", len(seg["companies"]))
    miss = [c for c in seg["companies"] if c not in new_mcd]
    print("未注入mcDetail的公司:", miss if miss else "无")
    # 抽查中再集团 2025
    print("中再集团 mcDetail 2025:", new_mcd.get("中再集团", {}).get("2025"))

    js = header + "\nlet " + var + " = " + json5.dumps(
        D, ensure_ascii=False, separators=(",", ":")) + ";\n"
    tmp = DATA_JS + ".tmp"
    open(tmp, "w", encoding="utf-8").write(js)
    os.replace(tmp, DATA_JS)

    # （实际资本结构/核心资本构成+净资产占比 暂缓实现，用户确认"先做最低资本结构就行"，故不生成 group_capital_detail.js）


if __name__ == "__main__":
    main()
