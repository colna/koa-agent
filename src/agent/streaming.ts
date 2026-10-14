import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';

export class TokenStreamHandler extends BaseCallbackHandler {
    override name = 'TokenStreamHandler';
    lc_prefer_chat_model_stream_events = true;

    private current = '';
    private last = '';

    constructor(private readonly onDelta: (text: string) => void) {
        super();
    }

    override handleChatModelStreamEvent(event: ChatModelStreamEvent, _runId: string): void {
        switch (event.event) {
            case 'message-start':
                this.current = '';
                break;
            case 'content-block-delta':
                if (event.delta.type === 'text-delta' && event.delta.text.length > 0) {
                    this.current += event.delta.text;
                    this.onDelta(event.delta.text);
                }
                break;
            case 'message-finish':
                this.last = this.current;
                break;
            default:
                break;
        }
    }

    get reply(): string {
        return this.last.length > 0 ? this.last : this.current;
    }
}
