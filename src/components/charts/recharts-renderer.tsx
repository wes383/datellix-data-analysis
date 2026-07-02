"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Area,
  AreaChart,
  Pie,
  PieChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import type { ChartPayload } from "@/lib/agent/state";

interface RechartsRendererProps {
  spec: ChartPayload;
}

// Color palette for series
const COLORS = [
  "#0f172a",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f43f5e",
];

/**
 * Compact number formatter for axis ticks. Large values are abbreviated to
 * keep the tick labels short enough to fit in the YAxis gutter — otherwise
 * values like 18000000000000 (GDP) overflow and get clipped on the left.
 * - |v| < 1e3  → raw (e.g. 42, 3.14)
 * - |v| < 1e6  → 1.2K, 3.4K
 * - |v| < 1e9  → 5.6M
 * - |v| < 1e12 → 7.8B
 * - else       → 9.0T
 */
function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1e3) return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (abs < 1e6) return (value / 1e3).toFixed(1) + "K";
  if (abs < 1e9) return (value / 1e6).toFixed(1) + "M";
  if (abs < 1e12) return (value / 1e9).toFixed(1) + "B";
  return (value / 1e12).toFixed(1) + "T";
}

/** Formatter for tooltip values — shows both compact and full precision. */
function formatTooltipValue(value: unknown): string {
  if (typeof value !== "number" || !isFinite(value)) return String(value);
  const compact = formatCompact(value);
  // If the compact form lost precision, append the full value in parentheses.
  if (compact !== String(value) && Math.abs(value) >= 1e3) {
    return `${compact} (${value.toLocaleString()})`;
  }
  return compact;
}

/** Shared YAxis props so every chart type formats ticks identically. */
const YAXIS_PROPS = {
  tick: { fontSize: 11, fill: "hsl(0 0% 45%)" },
  tickLine: false as const,
  axisLine: { stroke: "hsl(0 0% 89.8%)" },
  tickFormatter: (v: number) => formatCompact(v),
  // Default Recharts YAxis width is 60px; bump to 56px is enough for "9.0T"
  // but we keep 60 to be safe with negative values like "-1.2M".
  width: 56,
};

/** Shared Tooltip formatter — applies compact number formatting to values. */
const TOOLTIP_FORMATTER = (value: unknown) =>
  typeof value === "number" ? formatTooltipValue(value) : String(value);

/** Shared Tooltip style. */
const TOOLTIP_STYLE = {
  borderRadius: "8px",
  border: "1px solid hsl(0 0% 89.8%)",
  fontSize: "12px",
};

/**
 * Render a Recharts chart from a ChartPayload spec.
 *
 * Supports bar, line, area, pie, and scatter chart types.
 * The chart is responsive and fills its container width.
 */
export function RechartsRenderer({ spec }: RechartsRendererProps) {
  const { chartType, data, xKey, yKeys, title, groupKey } = spec;

  if (!data || data.length === 0 || !xKey || yKeys.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
        No data to visualize
      </div>
    );
  }

  const containerHeight = chartType === "pie" ? 320 : 300;

  return (
    <div className="w-full">
      {title && (
        <p className="mb-3 font-display text-sm font-medium tracking-tight text-foreground">
          {title}
        </p>
      )}
      <div style={{ width: "100%", height: containerHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          {renderChart(chartType, data, xKey, yKeys, groupKey)}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function renderChart(
  chartType: ChartPayload["chartType"],
  data: Record<string, unknown>[],
  xKey: string,
  yKeys: string[],
  groupKey?: string,
): React.ReactElement {
  switch (chartType) {
    case "bar":
      return (
        <BarChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <YAxis {...YAXIS_PROPS} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={TOOLTIP_FORMATTER}
          />
          {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: "12px" }} />}
          {yKeys.map((key, idx) => (
            <Bar
              key={key}
              dataKey={key}
              fill={COLORS[idx % COLORS.length]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      );

    case "line":
      return (
        <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <YAxis {...YAXIS_PROPS} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={TOOLTIP_FORMATTER}
          />
          {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: "12px" }} />}
          {yKeys.map((key, idx) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={COLORS[idx % COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3, fill: COLORS[idx % COLORS.length] }}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      );

    case "area":
      return (
        <AreaChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <defs>
            {yKeys.map((key, idx) => (
              <linearGradient
                key={key}
                id={`gradient-${key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor={COLORS[idx % COLORS.length]}
                  stopOpacity={0.3}
                />
                <stop
                  offset="95%"
                  stopColor={COLORS[idx % COLORS.length]}
                  stopOpacity={0.05}
                />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <YAxis {...YAXIS_PROPS} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={TOOLTIP_FORMATTER}
          />
          {yKeys.length > 1 && <Legend wrapperStyle={{ fontSize: "12px" }} />}
          {yKeys.map((key, idx) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={COLORS[idx % COLORS.length]}
              strokeWidth={2}
              fill={`url(#gradient-${key})`}
            />
          ))}
        </AreaChart>
      );

    case "pie": {
      const yKey = yKeys[0];
      return (
        <PieChart>
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid hsl(0 0% 89.8%)",
              fontSize: "12px",
            }}
          />
          <Legend wrapperStyle={{ fontSize: "12px" }} />
          <Pie
            data={data}
            dataKey={yKey}
            nameKey={xKey}
            cx="50%"
            cy="50%"
            outerRadius={100}
            innerRadius={45}
            paddingAngle={2}
          >
            {data.map((_, idx) => (
              <Cell
                key={idx}
                fill={COLORS[idx % COLORS.length]}
                stroke="hsl(0 0% 100%)"
                strokeWidth={2}
              />
            ))}
          </Pie>
        </PieChart>
      );
    }

    case "scatter": {
      const yKey = yKeys[0];
      // When a groupKey is present, split the data into one Scatter series
      // per distinct group value so each cluster gets its own color and
      // legend entry. Order groups by first appearance to keep cluster ids
      // stable; "Noise" is pushed to the end so it renders last (gray).
      if (groupKey) {
        const groups: string[] = [];
        const noiseGroup = "Noise";
        for (const row of data) {
          const g = String(row[groupKey] ?? "Unknown");
          if (g !== noiseGroup && !groups.includes(g)) groups.push(g);
        }
        groups.sort(); // Cluster 0, Cluster 1, ... in numeric order
        // Append "Noise" last if present
        if (data.some((r) => String(r[groupKey]) === noiseGroup)) {
          groups.push(noiseGroup);
        }
        const seriesMap = new Map<string, Record<string, unknown>[]>();
        for (const g of groups) seriesMap.set(g, []);
        for (const row of data) {
          const g = String(row[groupKey] ?? "Unknown");
          seriesMap.get(g)?.push(row);
        }
        return (
          <ScatterChart margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" />
            <XAxis
              dataKey={xKey}
              type="number"
              tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
              tickLine={false}
              axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
              tickFormatter={(v: number) => formatCompact(v)}
            />
            <YAxis
              dataKey={yKey}
              type="number"
              {...YAXIS_PROPS}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={TOOLTIP_FORMATTER}
            />
            <Legend wrapperStyle={{ fontSize: "12px" }} />
            {groups.map((g, idx) => {
              // Noise points get a muted gray; clusters use the palette.
              const color = g === "Noise" ? "#9ca3af" : COLORS[idx % COLORS.length];
              return (
                <Scatter
                  key={g}
                  name={g}
                  data={seriesMap.get(g) ?? []}
                  fill={color}
                  fillOpacity={0.7}
                />
              );
            })}
          </ScatterChart>
        );
      }
      // No grouping — single series, single color (original behavior).
      return (
        <ScatterChart margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" />
          <XAxis
            dataKey={xKey}
            type="number"
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
            tickFormatter={(v: number) => formatCompact(v)}
          />
          <YAxis
            dataKey={yKey}
            type="number"
            {...YAXIS_PROPS}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={TOOLTIP_FORMATTER}
          />
          <Scatter
            data={data}
            fill={COLORS[0]}
            fillOpacity={0.6}
          />
        </ScatterChart>
      );
    }

    default:
      return (
        <BarChart data={data}>
          <Bar dataKey={yKeys[0]} fill={COLORS[0]} />
        </BarChart>
      );
  }
}
