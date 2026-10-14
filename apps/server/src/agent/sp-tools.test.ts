/**
 * SP 工具集测试（全离线）：本地 mock HTTP 服务模拟 minerva BFF。
 * 覆盖：错误日志聚合/分页参数、Markdown 报表、CSV 导出落盘、在线总览合并、
 * v3 看板路由、signal 双步确认（confirm=false 零请求）与三态解析。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SpAdminClient } from '../sp/client.js';
import { createSpTools } from './sp-tools.js';

const servers: Server[] = [];
const dir = mkdtempSync(join(tmpdir(), 'sp-tools-test-'));

afterAll(async () => {
    await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    rmSync(dir, { recursive: true, force: true });
});

async function startMockServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function buildTools(baseUrl: string) {
    const client = new SpAdminClient({ baseUrl, token: 'test-token' });
    return createSpTools({ client, reportDir: dir, serverBaseUrl: 'http://127.0.0.1:3999' });
}

const errorItems = [
    {
        id: 'e1',
        creatorId: 'c1',
        action: 'getProfilePostImage',
        errorCode: 'ELEMENT_NOT_FOUND',
        message: '页面未发现帖子链接',
        selector: 'a[href*="/p/"]',
        durationMs: 32_000,
        createdAt: '2026-10-14T10:00:00.000Z',
    },
    {
        id: 'e2',
        creatorId: 'c2',
        action: 'getProfilePostImage',
        errorCode: 'ELEMENT_NOT_FOUND',
        message: '页面未发现帖子链接',
        selector: null,
        durationMs: null,
        createdAt: '2026-10-13T10:00:00.000Z',
    },
    {
        id: 'e3',
        creatorId: 'c1',
        action: 'getChatMessages',
        errorCode: 'NO_UNREAD',
        message: '收件箱没有未读消息',
        selector: null,
        durationMs: 1200,
        createdAt: '2026-10-13T01:00:00.000Z',
    },
];

describe('sp_query_script_errors', () => {
    it('聚合统计（Action/错误码/按日）并带默认时间范围与分页参数', async () => {
        let seenUrl = '';
        const baseUrl = await startMockServer((req, res) => {
            seenUrl = req.url ?? '';
            json(res, { success: true, data: { items: errorItems, total: 3 } });
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.queryScriptErrors.invoke({})) as string;
        const data = JSON.parse(text) as {
            总条数: number;
            按Action: [string, number][];
            按错误码: [string, number][];
            按日: [string, number][];
        };

        expect(data.总条数).toBe(3);
        expect(data.按Action[0]).toEqual(['getProfilePostImage', 2]);
        expect(data.按错误码).toEqual([
            ['ELEMENT_NOT_FOUND', 2],
            ['NO_UNREAD', 1],
        ]);
        // 2026-10-13T01:00Z → Asia/Shanghai 是 13 日 09:00；14T10:00Z → 14 日 18:00
        expect(data.按日).toEqual([
            ['2026-10-13', 2],
            ['2026-10-14', 1],
        ]);
        expect(seenUrl).toContain('/api/social-proxy/script/error-logs?');
        expect(seenUrl).toContain('page=1');
        expect(seenUrl).toContain('pageSize=2000');
        expect(seenUrl).toContain('startDate=');
    });
});

describe('sp_build_error_report', () => {
    it('输出 Markdown 报表（标题 + 三个维度表）', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            json(res, { success: true, data: { items: errorItems, total: 3 } });
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.buildErrorReport.invoke({})) as string;

        expect(text).toContain('# SP 脚本错误报表');
        expect(text).toContain('### 按 Action');
        expect(text).toContain('| getProfilePostImage | 2 (66.7%) |');
        expect(text).toContain('### 按错误码');
        expect(text).toContain('### 按日分布');
    });
});

describe('sp_export_script_errors_csv', () => {
    it('CSV 流式落盘并返回下载链接', async () => {
        const csv = '时间,Action\n2026-10-14,getProfilePostImage\n';
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
            res.end(csv);
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.exportErrorsCsv.invoke({})) as string;
        const data = JSON.parse(text) as { status: string; 文件: string; 下载链接: string };

        expect(data.status).toBe('exported');
        expect(data.文件).toMatch(/^script-errors_\d{8}_\d{6}\.csv$/);
        expect(data.下载链接).toBe(`http://127.0.0.1:3999/sp/reports/${data.文件}`);
        expect(readFileSync(join(dir, data.文件), 'utf8')).toBe(csv);
    });
});

describe('sp_online_overview', () => {
    it('合并实时设备 + 历史汇总 + 趋势', async () => {
        const baseUrl = await startMockServer((req, res) => {
            const url = req.url ?? '';
            if (url.startsWith('/api/social-proxy/gateway/devices')) {
                json(res, {
                    success: true,
                    data: { devices: [{ creatorId: 'c1', connectedAt: 1 }], count: 1 },
                });
                return;
            }
            if (url.startsWith('/api/sp-online/summary')) {
                json(res, {
                    success: true,
                    data: { totalUsers: 5, totalSeconds: 100, medianSeconds: 20 },
                });
                return;
            }
            if (url.startsWith('/api/sp-online/timeseries')) {
                json(res, {
                    success: true,
                    data: { items: [{ ts: '2026-10-14 10:00', onlineUsers: 3 }] },
                });
                return;
            }
            json(res, { success: false, error: 'unexpected' }, 404);
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.onlineOverview.invoke({})) as string;
        const data = JSON.parse(text) as {
            实时网关设备: { 在线数: number };
            历史在线汇总: { totalUsers: number };
            每小时在线趋势: { items: unknown[] };
        };

        expect(data.实时网关设备.在线数).toBe(1);
        expect(data.历史在线汇总.totalUsers).toBe(5);
        expect(data.每小时在线趋势.items).toHaveLength(1);
    });
});

describe('sp_dashboard_query', () => {
    it('trace 缺 creatorId → 本地拦截，不发请求', async () => {
        const tools = buildTools('http://127.0.0.1:1');
        const text = (await tools.dashboardQuery.invoke({ query: 'trace' })) as string;
        expect(text).toContain('必须提供 creatorId');
    });

    it('正常查询透传到对应路径', async () => {
        let seenUrl = '';
        const baseUrl = await startMockServer((req, res) => {
            seenUrl = req.url ?? '';
            json(res, { success: true, data: [{ signalCount: 1 }] });
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.dashboardQuery.invoke({ query: 'funnel', hours: 24 })) as string;

        expect(seenUrl).toContain('/api/social-proxy/v3/dashboard/funnel?');
        expect(seenUrl).toContain('hours=24');
        expect(text).toContain('funnel');
    });
});

describe('sp_send_signal（双步确认）', () => {
    it('confirm=false：不发任何请求，返回待确认摘要', async () => {
        let hits = 0;
        const baseUrl = await startMockServer((_req, res) => {
            hits += 1;
            json(res, { success: true, data: {} });
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.sendSignal.invoke({
            type: 'CE_EXCHANGED',
            creatorId: 'c1',
            userId: 'u1',
            payload: { userIgHandle: 'john', isFirstContact: true },
        })) as string;
        const data = JSON.parse(text) as { status: string; 待发送信号: { type: string } };

        expect(hits).toBe(0);
        expect(data.status).toBe('pending_confirmation');
        expect(data.待发送信号.type).toBe('CE_EXCHANGED');
    });

    it('confirm=true：内层 success + signal → sent', async () => {
        let seenBody = '';
        const baseUrl = await startMockServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', () => {
                seenBody = body;
                json(res, { success: true, data: { success: true, signal: { id: 'sig_1' } } });
            });
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.sendSignal.invoke({
            type: 'KEEPALIVE_TICK',
            creatorId: 'c1',
            confirm: true,
        })) as string;
        const data = JSON.parse(text) as { status: string; signalId: string };

        expect(data.status).toBe('sent');
        expect(data.signalId).toBe('sig_1');
        expect(seenBody).toContain('"type":"KEEPALIVE_TICK"');
    });

    it('confirm=true：内层 signal=null → deduped', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            json(res, { success: true, data: { success: true, signal: null } });
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.sendSignal.invoke({
            type: 'KEEPALIVE_TICK',
            creatorId: 'c1',
            confirm: true,
        })) as string;

        expect(JSON.parse(text)).toMatchObject({ status: 'deduped' });
    });

    it('confirm=true：内层 success=false → 拒绝文本', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            json(res, { success: true, data: { success: false, error: 'Unknown SignalType: X' } });
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.sendSignal.invoke({
            type: 'KEEPALIVE_TICK',
            creatorId: 'c1',
            confirm: true,
        })) as string;

        expect(text).toContain('SP 拒绝下发');
        expect(text).toContain('Unknown SignalType');
    });

    it('BFF 401 时转为可读错误文本（含 auth 归类）', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            json(res, {}, 401);
        });
        const tools = buildTools(baseUrl);

        const text = (await tools.sendSignal.invoke({
            type: 'KEEPALIVE_TICK',
            creatorId: 'c1',
            confirm: true,
        })) as string;

        expect(text).toContain('SP 调用失败（auth）');
    });
});
