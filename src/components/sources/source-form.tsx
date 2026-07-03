"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Database, Loader2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type DbType = "pg" | "mysql" | "bigquery" | "duckdb" | "sqlite" | "file";

/** Metadata returned by GET /api/sources/[id] (no secrets). */
export interface SourceInitialValues {
  id: string;
  type: DbType;
  name: string;
  meta: Record<string, unknown>;
}

interface SourceFormProps {
  mode: "create" | "edit";
  /** Required in edit mode; the source being edited. */
  initialValues?: SourceInitialValues;
  /** In create mode, binds the new source to this session. */
  sessionId?: string;
  /** Destination navigated to after a successful submit. */
  doneHref: string;
  /** Cancel link destination. */
  cancelHref: string;
}

function isFileType(t: DbType): t is "duckdb" | "sqlite" | "file" {
  return t === "duckdb" || t === "sqlite" || t === "file";
}

/**
 * Shared data source form used by the New and Edit pages.
 *
 * Create mode: POSTs to /api/sources (FormData for file types, JSON otherwise).
 * Edit mode:   PATCHes /api/sources/[id]. Password/credentials fields are
 *              optional — leaving them blank preserves the existing secret.
 *              File types (file/duckdb/sqlite) can additionally have their
 *              underlying file replaced via POST /api/sources/[id]/replace-file
 *              — when a new file is selected, it's uploaded first, then the
 *              normal PATCH runs for the name change. The data source ID
 *              stays the same so charts bound to it auto-update.
 */
export function SourceForm({
  mode,
  initialValues,
  sessionId,
  doneHref,
  cancelHref,
}: SourceFormProps) {
  const router = useRouter();
  const isEdit = mode === "edit";

  const [submitting, setSubmitting] = useState(false);
  const [type, setType] = useState<DbType>(
    initialValues?.type ?? "pg",
  );
  // Prefill non-secret fields from meta in edit mode.
  const meta = initialValues?.meta ?? {};
  const [form, setForm] = useState({
    name: initialValues?.name ?? "",
    host: (meta.host as string) ?? "",
    port: "5432",
    database: (meta.database as string) ?? "",
    user: "",
    password: "",
    ssl: "require",
    projectId: (meta.projectId as string) ?? "",
    location: "US",
    credentialsJson: "",
    dataset: "",
  });
  const [file, setFile] = useState<File | null>(null);
  // In edit mode, a file selected to replace the existing underlying file
  // (file/duckdb/sqlite types only). null = no replacement, just rename.
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  // True while the replace-file upload is in flight (separate from the
  // subsequent PATCH for the name change).
  const [replacingFile, setReplacingFile] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): string | null {
    if (!form.name.trim()) return "Please enter a display name";
    if (isEdit && isFileType(type)) {
      // File types in edit mode: only name is editable.
      return null;
    }
    if (type === "pg" || type === "mysql") {
      if (isEdit) {
        // In edit mode, password is optional; other fields required only if
        // they're empty AND we're not keeping the existing config.
        if (!form.host.trim() || !form.database.trim() || !form.user.trim()) {
          return "Please fill in host, database, and user";
        }
      } else if (
        !form.host.trim() ||
        !form.database.trim() ||
        !form.user.trim() ||
        !form.password.trim()
      ) {
        return "Please fill in all required database fields";
      }
    } else if (type === "bigquery") {
      if (isEdit) {
        if (!form.projectId.trim()) return "Please fill in projectId";
      } else if (!form.projectId.trim() || !form.credentialsJson.trim()) {
        return "Please fill in projectId and credentialsJson";
      }
    } else if (isFileType(type) && !isEdit) {
      if (!file) return "Please select a database file";
    }
    return null;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    const validationError = validate();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSubmitting(true);
    try {
      let res: Response;

      if (isEdit) {
        // If this is a file-type source and the user picked a new file,
        // upload it first via the replace-file endpoint. The data source
        // ID stays the same — charts bound to it will use the new file on
        // next re-query. Then proceed with the normal PATCH for the name
        // change below.
        if (isFileType(type) && replaceFile) {
          setReplacingFile(true);
          try {
            const fd = new FormData();
            fd.append("file", replaceFile);
            const replaceRes = await fetch(
              `/api/sources/${initialValues!.id}/replace-file`,
              { method: "POST", body: fd },
            );
            if (!replaceRes.ok) {
              const errBody = await replaceRes.text();
              throw new Error(
                errBody || `File replace failed: ${replaceRes.status}`,
              );
            }
          } finally {
            setReplacingFile(false);
          }
        }

        // PATCH with JSON body. Password/credentials omitted when blank so
        // the server preserves the existing ciphertext.
        const body: Record<string, unknown> = {
          name: form.name.trim(),
        };
        if (type === "pg" || type === "mysql") {
          body.host = form.host.trim();
          body.port = Number(form.port) || (type === "mysql" ? 3306 : 5432);
          body.database = form.database.trim();
          body.user = form.user.trim();
          body.ssl = form.ssl;
          if (form.password) body.password = form.password;
        } else if (type === "bigquery") {
          body.projectId = form.projectId.trim();
          body.location = form.location.trim() || "US";
          body.dataset = form.dataset.trim() || undefined;
          if (form.credentialsJson) body.credentialsJson = form.credentialsJson;
        }
        // duckdb/sqlite: only name is sent.

        res = await fetch(`/api/sources/${initialValues!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else if (isFileType(type)) {
        // Create: file types use FormData so the server uploads to Blob.
        const formData = new FormData();
        formData.append("type", type);
        formData.append("name", form.name.trim());
        if (sessionId) formData.append("sessionId", sessionId);
        if (file) formData.append("file", file);

        res = await fetch("/api/sources", {
          method: "POST",
          body: formData,
        });
      } else {
        // Create: pg/mysql/bigquery use JSON.
        const body: Record<string, unknown> = {
          type,
          name: form.name.trim(),
          sessionId: sessionId || undefined,
        };
        if (type === "pg" || type === "mysql") {
          body.host = form.host.trim();
          body.port = Number(form.port) || (type === "mysql" ? 3306 : 5432);
          body.database = form.database.trim();
          body.user = form.user.trim();
          body.password = form.password;
          body.ssl = form.ssl;
        } else if (type === "bigquery") {
          body.projectId = form.projectId.trim();
          body.location = form.location.trim() || "US";
          body.credentialsJson = form.credentialsJson;
          body.dataset = form.dataset.trim() || undefined;
        }

        res = await fetch("/api/sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(errBody || `Request failed: ${res.status}`);
      }

      if (!isEdit) {
        const data = (await res.json()) as {
          dataSourceId: string;
          indexed: boolean;
          indexError?: string;
        };
        if (data.indexed) {
          toast.success(`Data source "${form.name.trim()}" connected`, {
            description: "Schema indexed successfully",
          });
        } else {
          toast.success(`Data source "${form.name.trim()}" connected`, {
            description: data.indexError
              ? `Schema indexing failed: ${data.indexError}`
              : "Schema indexing skipped",
          });
        }
      } else {
        toast.success(`Data source "${form.name.trim()}" updated`, {
          description:
            isFileType(type) && replaceFile
              ? "File replaced — charts will use the new data on next re-query."
              : undefined,
        });
      }

      router.refresh();
      router.push(doneHref);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Request failed";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const isFile = isFileType(type);
  const isPgOrMysql = type === "pg" || type === "mysql";
  const isBigquery = type === "bigquery";

  return (
    <div className="h-screen overflow-y-auto bg-background">
      <div className="mx-auto max-w-2xl px-6 py-10">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
          >
            <Link href={cancelHref} aria-label="Back">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {isEdit ? "Edit data source" : "Connect database"}
            </h1>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {isEdit ? "Connection details" : "Database connection"}
            </CardTitle>
            <CardDescription>
              {isEdit
                ? "Update the display name or connection details. Leave the password blank to keep the current one. Credentials are encrypted with pgcrypto."
                : "Choose a database type and enter the connection details. Credentials are encrypted with pgcrypto before storage and only decrypted server-side at query time."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Database type selector — disabled in edit mode (type immutable) */}
              <div className="space-y-2">
                <Label htmlFor="type">Database type</Label>
                <Select
                  id="type"
                  value={type}
                  disabled={isEdit}
                  onChange={(v) => {
                    const next = v as DbType;
                    setType(next);
                    if (next === "pg" && form.port === "3306") {
                      update("port", "5432");
                    } else if (next === "mysql" && form.port === "5432") {
                      update("port", "3306");
                    }
                  }}
                  options={[
                    { value: "pg", label: "PostgreSQL" },
                    { value: "mysql", label: "MySQL" },
                    { value: "bigquery", label: "BigQuery" },
                    { value: "duckdb", label: "DuckDB file" },
                    { value: "sqlite", label: "SQLite file" },
                    // file type only shown in edit mode for existing file sources;
                    // file data sources are created via chat upload, not this form.
                    ...(isEdit && type === "file"
                      ? [{ value: "file", label: "File (CSV/Excel/Parquet)" }]
                      : []),
                  ]}
                />
                {isEdit && (
                  <p className="font-mono text-[10px] text-muted-foreground">
                    The database type cannot be changed after creation.
                  </p>
                )}
              </div>

              {/* Display name (always shown) */}
              <div className="space-y-2">
                <Label htmlFor="name">
                  Display name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder="Production analytics"
                  required
                  autoFocus
                />
              </div>

              {/* pg / mysql fields */}
              {isPgOrMysql && (
                <>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="host">
                        Host {!isEdit && <span className="text-destructive">*</span>}
                      </Label>
                      <Input
                        id="host"
                        value={form.host}
                        onChange={(e) => update("host", e.target.value)}
                        placeholder={
                          type === "pg"
                            ? "db.xxx.supabase.co"
                            : "mysql.example.com"
                        }
                        required={!isEdit}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="port">Port</Label>
                      <Input
                        id="port"
                        type="number"
                        value={form.port}
                        onChange={(e) => update("port", e.target.value)}
                        placeholder={type === "pg" ? "5432" : "3306"}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="database">
                        Database {!isEdit && <span className="text-destructive">*</span>}
                      </Label>
                      <Input
                        id="database"
                        value={form.database}
                        onChange={(e) => update("database", e.target.value)}
                        placeholder={type === "pg" ? "postgres" : "mysql"}
                        required={!isEdit}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="user">
                        User {!isEdit && <span className="text-destructive">*</span>}
                      </Label>
                      <Input
                        id="user"
                        value={form.user}
                        onChange={(e) => update("user", e.target.value)}
                        placeholder={type === "pg" ? "postgres" : "root"}
                        required={!isEdit}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password">
                      Password
                      {!isEdit && <span className="text-destructive"> *</span>}
                      {isEdit && (
                        <span className="ml-2 font-normal text-muted-foreground">
                          (leave blank to keep current)
                        </span>
                      )}
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      value={form.password}
                      onChange={(e) => update("password", e.target.value)}
                      placeholder={isEdit ? "••••••••" : "••••••••"}
                      required={!isEdit}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="ssl">SSL mode</Label>
                    <Select
                      id="ssl"
                      value={form.ssl}
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

              {/* bigquery fields */}
              {isBigquery && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="projectId">
                      Project ID {!isEdit && <span className="text-destructive">*</span>}
                    </Label>
                    <Input
                      id="projectId"
                      value={form.projectId}
                      onChange={(e) => update("projectId", e.target.value)}
                      placeholder="my-gcp-project"
                      required={!isEdit}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="location">Location</Label>
                    <Input
                      id="location"
                      value={form.location}
                      onChange={(e) => update("location", e.target.value)}
                      placeholder="US"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="credentialsJson">
                      Service account JSON
                      {!isEdit && <span className="text-destructive"> *</span>}
                      {isEdit && (
                        <span className="ml-2 font-normal text-muted-foreground">
                          (leave blank to keep current)
                        </span>
                      )}
                    </Label>
                    <Textarea
                      id="credentialsJson"
                      value={form.credentialsJson}
                      onChange={(e) =>
                        update("credentialsJson", e.target.value)
                      }
                      placeholder='{ "type": "service_account", "project_id": "…", … }'
                      rows={8}
                      required={!isEdit}
                      className="font-mono text-xs"
                    />
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {isEdit
                        ? "Paste a new key only if you want to rotate credentials."
                        : "Paste the full contents of your service account JSON key file."}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="dataset">
                      Default dataset{" "}
                      <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="dataset"
                      value={form.dataset}
                      onChange={(e) => update("dataset", e.target.value)}
                      placeholder="analytics"
                    />
                  </div>
                </>
              )}

              {/* duckdb / sqlite file input (create mode only) */}
              {isFile && !isEdit && (
                <div className="space-y-2">
                  <Label htmlFor="file">
                    {type === "duckdb" ? "DuckDB file" : "SQLite file"}{" "}
                    <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="file"
                    type="file"
                    accept={
                      type === "duckdb" ? ".duckdb" : ".db,.sqlite,.sqlite3"
                    }
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    required
                  />
                  {file && (
                    <p className="font-mono text-[10px] text-muted-foreground">
                      Selected: {file.name} ({(file.size / 1024).toFixed(1)} KB)
                    </p>
                  )}
                  <p className="font-mono text-[10px] text-muted-foreground">
                    The file is uploaded to Vercel Blob and queried inside the
                    sandbox at runtime.
                  </p>
                </div>
              )}

              {isFile && isEdit && (
                <div className="space-y-2">
                  <Label htmlFor="replaceFile">Replace file (optional)</Label>
                  <Input
                    id="replaceFile"
                    type="file"
                    accept={
                      type === "file"
                        ? ".csv,.xlsx,.parquet"
                        : type === "duckdb"
                          ? ".duckdb"
                          : ".db,.sqlite,.sqlite3"
                    }
                    onChange={(e) =>
                      setReplaceFile(e.target.files?.[0] ?? null)
                    }
                    disabled={replacingFile}
                  />
                  {replaceFile && (
                    <p className="font-mono text-[10px] text-muted-foreground">
                      Selected: {replaceFile.name} (
                      {(replaceFile.size / 1024).toFixed(1)} KB)
                    </p>
                  )}
                  <p className="font-mono text-[10px] text-muted-foreground">
                    Upload a new file to replace the existing one. Charts bound
                    to this data source will automatically use the new data.
                  </p>
                  {(() => {
                    const filename =
                      (meta.filename as string) ??
                      (typeof meta.blobUrl === "string"
                        ? String(meta.blobUrl).split("/").pop()
                        : undefined);
                    const size = meta.size as number | undefined;
                    return (
                      <p className="font-mono text-[10px] text-muted-foreground">
                        Current file:
                        {filename ? ` ${filename}` : " —"}
                        {typeof size === "number"
                          ? ` (${(size / 1024).toFixed(1)} KB)`
                          : ""}
                      </p>
                    );
                  })()}
                </div>
              )}

              {sessionId && !isEdit && (
                <p className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                  This data source will be bound to the current session.
                </p>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button asChild variant="outline" type="button">
                  <Link href={cancelHref}>Cancel</Link>
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {replacingFile
                        ? "Replacing file…"
                        : isEdit
                          ? "Saving…"
                          : "Connecting…"}
                    </>
                  ) : isEdit ? (
                    "Save changes"
                  ) : isFile ? (
                    "Upload & connect"
                  ) : (
                    "Connect & index"
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
