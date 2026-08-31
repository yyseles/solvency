/* 保险行业偿付能力分析平台 —— 纯前端逻辑（多板块） */
(function(){
  let D = SOLVENCY_DATA;
  let LAB = D.meta.labels;
  let SEG_NAMES = D.meta.segmentNames;
  const SEG_ORDER = D.meta.segments;

  // ---------- 当前板块（切换时重建） ----------
  let COMPS, PERIODS, KEY2PERIOD, DATA, TL;
  const S = {
    seg:'all',
    range:[0,0],
    rankMetric:'C', rankPeriod:null,
    riskEntity:null, riskInd:true, riskPeriod:null, capTab:'mc',
    equityForm:'tier',
    mcPieMode:'top', mcPieParent:'market',
    rankEvo:null,
    alertPeriod:null, alertFilter:'all',
    cmp:new Set(), focus:null
  };

  function loadSeg(seg){
    S.seg = seg;
    if(seg==='all'){
      COMPS=[]; PERIODS=[]; DATA={}; KEY2PERIOD={}; TL=[];
      S.riskEntity=null;
      updateSegInfo();
      return;
    }
    const s = D.segments[seg];
    COMPS = s.companies; PERIODS = s.periods; DATA = s.data;
    KEY2PERIOD = {}; PERIODS.forEach(p=>KEY2PERIOD[p.key]=p);
    TL = PERIODS.map(p=>p.key);
    S.range = [0, TL.length-1];
    S.cmp.clear(); S.focus=null;
    // 默认选中"阳光系"公司（各板块对应）
    const DEF_ENT = {group:'阳光集团',property:'阳光财产',life:'阳光人寿'};
    S.riskEntity = COMPS.includes(DEF_ENT[seg]||'') ? DEF_ENT[seg] : (COMPS[0]||null);
    updateSegInfo();
  }

  // ---------- 工具 ----------
  const has = k => !!KEY2PERIOD[k];
  function valuesAt(key,field){
    const out=[]; for(const c of COMPS){const r=DATA[c][key]; const v=r&&r[field]; if(v!=null && !isNaN(v)) out.push(v);} return out;
  }
  function industrySumAt(key,field){
    let s=0; for(const c of COMPS){const r=DATA[c][key]; const v=r&&r[field]; if(v!=null && !isNaN(v)) s+=v;} return s;
  }
  // 监管口径加权平均：综合=Σ实际资本/Σ最低资本；核心=Σ核心资本/Σ最低资本
  // 纳入口径：要求「实际资本 I、核心一级 J、最低资本 N」三项齐全即纳入；核心二级 K 可缺省。
  //   - 核心资本 = 有K时 核心一级+核心二级(J+K)；缺K时 仅核心一级(J)
  //   - 实际资本 I = J+K+L+M ≥ 核心资本（K 缺省时 I≥J 仍成立），故 综合加权≥核心加权 恒等式保持。
  function weightedAt(key,field){
    let num=0, den=0;
    for(const c of COMPS){
      const r=DATA[c][key]; if(!r) continue;
      const I=r.I,J=r.J,K=r.K,N=r.N;
      const okI=I!=null&&!isNaN(I), okJ=J!=null&&!isNaN(J),
            okK=K!=null&&!isNaN(K), okN=N!=null&&!isNaN(N);
      if(!(okI&&okJ&&okN)) continue;            // K 不再强制要求
      const core = okK ? (J+K) : J;            // 缺K时核心资本=核心一级
      num += (field==='C') ? I : core;
      den += N;
    }
    return den>0 ? num/den : NaN;
  }
  function quantile(arr,q){
    if(!arr.length) return NaN;
    const a=arr.slice().sort((x,y)=>x-y);
    const pos=(a.length-1)*q, b=Math.floor(pos), r=pos-b;
    return a[b+1]!==undefined ? a[b]+r*(a[b+1]-a[b]) : a[b];
  }
  const median=a=>quantile(a,0.5);
  const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;
  function statOf(arr,st){
    if(!arr.length) return NaN;
    if(st==='mean') return mean(arr);
    if(st==='median') return median(arr);
    const map={p10:0.1,p25:0.25,p75:0.75,p90:0.9};
    return quantile(arr,map[st]);
  }
  const pct=v=> (v==null||isNaN(v))?'—':(v*100).toFixed(1)+'%';
  function yi(wan){
    const v=wan/10000;
    if(Math.abs(v)>=10000) return (v/10000).toFixed(2)+' 万亿';
    return v.toLocaleString('zh-CN',{maximumFractionDigits:0});
  }
  const fmtYi = v => yi(v)+' 亿';
  function bucketC(v){
    if(v==null) return '缺失';
    if(v<1.0) return '<100%';
    if(v<1.5) return '100-150%';
    if(v<2.0) return '150-200%';
    return '≥200%';
  }
  const CMP_TH=['#2f6fed','#16a085','#e67e22','#9b59b6','#e74c3c','#34495e'];
  const BUCKET_COL={'<100%':'#e74c3c','100-150%':'#e67e22','150-200%':'#16a085','≥200%':'#2f6fed','未披露':'#9aa7b5'};
  const pctLine = f => f==='C'?1.0:0.5;

  // 最低资本风险结构「下钻」配置（基于各板块《最低资本》明细表 C-ROSS 二期 33 项）
  // pie=true 用饼图（量化风险内部四构成）；否则用横向条形展示子项（含分散效应扣减，负值向左）
  const MC_CATS = {
    overview:{label:'量化风险总览', pie:true,
      items:[['mcP','寿险业务保险风险'],['mcR','市场风险'],['mcS','信用风险'],['mcQ','非寿险业务保险风险']]},
    life:{label:'寿险业务保险风险', pie:false, total:'mcP',
      items:[['mcP_loss','损失发生风险'],['mcP_surr','退保风险'],['mcP_exp','费用风险'],['mcP_div','风险分散效应(扣减)']]},
    nonlife:{label:'非寿险业务保险风险', pie:false, total:'mcQ',
      items:[['mcQ_prem','保费及准备金风险'],['mcQ_cata','巨灾风险'],['mcQ_div','风险分散效应(扣减)']]},
    market:{label:'市场风险', pie:false, total:'mcR',
      items:[['mcR_rate','利率风险'],['mcR_eq','权益价格风险'],['mcR_re','房地产价格风险'],
             ['mcR_ofb','境外固收价格风险'],['mcR_ofe','境外权益价格风险'],['mcR_fx','汇率风险'],['mcR_div','风险分散效应(扣减)']]},
    credit:{label:'信用风险', pie:false, total:'mcS',
      items:[['mcS_spr','利差风险'],['mcS_def','交易对手违约风险'],['mcS_div','风险分散效应(扣减)']]},
    addcap:{label:'附加资本', pie:false, total:'mcAdd',
      items:[['mcAdd_cyc','逆周期附加资本'],['mcAdd_dsii','D-SII附加资本'],['mcAdd_gsii','G-SII附加资本'],['mcAdd_oth','其他附加资本']]},
  };
  // 聚合项(与主料重合)在主表以字母存储；明细仅含细分项。下钻时按 key 前缀区分读取源。
  const MC_AGG = {mcO:'O',mcP:'P',mcQ:'Q',mcR:'R',mcS:'S',mcT:'T',mcU:'U',mcV:'V',mcN:'N'};
  // 取所选主体某期末的最低资本明细记录（无则返回 null）
  function mcRec(key){
    const mc = (D.segments[S.seg]&&D.segments[S.seg].mcDetail)||{};
    if(!S.riskEntity) return null;
    const m = mc[S.riskEntity];
    return (m && m[key]) ? m[key] : null;
  }
  function mcEntityVals(key,cat){
    const e = mcRec(key);
    const mainRec = (S.riskEntity && DATA[S.riskEntity]) ? (DATA[S.riskEntity][key]||{}) : {};
    return cat.items.map(it => {
      let v;
      if(MC_AGG[it[0]]) v = mainRec[MC_AGG[it[0]]];   // 聚合项读主表
      else v = e ? e[it[0]] : null;                  // 细分项读明细
      return (v!=null && !isNaN(v)) ? v : 0;
    });
  }
  function mcIndVals(key,cat){
    const mc = (D.segments[S.seg]&&D.segments[S.seg].mcDetail)||{};
    const out = cat.items.map(()=>0);
    for(const c of COMPS){
      cat.items.forEach((it,i)=>{
        let v;
        if(MC_AGG[it[0]]){ const r=DATA[c]&&DATA[c][key]; v=r?r[MC_AGG[it[0]]]:null; }
        else { const m=mc[c]; v=(m&&m[key])?m[key][it[0]]:null; }
        if(v!=null&&!isNaN(v)) out[i]+=v;
      });
    }
    return out;
  }

  // 公司某期末的偿付能力状态：达标 / 不达标 / 未披露（C/D 为空或 NaN）
  function statusOf(comp,key){
    const r=DATA[comp][key];
    const c=r&&r.C, d=r&&r.D;
    const hasC=c!=null && !isNaN(c), hasD=d!=null && !isNaN(d);
    if(hasC && hasD) return (c>=1.0 && d>=0.5)?'ok':'bad';
    return 'nodata';
  }

  // ---------- 渲染容器 ----------
  const charts={};
  // 容器尺寸变化时（含首次布局完成、面板由隐藏变显示）自动 resize，避免图表初始化在 0 宽容器而空白
  const _ro = ('ResizeObserver' in window) ? new ResizeObserver(es=>{
    for(const e of es){ const c=charts[e.target.id]; if(c && !e.target.closest('.panel:not(.on)') && e.target.offsetParent!==null) c.resize(); }
  }) : null;
  function chart(id){
    const el=document.getElementById(id); if(!el) return null;
    if(!charts[id]){ charts[id]=echarts.init(el); if(_ro) _ro.observe(el); }
    return charts[id];
  }
  function setOpt(id,opt){ const c=chart(id); if(!c) return; c.setOption(opt,true); requestAnimationFrame(()=>{ if(charts[id]) charts[id].resize(); }); }
  function tlSlice(){ return TL.slice(S.range[0], S.range[1]+1); }

  // ---------- 板块信息 ----------
  function updateSegInfo(){
    if(S.seg==='all'){
      const note='全行业概览：列示各细分板块最新一期的偿付能力概览（计算加权口径｜监管披露口径）';
      document.getElementById('caliberNote').textContent=note;
      document.getElementById('segMeta').textContent='全行业 · 四板块最新概览';
      return;
    }
    const ye = PERIODS.filter(p=>p.kind==='year-end');
    const prelim = ye.filter(p=>p.source==='prelim').length;
    let cal='';
    if(ye.length>0 && prelim===0) cal='当前板块年末值均为审计后（年度）';
    if(REG_INDUSTRY && REG_INDUSTRY.data[S.seg]){
      const note = '行业平均含两口径：监管披露（监管直接披露）｜ 披露统计（本平台基于个体披露自算 加权/中位/均值）';
      cal = cal ? cal + '；' + note : note;
    }
    document.getElementById('caliberNote').textContent = cal;
    const last = PERIODS.length? PERIODS[PERIODS.length-1].label : '—';
    document.getElementById('segMeta').textContent =
      `${SEG_NAMES[S.seg]} · ${COMPS.length}家 · ${PERIODS.length}期 · 最新：${last}`;
  }

  // ---------- 概览 ----------
  function renderOverview(){
    if(S.seg==='all'){ renderAllOverview(); return; }
    const sl=tlSlice(); const lastK=sl[sl.length-1];
    const total=COMPS.length;
    let comp=0, bad=0, nodata=0;
    for(const c of COMPS){ const st=statusOf(c,lastK); if(st==='ok')comp++; else if(st==='bad')bad++; else nodata++; }
    const disclosed=comp+bad;
    const rate=disclosed?comp/disclosed:0;
    const risk=bad+nodata;
    const Cs=valuesAt(lastK,'C'), Ds=valuesAt(lastK,'D');
    const medC=median(Cs), medD=median(Ds), meanC=mean(Cs), meanD=mean(Ds);
    const wC=weightedAt(lastK,'C'), wD=weightedAt(lastK,'D');
    const nW=COMPS.filter(c=>{const r=DATA[c][lastK]; if(!r) return false;
      const v=[r.I,r.J,r.K,r.N]; return v.every(x=>x!=null&&!isNaN(x));}).length;
    // 监管披露口径（仅财产/人身/再保有数据，集团不含）
    const reg = (REG_INDUSTRY && REG_INDUSTRY.data[S.seg]) ? REG_INDUSTRY.data[S.seg][lastK] : null;
    const pctReg = v => (v==null)?'—':(v).toFixed(1)+'%';
    const regC = reg ? [['监管披露', pctReg(reg.C)]] : [];
    const regD = reg ? [['监管披露', pctReg(reg.D)]] : [];
    document.getElementById('kpiBox').innerHTML = [
      kpi3('综合偿付能力充足率',pct(wC),[...regC,['中位',pct(medC)],['算数平均',pct(meanC)]],colorFor(wC,1.0)),
      kpi3('核心偿付能力充足率',pct(wD),[...regD,['中位',pct(medD)],['算数平均',pct(meanD)]],colorFor(wD,0.5)),
      kpi('行业达标率',(rate*100).toFixed(1)+'%', `达标 ${comp} / 已披露 ${disclosed} 家（未披露 ${nodata} 家单列）`, rate>=0.95?'#27ae60':'#e67e22'),
      kpi('风险公司数（含未披露公司）',risk+' 家', `综合<100% 或 核心<50%（不达标），含未披露 ${nodata} 家`, risk===0?'#27ae60':'#e74c3c'),
    ].join('');
    trendLineChart('ovC','C',sl,1.0);
    trendLineChart('ovD','D',sl,0.5);
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const rates=sl.map(k=>{let c=0,d=0;for(const cc of COMPS){const st=statusOf(cc,k);if(st==='ok')c++;else if(st==='bad')d++;}const disc=c+d;return disc?+(c/disc*100).toFixed(1):0;});
    const bads=sl.map(k=>{let b=0;for(const cc of COMPS){const st=statusOf(cc,k); if(st==='bad'||st==='nodata')b++;}return b;});
    setOpt('ovComp',{
      tooltip:{trigger:'axis'}, legend:{data:['达标率%','风险公司数（含未披露公司）'],top:0},
      grid:{left:50,right:55,top:35,bottom:30},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35}},
      yAxis:[{type:'value',name:'达标率%',max:100,min:0},{type:'value',name:'家',min:0}],
      series:[
        {name:'达标率%',type:'line',smooth:true,data:rates,areaStyle:{opacity:.12},itemStyle:{color:'#27ae60'},lineStyle:{width:2.5}},
        {name:'风险公司数（含未披露公司）',type:'bar',yAxisIndex:1,data:bads,itemStyle:{color:'#e74c3c',opacity:.7}}
      ]
    });
  }
  // 全行业概览：列示各细分板块最新一期的偿付能力概览
  function renderAllOverview(){
    const segs = SEG_ORDER.filter(s=>D.segments[s]);
    const regPct=v=>(v==null)?'—':v.toFixed(1)+'%';
    const rows = segs.map(seg=>{
      const s=D.segments[seg];
      const saveC=COMPS, saveD=DATA, saveK=KEY2PERIOD, saveTL=TL;
      COMPS=s.companies; DATA=s.data;
      KEY2PERIOD={}; s.periods.forEach(p=>KEY2PERIOD[p.key]=p); TL=s.periods.map(p=>p.key);
      const lastP=s.periods[s.periods.length-1];
      const lastK=lastP.key;
      const Cs=valuesAt(lastK,'C'), Ds=valuesAt(lastK,'D');
      const wC=weightedAt(lastK,'C'), wD=weightedAt(lastK,'D');
      const reg=(REG_INDUSTRY&&REG_INDUSTRY.data[seg])?REG_INDUSTRY.data[seg][lastK]:null;
      const n=COMPS.length;
      let comp=0,bad=0,nodata=0;
      for(const c of COMPS){const st=statusOf(c,lastK); if(st==='ok')comp++; else if(st==='bad')bad++; else nodata++;}
      const disclosed=comp+bad; const rate=disclosed?comp/disclosed:0;
      COMPS=saveC; DATA=saveD; KEY2PERIOD=saveK; TL=saveTL;
      return {seg,name:SEG_NAMES[seg],label:lastP.label,wC,wD,reg,n,rate};
    });
    // 「其中」子集定义（在每个板块主行下展开）
    const SUBSETS = {
      group: [
        { label:'其中：上市保险集团', companies:['平安集团','人保集团','太保集团','太平集团'] },
        { label:'其中：阳光集团', companies:['阳光集团'] },
      ],
      property: [
        { label:'其中：上市财险公司', companies:['平安产险','人保财险','太保财险','太平财险','众安财产','大地财产'] },
        { label:'其中：阳光财产', companies:['阳光财产'] },
      ],
      life: [
        { label:'其中：上市人身险公司', companies:['平安寿险','人保寿险','太保寿险','太平人寿','中国人寿','新华保险'] },
        { label:'其中：阳光人寿', companies:['阳光人寿'] },
        { label:'其中：银保系公司', companies:['工银安盛','光大永明','建信人寿','交银人寿','中荷人寿','农银人寿','中银三星','中邮人寿','招商信诺'] },
      ],
    };
    // 计算某板块下「其中」子集行的加权充足率与达标率
    function subRow(seg, compsIn){
      const s=D.segments[seg];
      const companies=compsIn.filter(c=> s.companies.includes(c)); // 与板块实际公司求交集，剔除不存在项
      const saveC=COMPS, saveD=DATA, saveK=KEY2PERIOD, saveTL=TL;
      COMPS=companies; DATA=s.data;
      KEY2PERIOD={}; s.periods.forEach(p=>KEY2PERIOD[p.key]=p); TL=s.periods.map(p=>p.key);
      const lastP=s.periods[s.periods.length-1]; const lastK=lastP.key;
      const wC=weightedAt(lastK,'C'), wD=weightedAt(lastK,'D');
      let comp=0,bad=0,nodata=0;
      for(const c of companies){ const st=statusOf(c,lastK); if(st==='ok')comp++; else if(st==='bad')bad++; else nodata++; }
      const disclosed=comp+bad; const rate=disclosed?comp/disclosed:0;
      COMPS=saveC; DATA=saveD; KEY2PERIOD=saveK; TL=saveTL;
      return {wC,wD,n:companies.length,rate};
    }
    const box=document.getElementById('overviewAll');
    // 先释放旧图表实例，避免 innerHTML 重建后实例仍绑定到已移除的旧 DOM（导致切换回此 tab 时图不显示）
    ['allBar_group','allBar_property','allBar_life','allBar_reins'].forEach(id=>{ if(charts[id]){ try{charts[id].dispose();}catch(e){} charts[id]=null; } });
    // 组装表格 tbody：每个板块主行 + 其「其中」子集行
    const segRowMap={}; rows.forEach(r=>segRowMap[r.seg]=r);
    let tbody='';
    rows.forEach(r=>{
      tbody += `<tr>`+
        `<td style="text-align:left;font-weight:600">${r.name}</td>`+
        `<td>${r.label}</td>`+
        `<td style="color:${colorFor(r.wC,1.0)};font-weight:600">${pct(r.wC)}</td>`+
        `<td>${r.reg?regPct(r.reg.C):'—'}</td>`+
        `<td style="color:${colorFor(r.wD,0.5)};font-weight:600">${pct(r.wD)}</td>`+
        `<td>${r.reg?regPct(r.reg.D):'—'}</td>`+
        `<td>${r.n} 家</td>`+
        `<td>${(r.rate*100).toFixed(1)}%</td>`+
      `</tr>`;
      (SUBSETS[r.seg]||[]).forEach(sb=>{
        const sr=subRow(r.seg, sb.companies);
        tbody += `<tr style="background:#fafbfc">`+
          `<td style="text-align:left;padding-left:24px;color:#556">${sb.label}</td>`+
          `<td></td>`+
          `<td style="color:${colorFor(sr.wC,1.0)};font-weight:600">${pct(sr.wC)}</td>`+
          `<td>—</td>`+
          `<td style="color:${colorFor(sr.wD,0.5)};font-weight:600">${pct(sr.wD)}</td>`+
          `<td>—</td>`+
          `<td>${sr.n} 家</td>`+
          `<td>${(sr.rate*100).toFixed(1)}%</td>`+
        `</tr>`;
      });
    });
    box.innerHTML =
      '<div class="hint" style="margin-bottom:14px">以下为各细分板块最新报告期的行业偿付能力概览。计算加权口径为本平台基于个体披露自算（综合=Σ实际资本/Σ最低资本，核心=Σ核心资本/Σ最低资本）；监管披露口径为金融监管总局直接披露（集团暂无监管披露口径，以「—」表示）。「其中」子集行仅列计算加权口径，监管披露口径不区分子集，统一以「—」表示。</div>'+
      '<div class="card"><h3>各板块最新偿付能力概览</h3>'+
        '<div style="overflow-x:auto;border:1px solid var(--line);border-radius:10px"><table style="width:100%;min-width:680px;table-layout:auto;font-size:13px;border-collapse:separate;border-spacing:0">'+
          '<thead><tr><th>板块</th><th>最新期</th><th>综合(加权)</th><th>综合(监管)</th><th>核心(加权)</th><th>核心(监管)</th><th>样本数</th><th>达标率</th></tr></thead>'+
          '<tbody>'+tbody+'</tbody>'+
        '</table>'+
      '</div>'+
      '<p style="font-size:11.5px;color:var(--sub);margin-top:8px;line-height:1.7">注：上市保险集团包括平安集团、人保集团、太保集团、太平集团共4家；上市财险公司包括平安产险、人保财险、太保财险、太平财险、众安财产、大地财产共6家；上市人身险公司包括平安寿险、人保寿险、太保寿险、太平人寿、中国人寿、新华保险共6家；银保系公司包括工银安盛、光大永明、建信人寿、交银人寿、中荷人寿、农银人寿、中银三星、中邮人寿、招商信诺共9家。</p>'+
      '<div class="grid2">'+
        '<div class="card"><h3>保险集团控股公司 · 综合 vs 核心</h3><div id="allBar_group" class="chart" style="height:320px"></div></div>'+
        '<div class="card"><h3>财产保险公司 · 综合 vs 核心</h3><div id="allBar_property" class="chart" style="height:320px"></div></div>'+
        '<div class="card"><h3>人身保险公司 · 综合 vs 核心</h3><div id="allBar_life" class="chart" style="height:320px"></div></div>'+
        '<div class="card"><h3>再保险公司 · 综合 vs 核心</h3><div id="allBar_reins" class="chart" style="height:320px"></div></div>'+
      '</div>';
    const barLabel={show:true,position:'top',fontSize:10,color:'#666',formatter:p=>p.value!=null?p.value.toFixed(1)+'%':'—'};
    const subColors=['#16a085','#8e44ad','#c0392b','#16a0a0'];
    [['group','allBar_group'],['property','allBar_property'],['life','allBar_life'],['reins','allBar_reins']].forEach(([seg,id])=>{
      const r=segRowMap[seg]; const hasReg=!!r.reg;
      const series=[], legend=[];
      series.push({name:'整体(加权)',type:'bar',
        data:[r.wC!=null?+(r.wC*100).toFixed(2):null, r.wD!=null?+(r.wD*100).toFixed(2):null],
        itemStyle:{color:'#2f6fed'}, label:barLabel}); legend.push('整体(加权)');
      if(hasReg){ series.push({name:'整体(监管)',type:'bar',
        data:[+(r.reg.C).toFixed(2), +(r.reg.D).toFixed(2)], itemStyle:{color:'#e67e22'}, label:barLabel}); legend.push('整体(监管)'); }
      (SUBSETS[seg]||[]).forEach((sb,si)=>{
        const sr=subRow(seg, sb.companies);
        const nm=sb.label.replace('其中：','');
        series.push({name:nm,type:'bar',
          data:[sr.wC!=null?+(sr.wC*100).toFixed(2):null, sr.wD!=null?+(sr.wD*100).toFixed(2):null],
          itemStyle:{color:subColors[si%subColors.length]}, label:barLabel});
        legend.push(nm);
      });
      setOpt(id,{
        tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>(v==null?'-':v.toFixed(1)+'%')},
        legend:{data:legend, top:0, type:'scroll', textStyle:{fontSize:10}},
        grid:{left:55,right:18,top:50,bottom:30},
        xAxis:{type:'category',data:['综合偿付能力充足率','核心偿付能力充足率']},
        yAxis:{type:'value',name:'充足率%',axisLabel:{formatter:v=>v+'%'}},
        series
      });
    });
    setTimeout(()=>{ ['allBar_group','allBar_property','allBar_life','allBar_reins'].forEach(id=>{ if(charts[id]) charts[id].resize(); }); },30);
  }
  function kpi(lab,val,sub,color){return `<div class="kpi"><div class="lab">${lab}</div><div class="val" style="color:${color}">${val}</div><div class="sub">${sub}</div></div>`;}
  function kpi3(lab,val,stats,color){
    const chips=stats.map(s=>{
      const cls = s[0]==='监管披露' ? 'kstat reg' : 'kstat';
      return `<span class="${cls}"><b>${s[1]}</b><i>${s[0]}</i></span>`;
    }).join('');
    return `<div class="kpi"><div class="lab">${lab}</div><div class="val" style="color:${color}">${val}</div><div class="sub stats">${chips}</div></div>`;
  }
  function colorFor(v,line){ if(v==null) return '#888'; return v<line?'#e74c3c':(v<line*1.5?'#e67e22':'#27ae60'); }
  function prevComparable(k){
    const p=KEY2PERIOD[k]; if(!p) return null;
    if(p.kind==='year-end'){ const pk=`${p.year-1}`; return has(pk)?pk:null; }
    const pk=`${p.year-1}Q${p.q}`; return has(pk)?pk:null;
  }

  // 概览：时间趋势折线（计算加权平均 主线条；叠加 监管披露 与 中位数 对照）
  function trendLineChart(id,field,sl,line){
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const w=sl.map(k=>weightedAt(k,field));
    const med=sl.map(k=>median(valuesAt(k,field)));
    const regSet=(REG_INDUSTRY && REG_INDUSTRY.data[S.seg]) ? REG_INDUSTRY.data[S.seg] : null;
    const regArr=regSet ? sl.map(k=>{const r=regSet[k]; return r ? (field==='C'?r.C:r.D)/100 : null;}) : null;
    const fieldCol=field==='C'?'#2f6fed':'#16a085';
    const series=[
      {name:'计算加权平均',type:'line',smooth:true,data:w,symbol:'circle',symbolSize:5,lineStyle:{width:2.8,color:fieldCol},itemStyle:{color:fieldCol}},
      {name:'中位数',type:'line',smooth:true,data:med,symbol:'none',lineStyle:{width:1.6,type:'dotted',color:'#9aa7b5'},itemStyle:{color:'#9aa7b5'}}
    ];
    if(regArr){
      const regCol='#e67e22';
      series.push({name:'监管披露',type:'line',smooth:true,data:regArr,symbol:'circle',symbolSize:5,lineStyle:{width:2.4,type:'dashed',color:regCol},itemStyle:{color:regCol}});
    }
    series.push({name:'达标线',type:'line',data:sl.map(()=>line),symbol:'none',lineStyle:{type:'dashed',color:'#e74c3c',width:1.5},tooltip:{show:false},silent:true});
    setOpt(id,{
      tooltip:{trigger:'axis',valueFormatter:v=>(v==null?'-':(v*100).toFixed(1)+'%')},
      legend:{data:series.map(s=>s.name).filter(n=>n!=='达标线'),top:0,type:'scroll'},
      grid:{left:55,right:20,top:35,bottom:55},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35}},
      yAxis:{type:'value',axisLabel:{formatter:v=>(v*100).toFixed(0)+'%'},name:'充足率'},
      series
    });
  }

  // （原「时间趋势」独立板块已删除，时间趋势折线已并入概览 ovC/ovD）

  // ---------- 公司排名 ----------
  function renderRank(){
    const k=S.rankPeriod;
    const all=COMPS.map(c=>{const r=DATA[c][k]; const st=statusOf(c,k);
      return {c, v:(st==='nodata'||!r||r.C==null)?null:r.C, C:r?r.C:null, D:r?r.D:null, I:r?r.I:null, N:r?r.N:null, st};});
    const disclosed=all.filter(x=>x.v!=null).sort((a,b)=>b.v-a.v);
    const nodata=all.filter(x=>x.st==='nodata').sort((a,b)=>a.c.localeCompare(b.c));
    const rows=disclosed.concat(nodata);
    const cats=disclosed.map(x=>x.c), vals=disclosed.map(x=>x.v);
    const colors=disclosed.map(x=> x.v< pctLine('C')?'#e74c3c':(x.v< pctLine('C')*1.5?'#e67e22':'#27ae60'));
    setOpt('rankBar',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>(v*100).toFixed(1)+'%'},
      grid:{left:110,right:40,top:10,bottom:30},
      xAxis:{type:'value',axisLabel:{formatter:v=>(v*100).toFixed(0)+'%'}},
      yAxis:{type:'category',data:cats,axisLabel:{fontSize:10},inverse:true},
      dataZoom:[{type:'slider',yAxisIndex:0,right:6,width:14,start:0,end:40}],
      series:[{type:'bar',data:vals.map((v,i)=>({value:v,itemStyle:{color:colors[i]}})),barWidth:'70%'}]
    });
    const tb=document.getElementById('rankTable');
    document.getElementById('rankTableHdr').querySelector('thead').innerHTML='<tr><th>排名</th><th>公司</th><th>综合充足率</th><th>核心充足率</th><th>综合排名</th><th>核心排名</th><th>实际资本(亿)</th><th>最低资本(亿)</th><th>状态</th></tr>';
    // 计算综合排名（按 C 降序）、核心排名（按 D 降序）
    const cRank={}, dRank={};
    all.filter(x=>x.C!=null).slice().sort((a,b)=>b.C-a.C).forEach((x,i)=>cRank[x.c]=i+1);
    all.filter(x=>x.D!=null).slice().sort((a,b)=>b.D-a.D).forEach((x,i)=>dRank[x.c]=i+1);
    const q=document.getElementById('rankSearch').value.trim();
    const frows=rows.filter(x=>!q||x.c.includes(q));
    tb.querySelector('tbody').innerHTML=frows.map(x=>{
      let stTag;
      if(x.st==='nodata') stTag='<span class="tag nodata">未披露</span>';
      else if(x.C<1.0||x.D<0.5) stTag='<span class="tag bad">不达标</span>';
      else if(x.C<1.2||x.D<0.6) stTag='<span class="tag warn">关注</span>';
      else stTag='<span class="tag ok">达标</span>';
      const rankNo = x.v!=null ? (disclosed.indexOf(x)+1) : '—';
      return `<tr data-c="${x.c}"><td>${rankNo}</td><td>${x.c}</td><td>${pct(x.C)}</td><td>${pct(x.D)}</td><td>${cRank[x.c]||'—'}</td><td>${dRank[x.c]||'—'}</td><td>${x.I!=null?yi(x.I):'—'}</td><td>${x.N!=null?yi(x.N):'—'}</td><td>${stTag}</td></tr>`;
    }).join('');
    tb.querySelectorAll('tbody tr').forEach(tr=>tr.onclick=()=>{
      tb.querySelectorAll('tbody tr').forEach(t=>t.style.background='');
      tr.style.background='#eef3ff'; S.focus=tr.dataset.c;
    });
    renderRankEvo();
  }

  // 所选公司 充足率 vs 行业排名 折线图（按 field 分别画：综合一张、核心一张）
  function renderEvoChart(id,field){
    const c=S.rankEvo;
    const sl=tlSlice();
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const cv=sl.map(k=>{const r=DATA[c][k]; return r? r[field]:null;});
    const col=field==='C'?'#2f6fed':'#16a085';
    const name=field==='C'?'综合充足率':'核心充足率';
    const rank=sl.map(k=>{
      const vals=COMPS.map(x=>{const r=DATA[x][k]; return (r&&r[field]!=null)?r[field]:null;}).filter(v=>v!=null).sort((a,b)=>b-a);
      const my=(DATA[c][k]&&DATA[c][k][field]!=null)?DATA[c][k][field]:null;
      return my==null? null : vals.indexOf(my)+1;
    });
    setOpt(id,{
      title:{text:name+'（蓝） vs '+name.replace('充足率','排名')+'（橙·右轴）',left:0,top:4,textStyle:{fontSize:12,color:'#555',fontWeight:'normal'}},
      tooltip:{trigger:'axis'},
      legend:{data:[name,'行业排名'],top:22},
      grid:{left:50,right:52,top:52,bottom:28},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35,fontSize:10}},
      yAxis:[{type:'value',name:'充足率',axisLabel:{formatter:v=>(v*100).toFixed(0)+'%',fontSize:10},nameTextStyle:{fontSize:10}},
             {type:'value',name:'排名',inverse:true,min:1,max:COMPS.length,axisLabel:{fontSize:10},nameTextStyle:{fontSize:10}}],
      series:[
        {name:name,type:'line',data:cv,symbol:'circle',symbolSize:5,lineStyle:{width:2.5,color:col},itemStyle:{color:col}},
        {name:'行业排名',type:'line',yAxisIndex:1,data:rank,symbol:'circle',symbolSize:5,lineStyle:{width:2,color:'#e67e22',type:'dashed'},itemStyle:{color:'#e67e22'}}
      ]
    });
  }
  function renderRankEvo(){
    const c=S.rankEvo;
    if(!c){
      const emptyOpt={title:{text:'请选择公司',left:'center',top:'middle',textStyle:{color:'#999'}}};
      setOpt('rankEvo',emptyOpt);
      return;
    }
    const field=S.rankMetric;
    renderEvoChart('rankEvo',field);
    const sl=tlSlice();
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const cv=sl.map(k=>{const r=DATA[c][k]; return r? r.C:null;});
    const dv=sl.map(k=>{const r=DATA[c][k]; return r? r.D:null;});
    const cRank=sl.map(k=>{
      const vals=COMPS.map(x=>{const r=DATA[x][k]; return (r&&r.C!=null)?r.C:null;}).filter(v=>v!=null).sort((a,b)=>b-a);
      const my=(DATA[c][k]&&DATA[c][k].C!=null)?DATA[c][k].C:null;
      return my==null? null : vals.indexOf(my)+1;
    });
    const dRank=sl.map(k=>{
      const vals=COMPS.map(x=>{const r=DATA[x][k]; return (r&&r.D!=null)?r.D:null;}).filter(v=>v!=null).sort((a,b)=>b-a);
      const my=(DATA[c][k]&&DATA[c][k].D!=null)?DATA[c][k].D:null;
      return my==null? null : vals.indexOf(my)+1;
    });
    const tb=document.getElementById('rankEvoTable');
    document.getElementById('rankEvoTableHdr').querySelector('thead').innerHTML='<tr><th>报告期</th><th>综合</th><th>核心</th><th>综合排名</th><th>核心排名</th></tr>';
    tb.querySelector('tbody').innerHTML=sl.map((k,i)=>`<tr><td>${labels[i]}</td><td>${pct(cv[i])}</td><td>${pct(dv[i])}</td><td>${cRank[i]!=null?cRank[i]+' / '+COMPS.length:'—'}</td><td>${dRank[i]!=null?dRank[i]+' / '+COMPS.length:'—'}</td></tr>`).join('');
  }

  // ---------- 风险分布 ----------
  function renderDist(){
    const sl=tlSlice();
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const buckets=['<100%','100-150%','150-200%','≥200%','未披露'];
    const counts=buckets.map(()=>sl.map(()=>0));
    sl.forEach((k,si)=>{ COMPS.forEach(c=>{ const st=statusOf(c,k);
      if(st==='nodata'){ counts[4][si]++; return; }
      const v=(DATA[c][k]&&DATA[c][k].C!=null)?DATA[c][k].C:null;
      if(v==null) return; const b=bucketC(v); const bi=buckets.indexOf(b); if(bi>=0&&bi<4)counts[bi][si]++;
    });});
    setOpt('distStack',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'}},
      legend:{data:buckets,top:0},
      grid:{left:45,right:20,top:35,bottom:55},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35}},
      yAxis:{type:'value',name:'公司数',max:COMPS.length},
      series:buckets.map((b,i)=>({name:b,type:'bar',stack:'t',data:counts[i],itemStyle:{color:BUCKET_COL[b]}}))
    });
  }

  // ---------- 风险结构 ----------
  function entityRec(key,isInd){
    if(isInd){
      const o={}; ['O','P','Q','R','S','V','T','U','I','J','K','L','M','N','G','H'].forEach(f=>o[f]=industrySumAt(key,f));
      return o;
    }
    return (S.riskEntity && DATA[S.riskEntity]) ? (DATA[S.riskEntity][key]||{}) : {};
  }

  // ===== 最低资本分解 =====
  const MC_COMP = [
    {f:'P',n:'寿险保险',  c:'#2f6fed',neg:false, sub:'life'},
    {f:'Q',n:'非寿险保险',c:'#16a085',neg:false, sub:'nonlife'},
    {f:'R',n:'市场',      c:'#e67e22',neg:false, sub:'market'},
    {f:'S',n:'信用',      c:'#9b59b6',neg:false, sub:'credit'},
    {f:'T',n:'风险分散效应',c:'#e74c3c',neg:true},
    {f:'U',n:'损失吸收效应',c:'#f1c40f',neg:true},
    {f:'V',n:'控制风险',  c:'#34495e',neg:false},
  ];
  // 最低资本占比时间趋势：所选公司（% of company N）
  function renderRiskCapTrend(){
    const sl=tlSlice();
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const ent=S.riskEntity;
    const getRec=k=>(ent&&DATA[ent])?DATA[ent][k]||{}:{};
    const pctData=MC_COMP.map(c=>
      sl.map(k=>{const r=getRec(k);const N=r.N;return (N!=null&&N!==0&&r[c.f]!=null)?(r[c.f]/N*100):null;})
    );
    const nLine=sl.map(k=>{const r=getRec(k);return r.N!=null?r.N:null;});
    const barSeries=MC_COMP.map((c,i)=>({
      name:c.n,type:'bar',stack:'mc',data:pctData[i],
      itemStyle:{color:c.c},label:{show:false}
    }));
    const lineName = '最低资本合计(N)';
    setOpt('riskCapTrend',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},
        formatter:function(params){
          let h='<b>'+params[0].axisValue+'</b>';
          params.forEach(p=>{
            if(p.seriesType==='line') h+='<br/>'+p.marker+lineName+': '+(p.value!=null?yi(p.value):'—');
            else h+='<br/>'+p.marker+p.seriesName+': '+(p.value!=null?p.value.toFixed(2)+'%':'—');
          });
          return h;
        }
      },
      legend:{data:[...MC_COMP.map(c=>c.n),'最低资本合计(N)'],top:0,type:'plain',textStyle:{fontSize:10},itemWidth:12,itemHeight:9,itemGap:6},
      grid:{left:55,right:65,top:70,bottom:70},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:40,fontSize:10,interval:'auto'}},
      yAxis:[
        {type:'value',name:'占N比例%',axisLabel:{formatter:v=>v.toFixed(0)+'%',fontSize:10},nameTextStyle:{fontSize:11}},
        {type:'value',name:'金额(万元)',axisLabel:{formatter:v=>yi(v),fontSize:10},nameTextStyle:{fontSize:11}}
      ],
      series:[
        ...barSeries,
        {name:lineName,type:'line',data:nLine,yAxisIndex:1,
          symbol:'circle',symbolSize:4,lineStyle:{width:2,color:'#2c3e50'},itemStyle:{color:'#2c3e50'}}
      ]
    });
  }
  // 最低资本占比时间趋势：行业整体（% of industry N）
  function renderRiskCapTrendInd(){
    const sl=tlSlice();
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const pctData=MC_COMP.map(c=>
      sl.map(k=>{const v=industrySumAt(k,c.f);const N=industrySumAt(k,'N');return (N!=null&&N!==0)?(v/N*100):null;})
    );
    const nLine=sl.map(k=>industrySumAt(k,'N'));
    const barSeries=MC_COMP.map((c,i)=>({
      name:c.n,type:'bar',stack:'mc',data:pctData[i],
      itemStyle:{color:c.c},label:{show:false}
    }));
    const lineNameInd = '行业最低资本合计(N)';
    setOpt('riskCapTrendInd',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},
        formatter:function(params){
          let h='<b>'+params[0].axisValue+'</b>';
          params.forEach(p=>{
            if(p.seriesType==='line') h+='<br/>'+p.marker+lineNameInd+': '+(p.value!=null?yi(p.value):'—');
            else h+='<br/>'+p.marker+p.seriesName+': '+(p.value!=null?p.value.toFixed(2)+'%':'—');
          });
          return h;
        }
      },
      legend:{data:[...MC_COMP.map(c=>c.n),'行业最低资本合计(N)'],top:0,type:'plain',textStyle:{fontSize:10},itemWidth:12,itemHeight:9,itemGap:6},
      grid:{left:55,right:65,top:70,bottom:70},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:40,fontSize:10,interval:'auto'}},
      yAxis:[
        {type:'value',name:'占N比例%',axisLabel:{formatter:v=>v.toFixed(0)+'%',fontSize:10},nameTextStyle:{fontSize:11}},
        {type:'value',name:'金额(万元)',axisLabel:{formatter:v=>yi(v),fontSize:10},nameTextStyle:{fontSize:11}}
      ],
      series:[
        ...barSeries,
        {name:lineNameInd,type:'line',data:nLine,yAxisIndex:1,
          symbol:'circle',symbolSize:4,lineStyle:{width:2,color:'#2c3e50'},itemStyle:{color:'#2c3e50'}}
      ]
    });
  }
  // 最低资本：选定报告期 公司 vs 行业 拆解表（金额 + 占比，百分数 2 位小数）+ 子风险下钻
  function renderCapCmp(k){
    const tid='riskCapCmp2';
    const el=document.getElementById(tid); if(!el) return;
    const ent=S.riskEntity;
    if(!ent){ el.innerHTML=''; return; }
    const e=(DATA[ent]&&DATA[ent][k])||{};
    const ind=entityRec(k,true);
    const Ne=e.N||0, Nind=ind.N||0;
    const fmtV=v=>(v==null||isNaN(v))?'<span style="color:#9aa7b5">—</span>':yi(v);
    const pct=(v,t)=>(v!=null&&!isNaN(v)&&t>0)?(v/t*100).toFixed(2)+'%':'—';
    const hasMc = !!(D.segments[S.seg] && D.segments[S.seg].mcDetail);
    const rows=MC_COMP.map((c,ci)=>{
      const v=e[c.f], iV=ind[c.f];
      const hasSub = hasMc && c.sub && MC_CATS[c.sub];
      const arrow = hasSub ? '<span style="cursor:pointer;color:#2f6fed;font-size:11px;margin-right:4px" class="sub-arrow" data-ci="'+ci+'">▶</span>' : '<span style="display:inline-block;width:15px"></span>';
      let html = `<tr style="cursor:${hasSub?'pointer':'default'}" data-row="${ci}"><td>${arrow}${c.n}</td><td class="ar">${fmtV(v)}</td><td class="ar">${pct(v,Ne)}</td>`+
             `<td class="ar">${fmtV(iV)}</td><td class="ar">${pct(iV,Nind)}</td></tr>`;
      if(hasSub){
        const cat=MC_CATS[c.sub];
        const eVals=mcEntityVals(k,cat);
        const iVals=mcIndVals(k,cat);
        const totalVal=e[c.f]||0, totalInd=iV||0;
        const subRows=cat.items.map((it,ii)=>{
          const ev=eVals[ii], iv=iVals[ii];
          return `<tr class="sub-row sub-row-${ci}" style="display:none;background:#f8faff;border-left:3px solid ${c.c};font-size:11.4px">`+
            `<td style="padding-left:28px;color:#5a6a7a">　${it[1]}</td>`+
            `<td class="ar">${fmtV(ev)}</td><td class="ar">${pct(ev,totalVal)}</td>`+
            `<td class="ar">${fmtV(iv)}</td><td class="ar">${pct(iv,totalInd)}</td></tr>`;
        }).join('');
        html += subRows;
      }
      return html;
    }).join('');
    el.innerHTML='<table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr>'+
      '<th>风险构成</th><th class="ar">'+ent+'金额</th><th class="ar">'+ent+'占比</th>'+
      '<th class="ar">行业金额</th><th class="ar">行业占比</th></tr></thead><tbody>'+rows+
      `<tr style="font-weight:700;background:#f7faff"><td>最低资本合计(N)</td>`+
      `<td class="ar">${fmtV(Ne)}</td><td class="ar">100.00%</td>`+
      `<td class="ar">${fmtV(Nind)}</td><td class="ar">100.00%</td></tr></tbody></table>`;
    // 绑定展开/收起
    el.querySelectorAll('.sub-arrow').forEach(a=>{
      a.addEventListener('click',function(ev){
        ev.stopPropagation();
        const ci=this.getAttribute('data-ci');
        const rows=el.querySelectorAll('.sub-row-'+ci);
        const visible=rows[0]&&rows[0].style.display!=='none';
        rows.forEach(r=>r.style.display=visible?'none':'table-row');
        this.textContent=visible?'▶':'▼';
      });
    });
    el.querySelectorAll('tr[data-row]').forEach(tr=>{
      if(!tr.querySelector('.sub-arrow')) return;
      tr.addEventListener('click',function(){
        const ci=this.getAttribute('data-row');
        const arrow=this.querySelector('.sub-arrow');
        if(arrow) arrow.click();
      });
    });
    const tt=document.getElementById('capCmpTitle');
    if(tt) tt.textContent=ent+' vs 行业 · 最低资本拆解（'+KEY2PERIOD[k].label+'）';
  }
  // 最低资本：公司 vs 行业 占比对比（横向分组条形，百分数 2 位小数）
  function renderCapPieCmp(k){
    const ent=S.riskEntity;
    // 子风险模式：根据 mcPieMode 切换父风险按钮组的可见性
    const parentEl=document.getElementById('mcPieParent');
    if(parentEl) parentEl.style.display = (S.mcPieMode==='sub') ? '' : 'none';
    let cats, compData, indData, colors;
    if(S.mcPieMode==='sub'){
      // 子风险下钻：先选一个顶层风险(寿险/非寿/市场/信用)，再展示该顶层下的子项占比
      // 占比分母 = 该顶层风险合计（life→mcP, nonlife→mcQ, market→mcR, credit→mcS）
      const subKey=S.mcPieParent in MC_CATS ? S.mcPieParent : 'market';
      const cat=MC_CATS[subKey];
      if(!cat){ cats=[]; compData=[]; indData=[]; colors=[]; }
      else {
        cats=cat.items.map(it=>it[1]);
        colors=cat.items.map(()=> (MC_COMP.find(c=>c.sub===subKey)||{}).c || '#2f6fed');
        const parentField=MC_AGG[cat.total]; // mcP→P, mcR→R, ...
        if(ent){
          const e=(DATA[ent]&&DATA[ent][k])||{};
          const Ne=parentField?(e[parentField]||0):null;
          const ind=entityRec(k,true);
          const Nind=parentField?(ind[parentField]||0):null;
          const ev=mcEntityVals(k,cat);
          const iv=mcIndVals(k,cat);
          compData=ev.map(v=>(Ne>0 && v!=null)?v/Ne*100:null);
          indData=iv.map(v=>(Nind>0 && v!=null)?v/Nind*100:null);
        } else { compData=cats.map(()=>null); indData=cats.map(()=>null); }
      }
    } else {
      // 顶层视图
      cats=MC_COMP.map(c=>c.n);
      colors=MC_COMP.map(c=>c.c);
      if(ent){
        const e=(DATA[ent]&&DATA[ent][k])||{}; const Ne=e.N||0;
        const ind=entityRec(k,true); const Nind=ind.N||0;
        compData=MC_COMP.map(c=>Ne>0?(e[c.f]/Ne*100):null);
        indData=MC_COMP.map(c=>Nind>0?(ind[c.f]/Nind*100):null);
      } else { compData=MC_COMP.map(()=>null); indData=MC_COMP.map(()=>null); }
    }
    setOpt('riskCapPieCmp',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>v==null?'—':v.toFixed(2)+'%'},
      legend:{data:['公司占比','行业占比'],top:0},
      grid:{left:92,right:30,top:35,bottom:30},
      xAxis:{type:'value',name:'占比%',axisLabel:{formatter:v=>v.toFixed(0)+'%'}},
      yAxis:{type:'category',data:cats,axisLabel:{fontSize:11,interval:0}},
      series:[
        {name:'公司占比',type:'bar',data:compData.map((v,i)=>({value:v,itemStyle:{color:colors[i]}}))},
        {name:'行业占比',type:'bar',data:indData,itemStyle:{color:'#cfd8e3'}}
      ]
    });
  }

  // ===== 实际资本分解 =====
  // 实际资本分解形式配置：tier=四级资本(J/K/L/M)；core=核心·附属(核心=J+K, 附属=L+M)
  function equityCfg(form){
    if(form==='core') return {
      tiers:[['核心资本','核心资本',e=>(e.J||0)+(e.K||0),i=>(i.J||0)+(i.K||0),'#2f6fed'],
             ['附属资本','附属资本',e=>(e.L||0)+(e.M||0),i=>(i.L||0)+(i.M||0),'#e67e22']]
    };
    return {
      tiers:[['J','核心一级',e=>e.J||0,i=>i.J||0,'#27ae60'],
             ['K','核心二级',e=>e.K||0,i=>i.K||0,'#16a085'],
             ['L','附属一级',e=>e.L||0,i=>i.L||0,'#e67e22'],
             ['M','附属二级',e=>e.M||0,i=>i.M||0,'#e74c3c']]
    };
  }
  // 实际资本占比时间趋势：所选公司（% of company I）
  function renderEquityTrendCompany(targetId){
    const tid=targetId||'riskEquityTrend';
    const sl=tlSlice();
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const cfg=equityCfg(S.equityForm);
    const ent=S.riskEntity;
    const series=cfg.tiers.map(t=>({
      name:t[1],type:'line',stack:'ent',
      data:sl.map(k=>{const r=ent&&DATA[ent]&&DATA[ent][k];const I=r&&r.I;return (I>0)?(t[2](r)/I*100):null;}),
      areaStyle:{color:t[4],opacity:0.55},lineStyle:{width:1.5,color:t[4]},symbol:'none',
      tooltip:{formatter:p=>`${t[1]}: ${p.value!=null?p.value.toFixed(2)+'%':'—'}`}
    }));
    setOpt(tid,{
      tooltip:{trigger:'axis',axisPointer:{type:'cross'},
        formatter:function(params){
          if(!params||!params.length) return '';
          let h='<b>'+params[0].axisValue+'</b>';
          for(const p of params){
            if(p.seriesType==='line') h+='<br/>'+p.marker+p.seriesName+': '+(p.value!=null?p.value.toFixed(2)+'%':'—');
          }
          return h;
        }
      },
      legend:{data:cfg.tiers.map(t=>t[1]),top:0},
      grid:{left:55,right:20,top:35,bottom:55},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35}},
      yAxis:{type:'value',name:'占I比例%',max:100,axisLabel:{formatter:v=>v.toFixed(0)+'%'}},
      series
    });
  }
  // 实际资本占比时间趋势：行业整体（% of industry I）
  function renderEquityTrendInd(targetId){
    const tid=targetId||'equityTrendInd';
    const sl=tlSlice();
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const cfg=equityCfg(S.equityForm);
    const series=cfg.tiers.map(t=>({
      name:t[1],type:'line',stack:'ind',
      data:sl.map(k=>{const I=industrySumAt(k,'I');const io={J:industrySumAt(k,'J'),K:industrySumAt(k,'K'),L:industrySumAt(k,'L'),M:industrySumAt(k,'M')};return (I>0)?(t[3](io)/I*100):null;}),
      areaStyle:{color:t[4],opacity:0.55},lineStyle:{width:1.5,color:t[4]},symbol:'none',
      tooltip:{formatter:p=>`${t[1]}: ${p.value!=null?p.value.toFixed(2)+'%':'—'}`}
    }));
    setOpt(tid,{
      tooltip:{trigger:'axis',axisPointer:{type:'cross'},
        formatter:function(params){
          if(!params||!params.length) return '';
          let h='<b>'+params[0].axisValue+'</b>';
          for(const p of params){
            if(p.seriesType==='line') h+='<br/>'+p.marker+p.seriesName+': '+(p.value!=null?p.value.toFixed(2)+'%':'—');
          }
          return h;
        }
      },
      legend:{data:cfg.tiers.map(t=>t[1]),top:0},
      grid:{left:55,right:20,top:35,bottom:55},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35}},
      yAxis:{type:'value',name:'占I比例%',max:100,axisLabel:{formatter:v=>v.toFixed(0)+'%'}},
      series
    });
  }
  // 实际资本：选定报告期 公司 vs 行业 拆解表（金额 + 占比，百分数 2 位小数）
  function renderEquityCmp2(k, targetId){
    const tid=targetId||'riskEquityCmp2';
    const el=document.getElementById(tid); if(!el) return;
    const ent=S.riskEntity;
    if(!ent){ el.innerHTML=''; return; }
    const cfg=equityCfg(S.equityForm);
    const e=(DATA[ent]&&DATA[ent][k])||{};
    const ind=entityRec(k,true);
    const Ie=e.I||0, Iind=ind.I||0;
    const fmtV=v=>(v==null||isNaN(v))?'<span style="color:#9aa7b5">—</span>':yi(v);
    const pct=(v,t)=>(v!=null&&!isNaN(v)&&t>0)?(v/t*100).toFixed(2)+'%':'—';
    const rows=cfg.tiers.map(t=>{
      const v=t[2](e), iV=t[3](ind);
      return `<tr><td>${t[1]}(${t[0]})</td><td class="ar">${fmtV(v)}</td><td class="ar">${pct(v,Ie)}</td>`+
             `<td class="ar">${fmtV(iV)}</td><td class="ar">${pct(iV,Iind)}</td></tr>`;
    }).join('');
    el.innerHTML='<table style="width:100%;font-size:12px"><thead><tr>'+
      '<th>资本层级</th><th class="ar">'+ent+'金额</th><th class="ar">'+ent+'占比</th>'+
      '<th class="ar">行业金额</th><th class="ar">行业占比</th></tr></thead><tbody>'+rows+
      `<tr style="font-weight:700;background:#f7faff"><td>实际资本合计(I)</td>`+
      `<td class="ar">${fmtV(Ie)}</td><td class="ar">100.00%</td>`+
      `<td class="ar">${fmtV(Iind)}</td><td class="ar">100.00%</td></tr></tbody></table>`;
    const tt=document.getElementById('equityCmpTitle');
    if(tt) tt.textContent=ent+' vs 行业 · 实际资本拆解（'+KEY2PERIOD[k].label+'）';
  }
  // 实际资本：公司 vs 行业 占比对比（横向分组条形）
  function renderEquityPieCmp(k, targetId){
    const cfg=equityCfg(S.equityForm);
    const cats=cfg.tiers.map(t=>t[1]);
    const ent=S.riskEntity;
    let compData, indData;
    if(ent){
      const e=(DATA[ent]&&DATA[ent][k])||{}; const Ie=e.I||0;
      const ind=entityRec(k,true); const Iind=ind.I||0;
      compData=cfg.tiers.map(t=>Ie>0?(t[2](e)/Ie*100):null);
      indData=cfg.tiers.map(t=>Iind>0?(t[3](ind)/Iind*100):null);
    } else { compData=cfg.tiers.map(()=>null); indData=cfg.tiers.map(()=>null); }
    setOpt(targetId||'equityPieCmp',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>v==null?'—':v.toFixed(2)+'%'},
      legend:{data:['公司占比','行业占比'],top:0},
      grid:{left:80,right:30,top:35,bottom:30},
      xAxis:{type:'value',name:'占比%',axisLabel:{formatter:v=>v.toFixed(0)+'%'}},
      yAxis:{type:'category',data:cats},
      series:[
        {name:'公司占比',type:'bar',data:compData,itemStyle:{color:'#2f6fed'}},
        {name:'行业占比',type:'bar',data:indData,itemStyle:{color:'#cfd8e3'}}
      ]
    });
  }

  // ===== 核心资本明细拆分（人身险专属，基于 LIFE_CAP_DETAIL）=====
  function renderCoreDetail(k){
    const panel=document.getElementById('lifeCapDetailPanel');
    if(!panel) return;
    // 仅人身险板块显示
    if(S.seg!=='life'){ panel.style.display='none'; return; }
    panel.style.display='';
    if(typeof LIFE_CAP_DETAIL==='undefined'){ panel.innerHTML='<p style="color:#999;padding:20px">明细数据未加载</p>'; return; }

    const LCD=LIFE_CAP_DETAIL;
    const periods=LCD.periods;
    const ent=S.riskEntity;

    // 核心一级子项定义：[短名, 全名, 字段key, 颜色]
    const C1_ITEMS=[
      ['净资产','净资产','net','#2f6fed'],
      ['非认可资产','各项非认可资产的账面价值','adj_nonrec','#e74c3c'],
      ['长期股权投资差额','长期股权投资的认可价值与账面价值的差额','adj_lti','#f39c12'],
      ['投资性房地产增值','投资性房地产公允价值增值','adj_invprop','#9b59b6'],
      ['递延所得税资产','递延所得税资产(经营性亏损除外)','adj_dta','#1abc9c'],
      ['大灾准备金','对农业保险提取的大灾风险准备金','adj_cat','#34495e'],
      ['保单未来盈余','计入核心一级资本的保单未来盈余','adj_fvs','#27ae60'],
      ['负债类工具','符合核心一级标准的负债类资本工具','adj_liab','#e67e22'],
      ['其他调整','银保监会规定的其他调整项目','adj_other','#95a5a6'],
    ];
    // 核心二级子项
    const C2_ITEMS=[
      ['优先股','优先股','c2_pref','#16a085'],
      ['保单未来盈余','计入核心二级资本的保单未来盈余','c2_fvm','#2980b9'],
      ['其他核心二级','其他核心二级资本','c2_oth','#8e44ad'],
      ['减:超限额扣除','减：超限额应扣除的部分','c2_ded','#c0392b'],
    ];

    // ---- 图表：核心资本构成堆叠柱状图（最新期行业汇总 + 所选公司）----
    function sumIndustry(metric, pk){
      let s=0;
      for(const c of LCD.companies){
        const r=LCD.data[c]&&LCD.data[c][pk];
        if(r&&r[metric]!=null) s+=r[metric];
      }
      return s;
    }
    function companyVal(metric, pk){
      if(!ent||!LCD.data[ent]) return null;
      const r=LCD.data[ent][pk];
      return r?r[metric]:null;
    }

    const kIdx=periods.indexOf(k);
    const latestK=kIdx>=0?k:periods[periods.length-1];

    // 占比图已移除：核心二级资本明细绝大多数公司未披露，拆分结果无可分析性（2026-08-05）

    // ---- 表格：核心资本构成（2026Q1）四列：公司金额/公司占比/行业金额/行业占比 ----
    const tk='2026Q1';
    const tblEl=document.getElementById('coreDetailTable');
    const fmtV=v=>(v==null||isNaN(v))?'<span style="color:#9aa7b5">—</span>':yi(v);
    const iC1=sumIndustry('core1',tk), iC2=sumIndustry('core2',tk), iCore=iC1+iC2;
    const cC1=companyVal('core1',tk), cC2=companyVal('core2',tk), cCore=(cC1||0)+(cC2||0);
    const rows=[];
    // 核心一级
    rows.push('<tr style="background:#eaf0fa;font-weight:700"><td colspan="5">核心一级资本</td></tr>');
    for(const item of C1_ITEMS){
      const iv=sumIndustry(item[2],tk);
      const cv=companyVal(item[2],tk);
      rows.push(`<tr><td>${item[1]}</td>`+
        `<td class="ar">${ent?fmtV(cv):'—'}</td>`+
        `<td class="ar">${ent&&cCore&&cv!=null?(cv/cCore*100).toFixed(1)+'%':'—'}</td>`+
        `<td class="ar">${fmtV(iv)}</td>`+
        `<td class="ar">${iCore?(iv/iCore*100).toFixed(1)+'%':'—'}</td></tr>`);
    }
    rows.push(`<tr style="background:#f0f4ff;font-weight:600"><td>核心一级资本合计</td>`+
      `<td class="ar">${ent?fmtV(cC1):'—'}</td>`+
      `<td class="ar">${ent&&cCore&&cC1!=null?(cC1/cCore*100).toFixed(1)+'%':'—'}</td>`+
      `<td class="ar">${fmtV(iC1)}</td>`+
      `<td class="ar">${iCore?(iC1/iCore*100).toFixed(1)+'%':'—'}</td></tr>`);
    // 核心二级
    rows.push('<tr style="background:#e8faf0;font-weight:700"><td colspan="5">核心二级资本</td></tr>');
    for(const item of C2_ITEMS){
      const iv=sumIndustry(item[2],tk);
      const cv=companyVal(item[2],tk);
      rows.push(`<tr><td>${item[1]}</td>`+
        `<td class="ar">${ent?fmtV(cv):'—'}</td>`+
        `<td class="ar">${ent&&cCore&&cv!=null?(cv/cCore*100).toFixed(1)+'%':'—'}</td>`+
        `<td class="ar">${fmtV(iv)}</td>`+
        `<td class="ar">${iCore?(iv/iCore*100).toFixed(1)+'%':'—'}</td></tr>`);
    }
    rows.push(`<tr style="background:#f0fff4;font-weight:600"><td>核心二级资本合计</td>`+
      `<td class="ar">${ent?fmtV(cC2):'—'}</td>`+
      `<td class="ar">${ent&&cCore&&cC2!=null?(cC2/cCore*100).toFixed(1)+'%':'—'}</td>`+
      `<td class="ar">${fmtV(iC2)}</td>`+
      `<td class="ar">${iCore?(iC2/iCore*100).toFixed(1)+'%':'—'}</td></tr>`);
    // 核心资本合计
    rows.push(`<tr style="background:#fff8e1;font-weight:700"><td>核心资本合计（一级+二级）</td>`+
      `<td class="ar">${ent?fmtV(cCore):'—'}</td>`+
      `<td class="ar">100.0%</td>`+
      `<td class="ar">${fmtV(iCore)}</td>`+
      `<td class="ar">100.0%</td></tr>`);

    tblEl.innerHTML='<table style="width:100%;border-collapse:collapse"><thead><tr>'+
      '<th>项目</th>'+
      (ent?`<th class="ar">${ent}金额</th>`:'<th class="ar">公司金额</th>')+
      '<th class="ar">公司占比</th>'+
      '<th class="ar">行业金额</th>'+
      '<th class="ar">行业占比</th>'+
      '</tr></thead><tbody>'+rows.join('')+'</tbody></table>';
  }

  // ===== 净资产占比走势（人身险专属）=====
  function renderNetAssetRatio(){
    const chartEl=document.getElementById('netAssetRatioChart');
    if(!chartEl) return;
    if(S.seg!=='life'||typeof LIFE_CAP_DETAIL==='undefined'){ chartEl.style.display='none'; return; }
    chartEl.style.display='';

    const LCD=LIFE_CAP_DETAIL;
    const periods=LCD.periods;
    const labels=periods.map(p=>{
      const map={'2022Q1':'22Q1','2022Q2':'22Q2','2022Q3':'22Q3','2022Q4':'22Q4',
                '2023Q1':'23Q1','2023Q2':'23Q2','2023Q3':'23Q3','2023Q4':'23Q4',
                '2024Q1':'24Q1','2024Q2':'24Q2','2024Q3':'24Q3','2024Q4':'24Q4',
                '2025Q1':'25Q1','2025Q2':'25Q2','2025Q3':'25Q3','2025Q4':'25Q4',
                '2026Q1':'26Q1'};
      return map[p]||p;
    });

    function sumInd(m){
      let s=0;
      for(const c of LCD.companies){
        const r=LCD.data[c]&&LCD.data[c][m];
        if(r){
          const n=r['net'];const c1=r['core1'];const c2=r['core2'];const tot=r['total'];
          if(n!=null&&c1!=null&&c2!=null&&tot!=null) s+=n;
        }
      }
      return s;
    }

    // 行业整体两条线
    const indRatioCore=periods.map(p=>{
      let netSum=0,coreSum=0,n=0;
      for(const c of LCD.companies){
        const r=LCD.data[c]&&LCD.data[c][p]; if(!r) continue;
        if(r.net!=null&&(r.core1!=null||r.core2!=null)){
          netSum+=r.net; coreSum+=(r.core1||0)+(r.core2||0); n++;
        }
      }
      return coreSum>0?netSum/coreSum*100:null;
    });
    const indRatioAct=periods.map(p=>{
      let netSum=0,totSum=0;
      for(const c of LCD.companies){
        const r=LCD.data[c]&&LCD.data[c][p]; if(!r) continue;
        if(r.net!=null&&r.total!=null){ netSum+=r.net; totSum+=r.total; }
      }
      return totSum>0?netSum/totSum*100:null;
    });

    // 所选公司两条线
    const ent=S.riskEntity;
    const compRatioCore=periods.map(p=>{
      if(!ent||!LCD.data[ent]) return null;
      const r=LCD.data[ent][p]; if(!r) return null;
      const core=(r.core1||0)+(r.core2||0);
      return (r.net!=null&&core>0)?r.net/core*100:null;
    });
    const compRatioAct=periods.map(p=>{
      if(!ent||!LCD.data[ent]) return null;
      const r=LCD.data[ent][p]; if(!r) return null;
      return (r.net!=null&&r.total&&r.total>0)?r.net/r.total*100:null;
    });

    setOpt('netAssetRatioChart',{
      tooltip:{trigger:'axis',axisPointer:{type:'cross'},
        formatter:function(params){
          if(!params||!params.length) return '';
          let h='<b>'+params[0].axisValue+'</b>';
          for(const p of params)
            if(p.seriesType==='line') h+='<br/>'+p.marker+p.seriesName+': '+(p.value!=null?p.value.toFixed(2)+'%':'—');
          return h;
        }
      },
      legend:{data:['行业·净资产/核心资本','行业·净资产/实际资本',(ent||'')+'·净资产/核心资本',(ent||'')+'·净资产/实际资本'].filter(Boolean),top:0,textStyle:{fontSize:10}},
      grid:{left:60,right:60,top:48,bottom:45},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35,fontSize:10}},
      yAxis:[{type:'value',name:'净资产/核心资本 %',min:0,axisLabel:{formatter:v=>v.toFixed(0)+'%'}},
              {type:'value',name:'净资产/实际资本 %',min:0,axisLabel:{formatter:v=>v.toFixed(0)+'%'}}],
      series:[
        {name:'行业·净资产/核心资本',type:'line',data:indRatioCore,smooth:true,itemStyle:{color:'#2f6fed'},lineStyle:{width:2.2},symbol:'circle',symbolSize:4},
        {name:'行业·净资产/实际资本',type:'line',data:indRatioAct,smooth:true,itemStyle:{color:'#16a085'},lineStyle:{width:2.2},symbol:'diamond',symbolSize:4,yAxisIndex:1},
        ...(ent?[{name:ent+'·净资产/核心资本',type:'line',data:compRatioCore,smooth:true,itemStyle:{color:'#e67e22'},lineStyle:{width:2,dashType:[5,3]},symbol:'triangle',symbolSize:5},
               {name:ent+'·净资产/实际资本',type:'line',data:compRatioAct,smooth:true,itemStyle:{color:'#c0392b'},lineStyle:{width:2,dashType:[5,3]},symbol:'triangleSymbol',symbolSize:5,yAxisIndex:1}]:[])
      ]
    });
  }

  function renderRisk(){
    const k=S.riskPeriod;
    const hasMc = !!(D.segments[S.seg] && D.segments[S.seg].mcDetail && Object.keys(D.segments[S.seg].mcDetail).length);
    const panelMC=document.getElementById('capPanelMC');
    const panelEq=document.getElementById('capPanelEquity');
    const emptyCap=document.getElementById('riskCapEmpty');
    const mcCharts=document.getElementById('capMcCharts');
    const showMc = S.capTab==='mc';
    if(panelMC) panelMC.style.display = showMc?'':'none';
    if(panelEq)  panelEq.style.display  = showMc?'none':'';
    if(showMc && !hasMc){
      // 集团：最低资本明细暂缺，仅提示
      if(emptyCap) emptyCap.style.display='block';
      if(mcCharts) mcCharts.style.display='none';
      return;
    }
    if(emptyCap) emptyCap.style.display='none';
    if(mcCharts) mcCharts.style.display='';
    if(showMc){
      // 最低资本分解：行业趋势 + 公司趋势 + 拆解表 + 占比对比
      renderRiskCapTrendInd();
      renderRiskCapTrend();
      renderCapCmp(k);
      renderCapPieCmp(k);
    } else {
      // 实际资本分解：行业趋势 + 公司趋势 + 拆解表 + 占比对比
      renderEquityTrendInd();
      renderEquityTrendCompany();
      renderEquityCmp2(k);
      renderEquityPieCmp(k);
      // 人身险专属：核心资本明细拆分 + 净资产占比
      renderCoreDetail(k);
      renderNetAssetRatio();
    }
  }

  // ---------- 监管预警 ----------
  function renderAlert(){
    const k=S.alertPeriod;
    const rows=COMPS.map(c=>{const r=DATA[c][k]; const st=statusOf(c,k); return {c,r,st};});
    let f=rows;
    if(S.alertFilter==='bad') f=rows.filter(x=>x.st==='bad');
    else if(S.alertFilter==='warn') f=rows.filter(x=>x.st==='warn');
    const tb=document.getElementById('alertTable');
    document.getElementById('alertTableHdr').querySelector('thead').innerHTML='<tr><th>公司</th><th>综合充足率</th><th>核心充足率</th><th>实际资本(亿)</th><th>最低资本(亿)</th><th>状态</th></tr>';
    f.sort((a,b)=>{const av=(a.r&&a.r.C!=null)?a.r.C:99, bv=(b.r&&b.r.C!=null)?b.r.C:99; return av-bv;});
    tb.querySelector('tbody').innerHTML=f.map(x=>{
      let stTag;
      if(x.st==='nodata') stTag='<span class="tag nodata">未披露</span>';
      else if(x.r.C<1.0||x.r.D<0.5) stTag='<span class="tag bad">不达标</span>';
      else if(x.r.C<1.2||x.r.D<0.6) stTag='<span class="tag warn">关注</span>';
      else stTag='<span class="tag ok">达标</span>';
      const cc = x.r&&x.r.C!=null?pct(x.r.C):'—';
      const dd = x.r&&x.r.D!=null?pct(x.r.D):'—';
      const ii = x.r&&x.r.I!=null?yi(x.r.I):'—';
      const nn = x.r&&x.r.N!=null?yi(x.r.N):'—';
      const cCol = x.st==='nodata'?'#7a8aa0':colorFor(x.r.C,1.0);
      const dCol = x.st==='nodata'?'#7a8aa0':colorFor(x.r.D,0.5);
      return `<tr><td>${x.c}</td><td style="color:${cCol};font-weight:600">${cc}</td><td style="color:${dCol};font-weight:600">${dd}</td><td>${ii}</td><td>${nn}</td><td>${stTag}</td></tr>`;
    }).join('');
    const prevK=prevComparable(k);
    if(prevK){
      const drop=COMPS.map(c=>{const r=DATA[c][k],pr=DATA[c][prevK]; if(!r||!pr||r.C==null||pr.C==null) return null; return {c,d:(r.C-pr.C)*100};})
                      .filter(x=>x).sort((a,b)=>a.d-b.d).slice(0,15).reverse();
      setOpt('alertDrop',{
        tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>v.toFixed(1)+'pp'},
        grid:{left:90,right:30,top:15,bottom:30},
        xAxis:{type:'value',axisLabel:{formatter:'{value}pp'}},
        yAxis:{type:'category',data:drop.map(x=>x.c),axisLabel:{fontSize:11}},
        series:[{type:'bar',data:drop.map(x=>({value:x.d,itemStyle:{color:x.d<0?'#e74c3c':'#27ae60'}})),barWidth:'62%',
          label:{show:true,position:'right',formatter:p=>p.value.toFixed(1)}}]
      });
    } else { setOpt('alertDrop',{title:{text:'无上一可比时点',left:'center',top:'middle',textStyle:{color:'#999'}}}); }
  }

  // ---------- 下拉填充 ----------
  function fillSelect(id,keys,labels,def){
    const el=document.getElementById(id); el.innerHTML='';
    keys.forEach((k,i)=>{const o=document.createElement('option');o.value=k;o.text=labels[i];el.appendChild(o);});
    if(def!=null) el.value=def;
  }
  function initSelects(){
    fillSelect('rankPeriod',TL,TL.map(k=>KEY2PERIOD[k].label), TL[TL.length-1]); S.rankPeriod=TL[TL.length-1];
    fillSelect('riskPeriod',TL,TL.map(k=>KEY2PERIOD[k].label), TL[TL.length-1]); S.riskPeriod=TL[TL.length-1];
    fillSelect('alertPeriod',TL,TL.map(k=>KEY2PERIOD[k].label), TL[TL.length-1]); S.alertPeriod=TL[TL.length-1];
    const re=document.getElementById('riskEntity'); re.innerHTML='';
    COMPS.forEach(c=>{const o=document.createElement('option');o.value=c;o.text=c;re.appendChild(o);});
    re.value=S.riskEntity||(COMPS[0]||'');
    const res=document.getElementById('rankEvoSel'); res.innerHTML='';
    COMPS.forEach(c=>{const o=document.createElement('option');o.value=c;o.text=c;res.appendChild(o);});
    const defEvo=S.riskEntity||(COMPS[0]||''); res.value=defEvo; S.rankEvo=defEvo;
  }

  // ---------- 范围下拉 ----------
  function fillRange(){
    const ss=document.getElementById('rangeStart'), se=document.getElementById('rangeEnd');
    ss.innerHTML=''; se.innerHTML='';
    TL.forEach((k,i)=>{const o1=document.createElement('option');o1.value=i;o1.text=KEY2PERIOD[k].label;
      const o2=document.createElement('option');o2.value=i;o2.text=KEY2PERIOD[k].label; ss.appendChild(o1);se.appendChild(o2);});
    ss.value=S.range[0]; se.value=S.range[1];
  }

  function refreshTimeBased(){
    fillRange(); initSelects();
    if(S.seg==='all'){ renderOverview(); return; }
    renderOverview(); renderRank(); renderDist(); renderRisk(); renderAlert(); setTimeout(syncSplitHdr,0);
  }
  function refreshAll(){
    if(S.seg==='all'){ renderOverview(); return; }
    renderOverview(); renderRank(); renderDist(); renderRisk(); renderAlert(); setTimeout(syncSplitHdr,0);
  }

  // ---------- 事件绑定 ----------
  // ---------- 数据管理：导出/导入 JSON + 导出可转发网页 ----------
  function downloadFile(content, filename, mime){
    const blob=new Blob([content],{type:mime||'text/plain;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=filename;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 200);
  }
  function exportDataJson(){
    const obj={ SOLVENCY_DATA, REG_INDUSTRY };
    downloadFile(JSON.stringify(obj,null,1), 'solvency_data.json', 'application/json;charset=utf-8');
    const m=document.getElementById('dataMsg'); if(m) m.textContent='已导出 solvency_data.json（含各公司明细 + 监管披露行业平均数）。';
  }
  function importDataJson(file){
    const reader=new FileReader();
    reader.onload=()=>{
      try{
        const obj=JSON.parse(reader.result);
        if(!obj.SOLVENCY_DATA || !obj.REG_INDUSTRY) throw new Error('文件缺少 SOLVENCY_DATA 或 REG_INDUSTRY');
        SOLVENCY_DATA=obj.SOLVENCY_DATA; REG_INDUSTRY=obj.REG_INDUSTRY;
        D=SOLVENCY_DATA; LAB=D.meta.labels; SEG_NAMES=D.meta.segmentNames;
        // 重置图表实例，避免旧数据残留
        for(const k in charts){ try{charts[k].dispose();}catch(e){} delete charts[k]; }
        loadSeg(S.seg); applySegMode(); refreshTimeBased();
        const m=document.getElementById('dataMsg'); if(m) m.textContent='已导入并更新：共 '+D.segments.property.companies.length+' 家财产险 / '+D.segments.life.companies.length+' 家人身险等数据。可点"导出可转发网页"重新打包转发。';
      }catch(e){
        const m=document.getElementById('dataMsg'); if(m) m.textContent='导入失败：'+e.message;
      }
    };
    reader.readAsText(file);
  }
  function exportStandaloneWeb(){
    const sdS='/*__SOLVENCY_DATA_START__*/', sdE='/*__SOLVENCY_DATA_END__*/';
    const riS='/*__REG_INDUSTRY_START__*/', riE='/*__REG_INDUSTRY_END__*/';
    const html0=document.documentElement.outerHTML;
    if(html0.indexOf(sdS)<0){
      alert('当前页面不是"可转发单文件"。请用 solvency/偿付能力分析平台_可转发.html 打开本页后再点"导出可转发网页"。\n（开发版 index.html 不支持此功能，请把单文件发给你即可。）');
      return;
    }
    const sd=JSON.stringify(SOLVENCY_DATA).replace(/</g,'\\u003c');
    const ri=JSON.stringify(REG_INDUSTRY).replace(/</g,'\\u003c');
    const out=html0
      .replace(new RegExp(sdS+'[\\s\\S]*?'+sdE), sdS+'\nlet SOLVENCY_DATA = '+sd+';\n'+sdE)
      .replace(new RegExp(riS+'[\\s\\S]*?'+riE), riS+'\nlet REG_INDUSTRY = '+ri+';\n'+riE);
    downloadFile('<!DOCTYPE html>\n'+out, '偿付能力分析平台_可转发.html', 'text/html;charset=utf-8');
    const m=document.getElementById('dataMsg'); if(m) m.textContent='已导出"偿付能力分析平台_可转发.html"（含最新数据），可直接发给别人。';
  }
  function openData(){ const mm=document.getElementById('dataMask'); if(mm) mm.style.display='flex'; }
  function closeData(){ const mm=document.getElementById('dataMask'); if(mm) mm.style.display='none'; }
  function bind(){
    document.getElementById('segtabs').querySelectorAll('button[data-seg]').forEach(b=>b.onclick=()=>{
      document.getElementById('segtabs').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      if(b.dataset.seg==='compare'){
        document.getElementById('tabs').style.display='none';
        const ctl=document.querySelector('.controls'); if(ctl) ctl.style.display='none';
        const se=document.getElementById('segExportBtn'); if(se) se.style.display='none';
        const sp=document.getElementById('segExportPeriod'); if(sp) sp.style.display='none';
        document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
        document.getElementById('p-compare').classList.add('on');
        renderCompare();
        setTimeout(()=>{ Object.values(cmpCharts).forEach(c=>c && c.resize()); }, 30);
        return;
      }
      loadSeg(b.dataset.seg); applySegMode(); refreshTimeBased();
    });
    // 行业明细导出按钮（当前板块 + 期次选择）
    const seb = document.getElementById('segExportBtn');
    if(seb) seb.onclick = ()=> {
      const sp = document.getElementById('segExportPeriod');
      const selPeriod = (sp && sp.value && sp.value!=='all') ? sp.value : null;
      exportSegDetail(S.seg, selPeriod);
    };
    // 数据管理（已移除"数据"按钮及浮层）
    document.getElementById('rangeStart').onchange=e=>{S.range[0]=+e.target.value; if(S.range[0]>S.range[1])S.range[1]=S.range[0]; refreshTimeBased();};
    document.getElementById('rangeEnd').onchange=e=>{S.range[1]=+e.target.value; if(S.range[1]<S.range[0])S.range[0]=S.range[1]; refreshTimeBased();};
    document.getElementById('tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{
      document.getElementById('tabs').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
      document.getElementById('p-'+b.dataset.p).classList.add('on');
      setTimeout(()=>Object.values(charts).forEach(c=>c.resize()),30);
    });
    document.getElementById('rankMetric').querySelectorAll('button').forEach(b=>b.onclick=()=>{
      document.getElementById('rankMetric').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on'); S.rankMetric=b.dataset.v; renderRankEvo();
    });
    document.getElementById('rankPeriod').onchange=e=>{S.rankPeriod=e.target.value; renderRank();};
    document.getElementById('rankSearch').oninput=()=>renderRank();
    // 下载汇总CSV（所有期次×全部主体，汇报用）
    const cd=document.getElementById('cmpDownload'); if(cd) cd.onclick=exportCmpCsv;
    const ct=document.getElementById('cmpToggleCap'); if(ct) ct.onclick=()=>{
      cmpCapVisible = !cmpCapVisible;
      const panel = document.getElementById('p-compare');
      panel.classList.toggle('cmp-show-cap', cmpCapVisible);
      ct.textContent = cmpCapVisible ? '隐藏资本明细' : '展开资本明细';
    };
    // 板块子Tab切换
    const cst=document.getElementById('cmpSecTabs'); if(cst) cst.querySelectorAll('button').forEach(b=>b.onclick=()=>{
      cst.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('#cmpSections .cmp-sec').forEach(s=> s.style.display='none');
      const target=document.querySelector('#cmpSections .cmp-sec[data-csec="'+b.dataset.csec+'"]');
      if(target){ target.style.display=''; setTimeout(()=>{ Object.values(cmpCharts).forEach(c=>c && c.resize()); }, 30); }
    });
    // 两期对比期选择器
    document.querySelectorAll('.cmpCmpPk').forEach(sel=> sel.onchange=()=>{
      const sec=sel.dataset.sec, pos=sel.dataset.pos;
      if(!cmpCmpPeriods[sec]) cmpCmpPeriods[sec]={};
      cmpCmpPeriods[sec][pos]=sel.value;
      renderSecCompare(sec);
    });
    document.getElementById('rankEvoSel').onchange=e=>{ S.rankEvo=e.target.value; renderRankEvo(); };
    document.getElementById('riskEntity').onchange=e=>{S.riskEntity=e.target.value; renderRisk();};
    document.getElementById('riskInd').onchange=e=>{S.riskInd=e.target.checked; renderRisk();};
    document.getElementById('riskPeriod').onchange=e=>{S.riskPeriod=e.target.value; renderRisk();};
    document.getElementById('capTab').querySelectorAll('button').forEach(b=>b.onclick=()=>{
      document.getElementById('capTab').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on'); S.capTab=b.dataset.v; renderRisk();
      setTimeout(()=>Object.values(charts).forEach(c=>c.resize()),30);
    });
    document.getElementById('equityForm').querySelectorAll('button').forEach(b=>b.onclick=()=>{
      document.getElementById('equityForm').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on'); S.equityForm=b.dataset.v; renderRisk();
    });
    const mcPieModeEl=document.getElementById('mcPieMode');
    if(mcPieModeEl) mcPieModeEl.querySelectorAll('button').forEach(b=>b.onclick=()=>{
      mcPieModeEl.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on'); S.mcPieMode=b.dataset.v; renderRisk();
    });
    const mcPieParentEl=document.getElementById('mcPieParent');
    if(mcPieParentEl) mcPieParentEl.querySelectorAll('button').forEach(b=>b.onclick=()=>{
      mcPieParentEl.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on'); S.mcPieParent=b.dataset.v; renderRisk();
    });
    document.getElementById('alertPeriod').onchange=e=>{S.alertPeriod=e.target.value; renderAlert();};
    document.getElementById('alertFilter').querySelectorAll('button').forEach(b=>b.onclick=()=>{
      document.getElementById('alertFilter').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on'); S.alertFilter=b.dataset.v; renderAlert();
    });
    // 数据说明全局浮层
    const ao=document.getElementById('aboutOverlay');
    document.getElementById('aboutToggle').onclick=()=>{ao.style.display='block';};
    document.getElementById('aboutClose').onclick=()=>{ao.style.display='none';};
    ao.onclick=e=>{if(e.target===ao)ao.style.display='none';};
    window.addEventListener('resize',()=>Object.values(charts).forEach(c=>c.resize()));
  }

  // ---------- 上市公司及其他主要公司对比 ----------
  function fmtCmp(v, isRatio){
    if(isRatio){
      if(v==null || v==='') return '';
      const n = (typeof v==='number')? v : parseFloat(v);
      if(isNaN(n)) return '';
      return (n*100).toFixed(2) + '%';
    }
    const n = (typeof v==='number')? v : parseFloat(v);
    if(isNaN(n)) return '';
    if(Math.abs(n) >= 1000) return n.toLocaleString('zh-CN',{maximumFractionDigits:2});
    return n.toFixed(2);
  }
  function pctVal(v){ return (v==null)? null : (typeof v==='number'? v*100 : parseFloat(v)*100); }
  const CMP_SECS = ['group','life','property'];
  function cmpHas(obj,k){ return obj && Object.prototype.hasOwnProperty.call(obj,k); }

  // ===== 上市公司对比：数据全部运行时从 data.js / reg_industry.js 计算，不再依赖 Excel 或静态文件 =====
  const CMP_BLOCK_MAP = {'集团':'group','人身险':'life','寿险':'life','财产险':'property','产险':'property'};
  const AGG_BLOCK_TO_CONF = {'集团':'group','寿险':'life','产险':'property'};
  function cmpPeriodToDataKey(p){
    const yy = parseInt(p.slice(0,2),10), q = parseInt(p.slice(3),10);
    const yr = 2000 + yy;
    return (q===4) ? (''+yr) : (yr+'Q'+q);
  }
  // 取 data.js 中某板块某公司的某期记录（处理期次映射）
  function cmpDataRec(segKey, company, period){
    if(typeof SOLVENCY_DATA==='undefined') return null;
    const seg = SOLVENCY_DATA.segments[segKey];
    if(!seg || !seg.data || !seg.data[company]) return null;
    return seg.data[company][cmpPeriodToDataKey(period)] || null;
  }
  // 动态推导所有期次（YYQn 格式），data.js 新增期后自动包含
  let _cmpPeriodsCache = null;
  function cmpPeriods(){
    if(_cmpPeriodsCache) return _cmpPeriodsCache;
    const set = new Set();
    if(typeof SOLVENCY_DATA!=='undefined'){
      ['group','life','property'].forEach(seg=>{
        const d = SOLVENCY_DATA.segments[seg] && SOLVENCY_DATA.segments[seg].data;
        if(!d) return;
        Object.values(d).forEach(coData=>{
          Object.keys(coData).forEach(k=>{
            let yy, q;
            if(k.indexOf('Q')>=0){ yy=parseInt(k.slice(0,4)); q=parseInt(k.slice(5)); }
            else { yy=parseInt(k); q=4; }
            set.add((''+(yy-2000))+'Q'+q);
          });
        });
      });
    }
    _cmpPeriodsCache = Array.from(set).sort();
    return _cmpPeriodsCache;
  }
  // 加权比率（综合=ΣI/ΣN；核心=Σ(J+K)/ΣN），返回比率（小数）
  function cmpWeightedRatio(companies, segKey, period, isCore){
    let ns=0, ds=0;
    companies.forEach(c=>{
      const r = cmpDataRec(segKey, c, period);
      if(!r) return;
      if(isCore){ ns += (r.J||0)+(r.K||0); } else { ns += (r.I||0); }
      ds += (r.N||0);
    });
    return ds>0 ? ns/ds : null;
  }
  // 单公司/加权金额（亿元）
  function cmpAmtAt(segKey, company, period, capMetric){
    const r = cmpDataRec(segKey, company, period);
    if(!r) return null;
    let v;
    if(capMetric==='实际资本') v=r.I;
    else if(capMetric==='核心资本') v=(r.J||0)+(r.K||0);
    else if(capMetric==='附属资本') v=(r.L||0)+(r.M||0);
    else if(capMetric==='最低资本') v=r.N;
    else return null;
    return (v!=null) ? v/10000 : null; // data.js 金额单位：万元 → 亿元
  }
  function cmpWeightedAmt(companies, segKey, period, capMetric){
    let s=0, any=false;
    companies.forEach(c=>{
      const r = cmpDataRec(segKey, c, period);
      if(!r) return;
      let v;
      if(capMetric==='实际资本') v=r.I;
      else if(capMetric==='核心资本') v=(r.J||0)+(r.K||0);
      else if(capMetric==='附属资本') v=(r.L||0)+(r.M||0);
      else if(capMetric==='最低资本') v=r.N;
      else return;
      if(v!=null){ s += v; any=true; }
    });
    return any ? s/10000 : null;
  }
  function entityArr(ent, metric){
    const periods = cmpPeriods();
    const isCore = (metric==='核心偿付能力充足率');
    if(ent.src==='calc_group'){
      const cos = CMP_CONFIG.blocks.group.lists.allForCalc;
      return periods.map(p=> cmpWeightedRatio(cos, 'group', p, isCore));
    }
    if(ent.src==='agg'){
      const confKey = AGG_BLOCK_TO_CONF[ent.block];
      const cos = CMP_CONFIG.blocks[confKey].lists[ent.excl];
      return periods.map(p=> cmpWeightedRatio(cos, CMP_BLOCK_MAP[ent.block], p, isCore));
    }
    if(ent.src==='sun'){
      const segKey = CMP_BLOCK_MAP[ent.block];
      const field = isCore ? 'D' : 'C';
      return periods.map(p=>{ const r=cmpDataRec(segKey, ent.company, p); return (r&&r[field]!=null)?r[field]:null; });
    }
    if(ent.src==='bank'){
      const cos = CMP_CONFIG.blocks.life.lists.banks;
      return periods.map(p=> cmpWeightedRatio(cos, 'life', p, isCore));
    }
    if(ent.src==='reg'){
      if(typeof REG_INDUSTRY==='undefined') return periods.map(()=>null);
      const o = REG_INDUSTRY.data[ent.seg]||{};
      const field = isCore ? 'D' : 'C';
      return periods.map(p=>{ const dk=(p.endsWith('Q4')?'20'+p.slice(0,2):'20'+p); const x=o[dk]; return x? x[field] : null; });
    }
    return periods.map(()=>null);
  }
  function capArr(ent, capMetric){
    const periods = cmpPeriods();
    if(ent.src==='calc_group'){
      const cos = CMP_CONFIG.blocks.group.lists.allForCalc;
      return periods.map(p=> cmpWeightedAmt(cos, 'group', p, capMetric));
    }
    if(ent.src==='agg'){
      const confKey = AGG_BLOCK_TO_CONF[ent.block];
      const cos = CMP_CONFIG.blocks[confKey].lists[ent.excl];
      return periods.map(p=> cmpWeightedAmt(cos, CMP_BLOCK_MAP[ent.block], p, capMetric));
    }
    if(ent.src==='sun'){
      const segKey = CMP_BLOCK_MAP[ent.block];
      return periods.map(p=> cmpAmtAt(segKey, ent.company, p, capMetric));
    }
    if(ent.src==='bank'){
      const cos = CMP_CONFIG.blocks.life.lists.banks;
      return periods.map(p=> cmpWeightedAmt(cos, 'life', p, capMetric));
    }
    return periods.map(()=>null);
  }
  // 单公司比率/金额序列（对象 period->值），供明细表与 CSV 使用
  function cmpCompanyRatioMap(company, segKey, metric){
    const field = (metric==='综合偿付能力充足率')?'C':'D';
    const periods = cmpPeriods(); const o = {};
    periods.forEach(p=>{ const r=cmpDataRec(segKey, company, p); o[p]=(r&&r[field]!=null)?r[field]:null; });
    return o;
  }
  function cmpCompanyAmtMap(company, segKey, capMetric){
    const periods = cmpPeriods(); const o = {};
    periods.forEach(p=>{ o[p]=cmpAmtAt(segKey, company, p, capMetric); });
    return o;
  }
  function cmpBankRatioMap(company, metric){ return cmpCompanyRatioMap(company, 'life', metric); }
  function cmpBankAmtMap(company, capMetric){ return cmpCompanyAmtMap(company, 'life', capMetric); }

  let cmpCharts = {};
  let cmpCapVisible = false;
  let cmpCmpPeriods = {}; // {sec:{A,B}}
  function cmpDisplayPeriods(sec){
    const periods = cmpPeriods();
    return (sec==='group') ? periods.filter(p=> p.endsWith('Q2')||p.endsWith('Q4')) : periods;
  }
  function yearOf(p){ return 2000 + parseInt(p.slice(0,2),10); }
  function qOf(p){ return parseInt(p.slice(3),10); }
  function cmpDefaultPeriods(sec){
    const dp = cmpDisplayPeriods(sec);
    const latest = dp[dp.length-1];
    const ly = yearOf(latest);
    const prev = dp.filter(p=> yearOf(p)===ly-1 && qOf(p)===4)[0] || dp[dp.length-2];
    return { A: latest, B: prev };
  }
  function cmpEntityValAt(ent, metric, p){
    const BL = window.CMP_CONFIG.blocks;
    const i = cmpPeriods().indexOf(p);
    if(i<0) return null;
    const arr = entityArr(ent, metric);
    return arr[i];
  }
  function renderCompare(){
    const BL = window.CMP_CONFIG.blocks;
    document.getElementById('cmpNote').innerHTML =
      '口径：综合充足率 = Σ(实际资本)/Σ(最低资本)；核心充足率 = Σ(核心资本)/Σ(最低资本)（核心资本=核心一级+核心二级）。'
      + '「上市平均」<b>不含阳光系</b>；产险分「含众安 / 不含众安」两口径。'
      + ' 集团加权平均(计算口径)=所有集团公司加权<b>含阳光集团</b>（按半年报披露，仅Q2/Q4有数据，展示时隐藏Q1/Q3）。'
      + ' 监管披露口径为监管直接披露的行业平均（仅充足率，无资本明细）。银保系=9家银行系寿险公司加权。'
      + ' 金额单位：亿元（保留2位小数）。阳光系数值取自对应板块偿付能力表。';
    CMP_SECS.forEach(sec=>{
      // 初始化两期对比的默认期并填充下拉
      if(!cmpCmpPeriods[sec]) cmpCmpPeriods[sec] = cmpDefaultPeriods(sec);
      const dp = cmpDisplayPeriods(sec);
      ['A','B'].forEach(pos=>{
        const sel = document.querySelector('.cmpCmpPk[data-sec="'+sec+'"][data-pos="'+pos+'"]');
        if(sel){
          sel.innerHTML = dp.map(p=>'<option value="'+p+'"'+(p===cmpCmpPeriods[sec][pos]?' selected':'')+'>'+p+'</option>').join('');
        }
      });
      renderSecTrend(sec);
      renderSecCompare(sec);
      renderSecTable(sec);
    });
  }

  function renderSecTrend(sec){
    const BL = window.CMP_CONFIG.blocks;
    const S = BL[sec];
    const displayPeriods = cmpDisplayPeriods(sec);
    const colors = ['#2f6fdb','#16a085','#8e44ad','#c0392b','#e67e22','#f39c12','#7f8c8d','#3498db'];
    const zhMetrics = ['综合偿付能力充足率','核心偿付能力充足率'];
    zhMetrics.forEach((metric, mi)=>{
      const series = [];
      S.entities.forEach((ent, ei)=>{
        const rawArr = entityArr(ent, metric);
        const data = displayPeriods.map(p=>{
          const i = cmpPeriods().indexOf(p);
          const v = (i>=0)? rawArr[i] : null;
          return (v==null)? null : (ent.src==='reg'? v : pctVal(v));
        });
        series.push({
          name: ent.name,
          type:'line',
          smooth:true,
          symbol:'circle', symbolSize:6,
          connectNulls:true,
          data: data,
          lineStyle:{ width:2, color: colors[ei % colors.length] },
          itemStyle:{ color: colors[ei % colors.length] },
          emphasis:{ focus:'series' }
        });
      });
      const chartId = 'cmpTrend_'+sec+'_'+(mi===0?'C':'D');
      const option = {
        tooltip:{ trigger:'axis', valueFormatter:v=> v==null?'—':(v.toFixed(2)+'%') },
        legend:{ type:'scroll', top:2, textStyle:{ fontSize:10 }, itemWidth:14, itemHeight:10 },
        grid:{ left:58, right:22, top:40, bottom:54 },
        xAxis:{ type:'category', data:displayPeriods, axisLabel:{ fontSize:11, rotate: displayPeriods.length>8?30:0 }, boundaryGap:false },
        yAxis:{ type:'value', name:'充足率(%)', min:0, axisLabel:{ formatter:v=> (Math.round(v*10)/10) } },
        dataZoom:[{type:'inside'},{type:'slider', height:14, bottom:18}],
        series
      };
      if(!cmpCharts[chartId]) cmpCharts[chartId] = echarts.init(document.getElementById(chartId));
      cmpCharts[chartId].setOption(option, true);
      cmpCharts[chartId].resize();
    });
  }

  function renderSecCompare(sec){
    const BL = window.CMP_CONFIG.blocks;
    const S = BL[sec];
    const colors = ['#2f6fdb','#16a085','#8e44ad','#c0392b','#e67e22','#f39c12','#7f8c8d','#3498db'];
    const pA = cmpCmpPeriods[sec].A, pB = cmpCmpPeriods[sec].B;
    const zhMetrics = ['综合偿付能力充足率','核心偿付能力充足率'];
    zhMetrics.forEach((metric, mi)=>{
      const names = [], dataA = [], dataB = [];
      S.entities.forEach((ent, ei)=>{
        names.push(ent.name);
        const va = cmpEntityValAt(ent, metric, pA), vb = cmpEntityValAt(ent, metric, pB);
        dataA.push(va==null?null:(ent.src==='reg'?va:pctVal(va)));
        dataB.push(vb==null?null:(ent.src==='reg'?vb:pctVal(vb)));
      });
      // 差异数据（新期-旧期）
      const diffData = dataA.map((v,i)=> (v!=null && dataB[i]!=null) ? +(v - dataB[i]).toFixed(2) : null);
      const barLabel = { show:true, position:'top', fontSize:10, fontWeight:600, color:'#333',
        formatter:p=> p.value!=null ? p.value.toFixed(2) : '' };
      const option = {
        tooltip:{ trigger:'axis', valueFormatter:v=> v==null?'—':(v.toFixed(2)+'%') },
        legend:{ top:2, textStyle:{ fontSize:10 }, data:[pA,pB,'差异'] },
        grid:{ left:58, right:50, top:36, bottom:30 },
        xAxis:{ type:'category', data:names, axisLabel:{ fontSize:10, interval:0, rotate: names.length>4?20:0 } },
        yAxis:[
          { type:'value', name:'充足率(%)', min:0, axisLabel:{ formatter:v=> (Math.round(v*10)/10) } },
          { type:'value', name:'差异(%)', min:null, axisLabel:{ formatter:v=> v.toFixed(1), color:'#c0392b' },
            axisLine:{ lineStyle:{ color:'#c0392b' } }, splitLine:{ show:false } }
        ],
        series:[
          { name:pA, type:'bar', data:dataA, itemStyle:{ color:'#2f6fdb', borderRadius:[3,3,0,0] }, label:barLabel },
          { name:pB, type:'bar', data:dataB, itemStyle:{ color:'#e67e22', borderRadius:[3,3,0,0] }, label:barLabel },
          { name:'差异', type:'line', yAxisIndex:1, data:diffData,
            itemStyle:{ color:'#c0392b' }, symbol:'circle', symbolSize:6,
            lineStyle:{ width:2 },
            label:{ show:true, position:'top', fontSize:9, fontWeight:600, color:'#c0392b',
              formatter:p=> p.value!=null ? ((p.value>=0?'+':'')+p.value.toFixed(2)) : '' }
          }
        ]
      };
      const chartId = 'cmpCmp2_'+sec+'_'+(mi===0?'C':'D');
      if(!cmpCharts[chartId]) cmpCharts[chartId] = echarts.init(document.getElementById(chartId));
      cmpCharts[chartId].setOption(option, true);
      cmpCharts[chartId].resize();
    });
  }

  function renderSecTable(sec){
    const BL = window.CMP_CONFIG.blocks;
    const S = BL[sec];
    const periods = cmpPeriods();
    const displayPeriods = (sec==='group') ? periods.filter(p=> p.endsWith('Q2')||p.endsWith('Q4')) : periods;
    const CAP_METRICS = ['实际资本','核心资本','附属资本','最低资本'];
    const zhMetrics = ['综合偿付能力充足率','核心偿付能力充足率'];
    // 期次倒序：最新期(如26Q1)放第一列
    const revPeriods = [...displayPeriods].reverse();

    let h = '<div class="cmp-table"><table><thead><tr><th>主体</th>';
    revPeriods.forEach(p=> h += '<th>'+p+'</th>');
    h += '</tr></thead><tbody>';

    // 公司列表（去重阳光系，避免与 entities 中汇总行重复）
    const allCompanies = [...S.companies];
    if(sec==='life') allCompanies.push(...CMP_CONFIG.blocks.life.lists.banks.map(n=>({name:n,isBank:true})));
    const entityCompanyNames = new Set(S.entities.filter(e=>e.company).map(e=>e.company));
    const filteredCompanies = allCompanies.filter(item=>{
      const c = item.name || item;
      return !entityCompanyNames.has(c);
    });

    // 综合放一起、核心放一起（每段输出指标名标题行）
    zhMetrics.forEach((metric, mi) => {
      h += '<tr class="blk"><td colspan="'+(revPeriods.length+1)+'">'+metric+'</td></tr>';

      // 实体行（含资本子行）
      S.entities.forEach(ent=>{
        const arr = entityArr(ent, metric);
        const isRegPct = (ent.src==='reg');
        const dispArr = (sec==='group')
          ? arr.filter((v,i)=> periods[i].endsWith('Q2')||periods[i].endsWith('Q4')).reverse()
          : [...arr].reverse();
        h += '<tr class="agg"><td>'+ent.name+'</td>';
        dispArr.forEach(v=> {
          if(v==null){ h+='<td></td>'; return; }
          h += '<td>'+(isRegPct ? (parseFloat(v).toFixed(2)+'%') : fmtCmp(v,true))+'</td>';
        });
        h += '</tr>';
        if(ent.src!=='reg'){
          CAP_METRICS.forEach(cmName=>{
            const cArr = capArr(ent, cmName);
            const dispCArr = (sec==='group')
              ? cArr.filter((v,i)=> periods[i].endsWith('Q2')||periods[i].endsWith('Q4')).reverse()
              : [...cArr].reverse();
            h += '<tr class="sub"><td style="padding-left:22px;color:var(--sub);font-size:12px">└ '+cmName+'(亿元)</td>';
            dispCArr.forEach(v=> h += '<td>'+(v==null?'':fmtCmp(v,false))+'</td>');
            h += '</tr>';
          });
        }
      });

      // 公司明细行（含资本子行）
      filteredCompanies.forEach(item=>{
        const c = item.name || item;
        const isBank = item.isBank || false;
        const cls = (c.indexOf('阳光')>=0) ? 'sun' : (isBank ? 'bank' : '');
        const rVals = isBank
          ? cmpBankRatioMap(c, metric)
          : cmpCompanyRatioMap(c, S.dataBlock, metric);
        const rawVals = periods.map(p=> rVals[p]);
        const dispVals = (sec==='group')
          ? rawVals.filter((v,i)=> periods[i].endsWith('Q2')||periods[i].endsWith('Q4')).reverse()
          : [...rawVals].reverse();
        h += '<tr class="'+cls+'"><td>'+c+'</td>';
        dispVals.forEach(v=> h += '<td>'+(v==null?'':fmtCmp(v,true))+'</td>');
        h += '</tr>';
        CAP_METRICS.forEach(cmName=>{
          const cVals = isBank
            ? cmpBankAmtMap(c, cmName)
            : cmpCompanyAmtMap(c, S.dataBlock, cmName);
          const rawCVals = periods.map(p=> cVals[p]);
          const dispCVals = (sec==='group')
            ? rawCVals.filter((v,i)=> periods[i].endsWith('Q2')||periods[i].endsWith('Q4')).reverse()
            : [...rawCVals].reverse();
          h += '<tr class="sub'+(cls?' '+cls:'')+'"><td style="padding-left:22px;color:var(--sub);font-size:12px">└ '+cmName+'(亿元)</td>';
          dispCVals.forEach(v=> h += '<td>'+(v==null?'':fmtCmp(v,false))+'</td>');
          h += '</tr>';
        });
      });
    });

    h += '</tbody></table></div>';
    document.getElementById('cmpDetail_'+sec).innerHTML = h;
  }

  // 下载汇总CSV：格式与"上市公司及其他主要公司对比.xlsx"完全一致
  // 结构：每个指标段(综合/核心/实际资本/核心资本/附属资本/最低资本)一行表头，
  // 下接 集团/寿险/产险 板块的公司明细行 + 上市公司平均(合计)行；最后附银行系(仅综合/核心)。
  function exportCmpCsv(){
    const BL = window.CMP_CONFIG.blocks;
    const periods = cmpPeriods();
    let s = '\ufeff';
    // 充足率比率：保留6位小数(去除浮点噪声)，与Excel一致；资本(亿元)：2位
    function num(v){ return (v==null||!isFinite(v)) ? '' : (+v.toFixed(6)).toString(); }
    function numC(v){ return (v==null||!isFinite(v)) ? '' : v.toFixed(2); }

    function entRatio(sec, entName, metric, p){
      const ent = BL[sec].entities.find(e=>e.name===entName); if(!ent) return '';
      const arr = entityArr(ent, metric); const i = cmpPeriods().indexOf(p);
      return num(i>=0 ? arr[i] : null);
    }
    function entCap(sec, entName, capMetric, p){
      const ent = BL[sec].entities.find(e=>e.name===entName); if(!ent) return '';
      const arr = capArr(ent, capMetric); const i = cmpPeriods().indexOf(p);
      return numC(i>=0 ? arr[i] : null);
    }
    function compRatio(block, company, metric, p){
      return num(cmpCompanyRatioMap(company, block, metric)[p]);
    }
    function compCap(company, block, capMetric, p){
      return numC(cmpCompanyAmtMap(company, block, capMetric)[p]);
    }

    const METRICS = [
      { name:'综合偿付能力充足率', cap:false },
      { name:'核心偿付能力充足率', cap:false },
      { name:'实际资本', cap:true },
      { name:'核心资本', cap:true },
      { name:'附属资本', cap:true },
      { name:'最低资本', cap:true }
    ];
    function emitBlock(sec, label, companyList, avgRows){
      companyList.forEach((c,i)=>{
        const a = (i===0)?label:'';
        const vals = periods.map(p=> avgRowCap[sec] ? compCap(c,sec,METRICS_CUR, p) : compRatio(sec,c,METRICS_CUR, p));
        s += a + ',' + c + ',' + vals.join(',') + '\n';
      });
      avgRows.forEach(ar=>{
        const vals = periods.map(p=> avgRowCap[sec] ? entCap(sec, ar.ent, METRICS_CUR, p) : entRatio(sec, ar.ent, METRICS_CUR, p));
        s += ar.label + ',,' + vals.join(',') + '\n';
      });
    }
    let METRICS_CUR, avgRowCap = {};
    METRICS.forEach(def=>{
      METRICS_CUR = def.name; avgRowCap = {};
      const cap = def.cap;
      s += def.name + ',主体,' + periods.join(',') + '\n';
      // 集团
      avgRowCap.group = cap;
      emitBlock('group', '集团', BL.group.companies,
        [{ label:'上市公司'+(cap?'合计':'平均'), ent:'上市集团加权平均' }]);
      // 寿险
      avgRowCap.life = cap;
      emitBlock('life', '寿险', BL.life.companies,
        [{ label:'上市公司'+(cap?'合计':'平均'), ent:'上市人身险公司平均' }]);
      // 产险
      avgRowCap.property = cap;
      emitBlock('property', '产险', BL.property.companies, cap ? [
        { label:'上市公司合计-含众安', ent:'上市财险平均(含众安)' },
        { label:'上市公司合计-不含众安', ent:'上市财险平均(不含众安)' }
      ] : [
        { label:'上市公司平均-含众安', ent:'上市财险平均(含众安)' },
        { label:'上市公司平均-不含众安', ent:'上市财险平均(不含众安)' }
      ]);
    });

    // 银行系（仅综合/核心）
    const banks = BL.life.lists.banks;
    ['综合偿付能力充足率','核心偿付能力充足率'].forEach(metric=>{
      METRICS_CUR = metric;
      s += metric + ',主体,' + periods.join(',') + '\n';
      banks.forEach((c,i)=>{
        const a = (i===0)?'银行系主要公司':'';
        const vals = periods.map(p=> compRatio('life', c, metric, p));
        s += a + ',' + c + ',' + vals.join(',') + '\n';
      });
      const bankEnt = BL.life.entities.find(e=>e.name==='银保系平均');
      const arr = entityArr(bankEnt, metric);
      s += '银行系公司合计,,' + periods.map((p,k)=> num(arr[k])).join(',') + '\n';
    });

    const blob = new Blob([s], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = '上市公司及其他主要公司对比.csv'; a.click();
  }

  // 填充导出期次下拉（全部期间 + 各期次）
  function populateSegExportPeriods(segKey){
    const sel = document.getElementById('segExportPeriod');
    if(!sel) return;
    const seg = (typeof SOLVENCY_DATA!=='undefined') && SOLVENCY_DATA.segments[segKey];
    if(!seg){ sel.style.display='none'; return; }
    const opts = ['<option value="all">全部期间</option>'];
    seg.periods.forEach(pd=>{
      const label = (pd.q===4) ? ((pd.year-2000)+'Q4') : ((pd.year-2000)+'Q'+pd.q);
      opts.push('<option value="'+label+'">'+label+'</option>');
    });
    sel.innerHTML = opts.join('');
    sel.style.display = '';
  }

  // 导出某板块（集团/财产险/人身险/再保险）的行业明细原始数据
  // period: null=全部期间, 否则如'26Q1'
  function exportSegDetail(segKey, period){
    if(typeof SOLVENCY_DATA==='undefined'){ alert('数据未加载'); return; }
    const seg = SOLVENCY_DATA.segments[segKey];
    if(!seg){ alert('未知板块：'+segKey); return; }
    const NAMES = { group:'保险集团', property:'财产险', life:'人身险', reins:'再保险' };
    const cols = ['C','D','I','J','K','L','M','N'];
    const colHdr = ['综合C','核心D','实际资本I(万元)','核心一级J(万元)','核心二级K(万元)','附属一级L(万元)','附属二级M(万元)','最低资本N(万元)'];
    // 期次列表（保持 data.js 顺序），year-end 映射为 YYQ4
    let perRows = seg.periods.map(pd=>{
      const label = (pd.q===4) ? ((pd.year-2000)+'Q4') : ((pd.year-2000)+'Q'+pd.q);
      return { key: pd.key, label: label };
    });
    // 指定期次则只导出该期
    if(period){
      perRows = perRows.filter(pr => pr.label === period);
    }
    const periodSuffix = period ? ('_'+period) : '';
    let s = '\ufeff' + (NAMES[segKey]||segKey) + ' · 行业明细（C/D为比率，I~N为万元）\n';
    // 表头：公司 + 每期 8 列
    s += '公司';
    perRows.forEach(pr=>{ colHdr.forEach(h=>{ s += ','+pr.label+'-'+h; }); });
    s += '\n';
    seg.companies.forEach(co=>{
      const rec = seg.data[co] || {};
      s += co;
      perRows.forEach(pr=>{
        const r = rec[pr.key];
        if(!r){ colHdr.forEach(()=>{ s += ','; }); }
        else { cols.forEach(c=>{ s += ',' + (r[c]!=null ? r[c] : ''); }); }
      });
      s += '\n';
    });
    const blob = new Blob([s], {type:'text/csv;charset=utf-8'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = (NAMES[segKey]||segKey) + '_行业明细' + periodSuffix + '.csv'; a.click();
  }
  // ---------- 分离表头列宽同步 ----------
  function syncSplitHdr(){
    document.querySelectorAll('.split-table').forEach(function(container){
      var hdrTbl=container.querySelector('.split-hdr table');
      var bodyTbl=container.querySelector('.scroll table');
      if(!hdrTbl||!bodyTbl) return;
      var hdrThs=hdrTbl.querySelectorAll('th');
      var bodyTd=bodyTbl.querySelector('tbody tr');
      if(!bodyTd||!hdrThs.length) return;
      var bodyTds=bodyTd.querySelectorAll('td');
      for(var i=0;i<hdrThs.length&&i<bodyTds.length;i++){
        var w=bodyTds[i].getBoundingClientRect().width;
        hdrThs[i].style.width=Math.round(w)+'px';
      }
    });
  }
  window.addEventListener('resize', syncSplitHdr);

  // ---------- 启动 ----------
  function applySegMode(){
    const allMode = S.seg==='all';
    const cmpMode = S.seg==='compare';
    const tabs=document.getElementById('tabs'); if(tabs) tabs.style.display = (allMode || cmpMode) ? 'none' : '';
    const os=document.getElementById('overviewSingle'); if(os) os.style.display = allMode ? 'none' : '';
    const oa=document.getElementById('overviewAll'); if(oa) oa.style.display = allMode ? '' : 'none';
    const ctl=document.querySelector('.controls'); if(ctl) ctl.style.display = (allMode || cmpMode) ? 'none' : '';
    const se=document.getElementById('segExportBtn'); if(se) se.style.display = (allMode || cmpMode) ? 'none' : '';
    const sp=document.getElementById('segExportPeriod'); if(sp){
      sp.style.display = (allMode || cmpMode) ? 'none' : '';
      if(!allMode && !cmpMode){ populateSegExportPeriods(S.seg); }
    }
    if(allMode){
      document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
      const po=document.getElementById('p-overview'); if(po) po.classList.add('on');
    } else if(cmpMode){
      // compare 模式：segtab 处理器已设置 p-compare 为 on
    } else {
      // 主面板（集团/财产险/人身险/再保险）：恢复当前激活子面板
      document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
      const activeTab = document.querySelector('#tabs button.on');
      const pId = (activeTab && activeTab.dataset.p) ? ('p-'+activeTab.dataset.p) : 'p-overview';
      const panel = document.getElementById(pId);
      if(panel) panel.classList.add('on'); else { const po=document.getElementById('p-overview'); if(po) po.classList.add('on'); }
    }
  }
  function start(){
    loadSeg(S.seg);
    document.getElementById('segtabs').querySelectorAll('button').forEach(b=>{
      b.classList.toggle('on', b.dataset.seg===S.seg);
    });
    applySegMode();
    bind(); refreshTimeBased();
  }
  if(document.readyState!=='loading') start(); else document.addEventListener('DOMContentLoaded',start);
  // 资源（CSS/字体/图片）加载完成后统一 resize 一次，兜底首次布局时序导致的 0 宽空白
  window.addEventListener('load', ()=>{ for(const k in charts){ if(charts[k]) charts[k].resize(); } });
})();
