// SQL templates for the SP weekly data report.
// All time conditions are parameterized by { weekStart, distDay }.
//   weekStart : inclusive start date 'YYYY-MM-DD' for the weekly window (… >= weekStart)
//   distDay   : single representative day 'YYYY-MM-DD' for the online-duration distribution pie
//
// `kind` drives how generate_html renders each result:
//   scalar      -> KPI number
//   line        -> line chart (first col = x/date, remaining numeric cols = series)
//   pie         -> pie chart (col0 = name, col1 = value)
//   pie_grouped -> multiple pies split by first column (todo_type)
//   table       -> data table
//
// DB constants (DMS websql): dbId/dbType live in run_reports config, not here.

module.exports = function buildQueries({ weekStart, distDay }) {
  return [
    { id: 'avg_daily_per_user_min', title: '人均日均在线时长(分钟)', kind: 'scalar',
      sql: `SELECT ROUND(AVG(daily_per_user_min), 2) AS avg_daily_per_user_minutes
FROM (
  SELECT DATE(connected_at) AS dt, creator_id, SUM(duration_ms)/1000.0/60.0 AS daily_per_user_min
  FROM sp_v3_online_session
  WHERE disconnected_at IS NOT NULL AND DATE(connected_at) >= '${weekStart}'
  GROUP BY DATE(connected_at), creator_id
) daily;` },

    { id: 'online_minutes_daily', title: '人均在线时长(折线)', kind: 'line',
      sql: `SELECT DATE(connected_at) AS dt,
  ROUND(SUM(duration_ms)/1000.0/60.0, 2) AS total_online_minutes,
  ROUND(SUM(duration_ms)/1000.0/60.0/COUNT(DISTINCT creator_id), 2) AS avg_per_user_minutes
FROM sp_v3_online_session
WHERE disconnected_at IS NOT NULL AND DATE(connected_at) >= '${weekStart}'
GROUP BY DATE(connected_at) ORDER BY dt;` },

    { id: 'avg_daily_online_users', title: '日均在线人数', kind: 'scalar',
      sql: `SELECT ROUND(AVG(daily_cnt), 2) AS avg_daily_online_users
FROM (
  SELECT DATE(connected_at) AS dt, COUNT(DISTINCT creator_id) AS daily_cnt
  FROM sp_v3_online_session
  WHERE DATE(connected_at) >= '${weekStart}'
  GROUP BY DATE(connected_at)
) daily;` },

    { id: 'online_users_daily', title: '日均在线人数(折线)', kind: 'line',
      sql: `SELECT DATE(connected_at) AS dt, COUNT(DISTINCT creator_id) AS online_users
FROM sp_v3_online_session
WHERE DATE(connected_at) >= '${weekStart}'
GROUP BY DATE(connected_at) ORDER BY dt;` },

    { id: 'duration_dist', title: `不同在线时长人数分布(${distDay})`, kind: 'pie',
      sql: `SELECT duration_bucket, COUNT(*) AS user_count
FROM (
  SELECT creator_id, SUM(duration_ms)/1000.0/60.0 AS total_min,
    CASE
      WHEN SUM(duration_ms)/1000.0/60.0 < 30   THEN '0-30min'
      WHEN SUM(duration_ms)/1000.0/60.0 < 60   THEN '30-60min'
      WHEN SUM(duration_ms)/1000.0/60.0 < 120  THEN '1-2h'
      WHEN SUM(duration_ms)/1000.0/60.0 < 240  THEN '2-4h'
      WHEN SUM(duration_ms)/1000.0/60.0 < 480  THEN '4-8h'
      WHEN SUM(duration_ms)/1000.0/60.0 < 720  THEN '8-12h'
      ELSE '12h+'
    END AS duration_bucket
  FROM sp_v3_online_session
  WHERE disconnected_at IS NOT NULL AND DATE(connected_at) = '${distDay}'
  GROUP BY creator_id
) bucketed
GROUP BY duration_bucket
ORDER BY CASE duration_bucket
  WHEN '0-30min' THEN 1 WHEN '30-60min' THEN 2 WHEN '1-2h' THEN 3 WHEN '2-4h' THEN 4
  WHEN '4-8h' THEN 5 WHEN '8-12h' THEN 6 WHEN '12h+' THEN 7 END;` },

    { id: 'daily_ce', title: '每日ce次数(折线)', kind: 'line',
      sql: `SELECT DATE(create_at) AS dt, COUNT(*) AS daily_cnt
FROM user_ins_exchange_order
WHERE order_type='FREE' AND status='FINISH' AND followed=true AND DATE(create_at) >= '${weekStart}'
GROUP BY DATE(create_at) ORDER BY dt;` },

    { id: 'ce_gender', title: 'ce男女主动比例', kind: 'table',
      sql: `SELECT COUNT(*) AS total,
  SUM(CASE WHEN create_user_id = female_user_id THEN 1 ELSE 0 END) AS female_initiated,
  SUM(CASE WHEN create_user_id != female_user_id THEN 1 ELSE 0 END) AS male_initiated,
  ROUND(100.0*SUM(CASE WHEN create_user_id = female_user_id THEN 1 ELSE 0 END)/COUNT(*), 2) AS female_pct,
  ROUND(100.0*SUM(CASE WHEN create_user_id != female_user_id THEN 1 ELSE 0 END)/COUNT(*), 2) AS male_pct
FROM user_ins_exchange_order
WHERE order_type='FREE' AND status='FINISH' AND followed=true AND DATE(create_at) >= '${weekStart}';` },

    { id: 'ce_signal_followback_dm', title: 'sp收到ce消息次数、回关/打招呼成败(按天)', kind: 'table',
      sql: `SELECT DATE(s.created_at) AS dt, COUNT(DISTINCT s.id) AS ce_signal_count,
  SUM(CASE WHEN t.type='FOLLOW_BACK' THEN 1 ELSE 0 END) AS follow_back_total,
  SUM(CASE WHEN t.type='FOLLOW_BACK' AND t.status='COMPLETED' THEN 1 ELSE 0 END) AS follow_back_ok,
  SUM(CASE WHEN t.type='FOLLOW_BACK' AND t.status!='COMPLETED' THEN 1 ELSE 0 END) AS follow_back_fail,
  ROUND(100.0*SUM(CASE WHEN t.type='FOLLOW_BACK' AND t.status='COMPLETED' THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN t.type='FOLLOW_BACK' THEN 1 ELSE 0 END),0),2) AS follow_back_ok_pct,
  SUM(CASE WHEN t.type='SEND_DM' THEN 1 ELSE 0 END) AS send_dm_total,
  SUM(CASE WHEN t.type='SEND_DM' AND t.status='COMPLETED' THEN 1 ELSE 0 END) AS send_dm_ok,
  SUM(CASE WHEN t.type='SEND_DM' AND t.status!='COMPLETED' THEN 1 ELSE 0 END) AS send_dm_fail,
  ROUND(100.0*SUM(CASE WHEN t.type='SEND_DM' AND t.status='COMPLETED' THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN t.type='SEND_DM' THEN 1 ELSE 0 END),0),2) AS send_dm_ok_pct
FROM sp_v3_signal s
LEFT JOIN sp_v3_todo t ON t.signal_id = s.id AND t.type IN ('FOLLOW_BACK','SEND_DM')
WHERE s.type='CE_EXCHANGED' AND DATE(s.created_at) >= '${weekStart}'
GROUP BY DATE(s.created_at) ORDER BY dt DESC;` },

    { id: 'fail_reason_followback_dm', title: '回关/打招呼失败原因比例', kind: 'pie_grouped',
      sql: `SELECT t.type AS todo_type,
  CASE
    WHEN t.status='FAILED' AND t.error LIKE '%主页上找不到关注/已关注按钮%' THEN '主页上找不到关注/已关注按钮'
    WHEN t.status='FAILED' AND t.error LIKE '%SP.pipeline is not a function%' THEN 'SP.pipeline is not a function'
    WHEN t.status='FAILED' AND t.error LIKE '%Timeout%' THEN 'Timeout'
    WHEN t.status='FAILED' AND t.error LIKE '%当前页面不符合恢复条件%' THEN '当前页面不符合恢复条件'
    WHEN t.status='FAILED' AND t.error LIKE '%找不到发送按钮，请确认输入框中有内容%' THEN '找不到发送按钮，请确认输入框中有内容'
    WHEN t.status='FAILED' AND t.error LIKE '%not connected%' THEN 'Device not connected'
    WHEN t.status='FAILED' AND t.error LIKE '%请提供 userIgHandle 参数%' THEN '请提供 userIgHandle 参数'
    WHEN t.status='FAILED' THEN COALESCE(t.error, 'FAILED (no error)')
    ELSE t.status
  END AS fail_reason,
  COUNT(*) AS cnt,
  ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (PARTITION BY t.type), 2) AS pct
FROM sp_v3_signal s
JOIN sp_v3_todo t ON t.signal_id = s.id
WHERE s.type='CE_EXCHANGED' AND t.type IN ('FOLLOW_BACK','SEND_DM') AND t.status!='COMPLETED'
  AND s.created_at >= '${weekStart}'
GROUP BY t.type, fail_reason ORDER BY t.type, cnt DESC;` },

    { id: 'chat_daily', title: 'sp后聊天数据(按天)', kind: 'table',
      sql: `SELECT DATE(created_at) AS dt,
  SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) AS inbound_cnt,
  SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) AS outbound_cnt,
  COUNT(*) AS total_cnt,
  COUNT(DISTINCT creator_id) AS active_creators,
  COUNT(DISTINCT user_id) AS active_users
FROM social_proxy_ig_message_logs
WHERE created_at >= '${weekStart}' AND creator_id != '' AND user_id != ''
GROUP BY DATE(created_at) ORDER BY dt DESC;` },

    { id: 'avg_msg_per_pair', title: '平均每个匹配对收/发消息数', kind: 'table',
      sql: `SELECT ROUND(AVG(inbound_cnt),2) AS avg_inbound_per_pair, ROUND(AVG(outbound_cnt),2) AS avg_outbound_per_pair
FROM (
  SELECT creator_id, user_id,
    SUM(CASE WHEN direction='inbound' THEN 1 ELSE 0 END) AS inbound_cnt,
    SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) AS outbound_cnt
  FROM social_proxy_ig_message_logs
  WHERE created_at >= '${weekStart}' AND creator_id != '' AND user_id != ''
  GROUP BY creator_id, user_id
) pairs;` },

    { id: 'send_dist', title: '发送消息数量 creator 分布', kind: 'pie',
      sql: `SELECT send_bucket, COUNT(*) AS creator_count, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (),2) AS pct
FROM (
  SELECT creator_id,
    SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) AS outbound_cnt,
    CASE
      WHEN SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END)=0 THEN '0'
      WHEN SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END)<10 THEN '1-9'
      WHEN SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END)<50 THEN '10-49'
      WHEN SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END)<100 THEN '50-99'
      WHEN SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END)<200 THEN '100-199'
      WHEN SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END)<300 THEN '200-299'
      ELSE '300+'
    END AS send_bucket
  FROM social_proxy_ig_message_logs
  WHERE created_at >= '${weekStart}' AND creator_id != '' AND user_id != ''
  GROUP BY creator_id
) bucketed
GROUP BY send_bucket
ORDER BY CASE send_bucket WHEN '0' THEN 1 WHEN '1-9' THEN 2 WHEN '10-49' THEN 3 WHEN '50-99' THEN 4
  WHEN '100-199' THEN 5 WHEN '200-299' THEN 6 WHEN '300+' THEN 7 END;` },

    { id: 'signal_type', title: 'signal类型比例', kind: 'pie',
      sql: `SELECT type, COUNT(*) AS cnt, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (),2) AS pct
FROM sp_v3_signal WHERE created_at >= '${weekStart}' GROUP BY type ORDER BY cnt DESC;` },

    { id: 'signal_fail', title: 'signal失败原因比例', kind: 'pie',
      sql: `SELECT CASE
    WHEN status='FAILED' AND error LIKE '%主页上找不到关注/已关注按钮%' THEN '主页上找不到关注/已关注按钮'
    WHEN status='FAILED' AND error LIKE '%SP.pipeline is not a function%' THEN 'SP.pipeline is not a function'
    WHEN status='FAILED' AND error LIKE '%Timeout%' THEN 'Timeout'
    WHEN status='FAILED' AND error LIKE '%当前页面不符合恢复条件%' THEN '当前页面不符合恢复条件'
    WHEN status='FAILED' AND error LIKE '%找不到发送按钮，请确认输入框中有内容%' THEN '找不到发送按钮'
    WHEN status='FAILED' AND error LIKE '%not connected%' THEN 'Device not connected'
    WHEN status='FAILED' AND error LIKE '%请提供 userIgHandle 参数%' THEN '请提供 userIgHandle 参数'
    WHEN status='FAILED' THEN COALESCE(error,'FAILED (no error)')
    ELSE status END AS fail_reason,
  COUNT(*) AS cnt, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (),2) AS pct
FROM sp_v3_signal WHERE created_at >= '${weekStart}' AND status != 'PROCESSED'
GROUP BY fail_reason ORDER BY cnt DESC;` },

    { id: 'todo_type', title: 'todo类型比例', kind: 'pie',
      sql: `SELECT type, COUNT(*) AS cnt, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (),2) AS pct
FROM sp_v3_todo WHERE created_at >= '${weekStart}' GROUP BY type ORDER BY cnt DESC;` },

    { id: 'todo_fail', title: 'todo失败原因比例', kind: 'pie',
      sql: `SELECT CASE
    WHEN status='FAILED' AND error LIKE '%主页上找不到关注/已关注按钮%' THEN '主页上找不到关注/已关注按钮'
    WHEN status='FAILED' AND error LIKE '%SP.pipeline is not a function%' THEN 'SP.pipeline is not a function'
    WHEN status='FAILED' AND error LIKE '%Timeout%' THEN 'Timeout'
    WHEN status='FAILED' AND error LIKE '%当前页面不符合恢复条件%' THEN '当前页面不符合恢复条件'
    WHEN status='FAILED' AND error LIKE '%找不到发送按钮，请确认输入框中有内容%' THEN '找不到发送按钮'
    WHEN status='FAILED' AND error LIKE '%not connected%' THEN 'Device not connected'
    WHEN status='FAILED' AND error LIKE '%请提供 userIgHandle 参数%' THEN '请提供 userIgHandle 参数'
    WHEN status='FAILED' AND error LIKE '%收件箱没有未读消息%' THEN '收件箱没有未读消息'
    WHEN status='FAILED' AND error LIKE '%页面未发现帖子链接%' THEN '页面未发现帖子链接'
    WHEN status='FAILED' AND error LIKE '%检测到对方新消息，取消发送%' THEN '检测到对方新消息，取消发送'
    WHEN status='FAILED' AND error LIKE '%Device disconnected%' THEN 'Device disconnected'
    WHEN status='FAILED' AND error LIKE '%Cannot read properties of undefined%' THEN 'Cannot read properties of undefined'
    WHEN status='FAILED' AND error LIKE '%找不到待恢复的 sendMessage 任务%' THEN '找不到待恢复的 sendMessage 任务'
    WHEN status='FAILED' AND error LIKE '%无法进入聊天%' THEN '无法进入聊天'
    WHEN status='FAILED' THEN COALESCE(error,'FAILED (no error)')
    ELSE status END AS fail_reason,
  COUNT(*) AS cnt, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (),2) AS pct
FROM sp_v3_todo WHERE created_at >= '${weekStart}' AND status != 'COMPLETED'
GROUP BY fail_reason ORDER BY cnt DESC;` },

    { id: 'behavior_type', title: 'behavior类型比例', kind: 'pie',
      sql: `SELECT type, COUNT(*) AS cnt, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (),2) AS pct
FROM sp_v3_behavior_log WHERE created_at >= '${weekStart}' GROUP BY type ORDER BY cnt DESC;` },

    { id: 'behavior_fail', title: 'behavior失败原因比例', kind: 'pie',
      sql: `SELECT CASE
    WHEN status='FAILED' AND error LIKE '%主页上找不到关注/已关注按钮%' THEN '主页上找不到关注/已关注按钮'
    WHEN status='FAILED' AND error LIKE '%SP.pipeline is not a function%' THEN 'SP.pipeline is not a function'
    WHEN status='FAILED' AND error LIKE '%Timeout%' THEN 'Timeout'
    WHEN status='FAILED' AND error LIKE '%当前页面不符合恢复条件%' THEN '当前页面不符合恢复条件'
    WHEN status='FAILED' AND error LIKE '%找不到发送按钮，请确认输入框中有内容%' THEN '找不到发送按钮'
    WHEN status='FAILED' AND error LIKE '%not connected%' THEN 'Device not connected'
    WHEN status='FAILED' AND error LIKE '%请提供 userIgHandle 参数%' THEN '请提供 userIgHandle 参数'
    WHEN status='FAILED' AND error LIKE '%收件箱没有未读消息%' THEN '收件箱没有未读消息'
    WHEN status='FAILED' AND error LIKE '%页面未发现帖子链接%' THEN '页面未发现帖子链接'
    WHEN status='FAILED' AND error LIKE '%检测到对方新消息，取消发送%' THEN '检测到对方新消息，取消发送'
    WHEN status='FAILED' AND error LIKE '%Device disconnected%' THEN 'Device disconnected'
    WHEN status='FAILED' AND error LIKE '%Cannot read properties of undefined%' THEN 'Cannot read properties of undefined'
    WHEN status='FAILED' AND error LIKE '%找不到待恢复的 sendMessage 任务%' THEN '找不到待恢复的 sendMessage 任务'
    WHEN status='FAILED' AND error LIKE '%无法进入聊天%' THEN '无法进入聊天'
    WHEN status='FAILED' AND error LIKE '%未知方法%' THEN '未知方法'
    WHEN status='FAILED' AND error LIKE '%找不到聊天容器%' THEN '找不到聊天容器'
    WHEN status='FAILED' AND error LIKE '%Failed to execute%' THEN 'Failed to execute'
    WHEN status='FAILED' AND error LIKE '%关注操作未生效%' THEN '关注操作未生效'
    WHEN status='FAILED' AND error LIKE '%等待聊天页加载超时%' THEN '等待聊天页加载超时'
    WHEN status='FAILED' AND error LIKE '%ELEMENT_NOT_FOUND%' THEN 'ELEMENT_NOT_FOUND'
    WHEN status='FAILED' THEN COALESCE(error,'FAILED (no error)')
    ELSE status END AS fail_reason,
  COUNT(*) AS cnt, ROUND(100.0*COUNT(*)/SUM(COUNT(*)) OVER (),2) AS pct
FROM sp_v3_behavior_log WHERE created_at >= '${weekStart}' AND status NOT IN ('COMPLETED','SKIPPED')
GROUP BY fail_reason ORDER BY cnt DESC;` },

    { id: 'signal_daily', title: 'signal每日量级(折线)', kind: 'line',
      sql: `SELECT DATE(created_at) AS dt,
  SUM(CASE WHEN status='DONE' THEN 1 ELSE 0 END) AS success_cnt,
  SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS fail_cnt,
  COUNT(*) AS total_cnt
FROM sp_v3_signal WHERE created_at >= '${weekStart}'
GROUP BY DATE(created_at) ORDER BY dt;` },

    { id: 'todo_daily', title: 'todo每日量级(折线)', kind: 'line',
      sql: `SELECT DATE(created_at) AS dt,
  SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END) AS success_cnt,
  SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS fail_cnt,
  COUNT(*) AS total_cnt
FROM sp_v3_todo WHERE created_at >= '${weekStart}'
GROUP BY DATE(created_at) ORDER BY dt;` },

    { id: 'behavior_daily', title: 'behavior每日量级(折线)', kind: 'line',
      sql: `SELECT DATE(created_at) AS dt,
  SUM(CASE WHEN status IN ('COMPLETED','SKIPPED') THEN 1 ELSE 0 END) AS success_cnt,
  SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS fail_cnt,
  COUNT(*) AS total_cnt
FROM sp_v3_behavior_log WHERE created_at >= '${weekStart}'
GROUP BY DATE(created_at) ORDER BY dt;` },
  ];
};
