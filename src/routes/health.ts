/**
 * 健康检查路由。
 * 挂载路径：GET /health（在 app.ts 里与其它路由一起装配）。
 * uptime 用 process.uptime()（进程存活秒数），version 来自 version.ts 常量。
 */
import Router from '@koa/router';
import { VERSION } from '../version.js';

export function healthRouter(): Router {
    const router = new Router();

    router.get('/health', (ctx) => {
        ctx.body = { status: 'ok', uptime: process.uptime(), version: VERSION };
    });

    return router;
}
