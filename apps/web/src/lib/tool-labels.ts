/**
 * 工具名 → 中文标签映射（消息气泡、导出等共用）。
 */
const TOOL_LABELS: Record<string, string> = {
    sp_send_signal: '下发 SP 信号',
    sp_query_script_errors: '查询脚本错误日志',
    sp_build_error_report: '生成错误报表',
    sp_export_script_errors_csv: '导出 CSV',
    sp_online_overview: '在线数据分析',
    sp_dashboard_query: '查询链路看板',
    sls_query_log: '查询 SLS 日志',
    byteplus_query: '查询 BytePlus 数据',
    render_chart: '生成图表',
    echo: '回显测试',
};

/** 取工具的中文标签；未收录的原样返回「调用 <name>」。 */
export function toolLabel(name: string): string {
    return TOOL_LABELS[name] ?? `调用 ${name}`;
}
