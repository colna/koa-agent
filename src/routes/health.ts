import Router from '@koa/router';
import { VERSION } from '../version.js';

export function healthRouter(): Router {
    const router = new Router();

    router.get('/health', (ctx) => {
        ctx.body = { status: 'ok', uptime: process.uptime(), version: VERSION };
    });

    return router;
}
