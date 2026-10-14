/**
 * 模型工厂：把 Config 变成可用的 ChatModel 实例。
 *
 * 要点：
 * - `configuration.baseURL` 指向 OpenAI 兼容端点 —— 一套代码同时兼容
 *   OpenAI 官方 / DeepSeek / 本地 vLLM 等，切换只改 .env；
 * - temperature: 0：输出尽量确定，便于调试与测试（生产可按需放开）；
 * - 这里只是「构造」不会发网络请求 —— 首次 invoke 才真正调模型，
 *   所以没有 key 也能启动服务（对话接口到运行时才会 502）。
 *
 * 测试中不使用 ChatOpenAI，而是注入 FakeChatModel（src/testing/fake-model.ts），
 * 保证测试全离线、零真实 Key。
 */
import { ChatOpenAI } from '@langchain/openai';
import type { Config } from '../config.js';

export function createModel(config: Config): ChatOpenAI {
    return new ChatOpenAI({
        model: config.OPENAI_MODEL,
        apiKey: config.OPENAI_API_KEY,
        temperature: 0,
        configuration: { baseURL: config.OPENAI_BASE_URL },
    });
}
