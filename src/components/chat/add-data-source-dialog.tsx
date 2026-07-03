"use client";

import { useState, useRef, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Database, FileBox, Loader2, Plus, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createSession } from "@/app/actions/sessions";

/**
 * Unified "Add data source" modal with three tabs:
 *   1. Use existing — pick a previously-created DB data source
 *   2. Upload file — CSV/Excel/Parquet (session-scoped file data source)
 *   3. Connect database — new pg/mysql/bigquery connection
 *
 * Replaces the previously-separated "Upload file" and "Connect database"
 * buttons in both the WelcomeState (empty session) and the DataSourceBar
 * (active session header). The trigger button is controlled by the parent.
 */

type Tab = "existing" | "upload" | "connect";

interface ExistingSource {
  id: string;
  type: string;
  name: string;
  meta: Record<string, unknown>;
}

interface AddDataSourceDialogProps {
  /** Session ID to bind the data source to. May be "new" for uncreated sessions. */
  sessionId: string;
  /** If true, the session already has a data source (hides "existing" tab). */
  hasDataSource: boolean;
  /** Current data source mode: "database", "files", or null (none). */
  dataSourceMode: "database" | "files" | null;
  /** Pre-fetched list of the user's existing DB-type data sources. */
  existingSources: ExistingSource[];
  /** Trigger element (button) — rendered as-is; dialog opens on click. */
  trigger: React.ReactNode;
}

const TYPE_LABELS: Record<string, string> = {
  pg: "PostgreSQL",
  mysql: "MySQL",
  bigquery: "BigQuery",
  duckdb: "DuckDB",
  sqlite: "SQLite",
  file: "File",
};

function metaSubtitle(meta: Record<string, unknown>, type: string): string {
  if (type === "pg" || type === "mysql") {
    const host = meta.host as string | undefined;
    const db = meta.database as string | undefined;
    if (host && db) return `${host} / ${db}`;
    if (host) return host;
    if (db) return db;
  }
  if (type === "bigquery") {
    return (meta.projectId as string) ?? "";
  }
  if (type === "file" || type === "duckdb" || type === "sqlite") {
    return (meta.filename as string) ?? "";
  }
  return "";
}

export function AddDataSourceDialog({
  sessionId,
  hasDataSource,
  dataSourceMode,
  existingSources,
  trigger,
}: AddDataSourceDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("existing");

  // Reset to "existing" tab whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setTab(existingSources.length > 0 ? "existing" : "upload");
    }
  }, [open, existingSources.length]);

  function handleClose() {
    setOpen(false);
  }

  /** Resolve a real session ID, creating the session if sessionId === "new".
   *  NOTE: does NOT call router.replace here. The Chat component is keyed
   *  by sessionId, so navigating to the new URL mid-upload would remount
   *  the entire tree and close this dialog (resetting `open` to false),
   *  aborting the upload loop visually. Callers must perform the redirect
   *  themselves after their work is done. */
  async function ensureSession(): Promise<string | null> {
    if (sessionId !== "new") return sessionId;
    try {
      const s = await createSession();
      return s.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create session";
      toast.error(msg);
      return null;
    }
  }

  return (
    <>
      {/* Trigger: clone the trigger element to add onClick */}
      <span onClick={() => setOpen(true)} className="inline-flex cursor-pointer">
        {trigger}
      </span>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        >
          <div
            className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-base font-semibold">Add data source</h2>
              <button
                type="button"
                onClick={handleClose}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border">
              <TabButton
                active={tab === "existing"}
                onClick={() => setTab("existing")}
                disabled={existingSources.length === 0}
              >
                <FileBox className="h-3.5 w-3.5" />
                Use existing
              </TabButton>
              <TabButton
                active={tab === "upload"}
                onClick={() => setTab("upload")}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload file
              </TabButton>
              <TabButton
                active={tab === "connect"}
                onClick={() => setTab("connect")}
              >
                <Plus className="h-3.5 w-3.5" />
                Connect database
              </TabButton>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5">
              {tab === "existing" && (
                <ExistingTab
                  existingSources={existingSources}
                  sessionId={sessionId}
                  hasDataSource={hasDataSource}
                  dataSourceMode={dataSourceMode}
                  onClose={handleClose}
                  ensureSession={ensureSession}
                />
              )}
              {tab === "upload" && (
                <UploadTab
                  sessionId={sessionId}
                  dataSourceMode={dataSourceMode}
                  onClose={handleClose}
                  ensureSession={ensureSession}
                />
              )}
              {tab === "connect" && (
                <ConnectTab
                  sessionId={sessionId}
                  dataSourceMode={dataSourceMode}
                  onClose={handleClose}
                  ensureSession={ensureSession}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ============================================================
    Tab button
    ============================================================ */
function TabButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
        active
          ? "border-b-2 border-primary text-primary"
          : "text-muted-foreground hover:text-foreground"
      } disabled:pointer-events-none disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

/* ============================================================
    Shared: restriction notice banner
    ============================================================ */
function ModeNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
      <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
      <span>{children}</span>
    </div>
  );
}

/* ============================================================
    Tab 1: Use existing
    ============================================================ */
function ExistingTab({
  existingSources,
  sessionId,
  hasDataSource,
  dataSourceMode,
  onClose,
  ensureSession,
}: {
  existingSources: ExistingSource[];
  sessionId: string;
  hasDataSource: boolean;
  dataSourceMode: "database" | "files" | null;
  onClose: () => void;
  ensureSession: () => Promise<string | null>;
}) {
  const router = useRouter();
  const [binding, setBinding] = useState<string | null>(null);

  async function handleBind(sourceId: string) {
    if (binding) return;
    setBinding(sourceId);
    try {
      const sid = await ensureSession();
      if (!sid) {
        setBinding(null);
        return;
      }
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "existing",
          sourceId,
          sessionId: sid,
        }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `Failed to bind source: ${res.status}`);
      }
      toast.success("Data source connected");
      onClose();
      if (sessionId === "new") {
        router.replace(`/chat/${sid}`);
      } else {
        router.refresh();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to connect";
      toast.error(msg);
    } finally {
      setBinding(null);
    }
  }

  // Both DB-type and file-type sources can be reused.
  const reusable = existingSources;

  // Per-item compatibility: files can't coexist with a DB and vice-versa.
  function isItemDisabled(s: ExistingSource) {
    if (binding !== null) return true;
    if (dataSourceMode === "database" && s.type === "file") return true;
    if (dataSourceMode === "files" && s.type !== "file") return true;
    return false;
  }

  return (
    <div className="space-y-2">
      {dataSourceMode === "database" && (
        <ModeNotice>
          This session is connected to a database. Selecting another database will replace the current connection. Files cannot be used at the same time.
        </ModeNotice>
      )}
      {dataSourceMode === "files" && (
        <ModeNotice>
          This session has uploaded files. You cannot connect to a database. Remove all files first.
        </ModeNotice>
      )}
      <p className="mb-3 text-sm text-muted-foreground">
        Select an existing database connection or uploaded file to bind to this session.
      </p>
      {reusable.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
          No reusable data sources yet. Upload a file or create a connection in the other tabs.
        </p>
      ) : (
        <div className="space-y-1.5">
          {reusable.map((s) => {
            const disabled = isItemDisabled(s);
            return (
              <button
                key={s.id}
                type="button"
                disabled={disabled}
                onClick={() => !disabled && handleBind(s.id)}
                title={
                  dataSourceMode === "database" && s.type === "file"
                    ? "Database is connected, cannot add files"
                    : dataSourceMode === "files" && s.type !== "file"
                      ? "Files are uploaded, cannot connect database"
                      : undefined
                }
                className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {s.type === "file" ? (
                  <FileBox className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {TYPE_LABELS[s.type] ?? s.type}
                    {metaSubtitle(s.meta, s.type)
                      ? ` · ${metaSubtitle(s.meta, s.type)}`
                      : ""}
                  </div>
                </div>
                {binding === s.id && (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================
    Tab 2: Upload file
    ============================================================ */
function UploadTab({
  sessionId,
  dataSourceMode,
  onClose,
  ensureSession,
}: {
  sessionId: string;
  dataSourceMode: "database" | "files" | null;
  onClose: () => void;
  ensureSession: () => Promise<string | null>;
}) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  // Progress: "Uploading 2 / 5…" — completed count out of total.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ACCEPTED_EXTS = [".csv", ".xlsx", ".xls", ".parquet"];

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;

    // Validate extensions up front. Reject the whole batch if any file is
    // unsupported — avoids partial uploads of mixed batches and makes the
    // error message list every offending file.
    const invalid = files.filter((f) => {
      const name = f.name.toLowerCase();
      return !ACCEPTED_EXTS.some((ext) => name.endsWith(ext));
    });
    if (invalid.length > 0) {
      toast.error(
        `Unsupported format: ${invalid.map((f) => f.name).join(", ")}. Accepted: ${ACCEPTED_EXTS.join(", ")}. DuckDB / SQLite files use the Connect database tab.`,
      );
      return;
    }

    setUploading(true);
    setProgress({ done: 0, total: files.length });
    try {
      const sid = await ensureSession();
      if (!sid) {
        setUploading(false);
        setProgress(null);
        return;
      }

      // Upload files SEQUENTIALLY (not concurrently). Each /api/upload
      // request indexes the file's schema by spinning up an ephemeral
      // sandbox and running Python. Concurrent uploads would create multiple
      // sandboxes in parallel, which can race / fail silently — and since
      // indexing is best-effort on the server, the file would appear
      // uploaded in the UI but be invisible to the AI (no schema_embeddings
      // rows). Serial uploads avoid this sandbox contention.
      const successes: { name: string; reused: boolean; indexed: boolean }[] = [];
      const failures: { name: string; error: string }[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const formData = new FormData();
          formData.append("sessionId", sid);
          formData.append("file", file);
          const res = await fetch("/api/upload", {
            method: "POST",
            body: formData,
          });
          if (!res.ok) {
            const msg = await res.text();
            throw new Error(msg || `Upload failed: ${res.status}`);
          }
          const data = (await res.json()) as {
            reused?: boolean;
            indexed?: boolean;
            indexError?: string;
          };
          successes.push({
            name: file.name,
            reused: !!data.reused,
            indexed: !!data.indexed,
          });
        } catch (err) {
          failures.push({
            name: file.name,
            error: err instanceof Error ? err.message : "Upload failed",
          });
        }
        setProgress({ done: i + 1, total: files.length });
      }

      if (successes.length > 0) {
        const reusedCount = successes.filter((s) => s.reused).length;
        const newCount = successes.length - reusedCount;
        const indexedFailed = successes.filter((s) => !s.indexed);
        const parts: string[] = [];
        if (newCount > 0) parts.push(`${newCount} new file${newCount > 1 ? "s" : ""} uploaded`);
        if (reusedCount > 0) parts.push(`${reusedCount} reused`);
        toast.success(
          parts.length > 0 ? parts.join(" · ") : "Files uploaded",
          {
            description:
              successes.length > 1
                ? `${successes.map((s) => s.name).join(", ")}`
                : undefined,
          },
        );
        // Warn the user if any file's schema indexing failed — the file is
        // uploaded but the AI can't see its columns/tables.
        if (indexedFailed.length > 0) {
          toast.warning(
            `Schema indexing failed for ${indexedFailed.length} file${indexedFailed.length > 1 ? "s" : ""}: ${indexedFailed.map((f) => f.name).join(", ")}`,
            {
              description: "The AI may not be able to query these files. Try re-uploading.",
            },
          );
        }
      }
      if (failures.length > 0) {
        toast.error(
          `${failures.length} file${failures.length > 1 ? "s" : ""} failed: ${failures[0].error}`,
        );
      }

      // Only close + refresh if at least one file succeeded.
      if (successes.length > 0) {
        onClose();
        // For a newly-created session, navigate to its URL now — this
        // remounts Chat with the real sessionId and fetches fresh data
        // (including the uploaded files). For an existing session, just
        // refresh the current route to pick up the new files.
        if (sessionId === "new") {
          router.replace(`/chat/${sid}`);
        } else {
          router.refresh();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast.error(msg);
    } finally {
      setUploading(false);
      setProgress(null);
    }
  }

  const isDisabled = dataSourceMode === "database" || uploading;

  return (
    <div className="space-y-4">
      {dataSourceMode === "database" && (
        <ModeNotice>
          This session is connected to a database. You cannot upload files. Disconnect the database first.
        </ModeNotice>
      )}
      <p className="text-sm text-muted-foreground">
        Upload data files (CSV / Excel / Parquet). Files are queried via
        DuckDB in the sandbox. For DuckDB / SQLite database files, use the
        Connect database tab.
      </p>
      <div
        className={`flex flex-col items-center justify-center rounded-md border border-dashed border-border px-6 py-10 text-center ${
          dataSourceMode === "database" ? "opacity-50 cursor-not-allowed" : ""
        }`}
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (isDisabled) return;
          const dropped = Array.from(e.dataTransfer.files ?? []);
          if (dropped.length > 0) handleFiles(dropped);
        }}
      >
        <Upload className="mb-2 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium">
          {uploading && progress
            ? `Uploading ${progress.done} / ${progress.total}…`
            : "Drop files here or click to browse"}
        </p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          CSV · XLSX · XLS · Parquet
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          disabled={isDisabled}
          className="hidden"
          accept=".csv,.xlsx,.xls,.parquet"
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            if (picked.length > 0) handleFiles(picked);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          disabled={isDisabled}
          onClick={() => !isDisabled && fileInputRef.current?.click()}
        >
          {uploading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Uploading
            </>
          ) : (
            <>
              <Upload className="h-3.5 w-3.5" />
              Select files
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

/* ============================================================
    Tab 3: Connect database (new)
    ============================================================ */
function ConnectTab({
  sessionId,
  dataSourceMode,
  onClose,
  ensureSession,
}: {
  sessionId: string;
  dataSourceMode: "database" | "files" | null;
  onClose: () => void;
  ensureSession: () => Promise<string | null>;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [type, setType] = useState<
    "pg" | "mysql" | "bigquery" | "duckdb" | "sqlite"
  >("pg");
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: "5432",
    database: "",
    user: "",
    password: "",
    ssl: "require",
    projectId: "",
    location: "US",
    credentialsJson: "",
    dataset: "",
  });

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    if (!form.name.trim()) {
      toast.error("Please enter a display name");
      return;
    }
    setSubmitting(true);
    try {
      const sid = await ensureSession();
      if (!sid) {
        setSubmitting(false);
        return;
      }

      // duckdb / sqlite: upload the file via FormData so the server uploads
      // it to storage and binds the data source in single-DB mode
      // (sessions.data_source_id). This is the same path used by the
      // /sources/new page.
      if (type === "duckdb" || type === "sqlite") {
        if (!file) {
          toast.error("Please select a database file");
          setSubmitting(false);
          return;
        }
        const formData = new FormData();
        formData.append("type", type);
        formData.append("name", form.name.trim());
        formData.append("sessionId", sid);
        formData.append("file", file);

        const res = await fetch("/api/sources", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const msg = await res.text();
          throw new Error(msg || `Request failed: ${res.status}`);
        }
        const data = (await res.json()) as {
          reused?: boolean;
          indexed?: boolean;
          indexError?: string;
        };
        toast.success(
          data.reused
            ? "Reused existing data source"
            : `Data source "${form.name.trim()}" connected`,
          {
            description: data.indexed
              ? "Schema indexed successfully"
              : data.indexError
                ? `Schema indexing failed: ${data.indexError}`
                : undefined,
          },
        );
        onClose();
        if (sessionId === "new") {
          router.replace(`/chat/${sid}`);
        } else {
          router.refresh();
        }
        return;
      }

      // pg / mysql / bigquery: JSON body
      const body: Record<string, unknown> = {
        type,
        name: form.name.trim(),
        sessionId: sid,
      };
      if (type === "pg" || type === "mysql") {
        if (
          !form.host.trim() ||
          !form.database.trim() ||
          !form.user.trim() ||
          !form.password.trim()
        ) {
          toast.error("Please fill in all required database fields");
          setSubmitting(false);
          return;
        }
        body.host = form.host.trim();
        body.port = Number(form.port) || (type === "mysql" ? 3306 : 5432);
        body.database = form.database.trim();
        body.user = form.user.trim();
        body.password = form.password;
        body.ssl = form.ssl;
      } else if (type === "bigquery") {
        if (!form.projectId.trim() || !form.credentialsJson.trim()) {
          toast.error("Please fill in projectId and credentialsJson");
          setSubmitting(false);
          return;
        }
        body.projectId = form.projectId.trim();
        body.location = form.location.trim() || "US";
        body.credentialsJson = form.credentialsJson;
        body.dataset = form.dataset.trim() || undefined;
      }

      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `Request failed: ${res.status}`);
      }
      const data = (await res.json()) as {
        reused?: boolean;
        indexed?: boolean;
        indexError?: string;
      };
      toast.success(
        data.reused
          ? "Reused existing data source"
          : `Data source "${form.name.trim()}" connected`,
        {
          description: data.indexed
            ? "Schema indexed successfully"
            : data.indexError
              ? `Schema indexing failed: ${data.indexError}`
              : undefined,
        },
      );
      onClose();
      if (sessionId === "new") {
        router.replace(`/chat/${sid}`);
      } else {
        router.refresh();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Request failed";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const isDisabled = dataSourceMode === "files";
  const isPgOrMysql = type === "pg" || type === "mysql";
  const isBigquery = type === "bigquery";
  const isFileDb = type === "duckdb" || type === "sqlite";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {dataSourceMode === "files" && (
        <ModeNotice>
          This session has uploaded files. You cannot connect to a database. Remove all files first.
        </ModeNotice>
      )}
      {dataSourceMode === "database" && (
        <ModeNotice>
          This session is connected to a database. Connecting a new database will replace the existing connection.
        </ModeNotice>
      )}
      {/* Type selector */}
      <div className="space-y-2">
        <Label htmlFor="ds-type">Database type</Label>
        <Select
          id="ds-type"
          value={type}
          disabled={isDisabled || submitting}
          onChange={(v) => {
            const next = v as
              | "pg"
              | "mysql"
              | "bigquery"
              | "duckdb"
              | "sqlite";
            setType(next);
            if (next === "pg" && form.port === "3306") update("port", "5432");
            else if (next === "mysql" && form.port === "5432")
              update("port", "3306");
          }}
          options={[
            { value: "pg", label: "PostgreSQL" },
            { value: "mysql", label: "MySQL" },
            { value: "bigquery", label: "BigQuery" },
            { value: "duckdb", label: "DuckDB file" },
            { value: "sqlite", label: "SQLite file" },
          ]}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="ds-name">
          Display name <span className="text-destructive">*</span>
        </Label>
        <Input
          id="ds-name"
          value={form.name}
          disabled={isDisabled || submitting}
          onChange={(e) => update("name", e.target.value)}
          placeholder="Production analytics"
          required
          autoFocus
        />
      </div>

      {isPgOrMysql && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="ds-host">
                Host <span className="text-destructive">*</span>
              </Label>
              <Input
                id="ds-host"
                value={form.host}
                disabled={isDisabled || submitting}
                onChange={(e) => update("host", e.target.value)}
                placeholder={
                  type === "pg" ? "db.xxx.supabase.co" : "mysql.example.com"
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ds-port">Port</Label>
              <Input
                id="ds-port"
                type="number"
                value={form.port}
                disabled={isDisabled || submitting}
                onChange={(e) => update("port", e.target.value)}
                placeholder={type === "pg" ? "5432" : "3306"}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ds-database">
                Database <span className="text-destructive">*</span>
              </Label>
              <Input
                id="ds-database"
                value={form.database}
                disabled={isDisabled || submitting}
                onChange={(e) => update("database", e.target.value)}
                placeholder={type === "pg" ? "postgres" : "mysql"}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ds-user">
                User <span className="text-destructive">*</span>
              </Label>
              <Input
                id="ds-user"
                value={form.user}
                disabled={isDisabled || submitting}
                onChange={(e) => update("user", e.target.value)}
                placeholder={type === "pg" ? "postgres" : "root"}
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ds-password">
              Password <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ds-password"
              type="password"
              value={form.password}
              disabled={isDisabled || submitting}
              onChange={(e) => update("password", e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ds-ssl">SSL mode</Label>
            <Select
              id="ds-ssl"
              value={form.ssl}
              disabled={isDisabled || submitting}
              onChange={(v) => update("ssl", v)}
              options={[
                { value: "require", label: "require (recommended)" },
                { value: "disable", label: "disable" },
                { value: "verify-ca", label: "verify-ca" },
                { value: "verify-full", label: "verify-full" },
              ]}
            />
          </div>
        </>
      )}

      {isBigquery && (
        <>
          <div className="space-y-2">
            <Label htmlFor="ds-project">
              Project ID <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ds-project"
              value={form.projectId}
              disabled={isDisabled || submitting}
              onChange={(e) => update("projectId", e.target.value)}
              placeholder="my-gcp-project"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ds-location">Location</Label>
            <Input
              id="ds-location"
              value={form.location}
              disabled={isDisabled || submitting}
              onChange={(e) => update("location", e.target.value)}
              placeholder="US"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ds-creds">
              Service account JSON <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="ds-creds"
              value={form.credentialsJson}
              disabled={isDisabled || submitting}
              onChange={(e) => update("credentialsJson", e.target.value)}
              placeholder='{ "type": "service_account", ... }'
              rows={5}
              required
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ds-dataset">
              Default dataset{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="ds-dataset"
              value={form.dataset}
              disabled={isDisabled || submitting}
              onChange={(e) => update("dataset", e.target.value)}
              placeholder="analytics"
            />
          </div>
        </>
      )}

      {/* duckdb / sqlite file input */}
      {isFileDb && (
        <div className="space-y-2">
          <Label htmlFor="ds-file">
            {type === "duckdb" ? "DuckDB file" : "SQLite file"}{" "}
            <span className="text-destructive">*</span>
          </Label>
          <Input
            id="ds-file"
            type="file"
            disabled={isDisabled || submitting}
            accept={type === "duckdb" ? ".duckdb" : ".db,.sqlite,.sqlite3"}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
          {file && (
            <p className="font-mono text-[10px] text-muted-foreground">
              Selected: {file.name} ({(file.size / 1024).toFixed(1)} KB)
            </p>
          )}
          <p className="font-mono text-[10px] text-muted-foreground">
            The file is uploaded to storage and queried inside the sandbox at
            runtime. Bound in single-DB mode — only one database per session.
          </p>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button type="submit" disabled={isDisabled || submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Connecting
            </>
          ) : isFileDb ? (
            "Upload & connect"
          ) : (
            "Connect & index"
          )}
        </Button>
      </div>
    </form>
  );
}
