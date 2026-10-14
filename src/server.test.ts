import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { startServer } from './server.js';

describe('startServer', () => {
    it('随机端口可访问 /health，close 后端口释放', async () => {
        const running = await startServer(createApp({ log: () => {} }));
        expect(running.port).toBeGreaterThan(0);

        const res = await fetch(`${running.url}/health`);
        expect(res.status).toBe(200);

        await running.close();
        expect(running.server.listening).toBe(false);
        await expect(fetch(`${running.url}/health`)).rejects.toThrow();
    });
});
