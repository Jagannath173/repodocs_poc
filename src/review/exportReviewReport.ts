import * as vscode from "vscode";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import ExcelJS from "exceljs";
import type { ReviewTableState } from "../commands/webview/review_Webview/reviewPanel";

function asciiSafe(s: string): string {
  return s.replace(/[^\t\n\r\x20-\x7e]/g, "?");
}

function buildPlainReportBody(stored: ReviewTableState): string {
  const appliedSet = new Set(stored.appliedIndices ?? []);
  const records = (stored.appliedFixRecords ?? []).filter(
    (r) => !r?.isDemo && appliedSet.has(r.findingIndex)
  );
  const lines: string[] = [];
  lines.push(`Code review report — ${stored.fileName}`);
  lines.push(`Summary: ${stored.summary || "—"}`);
  lines.push("");
  lines.push("Accepted fixes:");
  lines.push("");
  for (const r of records) {
    const title = String(r.title || "Finding").replace(/\[sample\]\s*/gi, "").trim();
    lines.push(`--- ${title || "Finding"} (${r.findingIndex + 1}) ---`);
    lines.push(`Severity: ${r.severity || "—"}  Category: ${r.category || "—"}`);
    lines.push("Description:");
    lines.push(r.detail || "—");
    lines.push("Suggested fix:");
    lines.push(r.suggestion || "—");
    if (r.appliedAt) {
      lines.push(`Recorded: ${r.appliedAt}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

type ReportMetrics = {
  total: number;
  applied: number;
  rejected: number;
  pending: number;
};

function computeReportMetrics(stored: ReviewTableState): ReportMetrics {
  const totalFromRows = stored.findings?.length ?? 0;
  const declared =
    typeof stored.reviewFindingCount === "number" && !Number.isNaN(stored.reviewFindingCount)
      ? Math.max(0, stored.reviewFindingCount)
      : 0;
  const total = Math.max(totalFromRows, declared);
  const applied = stored.appliedIndices?.length ?? 0;
  const rejected = stored.rejectedIndices?.length ?? 0;
  const pending = Math.max(0, total - applied - rejected);
  return { total, applied, rejected, pending };
}

function clip(s: string, max: number): string {
  const t = String(s ?? "");
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`;
}

function issueDescriptionOnly(detail: string): string {
  return String(detail || "").split(/\n\nCode:/i)[0].trim() || "—";
}

export async function exportReviewReportToPdf(stored: ReviewTableState): Promise<void> {
  const pick = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${sanitizeBaseName(stored.fileName)}-review-report.pdf`),
    filters: { "PDF": ["pdf"] },
    saveLabel: "Save PDF",
  });
  if (!pick) {
    return;
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595; // A4
  const pageHeight = 842;
  const margin = 38;
  const contentW = pageWidth - margin * 2;
  const blue = rgb(0.12, 0.43, 0.92);
  const white = rgb(1, 1, 1);
  const textDark = rgb(0.12, 0.14, 0.18);
  const textMuted = rgb(0.35, 0.38, 0.42);
  const panel = rgb(0.96, 0.98, 1);

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ensureSpace = (need: number): void => {
    if (y - need < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  };

  const wrap = (raw: string, maxWidth: number, size: number, f = font): string[] => {
    const text = asciiSafe(raw || "");
    if (!text.trim()) return [""];
    const words = text.split(/\s+/);
    const out: string[] = [];
    let line = "";
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };

  const drawLines = (
    lines: string[],
    x: number,
    width: number,
    size: number,
    lineH: number,
    color = textDark,
    f = font
  ): void => {
    for (const l of lines) {
      ensureSpace(lineH + 2);
      page.drawText(clip(l, 1000), { x, y, size, font: f, color, maxWidth: width });
      y -= lineH;
    }
  };
  const drawTable = (
    title: string,
    headers: string[],
    rows: string[][],
    widths: number[]
  ): void => {
    ensureSpace(24);
    page.drawText(title, { x: margin, y, size: 10, font: fontBold, color: blue });
    y -= 12;
    const rowH = 16;
    const drawHead = () => {
      ensureSpace(rowH + 2);
      let x = margin;
      for (let i = 0; i < widths.length; i++) {
        page.drawRectangle({ x, y: y - rowH + 2, width: widths[i], height: rowH, color: blue });
        page.drawText(headers[i] || "", { x: x + 4, y: y - 10, size: 8, font: fontBold, color: white });
        x += widths[i];
      }
      y -= rowH;
    };
    drawHead();
    if (!rows.length) {
      rows = [["—", "No data", "—"]];
    }
    for (const row of rows) {
      ensureSpace(rowH + 2);
      if (y < margin + 60) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
        drawHead();
      }
      let x = margin;
      for (let c = 0; c < widths.length; c++) {
        page.drawRectangle({
          x,
          y: y - rowH + 2,
          width: widths[c],
          height: rowH,
          borderColor: rgb(0.8, 0.84, 0.9),
          borderWidth: 0.5,
          color: c % 2 === 0 ? rgb(0.99, 0.995, 1) : rgb(0.985, 0.99, 0.998),
        });
        page.drawText(clip(asciiSafe(row[c] ?? ""), 180), {
          x: x + 4,
          y: y - 10,
          size: 7.4,
          font,
          color: textDark,
          maxWidth: widths[c] - 6,
        });
        x += widths[c];
      }
      y -= rowH;
    }
    y -= 8;
  };

  // Header
  ensureSpace(72);
  page.drawRectangle({ x: margin, y: y - 26, width: contentW, height: 26, color: blue });
  page.drawText("Code Review Report", {
    x: margin + 10,
    y: y - 18,
    size: 12,
    font: fontBold,
    color: white,
  });
  y -= 38;
  page.drawText(clip(stored.fileName || "file", 180), {
    x: margin,
    y,
    size: 10,
    font: fontBold,
    color: textDark,
  });
  y -= 16;
  drawLines(
    wrap(`Summary: ${stored.summary || "—"}`, contentW, 9),
    margin,
    contentW,
    9,
    12,
    textMuted,
    font
  );
  y -= 4;

  // Summary table panel
  const metrics = computeReportMetrics(stored);
  ensureSpace(96);
  page.drawRectangle({ x: margin, y: y - 70, width: contentW, height: 70, color: panel });
  page.drawText("Report Summary", { x: margin + 10, y: y - 13, size: 10, font: fontBold, color: blue });
  const summaryRows: string[][] = [
    ["Total Findings", String(metrics.total), "Rows analyzed in this review snapshot"],
    ["Fixed (Accepted)", String(metrics.applied), "Findings accepted from fix preview"],
    ["Rejected", String(metrics.rejected), "Findings explicitly rejected by user"],
    ["Still Open", String(metrics.pending), "Pending findings that need action"],
  ];
  let ry = y - 28;
  for (const row of summaryRows) {
    page.drawText(`- ${row[0]}: ${row[1]} (${row[2]})`, {
      x: margin + 12,
      y: ry,
      size: 8.4,
      font,
      color: textDark,
      maxWidth: contentW - 18,
    });
    ry -= 10.5;
  }
  y -= 84;

  drawTable(
    "Progress Overview",
    ["Metric", "Count", "Status"],
    [
      ["Total Findings", String(metrics.total), metrics.total > 0 ? "Tracked" : "No findings"],
      ["Fixed", String(metrics.applied), metrics.applied > 0 ? "In progress" : "None"],
      ["Rejected", String(metrics.rejected), metrics.rejected > 0 ? "Reviewed" : "None"],
      ["Open", String(metrics.pending), metrics.pending > 0 ? "Needs action" : "Complete"],
    ],
    [190, 70, contentW - 260]
  );

  // Findings table
  const findings = Array.isArray(stored.findings) ? stored.findings : [];
  const appliedSet = new Set(stored.appliedIndices ?? []);
  const rejectedSet = new Set(stored.rejectedIndices ?? []);
  const findingRows = findings.map((f, i) => {
    const status = appliedSet.has(i) ? "Accepted" : rejectedSet.has(i) ? "Rejected" : "Open";
    return [
      String(i + 1),
      clip(String((f as { severity?: string }).severity || "—"), 12),
      status,
      clip(issueDescriptionOnly(String((f as { detail?: string }).detail || "")), 70),
      clip(String((f as { suggestion?: string }).suggestion || "—"), 34),
    ];
  });
  drawTable(
    "Findings Table",
    ["#", "Severity", "Status", "Description", "Suggested fix"],
    findingRows,
    [30, 54, 76, 248, contentW - 408]
  );

  // Accepted fix details
  const appliedSetForDetails = new Set(stored.appliedIndices ?? []);
  const records = (stored.appliedFixRecords ?? []).filter(
    (r) => !r?.isDemo && appliedSetForDetails.has(r.findingIndex)
  );
  ensureSpace(26);
  page.drawText("Accepted Fix Details", { x: margin, y, size: 10, font: fontBold, color: blue });
  y -= 14;
  if (!records.length) {
    drawLines(["No accepted fixes recorded."], margin, contentW, 9, 12, textMuted, font);
  } else {
    for (const r of records) {
      const blockNeed = 72;
      ensureSpace(blockNeed);
      page.drawRectangle({
        x: margin,
        y: y - blockNeed + 8,
        width: contentW,
        height: blockNeed - 8,
        borderColor: rgb(0.78, 0.82, 0.9),
        borderWidth: 0.8,
        color: rgb(0.985, 0.99, 1),
      });
      const title = String(r.title || "Finding").replace(/\[sample\]\s*/gi, "").trim();
      page.drawText(clip(`${title || "Finding"} (${r.findingIndex + 1})`, 180), {
        x: margin + 10,
        y: y - 14,
        size: 9.5,
        font: fontBold,
        color: textDark,
      });
      const meta = `Severity: ${r.severity || "—"}   Category: ${r.category || "—"}   Recorded: ${r.appliedAt || "—"}`;
      page.drawText(clip(asciiSafe(meta), 230), {
        x: margin + 10,
        y: y - 27,
        size: 8,
        font,
        color: textMuted,
        maxWidth: contentW - 20,
      });
      const desc = `Description: ${clip(r.detail || "—", 220)}`;
      const sug = `Suggested fix: ${clip(r.suggestion || "—", 220)}`;
      page.drawText(asciiSafe(desc), { x: margin + 10, y: y - 39, size: 8.2, font, color: textDark, maxWidth: contentW - 20 });
      page.drawText(asciiSafe(sug), { x: margin + 10, y: y - 50, size: 8.2, font, color: textDark, maxWidth: contentW - 20 });
      y -= blockNeed + 8;
    }
  }

  const bytes = await pdfDoc.save();
  await vscode.workspace.fs.writeFile(pick, Buffer.from(bytes));
  void vscode.window.showInformationMessage(`Saved PDF report: ${pick.fsPath}`);
}

export async function exportReviewReportToXlsx(stored: ReviewTableState): Promise<void> {
  const pick = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`${sanitizeBaseName(stored.fileName)}-review-report.xlsx`),
    filters: { Excel: ["xlsx"] },
    saveLabel: "Save Excel",
  });
  if (!pick) {
    return;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Code Review";
  const sheet = wb.addWorksheet("Review report", {
    properties: { defaultRowHeight: 18 },
  });
  [6, 28, 12, 40, 36, 22].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  let rowNum = 1;
  const header = ["#", "Title", "Severity", "Description", "Suggested fix", "Recorded (UTC)"];
  sheet.getRow(rowNum).values = header;
  sheet.getRow(rowNum).font = { bold: true };
  rowNum++;

  const appliedSet = new Set(stored.appliedIndices ?? []);
  const records = (stored.appliedFixRecords ?? []).filter(
    (r) => !r?.isDemo && appliedSet.has(r.findingIndex)
  );
  for (const r of records) {
    const title = String(r.title || "").replace(/\[sample\]\s*/gi, "").trim();
    sheet.getRow(rowNum).values = [r.findingIndex + 1, title, r.severity, r.detail, r.suggestion, r.appliedAt ?? ""];
    rowNum++;
  }

  const buf = await wb.xlsx.writeBuffer();
  await vscode.workspace.fs.writeFile(pick, Buffer.from(buf));
  void vscode.window.showInformationMessage(`Saved Excel report: ${pick.fsPath}`);
}

function sanitizeBaseName(fileName: string): string {
  const base = fileName.replace(/[\\/]/g, "_");
  return base.replace(/\.[^.]+$/, "") || "file";
}
