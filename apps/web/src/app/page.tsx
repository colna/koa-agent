/** 首页：单页聊天应用（布局骨架在 layout.tsx，交互全部在 Chat 客户端组件里）。 */
import { Chat } from '@/components/chat';

export default function Home() {
    return (
        <main className="mx-auto flex h-dvh w-full flex-col">
            <Chat />
        </main>
    );
}
