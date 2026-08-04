# -*- coding: utf-8 -*-
"""把偿付能力分析平台打包成单个自包含 HTML（所有 js/css/data 内联），便于转发。"""
import io, sys, os

SRC_DIR = r"C:\Users\yangyang05-ghq\Desktop\wb\solvency"
OUT = os.path.join(SRC_DIR, "偿付能力分析平台_可转发.html")

def read(p):
    with io.open(os.path.join(SRC_DIR, p), "r", encoding="utf-8") as f:
        return f.read()

html = read("index.html")
echarts = read("echarts.min.js")
datajs = read("data.js")
regjs = read("reg_industry.js")
comparejs = read("compare_config.js")
appjs = read("app.js")

import re
# 用内联脚本替换四个外部引用（兼容 ?v= 缓存破坏参数）。echarts 放最前。
def inline(tag, code):
    global html
    pat = re.compile(r'<script src="' + re.escape(tag) + r'(\?[^"]*)?"></script>')
    if tag == 'data.js':
        # 加标记，便于"导出可转发网页"在浏览器内替换数据
        wrapped = '/*__SOLVENCY_DATA_START__*/\n' + code + '\n/*__SOLVENCY_DATA_END__*/'
    elif tag == 'reg_industry.js':
        wrapped = '/*__REG_INDUSTRY_START__*/\n' + code + '\n/*__REG_INDUSTRY_END__*/'
    else:
        wrapped = code
    repl = '<script>/* ' + tag + ' (inlined) */\n' + wrapped + '\n</script>'
    html = pat.sub(lambda m: repl, html, count=1)

inline('echarts.min.js', echarts)
inline('data.js', datajs)
inline('reg_industry.js', regjs)
inline('compare_config.js', comparejs)
inline('app.js', appjs)

with io.open(OUT, "w", encoding="utf-8") as f:
    f.write(html)

size_kb = os.path.getsize(OUT) / 1024
print("OK 生成:", OUT)
print("大小: %.0f KB (%.2f MB)" % (size_kb, size_kb / 1024))
# 校验：不应再残留外部 src 引用
for tag in ['echarts.min.js', 'data.js', 'reg_industry.js', 'compare_config.js', 'app.js']:
    if ('src="' + tag) in html:
        print("!! 警告：仍残留外部引用", tag)
    else:
        print("  已内联:", tag)
