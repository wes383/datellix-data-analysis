/**
 * Shared helpers for transforming SQL query results into Recharts data arrays.
 *
 * Used by:
 *   - chart-viewer.tsx (library grid + detail page)
 *   - artifact-renderer.tsx (chat history rehydration)
 *   - the batch refresh flow (initial data passed from LibraryGrid)
 *
 * Numeric strings are coerced to numbers so Recharts draws axes correctly;
 * empty strings and non-numeric strings stay as-is. Capped at 100 rows to
 * match the SQL executor's MAX_ROWS display limit.
 */

/** Maximum rows to feed into a Recharts chart (matches MAX_ROWS in tools.ts). */
const MAX_CHART_ROWS = 100;

/**
 * Convert SQL columns + rows into the object-array shape Recharts expects.
 *
 * Each row becomes `{ [columnName]: value }`. Numeric strings (e.g. "42",
 * "3.14") are coerced to numbers so axes render as numbers, not categories.
 * Empty strings and non-numeric strings are preserved as-is. The first
 * 100 rows are returned (matches the SQL executor's display cap).
 */
export function buildChartData(
  columns: string[],
  rows: unknown[][],
): Record<string, unknown>[] {
  return rows.slice(0, MAX_CHART_ROWS).map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      const val = row[idx];
      if (typeof val === "string" && val !== "" && !isNaN(Number(val))) {
        obj[col] = Number(val);
      } else {
        obj[col] = val;
      }
    });
    return obj;
  });
}

/** Shape of a successful SQL refresh result returned to the client. */
export interface ChartRefreshData {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}
