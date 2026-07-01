"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUp, ChevronRight, Database, Loader2, Upload, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { Message } from "@/lib/db/schema";
import { createSession } from "@/app/actions/sessions";
import {
  ArtifactRenderer,
  type ArtifactView,
} from "@/components/chat/artifact-renderer";

interface ChatProps {
  sessionId: string;
  initialMessages: Message[];
  initialArtifacts?: Artifact[];
  dataSource?: { id: string; type: string; name: string } | null;
}

/* DB Artifact shape (payload is Record<string, unknown>).
   Type union matches lib/db/schema.ts Artifact (includes "forecast" for forward-compat). */
interface Artifact {
  id: string;
  session_id: string;
  type: "chart" | "table" | "code" | "forecast" | "summary";
  payload: Record<string, unknown>;
  created_at: string;
}

interface StreamMessage {
  content?: string;
  error?: string;
  artifact?: ArtifactView;
  tool?: string;
  node?: string;
  thinking?: string;
}

/** Local message row that may carry artifacts produced in the same turn.
 *  `segments` preserves the interleaved order of text/artifacts produced
 *  during streaming; when present, MessageRow renders them in order instead
 *  of the legacy "content first, artifacts after" layout. */
interface ChatMessage extends Message {
  artifacts?: ArtifactView[];
  segments?: PendingItem[];
}

/** Ordered streaming item — rendered in arrival order so tool progress,
 *  artifacts, thinking, and text interleave naturally instead of being grouped. */
type PendingItem =
  | { kind: "tool"; tool: string; content: string }
  | { kind: "artifact"; artifact: ArtifactView }
  | { kind: "thinking"; content: string }
  | { kind: "text"; content: string };

export function Chat({
  sessionId,
  initialMessages,
  initialArtifacts = [],
  dataSource = null,
}: ChatProps) {
  const router = useRouter();
  // `sessionId` prop is "new" for a pending session (no DB row yet). The
  // first message (or file upload) creates the real session and we track
  // the resolved id here so subsequent actions use it.
  const [resolvedSessionId, setResolvedSessionId] = useState<string>(
    sessionId === "new" ? "" : sessionId,
  );
  const isPending = !resolvedSessionId;
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    attachInitialArtifacts(initialMessages, initialArtifacts),
  );
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Derived streaming text (concatenation of all text items, for final persist)
  const pendingAssistant = pendingItems
    .filter((it): it is { kind: "text"; content: string } => it.kind === "text")
    .map((it) => it.content)
    .join("");

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, pendingItems]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;

    // For a pending session ("new"), create the real DB session first.
    let activeSessionId = resolvedSessionId;
    if (!activeSessionId) {
      try {
        const session = await createSession();
        activeSessionId = session.id;
        setResolvedSessionId(session.id);
        // Replace the URL so the page is bookmarkable / refresh-safe.
        // Use replace (not push) so back button doesn't return to /chat/new.
        router.replace(`/chat/${session.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create session";
        toast.error(msg);
        return;
      }
    }

    const userMessage: ChatMessage = {
      id: `temp-${Date.now()}`,
      session_id: activeSessionId,
      role: "user",
      content: text,
      tool_calls: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setStreaming(true);
    setPendingItems([]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: activeSessionId, message: text }),
      });
      if (!res.ok || !res.body) {
        const errBody = await res.text();
        throw new Error(errBody || `Request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantContent = "";
      const collectedArtifacts: ArtifactView[] = [];
      const items: PendingItem[] = [];

      const pushItem = (item: PendingItem) => {
        // Consecutive chunks of the same kind (text↔text, thinking↔thinking)
        // merge into the last item so streaming tokens accumulate instead of
        // creating one PendingItem per token. All other event types start a
        // new item so the render order matches arrival.
        const last = items[items.length - 1];
        if (
          last &&
          ((last.kind === "text" && item.kind === "text") ||
            (last.kind === "thinking" && item.kind === "thinking"))
        ) {
          (last as { content: string }).content += item.content;
        } else {
          items.push(item);
        }
        setPendingItems([...items]);
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          const line = evt.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const data = JSON.parse(payload) as StreamMessage;
            if (data.error) throw new Error(data.error);
            if (data.thinking) {
              pushItem({ kind: "thinking", content: data.thinking });
            }
            if (data.tool) {
              // Tool messages also carry `content`, but we render them as
              // tool items only — skip the text path to avoid duplicates.
              pushItem({
                kind: "tool",
                tool: data.tool,
                content: data.content ?? "",
              });
            } else if (data.content) {
              assistantContent += data.content;
              pushItem({ kind: "text", content: data.content });
            }
            if (data.artifact) {
              const artifact: ArtifactView = {
                type: data.artifact.type,
                payload: data.artifact.payload,
                node: data.node,
              };
              collectedArtifacts.push(artifact);
              pushItem({ kind: "artifact", artifact });
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) continue;
            throw parseErr;
          }
        }
      }

      if (assistantContent || collectedArtifacts.length > 0) {
        const assistantMessage: ChatMessage = {
          id: `temp-${Date.now()}`,
          session_id: sessionId,
          role: "assistant",
          content: assistantContent,
          tool_calls: null,
          created_at: new Date().toISOString(),
          artifacts: collectedArtifacts,
          // Preserve full interleaved order (tool + artifact + text) so
          // MessageRow can render a collapsible "thinking process" section.
          segments: items,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Streaming failed";
      toast.error(msg);
    } finally {
      setPendingItems([]);
      setStreaming(false);
      inputRef.current?.focus();
    }
  }

  async function handleFileUpload(file: File) {
    if (uploading) return;

    // For a pending session ("new"), create the real DB session first —
    // upload needs a session_id to bind the data source.
    let activeSessionId = resolvedSessionId;
    if (!activeSessionId) {
      try {
        const session = await createSession();
        activeSessionId = session.id;
        setResolvedSessionId(session.id);
        router.replace(`/chat/${session.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create session";
        toast.error(msg);
        return;
      }
    }

    setUploading(true);
    const toastId = toast.loading(`Uploading ${file.name}…`);
    const formData = new FormData();
    formData.append("sessionId", activeSessionId);
    formData.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(errBody || `Upload failed: ${res.status}`);
      }
      const data = (await res.json()) as {
        filename: string;
        size: number;
        format: string;
        indexed: boolean;
        indexError?: string;
      };
      toast.success(`Uploaded ${data.filename}`, {
        id: toastId,
        description: data.indexed
          ? `${data.format} · ${formatBytes(data.size)} · schema indexed`
          : `${data.format} · ${formatBytes(data.size)}${
              data.indexError ? ` · index failed: ${data.indexError}` : ""
            }`,
      });
      // Refresh server component so the DataSourceBar updates
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast.error(msg, { id: toastId });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* ============================================================
          Data source status bar (also hosts the upload button)
          ============================================================ */}
      <DataSourceBar
        sessionId={resolvedSessionId || sessionId}
        dataSource={dataSource}
        uploading={uploading}
        onUpload={handleFileUpload}
      />

      {/* ============================================================
          Messages
          ============================================================ */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          {messages.length === 0 && !pendingAssistant && (
            <WelcomeState
              sessionId={resolvedSessionId || sessionId}
              hasDataSource={!!dataSource}
              uploading={uploading}
              onUpload={handleFileUpload}
            />
          )}

          <div className="space-y-8">
            {messages.map((m, idx) => (
              <MessageRow
                key={m.id}
                message={m}
                index={idx}
                isLast={idx === messages.length - 1 && pendingItems.length === 0}
              />
            ))}

            {/* Streaming turn: items rendered in arrival order so tool
                progress, artifacts, and text interleave naturally. */}
            {pendingItems.length > 0 && (
              <StreamingItemsView items={pendingItems} />
            )}

            {streaming &&
              pendingItems.length === 0 && <ThinkingIndicator />}
          </div>
        </div>
      </div>

      {/* ============================================================
          Composer
          ============================================================ */}
      <div className="border-t border-border bg-card/30">
        <form onSubmit={handleSubmit} className="mx-auto max-w-3xl px-6 py-4">
          <div className="group flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 pr-2 transition-colors focus-within:border-primary">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask anything about your data…"
              autoFocus
              className="h-8 flex-1 border-0 bg-transparent px-0 font-sans text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Button
              type="submit"
              size="icon"
              disabled={streaming || !input.trim()}
              className="h-8 w-8 shrink-0 rounded-full p-0 font-medium"
              aria-label="Send"
            >
              {streaming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="mt-2 px-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Press Enter to send · Shift+Enter for newline
          </p>
        </form>
      </div>
    </div>
  );
}

/* ============================================================
    Attach initial artifacts to their nearest preceding assistant message
    ============================================================ */

/** Reconstruct a turn's interleaved layout from persisted segments.
 *
 * Segments are stored on the assistant message's `tool_calls` jsonb column
 * (despite the column name, it holds our segment array — see route.ts).
 * Each segment is one of:
 *   { kind: "tool", tool, content }
 *   { kind: "thinking", content }
 *   { kind: "text", content }
 *   { kind: "artifact", artifactType, artifactIndex }
 *
 * `artifactIndex` is the 0-based position into the session's artifacts
 * array (sorted by created_at). We map it back to the actual ArtifactView
 * so MessageRow can render it inline.
 *
 * If a message has no persisted segments (e.g., user messages, or
 * assistant messages from before this feature), fall back to the legacy
 * time-based attachment so existing sessions still show their artifacts. */
function attachInitialArtifacts(
  messages: Message[],
  artifacts: Artifact[],
): ChatMessage[] {
  const sortedArtifacts = [...artifacts].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const result: ChatMessage[] = messages.map((m) => ({ ...m }));
  let legacyArtifactIdx = 0;

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (msg.role !== "assistant") continue;

    // Try to rebuild from persisted segments first.
    const rawSegments = msg.tool_calls as unknown;
    if (Array.isArray(rawSegments) && rawSegments.length > 0) {
      const rebuilt: PendingItem[] = [];
      for (const seg of rawSegments as Array<Record<string, unknown>>) {
        if (seg.kind === "tool" && typeof seg.tool === "string" && typeof seg.content === "string") {
          rebuilt.push({ kind: "tool", tool: seg.tool, content: seg.content });
        } else if (seg.kind === "thinking" && typeof seg.content === "string") {
          rebuilt.push({ kind: "thinking", content: seg.content });
        } else if (seg.kind === "text" && typeof seg.content === "string") {
          rebuilt.push({ kind: "text", content: seg.content });
        } else if (
          seg.kind === "artifact" &&
          typeof seg.artifactIndex === "number" &&
          sortedArtifacts[seg.artifactIndex]
        ) {
          const art = sortedArtifacts[seg.artifactIndex];
          rebuilt.push({
            kind: "artifact",
            artifact: {
              type: art.type,
              payload: art.payload as unknown as ArtifactView["payload"],
            },
          });
        }
      }
      if (rebuilt.length > 0) {
        msg.segments = rebuilt;
        // Also populate `artifacts` for any legacy code paths that still
        // read it (none currently, but keeps the shape consistent).
        msg.artifacts = rebuilt
          .filter(
            (it): it is { kind: "artifact"; artifact: ArtifactView } =>
              it.kind === "artifact",
          )
          .map((it) => it.artifact);
        continue;
      }
    }

    // Legacy fallback: attach artifacts by timestamp proximity.
    if (sortedArtifacts.length === 0) continue;
    const nextMsg = result[i + 1];
    const nextTime = nextMsg
      ? new Date(nextMsg.created_at).getTime()
      : Number.POSITIVE_INFINITY;
    const collected: ArtifactView[] = [];
    while (legacyArtifactIdx < sortedArtifacts.length) {
      const art = sortedArtifacts[legacyArtifactIdx];
      const artTime = new Date(art.created_at).getTime();
      const msgTime = new Date(msg.created_at).getTime();
      if (artTime >= msgTime && artTime < nextTime) {
        collected.push({
          type: art.type,
          payload: art.payload as unknown as ArtifactView["payload"],
        });
        legacyArtifactIdx++;
      } else if (artTime >= nextTime) {
        break;
      } else {
        legacyArtifactIdx++;
      }
    }
    if (collected.length > 0) {
      msg.artifacts = collected;
    }
  }

  return result;
}

/* ============================================================
    Data source status bar
    ============================================================ */

function DataSourceBar({
  sessionId,
  dataSource,
  uploading,
  onUpload,
}: {
  sessionId: string;
  dataSource: { id: string; type: string; name: string } | null;
  uploading: boolean;
  onUpload: (file: File) => void;
}) {
  return (
    <div
      className={`flex items-center justify-between border-b border-border px-6 py-2 ${
        dataSource ? "bg-muted/30" : "bg-muted/20"
      }`}
    >
      <div className="flex items-center gap-2">
        <Database className="h-3.5 w-3.5 text-muted-foreground" />
        {dataSource ? (
          <>
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {dataSource.type === "pg" ? "Postgres" : dataSource.type}
            </span>
            <span className="font-mono text-sm font-medium text-foreground">
              {dataSource.name}
            </span>
          </>
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            No data source
          </span>
        )}
      </div>

      {/* Right side: upload link + connect/switch link */}
      <div className="flex items-center gap-3">
        {uploading ? (
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Uploading
          </span>
        ) : (
          <label
            className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
            title="Upload CSV / Excel / Parquet"
          >
            Upload file
            <input
              type="file"
              className="hidden"
              accept=".csv,.xlsx,.xls,.parquet"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(file);
                e.target.value = "";
              }}
            />
          </label>
        )}
        <Link
          href={`/sources/new?sessionId=${sessionId}`}
          className={`font-mono text-[10px] uppercase tracking-wider transition-colors ${
            dataSource
              ? "text-muted-foreground hover:text-foreground"
              : "text-primary hover:text-primary/80"
          }`}
        >
          Connect Postgres
        </Link>
      </div>
    </div>
  );
}

/* ============================================================
    Welcome state
    ============================================================ */

function WelcomeState({
  sessionId,
  hasDataSource,
  uploading,
  onUpload,
}: {
  sessionId: string;
  hasDataSource: boolean;
  uploading: boolean;
  onUpload: (file: File) => void;
}) {
  return (
    <div className="mb-12 flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-16 text-center">
      <div className="flex items-center gap-3">
        {!hasDataSource && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/sources/new?sessionId=${sessionId}`}>
              <Database className="h-3.5 w-3.5" />
              Connect a Postgres database
            </Link>
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={uploading}
          asChild
        >
          {uploading ? (
            <span>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Uploading
            </span>
          ) : (
            <label className="cursor-pointer">
              <Upload className="h-3.5 w-3.5" />
              Upload file
              <input
                type="file"
                className="hidden"
                accept=".csv,.xlsx,.xls,.parquet"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUpload(file);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </Button>
      </div>
    </div>
  );
}

/* ============================================================
    Message row
    ============================================================ */

function MessageRow({
  message,
  index,
  streaming = false,
  isLast = false,
}: {
  message: ChatMessage;
  index: number;
  streaming?: boolean;
  isLast?: boolean;
}) {
  const isUser = message.role === "user";
  const num = String(index + 1).padStart(2, "0");
  const artifacts = message.artifacts ?? [];
  const segments = message.segments;
  const grouped = segments ? groupSegments(segments) : [];

  return (
    <article
      className={`animate-fade-up ${isLast ? "" : "opacity-90"}`}
      style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
    >
      {/* Role label */}
      <div className="mb-2 flex items-center gap-3">
        <span className="font-mono text-[10px] text-muted-foreground">
          {num}
        </span>
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.2em] ${
            isUser ? "text-primary" : "text-muted-foreground"
          }`}
        >
          {isUser ? "You" : "Datellix"}
        </span>
        {streaming && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-primary animate-pulse-dot">
            streaming
          </span>
        )}
      </div>

      {/* Interleaved segments: tool steps render inline (not collapsed);
          only thinking chunks are grouped into collapsible blocks. */}
      {segments && segments.length > 0 ? (
        <div className="ml-7 space-y-3">
          {grouped.map((group, i) => {
            if (group.type === "thinking") {
              return <ThinkingProcess key={i} items={group.items} />;
            }
            if (group.type === "artifact") {
              return <ArtifactRenderer key={i} artifact={group.item.artifact} />;
            }
            if (group.type === "tool") {
              return (
                <ToolStepView
                  key={i}
                  tool={group.item.tool}
                  content={group.item.content}
                />
              );
            }
            return (
              <div
                key={i}
                className="whitespace-pre-wrap border-l-2 border-border pl-4 text-[15px] leading-relaxed text-foreground"
              >
                {group.item.content}
                {streaming && i === grouped.length - 1 && (
                  <span className="ml-0.5 inline-block h-4 w-2 bg-primary animate-caret" />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          {/* Content (legacy / user messages / DB-loaded messages) */}
          {message.content ? (
            <div
              className={`ml-7 whitespace-pre-wrap border-l-2 pl-4 text-[15px] leading-relaxed ${
                isUser
                  ? "border-primary text-foreground"
                  : "border-border text-foreground"
              }`}
            >
              {message.content}
              {streaming && (
                <span className="ml-0.5 inline-block h-4 w-2 bg-primary animate-caret" />
              )}
            </div>
          ) : streaming ? (
            <div className="ml-7 border-l-2 border-border pl-4 text-muted-foreground">
              …
            </div>
          ) : null}

          {/* Inline artifacts attached to this message */}
          {artifacts.length > 0 && (
            <div className="mt-3 ml-7 space-y-3">
              {artifacts.map((artifact, i) => (
                <ArtifactRenderer key={i} artifact={artifact} />
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}

/* ============================================================
    Segment grouping + collapsible thinking process
    ============================================================ */

type SegmentGroup =
  | {
      type: "thinking";
      items: { kind: "thinking"; content: string }[];
    }
  | {
      type: "tool";
      item: { kind: "tool"; tool: string; content: string };
    }
  | { type: "artifact"; item: { kind: "artifact"; artifact: ArtifactView } }
  | { type: "text"; item: { kind: "text"; content: string } };

/** Group consecutive thinking chunks into collapsible "thinking" blocks.
 *  Tool steps, artifacts, and text pass through as individual groups,
 *  preserving arrival order. Tool output is NOT collapsed — only model
 *  reasoning (thinking) is. */
function groupSegments(segments: PendingItem[]): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const seg of segments) {
    if (seg.kind === "thinking") {
      const last = groups[groups.length - 1];
      if (last && last.type === "thinking") {
        last.items.push({ kind: "thinking", content: seg.content });
      } else {
        groups.push({
          type: "thinking",
          items: [{ kind: "thinking", content: seg.content }],
        });
      }
    } else if (seg.kind === "tool") {
      groups.push({
        type: "tool",
        item: { kind: "tool", tool: seg.tool, content: seg.content },
      });
    } else if (seg.kind === "artifact") {
      groups.push({ type: "artifact", item: seg });
    } else {
      groups.push({ type: "text", item: seg });
    }
  }
  return groups;
}

/** Inline render of a single tool step. Collapsible after execution
 *  completes — only the title row (wrench + node name) is shown by
 *  default; click to expand the full content. During streaming,
 *  `defaultOpen` is set so the user sees live tool output. */
function ToolStepView({
  tool,
  content,
  defaultOpen = false,
}: {
  tool: string;
  content: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-l-2 border-primary/30 pl-4 text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
        />
        <Wrench className="h-3 w-3 shrink-0 text-primary/60" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-primary/70">
          {tool}
        </span>
      </button>
      {open && (
        <p className="mt-1.5 whitespace-pre-wrap pl-5 font-mono text-xs leading-relaxed">
          {content}
        </p>
      )}
    </div>
  );
}

function ThinkingProcess({
  items,
}: {
  items: { kind: "thinking"; content: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-l-2 border-primary/20 pl-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform duration-200 ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="font-mono text-[10px] uppercase tracking-wider text-primary/70">
          Thinking process
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {items.length} {items.length === 1 ? "step" : "steps"}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {items.map((item, i) => (
            <div
              key={i}
              className="flex items-start gap-2 text-muted-foreground"
            >
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40" />
              <div className="flex-1">
                <p className="font-mono text-xs leading-relaxed">
                  {truncate(item.content, 240)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
    Streaming items (tool / artifact / text in arrival order)
    ============================================================ */

function StreamingItemsView({ items }: { items: PendingItem[] }) {
  return (
    <div className="animate-fade-up space-y-4">
      <div className="mb-2 flex items-center gap-3">
        <span className="font-mono text-[10px] text-muted-foreground">
          {String(items.length).padStart(2, "0")}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Datellix
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-primary animate-pulse-dot">
          streaming
        </span>
      </div>

      <div className="ml-7 space-y-4">
        {items.map((item, i) => {
          if (item.kind === "tool") {
            return (
              <ToolStepView
                key={i}
                tool={item.tool}
                content={item.content}
                defaultOpen
              />
            );
          }
          if (item.kind === "thinking") {
            return (
              <div
                key={i}
                className="flex items-start gap-2 border-l-2 border-primary/30 pl-4 text-muted-foreground"
              >
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60 animate-pulse-dot" />
                <div className="flex-1">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-primary/70">
                    thinking
                  </span>
                  <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
                    {item.content}
                  </p>
                </div>
              </div>
            );
          }
          if (item.kind === "artifact") {
            return <ArtifactRenderer key={i} artifact={item.artifact} />;
          }
          // text
          return (
            <div
              key={i}
              className="border-l-2 border-border pl-4 text-[15px] leading-relaxed text-foreground"
            >
              {item.content}
              {i === items.length - 1 && (
                <span className="ml-0.5 inline-block h-4 w-2 bg-primary animate-caret" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
    Thinking indicator
    ============================================================ */

function ThinkingIndicator() {
  return (
    <div className="animate-fade-up">
      <div className="mb-2 flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Datellix
        </span>
      </div>
      <div className="ml-7 flex items-center gap-1.5 border-l-2 border-border pl-4 text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-dot" />
        <span className="font-mono text-xs">thinking…</span>
      </div>
    </div>
  );
}

/* ============================================================
    Utilities
    ============================================================ */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}
