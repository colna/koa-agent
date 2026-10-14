/**
 * 输入区（底部胶囊条）：自增长 textarea + 发送/停止按钮。
 * 细节：
 * - Enter 发送、Shift+Enter 换行；中文输入法组合期间 Enter 不触发发送（isComposing）；
 * - 流式中按钮变为「停止」（蓝色圆钮 ↔ 深色方钮）。
 */
import type { KeyboardEvent } from 'react';
import { useState } from 'react';

export interface ComposerProps {
    busy: boolean;
    onSend: (text: string) => void;
    onStop: () => void;
}

export function Composer({ busy, onSend, onStop }: ComposerProps) {
    const [value, setValue] = useState('');

    function submit() {
        const text = value.trim();
        if (text.length === 0 || busy) {
            return;
        }
        onSend(text);
        setValue('');
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
        }
    }

    return (
        <div className="mx-auto flex w-full max-w-[720px] items-end gap-2 p-4">
            <textarea
                aria-label="输入消息"
                rows={1}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                className="field-sizing-content max-h-40 min-h-[44px] flex-1 resize-none rounded-[22px] border border-hairline bg-surface-raised px-4 py-2.5 text-[15px] leading-[1.47] text-ink shadow-card outline-none placeholder:text-ink-secondary focus:ring-2 focus:ring-accent/40"
            />
            {busy ? (
                <button
                    type="button"
                    aria-label="停止生成"
                    onClick={onStop}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-white transition hover:opacity-80"
                >
                    <span className="size-3 rounded-[3px] bg-white" />
                </button>
            ) : (
                <button
                    type="button"
                    aria-label="发送"
                    onClick={submit}
                    disabled={value.trim().length === 0}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:bg-accent-hover disabled:opacity-30"
                >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                        <path
                            d="M8 13.5V3.5M8 3.5L3.5 8M8 3.5L12.5 8"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                </button>
            )}
        </div>
    );
}
