/**
 * SP 报表下载路由：GET /sp/reports/:name
 *
 * 只服务 SP_REPORT_DIR 内的文件（sp_export_script_errors_csv 工具的落盘目录）。
 * 文件名白名单校验（必须字母数字开头、仅含 [A-Za-z0-9._-]）—— 从源头杜绝路径穿越；
 * 另有 resolve 后的前缀二次校验兜底。
 */
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Router from '@koa/router';
import { HttpError } from '../errors.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SpRouterOptions {
    reportDir: string;
}

export function spRouter(options: SpRouterOptions): Router {
    const router = new Router({ prefix: '/sp' });
    const reportRoot = resolve(options.reportDir);

    router.get('/reports/:name', async (ctx) => {
        const name = ctx.params.name ?? '';
        if (!SAFE_NAME.test(name)) {
            throw new HttpError(400, 'BAD_REQUEST', '文件名不合法');
        }

        const filePath = resolve(join(reportRoot, name));
        if (filePath !== join(reportRoot, name) || !filePath.startsWith(reportRoot)) {
            throw new HttpError(400, 'BAD_REQUEST', '文件名不合法');
        }
        if (!existsSync(filePath)) {
            throw new HttpError(404, 'NOT_FOUND', '报表不存在或已被清理');
        }

        ctx.attachment(name);
        ctx.type = name.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/octet-stream';
        ctx.body = createReadStream(filePath);
    });

    return router;
}
