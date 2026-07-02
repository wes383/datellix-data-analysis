"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Database, FileBox, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

interface SourceRow {
  id: string;
  type: string;
  name: string;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface SourcesListProps {
  sources: SourceRow[];
}

/** Human-readable label for each data source type. */
const TYPE_LABELS: Record<string, string> = {
  pg: "PostgreSQL",
  mysql: "MySQL",
  bigquery: "BigQuery",
  duckdb: "DuckDB file",
  sqlite: "SQLite file",
  file: "File",
};

/** Returns true for file-backed types that show a file icon. */
function isFileBacked(type: string): boolean {
  return type === "duckdb" || type === "sqlite" || type === "file";
}

/** A short subtitle derived from non-secret meta fields. */
function metaSubtitle(source: SourceRow): string {
  const meta = source.meta ?? {};
  if (typeof meta.host === "string" && typeof meta.database === "string") {
    return `${meta.host}/${meta.database}`;
  }
  if (typeof meta.projectId === "string") return meta.projectId;
  if (typeof meta.filename === "string") return meta.filename;
  return "";
}

/**
 * Client-side list of data sources with Edit/Delete actions.
 * Delete calls DELETE /api/sources/[id] (no sessionId → full removal).
 */
export function SourcesList({ sources }: SourcesListProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    setDeletingId(id);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/sources/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(err || `Failed: ${res.status}`);
        }
        toast.success(`"${name}" deleted`);
        router.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Delete failed";
        toast.error(msg);
      } finally {
        setDeletingId(null);
      }
    });
  }

  if (sources.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16 text-center">
        <Database className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No data sources yet.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/sources/new">Connect your first data source</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            <TableHead>Name</TableHead>
            <TableHead className="w-32">Type</TableHead>
            <TableHead className="w-44">Created</TableHead>
            <TableHead className="w-32 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sources.map((s) => {
            const subtitle = metaSubtitle(s);
            const Icon = isFileBacked(s.type) ? FileBox : Database;
            return (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">
                        {s.name}
                      </p>
                      {subtitle && (
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {subtitle}
                        </p>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {TYPE_LABELS[s.type] ?? s.type}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground" suppressHydrationWarning>
                  {new Date(s.created_at).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Edit"
                    >
                      <Link href={`/sources/${s.id}/edit`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      title="Delete"
                      disabled={deletingId === s.id}
                      onClick={() => handleDelete(s.id, s.name)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
