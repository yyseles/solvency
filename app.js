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
      kpi('风险公司数',risk+' 家', `综合<100% 或 核心<50%（不达标），含未披露 ${nodata} 家`, risk===0?'#27ae60':'#e74c3c'),
    ].join('');
    trendLineChart('ovC','C',sl,1.0);
    trendLineChart('ovD','D',sl,0.5);
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const rates=sl.map(k=>{let c=0,d=0;for(const cc of COMPS){const st=statusOf(cc,k);if(st==='ok')c++;else if(st==='bad')d++;}const disc=c+d;return disc?+(c/disc*100).toFixed(1):0;});
    const bads=sl.map(k=>{let b=0;for(const cc of COMPS){const st=statusOf(cc,k); if(st==='bad'||st==='nodata')b++;}return b;});
    setOpt('ovComp',{
      tooltip:{trigger:'axis'}, legend:{data:['达标率%','风险公司数'],top:0},
      grid:{left:50,right:55,top:35,bottom:30},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35}},
      yAxis:[{type:'value',name:'达标率%',max:100,min:0},{type:'value',name:'家',min:0}],
      series:[
        {name:'达标率%',type:'line',smooth:true,data:rates,areaStyle:{opacity:.12},itemStyle:{color:'#27ae60'},lineStyle:{width:2.5}},
        {name:'风险公司数',type:'bar',yAxisIndex:1,data:bads,itemStyle:{color:'#e74c3c',opacity:.7}}
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
    const box=document.getElementById('overviewAll');
    // 先释放旧图表实例，避免 innerHTML 重建后实例仍绑定到已移除的旧 DOM（导致切换回此 tab 时图不显示）
    ['allBarC','allBarD'].forEach(id=>{ if(charts[id]){ try{charts[id].dispose();}catch(e){} charts[id]=null; } });
    box.innerHTML =
      '<div class="hint" style="margin-bottom:14px">以下为各细分板块最新报告期的行业偿付能力概览。计算加权口径为本平台基于个体披露自算（综合=Σ实际资本/Σ最低资本，核心=Σ核心资本/Σ最低资本）；监管披露口径为金融监管总局直接披露（集团暂无监管披露口径，以「—」表示）。</div>'+
      '<div class="card"><h3>各板块最新偿付能力概览</h3>'+
        '<table class="split-table" style="border-radius:10px;overflow:hidden">'+
          '<thead><tr><th>板块</th><th>最新期</th><th>综合(加权)</th><th>综合(监管)</th><th>核心(加权)</th><th>核心(监管)</th><th>样本数</th><th>达标率</th></tr></thead>'+
          '<tbody>'+rows.map(r=>`<tr>`+
            `<td style="text-align:left;font-weight:600">${r.name}</td>`+
            `<td>${r.label}</td>`+
            `<td style="color:${colorFor(r.wC,1.0)};font-weight:600">${pct(r.wC)}</td>`+
            `<td>${r.reg?regPct(r.reg.C):'—'}</td>`+
            `<td style="color:${colorFor(r.wD,0.5)};font-weight:600">${pct(r.wD)}</td>`+
            `<td>${r.reg?regPct(r.reg.D):'—'}</td>`+
            `<td>${r.n} 家</td>`+
            `<td>${(r.rate*100).toFixed(1)}%</td>`+
          `</tr>`).join('')+'</tbody>'+
        '</table>'+
      '</div>'+
      '<div class="grid2">'+
        '<div class="card"><h3>各板块综合偿付能力充足率对比</h3>'+
          '<div id="allBarC" class="chart" style="height:340px"></div></div>'+
        '<div class="card"><h3>各板块核心偿付能力充足率对比</h3>'+
          '<div id="allBarD" class="chart" style="height:340px"></div></div>'+
      '</div>';
    setOpt('allBarC',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>(v==null?'-':(v*100).toFixed(1)+'%')},
      legend:{data:['综合(加权)','综合(监管)'],top:0},
      grid:{left:55,right:30,top:35,bottom:30},
      xAxis:{type:'category',data:rows.map(r=>r.name)},
      yAxis:{type:'value',name:'充足率%',axisLabel:{formatter:v=>v+'%'}},
      series:[
        {name:'综合(加权)',type:'bar',data:rows.map(r=>r.wC!=null?+(r.wC*100).toFixed(1):null),itemStyle:{color:'#2f6fed'}},
        {name:'综合(监管)',type:'bar',data:rows.map(r=>r.reg?+r.reg.C.toFixed(1):null),itemStyle:{color:'#e67e22'}}
      ]
    });
    setOpt('allBarD',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>(v==null?'-':(v*100).toFixed(1)+'%')},
      legend:{data:['核心(加权)','核心(监管)'],top:0},
      grid:{left:55,right:30,top:35,bottom:30},
      xAxis:{type:'category',data:rows.map(r=>r.name)},
      yAxis:{type:'value',name:'充足率%',axisLabel:{formatter:v=>v+'%'}},
      series:[
        {name:'核心(加权)',type:'bar',data:rows.map(r=>r.wD!=null?+(r.wD*100).toFixed(1):null),itemStyle:{color:'#16a085'}},
        {name:'核心(监管)',type:'bar',data:rows.map(r=>r.reg?+r.reg.D.toFixed(1):null),itemStyle:{color:'#f1c40f'}}
      ]
    });
    setTimeout(()=>{ if(charts.allBarC) charts.allBarC.resize(); },30);
    setTimeout(()=>{ if(charts.allBarD) charts.allBarD.resize(); },30);
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
    const k=S.rankPeriod, field=S.rankMetric;
    const all=COMPS.map(c=>{const r=DATA[c][k]; const st=statusOf(c,k);
      return {c, v:(st==='nodata')?null:(r?r[field]:null), C:r?r.C:null, D:r?r.D:null, I:r?r.I:null, N:r?r.N:null, st};});
    const disclosed=all.filter(x=>x.v!=null).sort((a,b)=>b.v-a.v);
    const nodata=all.filter(x=>x.st==='nodata').sort((a,b)=>a.c.localeCompare(b.c));
    const rows=disclosed.concat(nodata);
    const cats=disclosed.map(x=>x.c), vals=disclosed.map(x=>x.v);
    const colors=disclosed.map(x=> x.v< pctLine(field)?'#e74c3c':(x.v< pctLine(field)*1.5?'#e67e22':'#27ae60'));
    setOpt('rankBar',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>(v*100).toFixed(1)+'%'},
      grid:{left:110,right:40,top:10,bottom:30},
      xAxis:{type:'value',axisLabel:{formatter:v=>(v*100).toFixed(0)+'%'}},
      yAxis:{type:'category',data:cats,axisLabel:{fontSize:10},inverse:true},
      dataZoom:[{type:'slider',yAxisIndex:0,right:6,width:14,start:0,end:40}],
      series:[{type:'bar',data:vals.map((v,i)=>({value:v,itemStyle:{color:colors[i]}})),barWidth:'70%'}]
    });
    const tb=document.getElementById('rankTable');
    document.getElementById('rankTableHdr').querySelector('thead').innerHTML='<tr><th>排名</th><th>公司</th><th>综合充足率</th><th>核心充足率</th><th>实际资本(亿)</th><th>最低资本(亿)</th><th>状态</th></tr>';
    const q=document.getElementById('rankSearch').value.trim();
    const frows=rows.filter(x=>!q||x.c.includes(q));
    tb.querySelector('tbody').innerHTML=frows.map(x=>{
      let stTag;
      if(x.st==='nodata') stTag='<span class="tag nodata">未披露</span>';
      else if(x.C<1.0||x.D<0.5) stTag='<span class="tag bad">不达标</span>';
      else if(x.C<1.2||x.D<0.6) stTag='<span class="tag warn">关注</span>';
      else stTag='<span class="tag ok">达标</span>';
      const rankNo = x.v!=null ? (disclosed.indexOf(x)+1) : '—';
      return `<tr data-c="${x.c}"><td>${rankNo}</td><td>${x.c}</td><td>${pct(x.C)}</td><td>${pct(x.D)}</td><td>${x.I!=null?yi(x.I):'—'}</td><td>${x.N!=null?yi(x.N):'—'}</td><td>${stTag}</td></tr>`;
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
      tooltip:{trigger:'axis'},
      legend:{data:[name,'行业排名'],top:0},
      grid:{left:50,right:52,top:28,bottom:28},
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
      setOpt('rankEvoC',{title:{text:'请选择公司',left:'center',top:'middle',textStyle:{color:'#999'}}});
      setOpt('rankEvoD',{title:{text:'请选择公司',left:'center',top:'middle',textStyle:{color:'#999'}}});
      return;
    }
    renderEvoChart('rankEvoC','C');   // 综合充足率 + 综合排名
    renderEvoChart('rankEvoD','D');   // 核心充足率 + 核心排名
    const field=S.rankMetric;
    const sl=tlSlice();
    const labels=sl.map(k=>KEY2PERIOD[k].label);
    const cv=sl.map(k=>{const r=DATA[c][k]; return r? r.C:null;});
    const dv=sl.map(k=>{const r=DATA[c][k]; return r? r.D:null;});
    const rank=sl.map(k=>{
      const vals=COMPS.map(x=>{const r=DATA[x][k]; return (r&&r[field]!=null)?r[field]:null;}).filter(v=>v!=null).sort((a,b)=>b-a);
      const my=(DATA[c][k]&&DATA[c][k][field]!=null)?DATA[c][k][field]:null;
      return my==null? null : vals.indexOf(my)+1;
    });
    const tb=document.getElementById('rankEvoTable');
    document.getElementById('rankEvoTableHdr').querySelector('thead').innerHTML='<tr><th>报告期</th><th>综合</th><th>核心</th><th>排名</th></tr>';
    tb.querySelector('tbody').innerHTML=sl.map((k,i)=>`<tr><td>${labels[i]}</td><td>${pct(cv[i])}</td><td>${pct(dv[i])}</td><td>${rank[i]!=null?rank[i]+' / '+COMPS.length:'—'}</td></tr>`).join('');
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
      legend:{data:[...MC_COMP.map(c=>c.n),'最低资本合计(N)'],top:0,type:'scroll',textStyle:{fontSize:11}},
      grid:{left:50,right:55,top:42,bottom:55},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35}},
      yAxis:[
        {type:'value',name:'占N比例%',axisLabel:{formatter:v=>v.toFixed(0)+'%'}},
        {type:'value',name:'金额',axisLabel:{formatter:v=>yi(v)}}
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
      legend:{data:[...MC_COMP.map(c=>c.n),'行业最低资本合计(N)'],top:0,type:'scroll',textStyle:{fontSize:11}},
      grid:{left:50,right:55,top:42,bottom:55},
      xAxis:{type:'category',data:labels,axisLabel:{rotate:35}},
      yAxis:[
        {type:'value',name:'占N比例%',axisLabel:{formatter:v=>v.toFixed(0)+'%'}},
        {type:'value',name:'金额',axisLabel:{formatter:v=>yi(v)}}
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
    const cats=MC_COMP.map(c=>c.n);
    const ent=S.riskEntity;
    let compData, indData;
    if(ent){
      const e=(DATA[ent]&&DATA[ent][k])||{}; const Ne=e.N||0;
      const ind=entityRec(k,true); const Nind=ind.N||0;
      compData=MC_COMP.map(c=>Ne>0?(e[c.f]/Ne*100):null);
      indData=MC_COMP.map(c=>Nind>0?(ind[c.f]/Nind*100):null);
    } else { compData=MC_COMP.map(()=>null); indData=MC_COMP.map(()=>null); }
    setOpt('riskCapPieCmp',{
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:v=>v==null?'—':v.toFixed(2)+'%'},
      legend:{data:['公司占比','行业占比'],top:0},
      grid:{left:92,right:30,top:35,bottom:30},
      xAxis:{type:'value',name:'占比%',axisLabel:{formatter:v=>v.toFixed(0)+'%'}},
      yAxis:{type:'category',data:cats},
      series:[
        {name:'公司占比',type:'bar',data:compData,itemStyle:{color:'#2f6fed'}},
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
      b.classList.add('on'); loadSeg(b.dataset.seg); applySegMode(); refreshTimeBased();
    });
    // 数据管理
    const db=document.getElementById('dataBtn'); if(db) db.onclick=openData;
    const dc=document.getElementById('dataClose'); if(dc) dc.onclick=closeData;
    const dm=document.getElementById('dataMask'); if(dm) dm.onclick=e=>{ if(e.target===dm) closeData(); };
    const ed=document.getElementById('btnExportData'); if(ed) ed.onclick=exportDataJson;
    const ew=document.getElementById('btnExportWeb'); if(ew) ew.onclick=exportStandaloneWeb;
    const fi=document.getElementById('fileData'); if(fi) fi.onchange=e=>{ if(e.target.files[0]) importDataJson(e.target.files[0]); e.target.value=''; };
    const di=document.getElementById('btnImportData'); if(di) di.onclick=()=>{ const f=document.getElementById('fileData'); if(f) f.click(); };
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
      b.classList.add('on'); S.rankMetric=b.dataset.v; renderRank();
    });
    document.getElementById('rankPeriod').onchange=e=>{S.rankPeriod=e.target.value; renderRank();};
    document.getElementById('rankSearch').oninput=()=>renderRank();
    document.getElementById('expCsv').onclick=exportRankCsv;
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
  function exportRankCsv(){
    const k=S.rankPeriod, field=S.rankMetric;
    const rows=COMPS.map(c=>{const r=DATA[c][k];const st=statusOf(c,k);return {c,r,st};})
      .sort((a,b)=>{const av=(a.r&&a.r[field]!=null)?a.r[field]:-1, bv=(b.r&&b.r[field]!=null)?b.r[field]:-1; return bv-av;});
    let s='排名,公司,综合充足率,核心充足率,实际资本(万元),最低资本(万元),状态\n';
    rows.forEach((x,i)=>{
      const st = x.st==='nodata'?'未披露':(x.r.C<1.0||x.r.D<0.5)?'不达标':((x.r.C<1.2||x.r.D<0.6)?'关注':'达标');
      s+=`${i+1},${x.c},${x.r&&x.r.C!=null?x.r.C:'未披露'},${x.r&&x.r.D!=null?x.r.D:'未披露'},${x.r&&x.r.I!=null?x.r.I:''},${x.r&&x.r.N!=null?x.r.N:''},${st}\n`;
    });
    const blob=new Blob([s],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download=`偿付能力排名_${KEY2PERIOD[k].label}.csv`; a.click();
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
    const tabs=document.getElementById('tabs'); if(tabs) tabs.style.display = allMode ? 'none' : '';
    const os=document.getElementById('overviewSingle'); if(os) os.style.display = allMode ? 'none' : '';
    const oa=document.getElementById('overviewAll'); if(oa) oa.style.display = allMode ? '' : 'none';
    if(allMode){
      document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
      const po=document.getElementById('p-overview'); if(po) po.classList.add('on');
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
