"use client";

import { useState, useTransition } from "react";
import { Link } from "@/i18n/navigation";
import { useRouter } from "next/navigation";
import { useTranslations, useFormatter } from "next-intl";
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

/** Maps a data source type key to its translation message key. */
const TYPE_LABEL_KEYS: Record<string, string> = {
  pg: "typePostgres",
  mysql: "typeMysql",
  bigquery: "typeBigquery",
  duckdb: "typeDuckdbFile",
  sqlite: "typeSqliteFile",
  file: "typeFile",
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
  const t = useTranslations("Sources");
  const tc = useTranslations("Common");
  const format = useFormatter();
  const [, startTransition] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function typeLabel(type: string): string {
    const key = TYPE_LABEL_KEYS[type];
    return key ? t(key) : type;
  }

  async function handleDelete(id: string, name: string) {
    // Disable the button early while we fetch the bound chart count.
    setDeletingId(id);
    let chartCount = 0;
    try {
      const res = await fetch(`/api/sources/${id}/charts`);
      if (res.ok) {
        const data = (await res.json()) as { count?: number };
        chartCount = typeof data.count === "number" ? data.count : 0;
      }
    } catch {
      // If the count lookup fails, fall back to a simple confirm.
      chartCount = 0;
    }

    const message =
      chartCount > 0
        ? t("confirmDeleteWithCharts", { name, count: chartCount })
        : t("confirmDelete", { name });

    if (!confirm(message)) {
      setDeletingId(null);
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(`/api/sources/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(err || tc("failedStatus", { status: res.status }));
        }
        toast.success(t("toastDeletedNamed", { name }));
        router.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("toastDeleteFailed");
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
          {t("emptyStateTitle")}
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/sources/new">{t("emptyStateCta")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("colName")}</TableHead>
            <TableHead className="w-32">{t("colType")}</TableHead>
            <TableHead className="w-44">{t("colCreated")}</TableHead>
            <TableHead className="w-32 text-right">{t("colActions")}</TableHead>
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
                  {typeLabel(s.type)}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground" suppressHydrationWarning>
                  {format.dateTime(new Date(s.created_at), { dateStyle: "medium" })}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title={t("editTitle")}
                    >
                      <Link href={`/sources/${s.id}/edit`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      title={t("deleteTitle")}
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
