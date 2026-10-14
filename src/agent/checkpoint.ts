import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

export function createCheckpointer(sqlitePath: string): BaseCheckpointSaver {
    if (sqlitePath === ':memory:') {
        return new MemorySaver();
    }
    const filePath = resolve(sqlitePath);
    mkdirSync(dirname(filePath), { recursive: true });
    return SqliteSaver.fromConnString(filePath);
}
