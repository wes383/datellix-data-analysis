import { Chat } from "@/components/chat/chat";

/**
 * Pending new-session page.
 *
 * Visited when the user clicks "New session" but hasn't sent the first
 * message yet — no `sessions` row is created until the first message is
 * submitted (see Chat.tsx). This keeps the sidebar free of empty
 * "New analysis session" entries.
 */
export default function NewSessionPage() {
  return (
    <Chat
      sessionId="new"
      initialMessages={[]}
      initialArtifacts={[]}
      dataSource={null}
    />
  );
}
