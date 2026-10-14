import type Router from '@koa/router';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import { errorMiddleware } from './middleware/error.js';
import { defaultLog, type LogFn, loggerMiddleware } from './middleware/logger.js';
import { healthRouter } from './routes/health.js';

export interface CreateAppOptions {
    log?: LogFn;
    routes?: Router[];
}

export function createApp(options: CreateAppOptions = {}): Koa {
    const log = options.log ?? defaultLog;
    const app = new Koa();

    app.use(loggerMiddleware(log));
    app.use(errorMiddleware(log));
    app.use(bodyParser({ enableTypes: ['json'], jsonLimit: '1mb' }));

    const routers = [healthRouter(), ...(options.routes ?? [])];
    for (const router of routers) {
        app.use(router.routes());
        app.use(router.allowedMethods());
    }

    return app;
}
