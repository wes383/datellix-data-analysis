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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function NewSourcePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId") ?? "";

  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    host: "",
    port: "5432",
    database: "",
    user: "",
    password: "",
    ssl: "require",
  });

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    if (
      !form.name.trim() ||
      !form.host.trim() ||
      !form.database.trim() ||
      !form.user.trim() ||
      !form.password.trim()
    ) {
      toast.error("Please fill in all required fields");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          host: form.host.trim(),
          port: Number(form.port) || 5432,
          database: form.database.trim(),
          user: form.user.trim(),
          password: form.password,
          ssl: form.ssl,
          sessionId: sessionId || undefined,
        }),
      });

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
              Connect Postgres
            </h1>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Database connection</CardTitle>
            <CardDescription>
              Enter your Postgres credentials. They are encrypted with
              pgcrypto before storage and only decrypted server-side at query
              time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Name */}
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
                    placeholder="db.xxx.supabase.co"
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
                    placeholder="5432"
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
                    placeholder="postgres"
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
                    placeholder="postgres"
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
