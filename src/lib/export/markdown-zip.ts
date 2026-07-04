/**
 * Export a report artifact as a ZIP archive containing:
 *   - report.md  — the Markdown body with {{artifact:ID}} markers replaced
 *                  by image links (![](images/chart-ID.png)) or inline
 *                  Markdown tables / text / code blocks.
 *   - images/    — one PNG per chart / forecast artifact, screenshotted
 *                  from the live DOM via html-to-image.
 *
 * Non-chart artifacts (tables, summaries, code, files) are serialized as
 * their Markdown equivalent — no image needed. This keeps the .md file
 * editable and the archive portable: any Markdown renderer that supports
 * relative image links will display the full report with charts.
 */

import JSZip from "jszip";
import { toPng } from "html-to-image";
import type {
  Artifact,
  ChartPayload,
  CodePayload,
  FilePayload,
  ForecastPayload,
  ReportPayload,
  SummaryPayload,
  TablePayload,
} from "@/lib/agent/state";

/**
 * Export a report as a .zip archive (Markdown + images).
 *
 * @param reportEl  The report container DOM element. Chart nodes are located
 *                  inside it via `[data-artifact-id="ID"]` attributes.
 * @param payload   The report payload (content + embeddedArtifacts).
 * @param filename  Suggested archive filename (without extension).
 */
export async function exportReportToMarkdownZip(
  reportEl: HTMLElement,
  payload: ReportPayload,
  filename: string,
): Promise<void> {
  const zip = new JSZip();
  const imagesFolder = zip.folder("images");

  // Build a lookup map: id → artifact
  const embeddedMap = new Map<string, Artifact>();
  if (payload.embeddedArtifacts) {
    for (const ea of payload.embeddedArtifacts) {
      embeddedMap.set(ea.id, ea.artifact);
    }
  }

  // Process the Markdown content: replace each {{artifact:ID}} marker.
  // Chart/forecast artifacts are screenshotted to PNG and referenced via
  // ![](images/chart-ID.png); other types are inlined as Markdown.
  let markdown = payload.content;
  const screenshotTasks: Promise<void>[] = [];

  if (payload.embeddedArtifacts && payload.embeddedArtifacts.length > 0) {
    for (const ea of payload.embeddedArtifacts) {
      const { id, artifact } = ea;
      const markerRe = new RegExp(
        `{{artifact:\\s*${id}\\s*}}`,
        "g",
      );
      const replacement = artifactToMarkdown(artifact, id);

      // If this artifact needs a screenshot (chart/forecast), capture it.
      if (needsScreenshot(artifact)) {
        const imgName = `chart-${id}.png`;
        screenshotTasks.push(
          captureArtifactPng(reportEl, id).then((dataUrl) => {
            if (dataUrl) {
              const base64 = dataUrl.split(",")[1];
              imagesFolder?.file(imgName, base64, { base64: true });
            }
          }),
        );
      }

      markdown = markdown.replace(markerRe, replacement);
    }
  }

  // If markers exist in content but aren't in embeddedArtifacts (shouldn't
  // happen in practice), strip them to avoid leaking raw markers.
  markdown = markdown.replace(/{{artifact:\s*\w+\s*}}/g, "");

  // Wait for all screenshots to complete before finalizing the zip.
  await Promise.all(screenshotTasks);

  // Add the Markdown file.
  zip.file("report.md", markdown);

  // Generate and download the archive.
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const safe = filename.replace(/[^\w\-.]+/g, "_") || "report";
  triggerDownload(url, `${safe}.zip`);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

/** Whether an artifact should be screenshotted to PNG for the archive. */
function needsScreenshot(artifact: Artifact): boolean {
  return artifact.type === "chart" || artifact.type === "forecast";
}

/**
 * Convert a non-chart artifact to its Markdown representation.
 * Chart/forecast artifacts return an image link (the PNG is captured
 * separately).
 */
function artifactToMarkdown(artifact: Artifact, id: string): string {
  switch (artifact.type) {
    case "chart":
    case "forecast": {
      const imgName = `chart-${id}.png`;
      const title =
        artifact.type === "chart"
          ? (artifact.payload as ChartPayload).title ?? "Chart"
          : "Forecast";
      return `![${title}](images/${imgName})`;
    }
    case "table":
      return tableToMarkdown(artifact.payload as TablePayload);
    case "file":
      return tableToMarkdown({
        columns: (artifact.payload as FilePayload).columns,
        rows: (artifact.payload as FilePayload).rows,
        title: (artifact.payload as FilePayload).title,
      });
    case "summary":
      return (artifact.payload as SummaryPayload).text;
    case "code": {
      const cp = artifact.payload as CodePayload;
      return `\n\`\`\`${cp.language}\n${cp.code}\n\`\`\`\n`;
    }
    default:
      return "";
  }
}

/** Convert a table payload to a GFM Markdown table. */
function tableToMarkdown(payload: {
  columns: string[];
  rows: unknown[][];
  title?: string;
}): string {
  const { columns, rows, title } = payload;
  let md = "";
  if (title) md += `**${title}**\n\n`;
  if (columns.length === 0) return md + "_(empty table)_\n";

  // Header
  md += `| ${columns.map(escapeMdPipe).join(" | ")} |\n`;
  md += `| ${columns.map(() => "---").join(" | ")} |\n`;
  // Rows
  for (const row of rows) {
    md += `| ${columns
      .map((_, i) => escapeMdPipe(formatCell(row[i])))
      .join(" | ")} |\n`;
  }
  return md + "\n";
}

/** Format a cell value for Markdown table display. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Escape pipe characters in Markdown table cells. */
function escapeMdPipe(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Screenshot an inline-rendered artifact DOM node to a PNG data URL.
 * The node is located via `[data-artifact-id="ID"]` inside the report
 * container. Returns null if the node isn't found or capture fails.
 */
async function captureArtifactPng(
  reportEl: HTMLElement,
  id: string,
): Promise<string | null> {
  const node = reportEl.querySelector(`[data-artifact-id="${id}"]`);
  if (!node || !(node instanceof HTMLElement)) return null;
  try {
    return await toPng(node, {
      backgroundColor: "#ffffff",
      pixelRatio: 2,
      cacheBust: true,
    });
  } catch (err) {
    console.error(`[markdown-zip] screenshot failed for ${id}:`, err);
    return null;
  }
}

/** Trigger a browser download from a data URL or object URL. */
function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
