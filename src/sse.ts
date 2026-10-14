/**
 * SSE（Server-Sent Events）写出工具 —— 本项目流式对话的「线上格式」层。
 *
 * SSE 帧格式（每帧 = 若干行 + 一个空行结尾）：
 *     event: message.delta        ← 事件名（客户端按名监听）
 *     data: {"text":"你"}         ← 一行 JSON（字符串内不能有裸换行）
 *     （空行）                     ← 帧结束标记
 *
 * 注释帧（以 `:` 开头的行）是协议自带的心跳机制：客户端会忽略其内容，
 * 但能保活中间代理的长连接（路由里每 15s 发一次 `: ping`）。
 *
 * 备注：这里直接操作原生 ServerResponse —— 因为流式响应由路由接管
 * （ctx.respond = false），不再经过 Koa 的响应封装。
 */
import type { ServerResponse } from 'node:http';

/**
 * 写出 SSE 响应头。X-Accel-Buffering: no 用于让 nginx 等反向代理关闭缓冲，
 * 否则增量会在代理层被攒住，实时性丢失。
 */
export function initSse(res: ServerResponse): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
}

/**
 * 写一帧事件。writableEnded 防护：客户端提前断开后不再写入，
 * 避免向已结束的流写入报错。
 */
export function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
    if (res.writableEnded) {
        return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 写注释帧（心跳保活）。 */
export function writeSseComment(res: ServerResponse, comment: string): void {
    if (res.writableEnded) {
        return;
    }
    res.write(`: ${comment}\n\n`);
}
