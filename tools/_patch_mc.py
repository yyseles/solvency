import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
import update_quarter as U
from _parse_zhongzai import parse_pdf

DATA_JS = 'data.js'
PDF = {
    '2025Q4': 'data/_pdf_tmp/2025Q4.pdf',
    '2026Q1': 'data/_pdf_tmp/2026Q1.pdf',
}

var, D, header = U.load_js(DATA_JS)
g = D['segments']['reins']
g.setdefault('mcDetail', {})['中再集团本级'] = g['mcDetail'].get('中再集团本级', {})

for q, path in PDF.items():
    _, mc = parse_pdf(path)
    g['mcDetail']['中再集团本级'][q] = mc
    print(f'{q}: mcDetail 子项数 = {len(mc)}',
          {k: mc[k] for k in list(mc)[:3]})

# 原子写
tmp = DATA_JS + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    f.write(var + ' = ' + json.dumps(D, ensure_ascii=False, indent=1) + ';\n')
os.replace(tmp, DATA_JS)
print('data.js 已更新（中再集团本级 mcDetail 补齐 2025Q4/2026Q1）')
