import type { ServerResponse } from 'node:http';

export function initSse(res: ServerResponse): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
}

export function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
    if (res.writableEnded) {
        return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function writeSseComment(res: ServerResponse, comment: string): void {
    if (res.writableEnded) {
        return;
    }
    res.write(`: ${comment}\n\n`);
}
