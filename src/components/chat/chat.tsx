"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ChevronRight, Database, Loader2, Plus, Square, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { toast } from "sonner";
import type { Message } from "@/lib/db/schema";
import { createSession } from "@/app/actions/sessions";
import {
  ArtifactRenderer,
  type ArtifactView,
} from "@/components/chat/artifact-renderer";
import { Markdown } from "@/components/chat/markdown";
import { AddDataSourceDialog } from "@/components/chat/add-data-source-dialog";

/** Existing DB data source shape passed from the server to the client.
 *  Mirrors the `ExistingSource` type in add-data-source-dialog.tsx. */
interface ExistingSource {
  id: string;
  type: string;
  name: string;
  meta: Record<string, unknown>;
}

/** Discriminated union for the data source bound to a session.
 *  - database mode: a single DB data source (pg/mysql/bigquery/duckdb/sqlite)
 *    bound via sessions.data_source_id
 *  - files mode: one or more file data sources bound via session_data_sources
 *  The two modes are mutually exclusive (enforced by the backend). */
type DataSourceProp =
  | { mode: "database"; data: { id: string; type: string; name: string } }
  | {
      mode: "files";
      files: { id: string; name: string; format: string; size: number }[];
    }
  | null;

interface ChatProps {
  sessionId: string;
  initialMessages: Message[];
  initialArtifacts?: Artifact[];
  dataSource?: DataSourceProp;
  existingSources?: ExistingSource[];
  /** Models available for switching in the chat composer. Populated from
   *  the user's custom LLM config. Empty when using project default or
   *  when only one model is configured (nothing to switch). */
  availableModels?: string[];
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
  // AIMessage text token (narration + final answer)
  content?: string;
  // AIMessage reasoning_content token (collapsible CoT)
  thinking?: string;
  // LLM started calling a tool. For run_python the server may attach
  // the source code directly (when args streamed fully before the id+name
  // was announced) so the UI can render it on the very first paint.
  tool_call?: { id: string; name: string; code?: string };
  // Tool finished executing
  tool_result?: { id: string; name: string; content: string };
  // Intermediate progress for a long-running tool (e.g. run_python code preview)
  tool_progress?: { id: string; name: string; type: string; code?: string };
  // Artifact produced by a content_and_artifact tool
  artifact?: ArtifactView;
  toolCallId?: string;
  error?: string;
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
 *  artifacts, thinking, and text interleave naturally instead of being grouped.
 *  Tool items carry `id` (tool_call_id) so a later tool_result event can fill
 *  in the content, and `completed` to toggle the running spinner. */
type PendingItem =
  | {
      kind: "tool";
      id: string;
      tool: string;
      content: string;
      completed: boolean;
      code?: string;
    }
  | { kind: "artifact"; artifact: ArtifactView }
  | { kind: "thinking"; content: string }
  | { kind: "text"; content: string };

// localStorage key prefix for per-session composer drafts.
// Keyed by sessionId so each session keeps its own draft across refreshes.
const DRAFT_KEY_PREFIX = "datellix:draft:";

function draftKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

function readDraft(sessionId: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(draftKey(sessionId)) ?? "";
  } catch {
    // localStorage may be unavailable (private mode, disabled) — silently skip.
    return "";
  }
}

function writeDraft(sessionId: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(draftKey(sessionId), value);
    } else {
      window.localStorage.removeItem(draftKey(sessionId));
    }
  } catch {
    // Ignore write failures — drafts are a best-effort convenience.
  }
}

export function Chat({
  sessionId,
  initialMessages,
  initialArtifacts = [],
  dataSource = null,
  existingSources = [],
  availableModels = [],
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
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  // Track which file data source is currently being removed (Task 19) so we
  // can disable its X button and show a spinner.
  const [removingFileId, setRemovingFileId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // AbortController for the current streaming request. When the user clicks
  // the stop button (or the page unloads), we call .abort() to cancel the
  // fetch — the server detects the disconnect and persists partial output.
  const abortControllerRef = useRef<AbortController | null>(null);
  // Debounce timer for writing the draft to localStorage — avoids a write
  // on every keystroke.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- Model selector state ----
  // The currently selected model. Persisted per-session in localStorage so
  // the user's choice survives page refresh. Defaults to availableModels[0].
  const [selectedModel, setSelectedModel] = useState<string>("");
  const showModelSelector = availableModels.length > 1;

  useEffect(() => {
    if (!showModelSelector) {
      setSelectedModel("");
      return;
    }
    // Restore from localStorage, falling back to the first model.
    const stored = (() => {
      try {
        return localStorage.getItem(`datellix:model:${sessionId}`) ?? "";
      } catch {
        return "";
      }
    })();
    // If the stored model is no longer in the list (user edited settings),
    // fall back to the first available.
    if (stored && availableModels.includes(stored)) {
      setSelectedModel(stored);
    } else {
      setSelectedModel(availableModels[0] ?? "");
    }
  }, [sessionId, availableModels, showModelSelector]);

  function handleModelChange(model: string) {
    setSelectedModel(model);
    try {
      localStorage.setItem(`datellix:model:${sessionId}`, model);
    } catch {
      // Ignore — best-effort persistence.
    }
  }

  // Restore the draft for this session on mount / sessionId change.
  // Done in an effect (not a lazy useState initializer) so SSR and the first
  // client render agree on the textarea value, avoiding hydration mismatch.
  useEffect(() => {
    const draft = readDraft(sessionId);
    if (draft) {
      setInput(draft);
      // Sync textarea height to restored content on the next frame.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        }
      });
    }
  }, [sessionId]);

  // Persist input changes to localStorage with a small debounce so we don't
  // hit the API on every keystroke. Cleared on submit / unmount.
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  // Abort the streaming fetch when the page is closed/refreshed so the
  // server detects the disconnect and persists partial AI output.
  useEffect(() => {
    function handleBeforeUnload() {
      abortControllerRef.current?.abort();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

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
    let isNewSession = false;
    if (!activeSessionId) {
      try {
        const session = await createSession();
        activeSessionId = session.id;
        setResolvedSessionId(session.id);
        isNewSession = true;
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
    // Clear the saved draft — the message has been sent, no need to restore.
    writeDraft(sessionId, "");
    setStreaming(true);
    setPendingItems([]);

    // Declare accumulators before try so they're accessible in catch (for
    // preserving partial output on abort / error).
    let assistantContent = "";
    const collectedArtifacts: ArtifactView[] = [];
    const items: PendingItem[] = [];

    const pushItem = (item: PendingItem) => {
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

    // Create an AbortController for this request so the user can interrupt
    // streaming. Also aborted on page unload (see beforeunload effect).
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSessionId,
          message: text,
          ...(selectedModel && { model: selectedModel }),
        }),
        signal: abortController.signal,
      });
      if (!res.ok || !res.body) {
        const errBody = await res.text();
        throw new Error(errBody || `Request failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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

            if (data.tool_call) {
              pushItem({
                kind: "tool",
                id: data.tool_call.id,
                tool: data.tool_call.name,
                content: "",
                code: data.tool_call.code,
                completed: false,
              });
            }

            if (data.tool_progress) {
              const tp = data.tool_progress;
              const existing = items.find(
                (it): it is Extract<PendingItem, { kind: "tool" }> =>
                  it.kind === "tool" && it.id === tp.id,
              );
              if (existing && tp.code) {
                existing.code = tp.code;
                setPendingItems([...items]);
              }
            }

            if (data.tool_result) {
              const tr = data.tool_result;
              const existing = items.find(
                (it): it is Extract<PendingItem, { kind: "tool" }> =>
                  it.kind === "tool" && it.id === tr.id,
              );
              if (existing) {
                existing.content = tr.content;
                existing.completed = true;
              } else {
                pushItem({
                  kind: "tool",
                  id: tr.id,
                  tool: tr.name,
                  content: tr.content,
                  completed: true,
                });
              }
              setPendingItems([...items]);
            }

            if (data.thinking) {
              pushItem({ kind: "thinking", content: data.thinking });
            }

            if (data.content) {
              assistantContent += data.content;
              pushItem({ kind: "text", content: data.content });
            }

            if (data.artifact) {
              const artifact: ArtifactView = {
                type: data.artifact.type,
                payload: data.artifact.payload,
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

      // Normal completion — add the assistant message to local state.
      if (assistantContent || collectedArtifacts.length > 0 || items.length > 0) {
        const assistantMessage: ChatMessage = {
          id: `temp-${Date.now()}`,
          session_id: activeSessionId,
          role: "assistant",
          content: assistantContent,
          tool_calls: null,
          created_at: new Date().toISOString(),
          artifacts: collectedArtifacts,
          segments: items,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      }
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("aborted"));

      if (isAbort) {
        // User clicked stop (or page unloaded). Preserve whatever the AI
        // already produced so it isn't lost. The server also persists this
        // partial output to the database (in its finally block), so it
        // survives a page refresh.
        if (assistantContent || collectedArtifacts.length > 0 || items.length > 0) {
          const assistantMessage: ChatMessage = {
            id: `temp-${Date.now()}`,
            session_id: activeSessionId,
            role: "assistant",
            content: assistantContent,
            tool_calls: null,
            created_at: new Date().toISOString(),
            artifacts: collectedArtifacts,
            segments: items,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        }
        // No error toast for user-initiated abort.
      } else {
        const msg = err instanceof Error ? err.message : "Streaming failed";
        toast.error(msg);
      }
    } finally {
      setPendingItems([]);
      setStreaming(false);
      abortControllerRef.current = null;
      inputRef.current?.focus();
      if (isNewSession && activeSessionId) {
        router.replace(`/chat/${activeSessionId}`);
      }
      // Always refresh so the sidebar reflects the latest session title
      // (the API route updates the title from the first user message).
      router.refresh();
    }
  }

  /** Stop the current AI stream. Already-output content is preserved. */
  function handleStop() {
    abortControllerRef.current?.abort();
  }

  async function handleRemoveFile(fileId: string) {
    // Remove a file data source from the current session (multi-file mode).
    // Calls DELETE /api/sources/[id]?sessionId=... then refreshes the
    // server component so the DataSourceBar re-renders without the file.
    const activeSessionId = resolvedSessionId || sessionId;
    if (!activeSessionId) return;
    if (removingFileId) return; // prevent concurrent removals

    setRemovingFileId(fileId);
    try {
      const res = await fetch(
        `/api/sources/${fileId}?sessionId=${encodeURIComponent(activeSessionId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(errBody || `Remove failed: ${res.status}`);
      }
      toast.success("Data source disconnected");
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Remove failed";
      toast.error(msg);
    } finally {
      setRemovingFileId(null);
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
        onRemoveFile={handleRemoveFile}
        removingFileId={removingFileId}
        existingSources={existingSources}
      />

      {/* ============================================================
          Messages
          ============================================================ */}
      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
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
          <div className="group flex items-end gap-2 rounded-3xl border border-border bg-card pl-6 py-2 pr-2 transition-colors focus-within:border-primary">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                const value = e.target.value;
                setInput(value);
                // Auto-resize: grow with content up to a max height, then scroll.
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
                // Persist to localStorage (debounced) so a refresh restores
                // the in-progress text instead of losing it.
                if (draftTimer.current) clearTimeout(draftTimer.current);
                draftTimer.current = setTimeout(() => {
                  writeDraft(sessionId, value);
                }, 300);
              }}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter inserts a newline (default behavior).
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (input.trim() && !streaming) {
                    e.currentTarget.form?.requestSubmit();
                  }
                }
              }}
              placeholder="Ask anything about your data…"
              autoFocus
              rows={1}
              className="max-h-[200px] flex-1 resize-none border-0 bg-transparent px-0 py-1.5 font-sans text-sm shadow-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {showModelSelector && (
              <Select
                value={selectedModel}
                onChange={handleModelChange}
                variant="pill"
                options={availableModels.map((m) => ({ value: m, label: m }))}
                className="shrink-0"
              />
            )}
            {streaming ? (
              <Button
                type="button"
                size="icon"
                onClick={handleStop}
                className="h-8 w-8 shrink-0 self-end rounded-full p-0 font-medium"
                aria-label="Stop"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim()}
                className="h-8 w-8 shrink-0 self-end rounded-full p-0 font-medium"
                aria-label="Send"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
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
 *   { kind: "tool", id, tool, content }   // id = tool_call_id
 *   { kind: "text", content }
 *   { kind: "artifact", artifactType, artifactIndex }
 *
 * Thinking segments are NOT persisted by route.ts (ephemeral CoT), so we
 * don't expect them here — but we handle them defensively in case an older
 * session still has them.
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
        if (
          seg.kind === "tool" &&
          typeof seg.tool === "string" &&
          typeof seg.content === "string"
        ) {
          // Tool segments are distinct per tool_call_id — never merge.
          // Preserve `code` (run_python source) so the UI can render the
          // collapsible code block on replay.
          rebuilt.push({
            kind: "tool",
            id: typeof seg.id === "string" ? seg.id : "",
            tool: seg.tool,
            content: seg.content,
            completed: true,
            code: typeof seg.code === "string" ? seg.code : undefined,
          });
        } else if (seg.kind === "thinking" && typeof seg.content === "string") {
          const last = rebuilt[rebuilt.length - 1];
          if (last && last.kind === "thinking") {
            last.content += seg.content;
          } else {
            rebuilt.push({ kind: "thinking", content: seg.content });
          }
        } else if (seg.kind === "text" && typeof seg.content === "string") {
          const last = rebuilt[rebuilt.length - 1];
          if (last && last.kind === "text") {
            last.content += seg.content;
          } else {
            rebuilt.push({ kind: "text", content: seg.content });
          }
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

/** Map an internal data source type to a human-readable label. */
function dbTypeLabel(type: string): string {
  switch (type) {
    case "pg":
      return "Postgres";
    case "mysql":
      return "MySQL";
    case "bigquery":
      return "BigQuery";
    case "duckdb":
      return "DuckDB";
    case "sqlite":
      return "SQLite";
    default:
      return type;
  }
}

function DataSourceBar({
  sessionId,
  dataSource,
  onRemoveFile,
  removingFileId,
  existingSources,
}: {
  sessionId: string;
  dataSource: DataSourceProp;
  onRemoveFile: (fileId: string) => void;
  removingFileId: string | null;
  existingSources: ExistingSource[];
}) {
  const hasDataSource = !!dataSource;

  return (
    <div
      className={`flex items-center justify-between border-b border-border px-6 py-2 ${
        hasDataSource ? "bg-muted/30" : "bg-muted/20"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {dataSource?.mode === "database" ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {dbTypeLabel(dataSource.data.type)}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              <span className="truncate max-w-[12rem]" title={dataSource.data.name}>
                {dataSource.data.name}
              </span>
              <button
                type="button"
                onClick={() => onRemoveFile(dataSource.data.id)}
                disabled={removingFileId === dataSource.data.id}
                aria-label={`Disconnect ${dataSource.data.name}`}
                className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              >
                {removingFileId === dataSource.data.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <X className="h-3 w-3" />
                )}
              </button>
            </span>
          </div>
        ) : dataSource?.mode === "files" ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              {dataSource.files.length} file{dataSource.files.length === 1 ? "" : "s"}
            </span>
            {dataSource.files.map((f) => {
              const isRemoving = removingFileId === f.id;
              return (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1.5 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                >
                  <span className="max-w-[12rem] truncate" title={f.name}>
                    {f.name}
                  </span>
                  <span className="text-muted-foreground">
                    {f.format}·{formatBytes(f.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveFile(f.id)}
                    disabled={isRemoving}
                    aria-label={`Remove ${f.name}`}
                    className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                  >
                    {isRemoving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                  </button>
                </span>
              );
            })}
          </div>
        ) : (
          <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            No data source
          </span>
        )}
      </div>

      {/* Right side: single "Add data source" trigger */}
      <div className="flex shrink-0 items-center">
        <AddDataSourceDialog
          sessionId={sessionId}
          hasDataSource={hasDataSource}
          dataSourceMode={
            dataSource?.mode === "database"
              ? "database"
              : dataSource?.mode === "files"
                ? "files"
                : null
          }
          existingSources={existingSources}
          trigger={
            <Button variant="outline" size="sm">
              <Plus className="h-3.5 w-3.5" />
              Add data source
            </Button>
          }
        />
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
                  code={group.item.code}
                  running={!group.item.completed}
                />
              );
            }
            return (
              <div
                key={i}
                className={`border-l-2 border-border pl-4 text-[15px] leading-relaxed text-foreground ${
                  isUser ? "whitespace-pre-wrap" : ""
                }`}
              >
                {isUser ? (
                  group.item.content
                ) : (
                  <Markdown content={group.item.content} />
                )}
                {streaming && i === grouped.length - 1 && (
                  <span className="ml-0.5 inline-block h-4 w-2 bg-primary animate-caret text-foreground align-middle" />
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
              className={`ml-7 border-l-2 pl-4 text-[15px] leading-relaxed ${
                isUser
                  ? "border-primary text-foreground whitespace-pre-wrap"
                  : "border-border text-foreground"
              }`}
            >
              {isUser ? (
                message.content
              ) : (
                <Markdown content={message.content} />
              )}
              {streaming && (
                <span className="ml-0.5 inline-block h-4 w-2 bg-primary animate-caret text-foreground align-middle" />
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
      item: {
        kind: "tool";
        id: string;
        tool: string;
        content: string;
        completed: boolean;
        code?: string;
      };
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
        item: {
          kind: "tool",
          id: seg.id,
          tool: seg.tool,
          content: seg.content,
          completed: seg.completed,
          code: seg.code,
        },
      });
    } else if (seg.kind === "artifact") {
      groups.push({ type: "artifact", item: seg });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.type === "text") {
        last.item.content += seg.content;
      } else {
        groups.push({
          type: "text",
          item: { kind: "text", content: seg.content },
        });
      }
    }
  }
  return groups;
}

/** Inline render of a single tool step. Collapsible — only the title row
 *  (wrench + node name) is shown by default; click to expand the full
 *  content. During streaming, `defaultOpen` is set so the user sees live
 *  tool output and the run_python code. When the tool finishes (running
 *  flips to false), the panel auto-collapses to keep the chat history
 *  tidy; the user can click to re-expand and view the code/output. */
function ToolStepView({
  tool,
  content,
  code,
  defaultOpen = false,
  running = false,
}: {
  tool: string;
  content: string;
  code?: string;
  defaultOpen?: boolean;
  running?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Auto-collapse as soon as the tool finishes (running flips to false).
  useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);
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
        {running && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/60" />
        )}
      </button>
      {open && (code || content) && (
        <div className="mt-1.5 space-y-3 pl-5">
          {code && (
            <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">
              <code>{code}</code>
            </pre>
          )}
          {content && (
            <p className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {content}
            </p>
          )}
        </div>
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
                code={item.code}
                defaultOpen
                running={!item.completed}
              />
            );
          }
          if (item.kind === "thinking") {
            const isLast = i === items.length - 1;
            if (isLast) {
              // Still thinking — show live content with a pulsing dot.
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
            // Thinking finished — collapse it (reuse ThinkingProcess which
            // defaults to closed). This folds each thinking block as soon as
            // the agent moves on to text/tool/artifact output.
            return (
              <ThinkingProcess
                key={i}
                items={[{ kind: "thinking", content: item.content }]}
              />
            );
          }
          if (item.kind === "artifact") {
            return <ArtifactRenderer key={i} artifact={item.artifact} />;
          }
          // text — render Markdown live so headings/lists/tables/code update
          // incrementally as tokens stream in, not only after the turn ends.
          return (
            <div
              key={i}
              className="border-l-2 border-border pl-4 text-[15px] leading-relaxed text-foreground"
            >
              <Markdown content={item.content} />
              {i === items.length - 1 && (
                <span className="ml-0.5 inline-block h-4 w-2 bg-primary animate-caret align-middle" />
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
