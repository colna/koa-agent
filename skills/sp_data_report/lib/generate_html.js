// Render the SP weekly report HTML from a results map (output of runReports).
// Self-contained: inlines ECharts so the file works offline via file://.
const fs = require('fs');
const path = require('path');

const num = v => v == null ? 0 : Number(v);
// HTML-escape table cells / headers (DB error strings may contain <script>, < > " etc.)
const esc = v => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// shorten noisy reason labels (some DB error strings embed huge injected JS blobs)
const shortName = v => {
  let s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (s.length > 42) s = s.slice(0, 40) + '…';
  return s;
};
// safe inline of JSON into a <script> tag: neutralize < > U+2028 U+2029
const jsonInline = obj => JSON.stringify(obj)
  .replace(/[<>\u2028\u2029]/g, m => '\\u' + ('000' + m.charCodeAt(0).toString(16)).slice(-4));

function pieData(rows, nameKey, valKey, topN = 9) {
  const arr = (rows || []).map(r => ({ name: shortName(r[nameKey]), value: num(r[valKey]) }));
  if (arr.length <= topN) return arr;
  const top = arr.slice(0, topN);
  const restVal = arr.slice(topN).reduce((s, x) => s + x.value, 0);
  top.push({ name: '其他', value: restVal });
  return top;
}
function tableHTML(rows, headers) {
  rows = rows || [];
  const cols = headers || (rows[0] ? Object.keys(rows[0]) : []);
  let h = '<table class="dt"><thead><tr>' + cols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of rows) h += '<tr>' + cols.map(c => `<td>${esc(r[c])}</td>`).join('') + '</tr>';
  return h + '</tbody></table>';
}
const rowsOf = (R, id) => (R[id] && R[id].rows) ? R[id].rows : [];
const scalar = (R, id, col) => { const r = rowsOf(R, id)[0]; return r ? r[col] : '-'; };

// data = results map; meta = { weekStart, distDay, endDate }
function renderHtml(R, meta, echartsPath) {
  const { weekStart, distDay, endDate } = meta;
  const ceGender = rowsOf(R, 'ce_gender')[0] || {};
  const avgPair = rowsOf(R, 'avg_msg_per_pair')[0] || {};

  const PAYLOAD = {
    scalars: {
      avgMin: scalar(R, 'avg_daily_per_user_min', 'avg_daily_per_user_minutes'),
      avgUsers: scalar(R, 'avg_daily_online_users', 'avg_daily_online_users'),
      ceGender, avgPair,
    },
    onlineMin: rowsOf(R, 'online_minutes_daily').map(r => ({ dt: r.dt, avg: num(r.avg_per_user_minutes), total: num(r.total_online_minutes) })),
    onlineUsers: rowsOf(R, 'online_users_daily').map(r => ({ dt: r.dt, v: num(r.online_users) })),
    durationDist: rowsOf(R, 'duration_dist').map(r => ({ name: r.duration_bucket, value: num(r.user_count) })),
    dailyCe: rowsOf(R, 'daily_ce').map(r => ({ dt: r.dt, v: num(r.daily_cnt) })),
    followFail: rowsOf(R, 'fail_reason_followback_dm').filter(r => r.todo_type === 'FOLLOW_BACK').map(r => ({ name: shortName(r.fail_reason), value: num(r.cnt) })),
    dmFail: rowsOf(R, 'fail_reason_followback_dm').filter(r => r.todo_type === 'SEND_DM').map(r => ({ name: shortName(r.fail_reason), value: num(r.cnt) })),
    sendDist: rowsOf(R, 'send_dist').map(r => ({ name: r.send_bucket, value: num(r.creator_count) })),
    signalType: pieData(rowsOf(R, 'signal_type'), 'type', 'cnt'),
    signalFail: pieData(rowsOf(R, 'signal_fail'), 'fail_reason', 'cnt'),
    todoType: pieData(rowsOf(R, 'todo_type'), 'type', 'cnt'),
    todoFail: pieData(rowsOf(R, 'todo_fail'), 'fail_reason', 'cnt'),
    behaviorType: pieData(rowsOf(R, 'behavior_type'), 'type', 'cnt'),
    behaviorFail: pieData(rowsOf(R, 'behavior_fail'), 'fail_reason', 'cnt'),
    signalDaily: rowsOf(R, 'signal_daily').map(r => ({ dt: r.dt, ok: num(r.success_cnt), fail: num(r.fail_cnt), total: num(r.total_cnt) })),
    todoDaily: rowsOf(R, 'todo_daily').map(r => ({ dt: r.dt, ok: num(r.success_cnt), fail: num(r.fail_cnt), total: num(r.total_cnt) })),
    behaviorDaily: rowsOf(R, 'behavior_daily').map(r => ({ dt: r.dt, ok: num(r.success_cnt), fail: num(r.fail_cnt), total: num(r.total_cnt) })),
  };

  const echarts = fs.readFileSync(echartsPath || path.join(__dirname, 'echarts.min.js'), 'utf8');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SP 数据报表 · 最近一周 (${weekStart} ~ ${endDate})</title>
<script>${echarts}</script>
<style>
  :root{--bg:#f5f6fa;--card:#fff;--ink:#1f2329;--sub:#646a73;--line:#e5e6eb;--accent:#3370ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1200px;margin:0 auto;padding:28px 20px 60px}
  header h1{font-size:24px;margin:0 0 6px}
  header .meta{color:var(--sub);font-size:13px}
  h2{font-size:19px;margin:34px 0 14px;padding-left:10px;border-left:4px solid var(--accent)}
  h3{font-size:15px;margin:0 0 4px;color:var(--ink)}
  .grid{display:grid;gap:16px}.g2{grid-template-columns:repeat(2,1fr)}
  @media(max-width:880px){.g2{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
  .chart{width:100%;height:320px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  @media(max-width:880px){.kpis{grid-template-columns:repeat(2,1fr)}}
  .kpi{background:linear-gradient(135deg,#3370ff,#5b8cff);color:#fff;border-radius:12px;padding:16px 18px}
  .kpi .v{font-size:28px;font-weight:700;line-height:1.1}.kpi .l{font-size:13px;opacity:.92;margin-top:6px}
  .note{color:var(--sub);font-size:12px;margin-top:8px}
  table.dt{width:100%;border-collapse:collapse;font-size:13px}
  table.dt th,table.dt td{border:1px solid var(--line);padding:7px 9px;text-align:right;white-space:nowrap}
  table.dt th{background:#f2f3f5;font-weight:600;text-align:center}
  table.dt td:first-child,table.dt th:first-child{text-align:center}
  .tablewrap{overflow-x:auto}
  .badge{display:inline-block;background:#eaf1ff;color:#3370ff;border-radius:6px;padding:2px 8px;font-size:12px;margin-left:8px}
</style></head>
<body><div class="wrap">
<header>
  <h1>SP 数据报表 · 最近一周</h1>
  <div class="meta">统计区间：<b>${weekStart} ~ ${endDate}</b>（时长分布饼图取代表日 <b>${distDay}</b>）　·　数据源：sp_v3 / social_proxy（PostgreSQL）　·　注：${endDate} 若为当日，数据未满全天</div>
</header>

<h2>一、PWA 在线数据</h2>
<div class="kpis">
  <div class="kpi"><div class="v">${esc(PAYLOAD.scalars.avgMin)}</div><div class="l">人均日均在线时长（分钟）</div></div>
  <div class="kpi"><div class="v">${esc(PAYLOAD.scalars.avgUsers)}</div><div class="l">日均在线人数</div></div>
  <div class="kpi"><div class="v">${esc(avgPair.avg_inbound_per_pair)}</div><div class="l">平均每对·收到消息</div></div>
  <div class="kpi"><div class="v">${esc(avgPair.avg_outbound_per_pair)}</div><div class="l">平均每对·发送消息</div></div>
</div>
<div class="grid g2" style="margin-top:16px">
  <div class="card"><h3>人均在线时长（折线）</h3><div id="c_onlineMin" class="chart"></div></div>
  <div class="card"><h3>日均在线人数（折线）</h3><div id="c_onlineUsers" class="chart"></div></div>
</div>
<div class="grid g2" style="margin-top:16px">
  <div class="card"><h3>不同在线时长人数分布（${distDay}）</h3><div id="c_durationDist" class="chart"></div></div>
  <div class="card"><h3>在线时长明细（按天）</h3><div class="tablewrap">${tableHTML(rowsOf(R, 'online_minutes_daily'))}</div></div>
</div>

<h2>二、业务漏斗数据</h2>
<div class="grid g2">
  <div class="card"><h3>每日 ce 次数（折线）</h3><div id="c_dailyCe" class="chart"></div></div>
  <div class="card"><h3>ce 男女主动比例 <span class="badge">女 ${esc(ceGender.female_pct)}% · 男 ${esc(ceGender.male_pct)}%</span></h3><div id="c_ceGender" class="chart"></div></div>
</div>
<div class="card" style="margin-top:16px"><h3>sp 收到 ce 消息次数、回关/打招呼成败（按天）</h3><div class="tablewrap">${tableHTML(rowsOf(R, 'ce_signal_followback_dm'))}</div></div>
<div class="grid g2" style="margin-top:16px">
  <div class="card"><h3>回关失败原因比例</h3><div id="c_followFail" class="chart"></div></div>
  <div class="card"><h3>打招呼失败原因比例</h3><div id="c_dmFail" class="chart"></div></div>
</div>
<div class="card" style="margin-top:16px"><h3>sp 后聊天数据（按天）</h3><div class="tablewrap">${tableHTML(rowsOf(R, 'chat_daily'))}</div></div>
<div class="card" style="margin-top:16px"><h3>发送消息数量 creator 分布</h3><div id="c_sendDist" class="chart"></div></div>

<h2>三、服务运行数据</h2>
<div class="grid g2">
  <div class="card"><h3>signal 类型比例</h3><div id="c_signalType" class="chart"></div></div>
  <div class="card"><h3>signal 失败原因比例</h3><div id="c_signalFail" class="chart"></div></div>
  <div class="card"><h3>todo 类型比例</h3><div id="c_todoType" class="chart"></div></div>
  <div class="card"><h3>todo 失败原因比例</h3><div id="c_todoFail" class="chart"></div></div>
  <div class="card"><h3>behavior 类型比例</h3><div id="c_behaviorType" class="chart"></div></div>
  <div class="card"><h3>behavior 失败原因比例</h3><div id="c_behaviorFail" class="chart"></div></div>
</div>
<div class="grid g2" style="margin-top:16px">
  <div class="card"><h3>signal 每日量级（成功/失败/总量）</h3><div id="c_signalDaily" class="chart"></div></div>
  <div class="card"><h3>todo 每日量级（成功/失败/总量）</h3><div id="c_todoDaily" class="chart"></div></div>
</div>
<div class="grid g2" style="margin-top:16px">
  <div class="card"><h3>behavior 每日量级（成功/失败/总量）</h3><div id="c_behaviorDaily" class="chart"></div></div>
</div>

<p class="note">由 DMS websql 数据自动生成 · skill: sp_data_report</p>
</div>

<script>
const P = ${jsonInline(PAYLOAD)};
const PALETTE = ['#3370ff','#00b42a','#ff7d00','#f53f3f','#7c3aed','#14c9c9','#fab005','#a0a4aa','#ee5fc1','#4080ff'];
function mk(id){const el=document.getElementById(id);if(!el)return null;const c=echarts.init(el);window.addEventListener('resize',()=>c.resize());return c;}
function lineChart(id,x,series){const c=mk(id);if(!c)return;c.setOption({color:PALETTE,tooltip:{trigger:'axis'},legend:{show:series.length>1,top:0},
  grid:{left:48,right:18,top:series.length>1?34:18,bottom:30},
  xAxis:{type:'category',data:x,axisLabel:{rotate:x.length>8?30:0}},yAxis:{type:'value'},
  series:series.map(s=>({name:s.name,type:'line',smooth:true,data:s.data,areaStyle:s.area?{opacity:.12}:undefined,label:{show:s.label,position:'top',fontSize:10}}))});}
function pieChart(id,data,opt={}){const c=mk(id);if(!c)return;c.setOption({color:PALETTE,tooltip:{trigger:'item',formatter:'{b}: {c} ({d}%)'},
  legend:{type:'scroll',orient:'vertical',right:6,top:'middle',textStyle:{fontSize:11}},
  series:[{type:'pie',radius:opt.donut?['42%','70%']:'68%',center:['38%','52%'],data,label:{show:true,formatter:'{d}%',fontSize:11},minShowLabelAngle:6}]});}

lineChart('c_onlineMin',P.onlineMin.map(d=>d.dt),[{name:'人均(分钟)',data:P.onlineMin.map(d=>d.avg),label:true},{name:'总时长(分钟)',data:P.onlineMin.map(d=>d.total)}]);
lineChart('c_onlineUsers',P.onlineUsers.map(d=>d.dt),[{name:'在线人数',data:P.onlineUsers.map(d=>d.v),area:true,label:true}]);
pieChart('c_durationDist',P.durationDist);
lineChart('c_dailyCe',P.dailyCe.map(d=>d.dt),[{name:'ce次数',data:P.dailyCe.map(d=>d.v),area:true,label:true}]);
pieChart('c_ceGender',[{name:'女主动',value:Number(P.scalars.ceGender.female_initiated)},{name:'男主动',value:Number(P.scalars.ceGender.male_initiated)}],{donut:true});
pieChart('c_followFail',P.followFail);pieChart('c_dmFail',P.dmFail);pieChart('c_sendDist',P.sendDist);
pieChart('c_signalType',P.signalType);pieChart('c_signalFail',P.signalFail,{donut:true});
pieChart('c_todoType',P.todoType);pieChart('c_todoFail',P.todoFail);
pieChart('c_behaviorType',P.behaviorType);pieChart('c_behaviorFail',P.behaviorFail);
function dailyVol(id,rows){lineChart(id,rows.map(d=>d.dt),[{name:'总量',data:rows.map(d=>d.total),label:true},{name:'成功',data:rows.map(d=>d.ok)},{name:'失败',data:rows.map(d=>d.fail)}]);}
dailyVol('c_signalDaily',P.signalDaily);dailyVol('c_todoDaily',P.todoDaily);dailyVol('c_behaviorDaily',P.behaviorDaily);
</script>
</body></html>`;
}

module.exports = { renderHtml };
