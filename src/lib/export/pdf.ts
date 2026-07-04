/**
 * PDF export utility — prints a DOM element via a hidden iframe so the
 * browser's native "Save as PDF" engine produces a real, text-based PDF
 * (selectable / copyable text, CJK support out of the box) instead of an
 * image-based screenshot.
 *
 * Why not jsPDF + html2canvas?
 *  - html2canvas screenshots the DOM → the resulting PDF is a series of
 *    PNG images, so text cannot be selected or copied.
 *  - jsPDF's text() API produces selectable text, but its built-in fonts
 *    (Helvetica) don't cover CJK glyphs; embedding a CJK font requires
 *    shipping/downloading a 10 MB+ TTF at runtime.
 *  - The browser's native print engine already has every font the page
 *    uses, handles pagination, and outputs real text. We just open a
 *    hidden iframe, write a clean print document, and call print().
 *
 * The trade-off is that the browser's print dialog opens (the user picks
 * "Save as PDF" as the destination). This is the standard web approach for
 * accessible, selectable-text PDF export.
 *
 * Elements annotated with `data-pdf-exclude` are stripped from the print
 * copy — used to omit the "References: N artifact(s)" footer from PDFs.
 */

/**
 * Print `element` as a PDF via the browser's native print dialog.
 *
 * The element is cloned (so the live DOM is untouched), any descendant
 * marked with `data-pdf-exclude` is removed, and the result is rendered
 * inside a hidden iframe with print-specific CSS before `print()` is
 * called. The user picks "Save as PDF" (or a real printer) in the dialog.
 *
 * @param element  The DOM node to export (typically the rendered report).
 * @param filename Suggested document title (used for the print job name;
 *                 the actual PDF filename is chosen by the user in the
 *                 print dialog).
 */
export function exportReportToPdf(
  element: HTMLElement,
  filename: string,
): void {
  // Clone so we can prune without mutating the live DOM.
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-pdf-exclude]").forEach((el) => el.remove());

  const docTitle = filename.replace(/\.pdf$/i, "") || "Report";

  // Print document: explicit colors (no Tailwind oklch/hsl vars, which
  // can resolve oddly in a fresh iframe), A4 page size, comfortable
  // margins, and sensible defaults for headings/paragraphs/code/tables.
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(docTitle)}</title>
<style>
  @page {
    size: A4;
    margin: 15mm 18mm;
  }
  * {
    box-sizing: border-box;
  }
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #0f172a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC",
      "Source Han Sans SC", sans-serif;
    font-size: 12pt;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4, h5, h6 {
    color: #0f172a;
    font-weight: 700;
    line-height: 1.3;
    margin: 1.2em 0 0.5em;
    page-break-after: avoid;
  }
  h1 { font-size: 22pt; margin-top: 0; }
  h2 { font-size: 17pt; }
  h3 { font-size: 14pt; }
  h4 { font-size: 12pt; }
  p { margin: 0.5em 0; }
  ul, ol { margin: 0.5em 0; padding-left: 1.6em; }
  li { margin: 0.2em 0; }
  code {
    font-family: "SF Mono", "Menlo", "Consolas", "Courier New", monospace;
    font-size: 10.5pt;
    background: #f1f5f9;
    padding: 0.1em 0.35em;
    border-radius: 3px;
  }
  pre {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 0.8em 1em;
    overflow-x: auto;
    page-break-inside: avoid;
    margin: 0.6em 0;
  }
  pre code {
    background: transparent;
    padding: 0;
    font-size: 10pt;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  blockquote {
    border-left: 3px solid #94a3b8;
    margin: 0.6em 0;
    padding: 0.2em 0.9em;
    color: #475569;
    background: #f8fafc;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.6em 0;
    font-size: 10.5pt;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #cbd5e1;
    padding: 0.35em 0.6em;
    text-align: left;
    vertical-align: top;
  }
  thead th {
    background: #f1f5f9;
    font-weight: 600;
  }
  tr:nth-child(even) td {
    background: #f8fafc;
  }
  a {
    color: #1d4ed8;
    text-decoration: underline;
  }
  hr {
    border: 0;
    border-top: 1px solid #cbd5e1;
    margin: 1em 0;
  }
  img {
    max-width: 100%;
    page-break-inside: avoid;
  }
</style>
</head>
<body>
${clone.outerHTML}
</body>
</html>`;

  // Hidden iframe: writing the document and calling print() inside it
  // isolates print styles from the host page and avoids replacing the
  // current document (which would tear down the SPA).
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.visibility = "hidden";
  document.body.appendChild(iframe);

  const iframeWin = iframe.contentWindow;
  if (!iframeWin) {
    document.body.removeChild(iframe);
    throw new Error("Failed to access iframe content window for print");
  }

  const iframeDoc = iframeWin.document;
  iframeDoc.open();
  iframeDoc.write(html);
  iframeDoc.close();

  // Give the iframe a moment to lay out (images, fonts) before printing.
  // The delay is short — content is already in the DOM synchronously
  // after write(); we just need a paint cycle.
  iframeWin.focus();
  setTimeout(() => {
    iframeWin.print();
    // Remove the iframe after the print dialog has had time to capture
    // the document. A 1s delay is generous; the dialog blocks the event
    // loop while open in most browsers, so cleanup happens after close.
    setTimeout(() => {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    }, 1000);
  }, 250);
}

/** Escape `&`, `<`, `>`, `"` for safe interpolation into HTML text. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
