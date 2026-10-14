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
