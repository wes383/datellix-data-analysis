"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDownToLine, ArrowUpFromLine, Clock } from "lucide-react";
import { useTranslations, useFormatter, useLocale } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** One day+source aggregated row. */
export interface ByDayRow {
  day: string; // YYYY-MM-DD
  source: string; // daytona | llm | blob | ...
  sandboxSeconds: number;
  tokensIn: number;
  tokensOut: number;
}

/** Totals across the queried window. */
export interface Totals {
  sandboxSeconds: number;
  tokensIn: number;
  tokensOut: number;
  count: number;
}

interface UsageDashboardProps {
  byDay: ByDayRow[];
  totals: Totals;
}

type Metric = "sandboxSeconds" | "tokens";

const BAR_COLOR = "#10b981";

export function UsageDashboard({ byDay, totals }: UsageDashboardProps) {
  const t = useTranslations("Usage");
  const format = useFormatter();
  const locale = useLocale();
  const [metric, setMetric] = useState<Metric>("sandboxSeconds");

  // Aggregate byDay into one row per day (single summed value per metric).
  // Source dimension is intentionally ignored — the chart shows totals only.
  const chartData = useMemo(() => {
    const map = new Map<string, { day: string; value: number }>();
    for (const r of byDay) {
      const existing = map.get(r.day);
      const v =
        metric === "sandboxSeconds"
          ? r.sandboxSeconds
          : r.tokensIn + r.tokensOut;
      if (existing) {
        existing.value += v;
      } else {
        map.set(r.day, { day: r.day, value: v });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
  }, [byDay, metric]);

  // Aggregate breakdown rows by day (sum across sources).
  const sortedRows = useMemo(() => {
    const map = new Map<
      string,
      { day: string; sandboxSeconds: number; tokensIn: number; tokensOut: number }
    >();
    for (const r of byDay) {
      const existing = map.get(r.day);
      if (existing) {
        existing.sandboxSeconds += r.sandboxSeconds;
        existing.tokensIn += r.tokensIn;
        existing.tokensOut += r.tokensOut;
      } else {
        map.set(r.day, {
          day: r.day,
          sandboxSeconds: r.sandboxSeconds,
          tokensIn: r.tokensIn,
          tokensOut: r.tokensOut,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.day.localeCompare(a.day));
  }, [byDay]);

  return (
    <div className="mx-auto h-full max-w-5xl overflow-y-auto px-6 py-8">
      {/* Title */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("pageTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("rangeLast90Days")}</p>
      </div>

      {byDay.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-dashed border-border bg-card">
          <p className="text-sm text-muted-foreground">{t("emptyState")}</p>
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              icon={<Clock className="h-4 w-4" />}
              label={t("metricTotalSandboxSeconds")}
              value={formatDuration(totals.sandboxSeconds)}
            />
            <StatCard
              icon={<ArrowDownToLine className="h-4 w-4" />}
              label={t("metricTotalTokensIn")}
              value={formatNumber(totals.tokensIn, locale)}
            />
            <StatCard
              icon={<ArrowUpFromLine className="h-4 w-4" />}
              label={t("metricTotalTokensOut")}
              value={formatNumber(totals.tokensOut, locale)}
            />
          </div>

          {/* Chart */}
          <Card className="mb-8">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">{t("chartDailyUsage")}</CardTitle>
              <div className="flex gap-1">
                <MetricButton
                  active={metric === "sandboxSeconds"}
                  onClick={() => setMetric("sandboxSeconds")}
                >
                  {t("metricSandboxSec")}
                </MetricButton>
                <MetricButton
                  active={metric === "tokens"}
                  onClick={() => setMetric("tokens")}
                >
                  {t("metricTokens")}
                </MetricButton>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="day"
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      tickFormatter={(d: string) => d.slice(5)}
                    />
                    <YAxis
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={11}
                      width={48}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                    />
                    <Bar
                      dataKey="value"
                      fill={BAR_COLOR}
                      radius={[8, 8, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Detail table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("sectionBreakdown")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colDay")}</TableHead>
                    <TableHead className="text-right">{t("colSandboxSec")}</TableHead>
                    <TableHead className="text-right">{t("colTokensIn")}</TableHead>
                    <TableHead className="text-right">{t("colTokensOut")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRows.map((r, i) => (
                    <TableRow key={`${r.day}-${i}`}>
                      <TableCell className="font-mono text-xs">{r.day}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.sandboxSeconds, locale)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.tokensIn, locale)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.tokensOut, locale)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">
          {label}
        </CardTitle>
        <span className="text-muted-foreground">{icon}</span>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function MetricButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-accent"
      }`}
    >
      {children}
    </button>
  );
}

function formatDuration(seconds: number): string {
  if (!seconds) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatNumber(n: number, locale: string = "en"): string {
  if (!n) return "0";
  return new Intl.NumberFormat(locale).format(n);
}
