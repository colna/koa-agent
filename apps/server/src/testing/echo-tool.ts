/**
 * 测试夹具：最小回显工具 —— 用于在测试中驱动「工具调用回合」，
 * 不引入任何业务语义（原教学示例工具 calculator / current_time 已移除）。
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const echoTool = tool(async ({ text }) => `echo:${text}`, {
    name: 'echo',
    description: '原样回显输入（测试夹具）。',
    schema: z.object({ text: z.string().min(1) }),
});
