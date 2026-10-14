/**
 * checkpointer 工厂：决定「会话状态存哪里」。
 *
 * checkpointer 是 LangGraph 的持久化抽象：图执行每一步，都会按 `thread_id`
 * 把状态快照写进去；下一次 invoke 时自动从快照恢复 —— 这就是多轮会话
 * 与「重启进程后继续聊」的实现机制。可选实现：
 *
 * - SQLite（默认，落盘）：`SqliteSaver.fromConnString(路径)`，跨进程存活；
 * - 内存（`new MemorySaver()`）：进程内、重启即丢；测试与演示够用。
 *
 * 两个实现细节：
 * 1. SQLite 文件路径可能是 `./data/agent.sqlite` 这种多层目录 —— better-sqlite3
 *    不会替你建目录，先 `mkdirSync(..., { recursive: true })` 保证存在；
 * 2. `':memory:'` 是 SQL 意义上的内存库标记：直接换成 MemorySaver 更直观
 *    （SQLite 的内存库是「每连接一个」，对多子图场景反而容易误解）。
 *
 * 工程坑（pnpm ≥ 10）：better-sqlite3 是原生模块，其安装脚本默认会被 pnpm
 * 拦截跳过 → 运行时找不到原生绑定。解法是在 package.json 声明
 * `pnpm.onlyBuiltDependencies: ["better-sqlite3"]` 显式放行构建。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

export function createCheckpointer(sqlitePath: string): BaseCheckpointSaver {
    if (sqlitePath === ':memory:') {
        return new MemorySaver();
    }
    const filePath = resolve(sqlitePath);
    mkdirSync(dirname(filePath), { recursive: true }); // 目录不存在则逐级创建
    return SqliteSaver.fromConnString(filePath);
}
