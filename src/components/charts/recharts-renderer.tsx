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
 * Render a Recharts chart from a ChartPayload spec.
 *
 * Supports bar, line, area, pie, and scatter chart types.
 * The chart is responsive and fills its container width.
 */
export function RechartsRenderer({ spec }: RechartsRendererProps) {
  const { chartType, data, xKey, yKeys, title } = spec;

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
          {renderChart(chartType, data, xKey, yKeys)}
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
): React.ReactElement {
  switch (chartType) {
    case "bar":
      return (
        <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid hsl(0 0% 89.8%)",
              fontSize: "12px",
            }}
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
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid hsl(0 0% 89.8%)",
              fontSize: "12px",
            }}
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
        <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
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
          <YAxis
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid hsl(0 0% 89.8%)",
              fontSize: "12px",
            }}
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
      return (
        <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 90%)" />
          <XAxis
            dataKey={xKey}
            type="number"
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <YAxis
            dataKey={yKey}
            type="number"
            tick={{ fontSize: 11, fill: "hsl(0 0% 45%)" }}
            tickLine={false}
            axisLine={{ stroke: "hsl(0 0% 89.8%)" }}
          />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid hsl(0 0% 89.8%)",
              fontSize: "12px",
            }}
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
