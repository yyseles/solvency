import fs from 'fs';
import vm from 'vm';
const src = fs.readFileSync('data.js','utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__SOLVENCY = SOLVENCY_DATA;', sandbox);
const D = sandbox.__SOLVENCY;

function prevComparable(KEY2PERIOD, k){
  const p=KEY2PERIOD[k]; if(!p) return null;
  if(p.kind==='year-end'){ const pk=`${p.year-1}`; return KEY2PERIOD[pk]?pk:null; }
  const pk=`${p.year-1}Q${p.q}`; return KEY2PERIOD[pk]?pk:null;
}

for(const seg of ['group','property','life','reins']){
  const s=D.segments[seg];
  const K2P={}; s.periods.forEach(p=>K2P[p.key]=p);
  const TL=s.periods.map(p=>p.key);
  const lastK=TL[TL.length-1];
  const prevK=prevComparable(K2P,lastK);
  console.log(`\n=== 板块 ${seg}: 最新期=${lastK}, 上一可比期=${prevK} ===`);
  if(!prevK){ console.log('  无上一可比期 -> 恶化榜不渲染 (显示"无上一可比时点")'); continue; }
  let n=0;
  for(const c of s.companies){
    const r=s.data[c][lastK], pr=s.data[c][prevK];
    const ok = r&&pr&&r.C!=null&&pr.C!=null;
    if(ok){ const d=(r.C-pr.C)*100; n++; console.log(`  ${c.padEnd(12)} ${lastK} C=${r.C} | ${prevK} C=${pr.C} | 变动=${d.toFixed(1)}pp`); }
    else { console.log(`  ${c.padEnd(12)} --缺数据(今年或去年) lastC=${r?r.C:null} prevC=${pr?pr.C:null}`); }
  }
  console.log(`  有数公司数: ${n}`);
}
