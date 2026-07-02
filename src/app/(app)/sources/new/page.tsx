"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Database, Loader2 } from "lucide-react";
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

type DbType = "pg" | "mysql" | "bigquery" | "duckdb" | "sqlite";

export default function NewSourcePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId") ?? "";

  const [submitting, setSubmitting] = useState(false);
  const [type, setType] = useState<DbType>("pg");
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
  const [file, setFile] = useState<File | null>(null);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function isFileType(t: DbType): t is "duckdb" | "sqlite" {
    return t === "duckdb" || t === "sqlite";
  }

  function validate(): string | null {
    if (!form.name.trim()) return "Please enter a display name";
    if (type === "pg" || type === "mysql") {
      if (
        !form.host.trim() ||
        !form.database.trim() ||
        !form.user.trim() ||
        !form.password.trim()
      ) {
        return "Please fill in all required database fields";
      }
    } else if (type === "bigquery") {
      if (!form.projectId.trim() || !form.credentialsJson.trim()) {
        return "Please fill in projectId and credentialsJson";
      }
    } else if (isFileType(type)) {
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

      if (isFileType(type)) {
        // File-based DB types: send FormData so the server can upload
        // the file to Vercel Blob and create the data_source.
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
        // JSON body for pg / mysql / bigquery
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

      // Navigate back to the session if bound, otherwise home
      if (sessionId) {
        router.push(`/chat/${sessionId}`);
      } else {
        router.push("/");
      }
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection failed";
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
            <Link
              href={sessionId ? `/chat/${sessionId}` : "/"}
              aria-label="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              Connect database
            </h1>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Database connection</CardTitle>
            <CardDescription>
              Choose a database type and enter the connection details.
              Credentials are encrypted with pgcrypto before storage and only
              decrypted server-side at query time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Database type selector */}
              <div className="space-y-2">
                <Label htmlFor="type">Database type</Label>
                <Select
                  id="type"
                  value={type}
                  onChange={(e) => {
                    const next = e.target.value as DbType;
                    setType(next);
                    // Reset port default when switching between pg/mysql
                    if (next === "pg" && form.port === "3306") {
                      update("port", "5432");
                    } else if (next === "mysql" && form.port === "5432") {
                      update("port", "3306");
                    }
                  }}
                >
                  <option value="pg">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="bigquery">BigQuery</option>
                  <option value="duckdb">DuckDB file</option>
                  <option value="sqlite">SQLite file</option>
                </Select>
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
                  {/* Host + Port */}
                  <div className="grid grid-cols-3 gap-4">
                    <div className="col-span-2 space-y-2">
                      <Label htmlFor="host">
                        Host <span className="text-destructive">*</span>
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
                        required
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

                  {/* Database + User */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="database">
                        Database <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="database"
                        value={form.database}
                        onChange={(e) => update("database", e.target.value)}
                        placeholder={type === "pg" ? "postgres" : "mysql"}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="user">
                        User <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="user"
                        value={form.user}
                        onChange={(e) => update("user", e.target.value)}
                        placeholder={type === "pg" ? "postgres" : "root"}
                        required
                      />
                    </div>
                  </div>

                  {/* Password */}
                  <div className="space-y-2">
                    <Label htmlFor="password">
                      Password <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      value={form.password}
                      onChange={(e) => update("password", e.target.value)}
                      placeholder="••••••••"
                      required
                    />
                  </div>

                  {/* SSL mode */}
                  <div className="space-y-2">
                    <Label htmlFor="ssl">SSL mode</Label>
                    <Select
                      id="ssl"
                      value={form.ssl}
                      onChange={(e) => update("ssl", e.target.value)}
                    >
                      <option value="require">require (recommended)</option>
                      <option value="disable">disable</option>
                      <option value="verify-ca">verify-ca</option>
                      <option value="verify-full">verify-full</option>
                    </Select>
                  </div>
                </>
              )}

              {/* bigquery fields */}
              {isBigquery && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="projectId">
                      Project ID <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      id="projectId"
                      value={form.projectId}
                      onChange={(e) => update("projectId", e.target.value)}
                      placeholder="my-gcp-project"
                      required
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
                      Service account JSON{" "}
                      <span className="text-destructive">*</span>
                    </Label>
                    <Textarea
                      id="credentialsJson"
                      value={form.credentialsJson}
                      onChange={(e) =>
                        update("credentialsJson", e.target.value)
                      }
                      placeholder='{ "type": "service_account", "project_id": "…", … }'
                      rows={8}
                      required
                      className="font-mono text-xs"
                    />
                    <p className="font-mono text-[10px] text-muted-foreground">
                      Paste the full contents of your service account JSON key
                      file.
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

              {/* duckdb / sqlite file input */}
              {isFile && (
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

              {sessionId && (
                <p className="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                  This data source will be bound to the current session.
                </p>
              )}

              {/* Actions */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button asChild variant="outline" type="button">
                  <Link href={sessionId ? `/chat/${sessionId}` : "/"}>
                    Cancel
                  </Link>
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Connecting…
                    </>
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
