# -*- coding: utf-8 -*-
"""
单季度数据更新一键脚本（覆盖全数据产物，替代手工逐项编辑）。

设计要点：
  * 按“修订号”(--rev，默认 0831)在地端 data/ 下定位源文件：只处理文件名含 rev 的文件，
    从而精确对应本次提供的若干张表（没有给新文件的板块自动跳过，不会误用旧 .xlsx）。
  * 默认 --overwrite：用源文件里该季度的值【覆盖】目标公司在 data 中的对应期次记录
    （仅覆盖该季度、仅覆盖源文件中出现的公司，绝不触碰其它期次/其它公司）。
  * 加法安全：即便带 --overwrite，也不会删除任何历史期次或无关公司。
  * 最低资本明细(MC)：从“人身险/产险/再保 最低资本{rev}.xlsx”抽取 P~V+N 合并进 data.js
    （仅覆盖这几个字段，其余 C..V 不动；寿险 MC 在偿付能力主表之后写入，作为权威来源）。

覆盖产物：data.js / reg_industry.js / life_capital_detail.js / property_capital_detail.js

用法：
  python tools/update_quarter.py                       # 仅更新数据（默认 rev=0831, overwrite）
  python tools/update_quarter.py --rev 0831 --dry     # 不写文件，打印将更新条数
  python tools/update_quarter.py --deploy             # 数据更新 + 同步 dist + 构建单文件 + git 推送 + curl 校验
  python tools/update_quarter.py --no-overwrite       # 仅填补缺失（已有则跳过），不覆盖
"""
import argparse, json, os, re, shutil, subprocess, sys, glob
import json5
from openpyxl import load_workbook

HERE = os.path.dirname(os.path.abspath(__file__))
SOLV = os.path.dirname(HERE)
DATA = os.path.join(SOLV, "data")
DATA_JS = os.path.join(SOLV, "data.js")
REG_JS = os.path.join(SOLV, "reg_industry.js")
LIFE_CAP_JS = os.path.join(SOLV, "life_capital_detail.js")
PROP_CAP_JS = os.path.join(SOLV, "property_capital_detail.js")

SOLV_COL_MAP = {
    "综合偿付能力充足率": "C", "核心偿付能力充足率": "D",
    "综合偿付能力溢额": "E", "核心偿付能力溢额": "F",
    "认可资产": "G", "认可负债": "H", "实际资本": "I",
    "核心一级资本": "J", "核心二级资本": "K", "附属一级资本": "L", "附属二级资本": "M",
    "最低资本": "N", "量化风险最低资本": "O", "寿险风险最低资本": "P",
    "非寿险风险最低资本": "Q", "市场风险最低资本": "R", "信用风险最低资本": "S",
    "量化风险分散效应": "T", "特定类别保险合同损失吸收效应": "U", "控制风险最低资本": "V",
}
CAP_ROW_MAP = {
    "核心一级资本": "core1", "净资产": "net", "对净资产的调整额": "adj",
    "各项非认可资产的账面价值": "adj_nonrec",
    "长期股权投资的认可价值与账面价值的差额": "adj_lti",
    "投资性房地产（包括保险公司以物权方式或通过子公司等方式持有的投资性房地产）的公允价值增值（扣除减值、折旧及所得税影响）": "adj_invprop",
    "递延所得税资产（由经营性亏损引起的递延所得税资产除外）": "adj_dta",
    "对农业保险提取的大灾风险准备金": "adj_cat",
    "计入核心一级资本的保单未来盈余": "adj_fvs",
    "符合核心一级资本标准的负债类资本工具且按规定可计入核心一级资本的金额": "adj_liab",
    "银保监会规定的其他调整项目": "adj_other",
    "核心二级资本": "core2", "优先股": "c2_pref",
    "计入核心二级资本的保单未来盈余": "c2_fvm", "其他核心二级资本": "c2_oth",
    "减：超限额应扣除的部分": "c2_ded",
    "附属一级资本": "sub1", "附属二级资本": "sub2", "实际资本合计": "total",
}
REG_SEG_MAP = {"财产险公司": "property", "人身险公司": "life", "再保险公司": "reins"}
# 最低资本表：聚合项（与 data.js 主表 P~V+N 对应）按指标名匹配
MC_AGG_MAP = {
    "寿险业务保险风险最低资本合计": "P",
    "非寿险业务保险风险最低资本合计": "Q",
    "市场风险-最低资本合计": "R",
    "信用风险-最低资本合计": "S",
    "量化风险分散效应": "T",
    "特定类别保险合同损失吸收效应": "U",
    "控制风险最低资本": "V",
    "最低资本": "N",
}
# 最低资本表：下钻明细项（写入 segments.<seg>.mcDetail）按指标名匹配
MC_DETAIL_MAP = {
    "寿险业务保险风险-损失发生风险最低资本": "mcP_loss",
    "寿险业务保险风险-退保风险最低资本": "mcP_surr",
    "寿险业务保险风险-费用风险最低资本": "mcP_exp",
    "寿险业务保险风险-风险分散效应": "mcP_div",
    "非寿险业务保险风险-保费及准备金风险最低资本": "mcQ_prem",
    "非寿险业务保险风险-巨灾风险最低资本": "mcQ_cata",
    "非寿险业务保险风险-风险分散效应": "mcQ_div",
    "市场风险-利率风险最低资本": "mcR_rate",
    "市场风险-权益价格风险最低资本": "mcR_eq",
    "市场风险-房地产价格风险最低资本": "mcR_re",
    "市场风险-境外固定收益类资产价格风险最低资本": "mcR_ofb",
    "市场风险-境外权益类资产价格风险最低资本": "mcR_ofe",
    "市场风险-汇率风险最低资本": "mcR_fx",
    "市场风险-风险分散效应": "mcR_div",
    "信用风险-利差风险最低资本": "mcS_spr",
    "信用风险-交易对手违约风险最低资本": "mcS_def",
    "信用风险-风险分散效应": "mcS_div",
    "附加资本": "mcAdd",
    "逆周期附加资本": "mcAdd_cyc",
    "D-SII附加资本": "mcAdd_dsii",
    "G-SII附加资本": "mcAdd_gsii",
    "其他附加资本": "mcAdd_oth",
}
# 旧版最低资本表兜底行号（无指标名匹配时回退）
MC_ROW_MAP = {3: "P", 8: "Q", 12: "R", 20: "S", 24: "T", 25: "U", 28: "V", 34: "N"}


def period_def(key):
    m = re.match(r"(\d{4})Q([1-4])$", key)
    if m:
        y, q = int(m.group(1)), int(m.group(2))
        return {"key": key, "year": y, "q": q, "kind": "quarter",
                "label": f"{y}年第{q}季度", "source": "quarter"}
    m = re.match(r"(\d{4})$", key)
    if m:
        y = int(m.group(1))
        return {"key": key, "year": y, "q": 4, "kind": "year-end",
                "label": f"{y}年", "source": "prelim"}
    raise SystemExit(f"[ERR] 无法解析期次键: {key}")


def rev_files(base, rev):
    """在 data/ 下找 base*.xlsx，只返回文件名含 rev 的（按尾部数字取最大）。无则返回 None。"""
    cands = glob.glob(os.path.join(DATA, base + "*.xlsx"))
    pref = [c for c in cands if rev in os.path.basename(c)]
    if not pref:
        return None

    def key(p):
        nums = re.findall(r"\d+", os.path.basename(p))
        return int(nums[-1]) if nums else 0

    return max(pref, key=key)


# ---------- 读取：偿付能力主表 ----------
def read_solvency(path):
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    hdr_i = None
    for ri, r in enumerate(rows):
        if r and any(str(c).strip() in SOLV_COL_MAP for c in r if c):
            hdr_i = ri
            break
    if hdr_i is None:
        print(f"  [WARN] 未找到表头: {os.path.basename(path)}")
        return {}
    headers = [str(c).strip() if c else "" for c in rows[hdr_i]]
    col_idx = {SOLV_COL_MAP[h]: ci for ci, h in enumerate(headers) if h in SOLV_COL_MAP}
    out = {}
    for ri in range(hdr_i + 1, len(rows)):
        r = rows[ri]
        if not r or not r[0]:
            continue
        comp = str(r[0]).strip()
        vals = {}
        for f, ci in col_idx.items():
            if ci < len(r) and r[ci] is not None:
                try:
                    v = float(r[ci])
                    if v == v:
                        vals[f] = round(v, 6)
                except Exception:
                    pass
        if vals:
            out[comp] = vals
    return out


# ---------- 读取：实际资本明细（横向，列A=指标，其余列=公司）----------
def read_capital(path):
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    metric_row = {}
    for ri, r in enumerate(rows):
        name = r[0]
        if name is None:
            continue
        f = CAP_ROW_MAP.get(str(name).strip())
        if f:
            metric_row[f] = ri
    CAP_ORDER = ["core1", "net", "adj", "adj_nonrec", "adj_lti", "adj_invprop",
                 "adj_dta", "adj_cat", "adj_fvs", "adj_liab", "adj_other",
                 "core2", "c2_pref", "c2_fvm", "c2_oth", "c2_ded", "sub1", "sub2", "total"]
    out = {}
    for ci in range(1, len(rows[0])):
        comp = rows[0][ci]
        if comp is None:
            continue
        comp = str(comp).strip()
        rec = {}
        for f in CAP_ORDER:
            ri = metric_row.get(f)
            v = rows[ri][ci] if (ri is not None and ci < len(rows[ri])) else None
            if v is None:
                rec[f] = None
            else:
                try:
                    rec[f] = round(float(v), 6)
                except Exception:
                    rec[f] = None
        if any(v is not None for v in rec.values()):
            out[comp] = rec
    return out


# ---------- 读取：最低资本明细（横向，行0=公司/行1=期次/行N=指标）----------
def read_mc_excel(path):
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    header_row = rows[0]
    period_row = rows[1]

    def parse_period(s):
        m = re.match(r"(\d{4})第(\d)季度", str(s).strip())
        return f"{m.group(1)}Q{m.group(2)}" if m else None

    # 指标名 -> 行号
    agg_map = {}      # name -> field (P..N)
    detail_map = {}   # name -> field (mcP_loss..mcAdd_oth)
    fallback_agg = {} # row_idx -> field (旧版兜底)
    for ri, r in enumerate(rows):
        name = str(r[0]).strip() if r[0] is not None else ""
        if not name:
            continue
        if name in MC_AGG_MAP:
            agg_map[name] = MC_AGG_MAP[name]
        if name in MC_DETAIL_MAP:
            detail_map[name] = MC_DETAIL_MAP[name]
        if ri in MC_ROW_MAP:
            fallback_agg[ri] = MC_ROW_MAP[ri]

    use_name_agg = bool(agg_map)

    out = {}
    current_comp = None
    for col in range(1, len(header_row)):
        cell = header_row[col]
        if cell and str(cell).strip():
            current_comp = str(cell).strip()
        if not current_comp:
            continue
        pkey = parse_period(period_row[col])
        if not pkey:
            continue
        agg_vals = {}
        detail_vals = {}
        for row_idx, r in enumerate(rows):
            cv = r[col] if col < len(r) else None
            if cv in (None, ""):
                continue
            try:
                fv = round(float(cv), 6)
            except (ValueError, TypeError):
                continue
            name = str(r[0]).strip() if r[0] is not None else ""
            # 聚合项
            field = agg_map.get(name) if use_name_agg else fallback_agg.get(row_idx)
            if field:
                agg_vals[field] = fv
            # 明细项
            df = detail_map.get(name)
            if df:
                detail_vals[df] = fv
        if agg_vals or detail_vals:
            out.setdefault(current_comp, {})[pkey] = {"agg": agg_vals, "detail": detail_vals}
    return out


# ---------- 读取：监管披露行业平均 xls ----------
def read_reg_xls(path, quarter):
    import xlrd
    wb = xlrd.open_workbook(path)
    ws = wb.sheet_by_index(0)
    qcol = None
    qname = {"Q1": "一季度末", "Q2": "二季度末", "Q3": "三季度末", "Q4": "四季度末"}[quarter[-2:]]
    hdr_row = None
    for r in range(ws.nrows):
        for c in range(ws.ncols):
            v = ws.cell(r, c).value
            if isinstance(v, str) and qname in v:
                hdr_row, qcol = r, c
                break
        if hdr_row is not None:
            break
    if qcol is None:
        print(f"  [WARN] 未在 {os.path.basename(path)} 找到 {qname} 列")
        return {}
    out = {}
    cur_metric = None
    for r in range(hdr_row + 1, ws.nrows):
        m0 = str(ws.cell(r, 0).value).strip()
        if m0:
            cur_metric = m0
        is_c = cur_metric and "综合偿付能力" in cur_metric
        is_d = cur_metric and "核心偿付能力" in cur_metric
        if not (is_c or is_d):
            continue
        seg_name = str(ws.cell(r, 1).value).strip()
        seg = REG_SEG_MAP.get(seg_name)
        if not seg:
            continue
        v = ws.cell(r, qcol).value
        if v in (None, ""):
            continue
        try:
            v = round(float(v) * 100.0, 2)
        except Exception:
            continue
        out.setdefault(seg, {})["C" if is_c else "D"] = round(v, 4)
    return out


# ---------- 通用 JS 读/写（保留 let + 头部注释）----------
def load_js(path):
    txt = open(path, encoding="utf-8").read()
    m = re.search(r"(let|const)\s+(\w+)\s*=\s*(\{.*\})\s*;", txt, re.S)
    if not m:
        raise SystemExit(f"[ERR] 解析失败: {path}")
    header = txt.split("\n", 1)[0]
    return m.group(2), json5.loads(m.group(3)), header


def save_js(path, var, obj, header, dry):
    js = header + "\nlet " + var + " = " + json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + ";\n"
    if dry:
        print(f"  [DRY] 将写出 {os.path.basename(path)} ({len(js)//1024} KB)")
        return
    tmp = path + ".tmp"
    open(tmp, "w", encoding="utf-8").write(js)
    os.replace(tmp, path)  # 原子写，不留 .bak


# ============================================================
def upsert_datajs(quarter, rev, dry, overwrite):
    print("=== data.js（偿付能力主表）===")
    var, D, header = load_js(DATA_JS)
    pdef = period_def(quarter)
    files = {"group": "集团偿付能力", "life": "人身险偿付能力",
             "property": "产险偿付能力", "reins": "再保偿付能力"}
    changed = False
    for seg, base in files.items():
        p = rev_files(base, rev)
        if not p:
            print(f"  [SKIP] 无 {rev} 源文件: {base}")
            continue
        recs = read_solvency(p)
        segobj = D["segments"][seg]
        old = segobj["data"]
        n_new = n_ovw = n_skip = 0
        for comp, vals in recs.items():
            if comp not in segobj["companies"]:
                segobj["companies"].append(comp)
                changed = True
            od = old.setdefault(comp, {})
            if quarter in od and od[quarter] and any(od[quarter].values()):
                if overwrite:
                    od[quarter] = vals
                    n_ovw += 1
                    changed = True
                else:
                    n_skip += 1
            else:
                od[quarter] = vals
                n_new += 1
                changed = True
        if not any(pd["key"] == quarter for pd in segobj["periods"]):
            segobj["periods"].append(pdef)
            segobj["periods"].sort(key=lambda x: (x["year"], x["q"]))
            changed = True
        print(f"  {seg}: 新增 {n_new} / 覆盖 {n_ovw} / 跳过 {n_skip}  (源 {len(recs)} 家, {os.path.basename(p)})")
    if changed and not dry:
        save_js(DATA_JS, var, D, header, dry)
    elif dry:
        save_js(DATA_JS, var, D, header, dry)
    else:
        print("  data.js 无变更，跳过写文件")


def upsert_reg(quarter, rev, dry):
    print("=== reg_industry.js（监管行业平均）===")
    import glob as _glob
    yr = quarter[:4]
    cands = _glob.glob(os.path.join(DATA, "*监管披露行业偿付能力水平*.xls"))
    cands.sort(key=lambda x: (0 if yr in os.path.basename(x) else 1, x))
    p = cands[0] if cands else None
    if not p:
        print("  [SKIP] 未找到监管披露行业偿付能力水平*.xls")
        return
    recs = read_reg_xls(p, quarter)
    if not recs:
        print(f"  [SKIP] {os.path.basename(p)} 中无 {quarter} 数据")
        return
    var, R, header = load_js(REG_JS)
    n = 0
    for seg, cd in recs.items():
        if quarter in R["data"].get(seg, {}) and R["data"][seg][quarter]:
            print(f"  [跳过] {seg}/{quarter} 已有数据")
            continue
        R["data"].setdefault(seg, {})[quarter] = cd
        n += 1
        print(f"  {seg}: C={cd.get('C')} D={cd.get('D')}")
    if n > 0 and not dry:
        save_js(REG_JS, var, R, header, dry)
    elif dry:
        save_js(REG_JS, var, R, header, dry)
    else:
        print("  reg_industry.js 无变更，跳过写文件")


def upsert_capital(quarter, rev, dry, overwrite):
    print("=== 实际资本明细 ===")
    for seg, base, js_path in [("life", "人身险实际资本", LIFE_CAP_JS),
                               ("property", "产险实际资本", PROP_CAP_JS)]:
        p = rev_files(base, rev)
        if not p:
            print(f"  [SKIP] 无 {rev} 源文件: {base}")
            continue
        recs = read_capital(p)
        var, CAP, header = load_js(js_path)
        if quarter not in CAP["periods"]:
            CAP["periods"].append(quarter)
            CAP["periods"].sort()
            changed = True
        else:
            changed = False
        n_new = n_ovw = n_skip = 0
        for comp, rec in recs.items():
            if comp not in CAP["companies"]:
                CAP["companies"].append(comp)
                changed = True
            existing = CAP["data"].get(comp, {}).get(quarter)
            if existing and any(v is not None for v in existing.values()):
                if overwrite:
                    CAP["data"].setdefault(comp, {})[quarter] = rec
                    n_ovw += 1
                    changed = True
                else:
                    n_skip += 1
            else:
                CAP["data"].setdefault(comp, {})[quarter] = rec
                n_new += 1
                changed = True
        if changed and not dry:
            save_js(js_path, var, CAP, header, dry)
        elif dry:
            save_js(js_path, var, CAP, header, dry)
        else:
            print(f"  {seg}: 无变更，跳过写文件")
        print(f"  {seg}: 新增 {n_new} / 覆盖 {n_ovw} / 跳过 {n_skip}  (源 {len(recs)} 家, {os.path.basename(p)})")


def upsert_mc(quarter, rev, dry, overwrite):
    print("=== 最低资本明细 (P~V+N + mcDetail 下钻) ===")
    mc_bases = {"life": "人身险最低资本", "property": "产险最低资本", "reins": "再保最低资本"}
    var, D, header = load_js(DATA_JS)
    changed = False
    for seg, base in mc_bases.items():
        p = rev_files(base, rev)
        if not p:
            print(f"  [SKIP] 无 {rev} 源文件: {base}")
            continue
        recs = read_mc_excel(p)  # {comp: {period: {"agg":{P..N},"detail":{mcP_loss..}}}}}
        segobj = D["segments"][seg]
        mcDetail = segobj.setdefault("mcDetail", {})
        n_new = n_ovw = n_skip = 0
        d_new = d_ovw = d_skip = 0
        for comp, permap in recs.items():
            if quarter not in permap:
                continue
            vals = permap[quarter]
            if comp not in segobj["companies"]:
                print(f"  [WARN] {comp} 不在 data.js {seg} 公司列表，跳过")
                continue
            # 1) 主表聚合 P~V+N
            od = segobj["data"].setdefault(comp, {})
            rec = od.setdefault(quarter, {})
            has = any(k in rec for k in ("P", "Q", "R", "S", "T", "U", "V", "N"))
            if has and not overwrite:
                n_skip += 1
            else:
                for f, v in vals.get("agg", {}).items():
                    rec[f] = v
                if has:
                    n_ovw += 1
                else:
                    n_new += 1
                changed = True
            # 2) mcDetail 下钻明细
            det = vals.get("detail", {})
            if det:
                existing_det = mcDetail.setdefault(comp, {}).get(quarter)
                has_det = existing_det and any(v is not None for v in existing_det.values())
                if has_det and not overwrite:
                    d_skip += 1
                else:
                    mcDetail[comp][quarter] = det
                    if has_det:
                        d_ovw += 1
                    else:
                        d_new += 1
                    changed = True
        print(f"  {seg}: 主表 {n_new + n_ovw} 家(新{n_new}/覆盖{n_ovw}/跳过{n_skip})  mcDetail {d_new + d_ovw} 家(新{d_new}/覆盖{d_ovw}/跳过{d_skip})  ({os.path.basename(p)})")
    if changed and not dry:
        save_js(DATA_JS, var, D, header, dry)
    elif dry:
        save_js(DATA_JS, var, D, header, dry)
    else:
        print("  最低资本明细无变更，跳过写文件")


# ============================================================
def deploy(quarter):
    print("=== 部署 ===")
    for f in ["app.js", "index.html", "echarts.min.js", "compare_config.js",
              "life_capital_detail.js", "property_capital_detail.js",
              "data.js", "reg_industry.js"]:
        shutil.copy2(f, os.path.join("dist", f))
    subprocess.run([sys.executable, "_build_standalone.py"], check=True)
    shutil.copy2("偿付能力分析平台_可转发.html", "dist/偿付能力分析平台_可转发.html")
    subprocess.run(["git", "add", "-A"], check=True)
    subprocess.run(["git", "commit", "-m", f"data: upsert {quarter} (update_quarter.py)"], check=True)
    subprocess.run(["git", "push"], check=True)
    import urllib.request
    for url in ["https://yyseles.github.io/solvency/data.js",
                "https://yyseles.github.io/solvency/reg_industry.js"]:
        try:
            html = urllib.request.urlopen(url, timeout=20).read().decode("utf-8", "ignore")
            print(f"  线上 {url.split('/')[-1]} 含 {quarter}:", quarter in html)
        except Exception as e:
            print("  [WARN] 在线校验失败:", e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quarter", default="2026Q2")
    ap.add_argument("--rev", default="0831")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--deploy", action="store_true")
    ap.add_argument("--no-overwrite", dest="overwrite", action="store_false")
    ap.set_defaults(overwrite=True)
    args = ap.parse_args()

    upsert_datajs(args.quarter, args.rev, args.dry, args.overwrite)
    upsert_reg(args.quarter, args.rev, args.dry)
    upsert_capital(args.quarter, args.rev, args.dry, args.overwrite)
    upsert_mc(args.quarter, args.rev, args.dry, args.overwrite)
    if args.deploy and not args.dry:
        deploy(args.quarter)
    print("\n完成。")


if __name__ == "__main__":
    main()
