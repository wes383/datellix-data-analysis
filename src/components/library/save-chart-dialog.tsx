"use client";

import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface SaveChartDialogProps {
  open: boolean;
  onClose: () => void;
  /** Chart spec (ChartPayload without data for Recharts, or full figure for Plotly). */
  spec: Record<string, unknown>;
  /** SQL used to generate the chart. */
  sql?: string;
  /** "recharts" | "plotly" */
  renderer: "recharts" | "plotly";
  /** Default title (from the chart's title field). */
  defaultTitle: string;
  /** Session ID the chart was generated in. */
  sessionId: string;
  /** Data source IDs bound to the session (for chart binding). */
  dataSourceIds: string[];
}

/**
 * Modal dialog for saving an AI-generated chart to the chart library.
 * Sends POST /api/charts with the chart spec, SQL, renderer, and data
 * source binding derived from the session.
 */
export function SaveChartDialog({
  open,
  onClose,
  spec,
  sql,
  renderer,
  defaultTitle,
  sessionId,
  dataSourceIds,
}: SaveChartDialogProps) {
  const t = useTranslations("Library");
  const tc = useTranslations("Common");
  const [title, setTitle] = useState(defaultTitle || tc("untitledChart"));
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || saving) return;
    if (dataSourceIds.length === 0) {
      toast.error(t("toastNoDataSourceBound"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/charts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          spec,
          sql_text: sql ?? null,
          renderer,
          data_source_ids: dataSourceIds,
          source_session_id: sessionId,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || tc("failedStatus", { status: res.status }));
      }
      toast.success(t("toastChartSaved"));
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("toastSaveFailed");
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  if (!open || typeof document === "undefined") return null;

  // Render via portal to document.body so the fixed overlay escapes any
  // ancestor with `transform` / `filter` / `will-change` (e.g. the artifact
  // card's `animate-fade-up` animation retains `transform: translateY(0)`
  // which creates a containing block that traps `position: fixed` children).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-base font-semibold tracking-tight">
            {t("dialogTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="chart-title">{t("labelTitle")}</Label>
            <Input
              id="chart-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("placeholderChartTitle")}
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="chart-description">{t("labelDescriptionOptional")}</Label>
            <Textarea
              id="chart-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("placeholderDescription")}
              rows={3}
            />
          </div>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <p className="font-mono text-[10px] text-muted-foreground">
              {t("labelRenderer")} {renderer}
              {sql ? ` · ${t("hintSqlSavedForRequery")}` : ""}
              {" · "}
              {t("hintDataSourcesBound", { count: dataSourceIds.length })}
            </p>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={saving || !title.trim()}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {tc("saving")}
                </>
              ) : (
                t("buttonSaveToLibrary")
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
