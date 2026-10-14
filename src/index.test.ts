/**
 * 入口模块测试：.env 缺失容错 + 优雅退出流程。
 * 两个技巧：① exit 注入 mock（否则真退出会杀掉测试进程）；
 * ② 手动 process.emit('SIGTERM') 必须带信号名参数，否则监听器收到 undefined。
 */
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { loadDotEnv, setupGracefulShutdown } from './index.js';
import { startServer } from './server.js';

describe('loadDotEnv', () => {
    it('无 .env 时不抛错', () => {
        expect(() => loadDotEnv()).not.toThrow();
    });
});

describe('setupGracefulShutdown', () => {
    it('SIGTERM 后关闭服务并 exit(0)；dispose 后不再响应信号', async () => {
        const running = await startServer(createApp({ log: () => {} }));
        const exit = vi.fn();
        const log = vi.fn();
        const dispose = setupGracefulShutdown(running, log, exit);

        process.emit('SIGTERM', 'SIGTERM');

        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
        expect(running.server.listening).toBe(false);
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('SIGTERM') }),
        );

        dispose();
        process.emit('SIGINT', 'SIGINT');
        expect(exit).toHaveBeenCalledTimes(1);

        await running.close().catch(() => {});
    });
});
