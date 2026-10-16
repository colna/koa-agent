-- pwa4 消息收益全链路验证（archat 主库 pgCfg）。跑法：
--   k8s_pg_query.sh --sql-file queries/pwa4_verify.sql

-- ① flow inbox（pwa4 最近20）：加钱成功应 FINISH、fail_reason 空
SELECT source, "timestamp", event_id, status, fail_reason, updated_at
FROM pwa_balance_msg_flow WHERE source='pwa4' ORDER BY updated_at DESC LIMIT 20;

-- ② 加钱流水 history（PWA4 最近20）：ext_id=event_id、balance_change=金额
SELECT id, from_user_id, to_user_id, balance_change, left_balance, change_type, ext_id, created_at
FROM pwa_user_balance_change_history
WHERE change_type='PWA_USER_BALANCE_CHANGE_TYPE_PWA4' ORDER BY id DESC LIMIT 20;

-- ③ 钱包余额（注意列名 update_at，非 updated_at；判成功看 balance 值本身）
SELECT user_id, balance_type, balance, update_at
FROM user_balance WHERE user_id IN (2100045711,2100059898) ORDER BY user_id, balance_type;

-- ④ 死信表（应无真毒消息）
SELECT id, topic, "partition", "offset", err_code, err_msg, created_at
FROM pwa_balance_msg_dead ORDER BY id DESC LIMIT 20;

-- A 一致性：flow=FINISH 但 history 缺行（应 0 行）
SELECT f.source, f."timestamp", f.event_id
FROM pwa_balance_msg_flow f
LEFT JOIN pwa_user_balance_change_history h
  ON h.change_type='PWA_USER_BALANCE_CHANGE_TYPE_PWA4' AND h.ext_id=f.event_id
WHERE f.source='pwa4' AND f.status='FINISH' AND h.id IS NULL;

-- B 一致性：同 (change_type,ext_id) 重复加钱（应 0 行）
SELECT change_type, ext_id, count(*) AS cnt
FROM pwa_user_balance_change_history
WHERE ext_id IS NOT NULL GROUP BY change_type, ext_id HAVING count(*)>1;

-- C 一致性：卡住的未完成 flow >5min（应 0 行）
SELECT source, event_id, status, updated_at, now()-updated_at AS stale
FROM pwa_balance_msg_flow
WHERE status IN ('INIT','PROCESSING') AND updated_at < now()-interval '5 minutes';
