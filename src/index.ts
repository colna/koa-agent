import { pathToFileURL } from 'node:url';
import { createCheckpointer } from './agent/checkpoint.js';
import { createAgentGraph } from './agent/graph.js';
import { createModel } from './agent/model.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { defaultLog, type LogFn } from './middleware/logger.js';
import { agentRouter } from './routes/agent.js';
import { type RunningServer, startServer } from './server.js';

export function loadDotEnv(): void {
    try {
        process.loadEnvFile();
    } catch {
        // 无 .env 时按当前环境变量运行
    }
}

export function setupGracefulShutdown(
    running: RunningServer,
    log: LogFn,
    exit: (code: number) => void = (code) => process.exit(code),
): () => void {
    const shutdown = (signal: NodeJS.Signals) => {
        log({ level: 'info', message: `收到 ${signal}，优雅退出` });
        void running.close().then(
            () => exit(0),
            () => exit(1),
        );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return () => {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
    };
}

export async function main(log: LogFn = defaultLog): Promise<RunningServer> {
    loadDotEnv();
    const config = loadConfig();
    const graph = createAgentGraph({
        model: createModel(config),
        checkpointer: createCheckpointer(config.AGENT_SQLITE_PATH),
    });
    const app = createApp({ log, routes: [agentRouter({ graph, log })] });
    const running = await startServer(app, config.PORT, config.HOST);
    log({ level: 'info', message: '服务已启动', url: running.url });
    setupGracefulShutdown(running, log);
    return running;
}

const isEntrypoint =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
    main().catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
