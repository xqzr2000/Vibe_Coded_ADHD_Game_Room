// Renders Scout's professional session statement as a PDF.
// Uses pdfkit (pure JS, no headless browser) and streams straight to the
// HTTP response — nothing is written to disk.

import PDFDocument from "pdfkit";

const INK = "#17221e";
const SOFT = "#55635d";
const RULE = "#d4ddd8";
const ACCENT = "#0e7f74";

export function renderReportPdf(report, res) {
  const doc = new PDFDocument({ size: "LETTER", margin: 64, bufferPages: true });
  doc.pipe(res);

  const dateLabel = new Date(report.generatedAt || Date.now()).toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
  });

  // --- Header -------------------------------------------------------------
  doc.font("Helvetica-Bold").fontSize(18).fillColor(INK).text("Focus Room — Session Statement");
  doc.moveDown(0.25);
  doc.font("Helvetica").fontSize(9).fillColor(SOFT).text(`Generated ${dateLabel} · Prepared by Scout, an AI research agent`);
  doc.moveDown(0.7);
  rule(doc);
  doc.moveDown(0.9);

  // --- Body sections ------------------------------------------------------
  section(doc, "Purpose of this document", report.purpose);
  section(doc, "Summary of the conversation", report.summary);
  bulletSection(doc, "Reported experiences", report.reportedExperiences);
  bulletSection(doc, "Areas discussed", report.areasDiscussed);
  bulletSection(doc, "Games and resources reviewed", report.resourcesReviewed);
  bulletSection(doc, "Suggested next steps", report.nextSteps);

  if (report.questionsForClinician?.length) {
    bulletSection(doc, "Questions to bring to a clinician", report.questionsForClinician);
  }

  // --- Disclaimer ---------------------------------------------------------
  doc.moveDown(0.5);
  rule(doc);
  doc.moveDown(0.6);
  doc
    .font("Helvetica-Oblique")
    .fontSize(8.5)
    .fillColor(SOFT)
    .text(
      report.disclaimer ||
        "This document summarizes a conversation with an AI screening companion. It is not a diagnosis, a medical record, or a clinical assessment, and it was not produced by a licensed clinician. ADHD can only be diagnosed through evaluation by a qualified professional; conditions including anxiety, depression, sleep disorders, and thyroid dysfunction can produce similar symptoms. EndeavorRx is a prescription-only treatment for children aged 8-17. Please bring any concerns to a physician, psychiatrist, or psychologist.",
      { align: "left", lineGap: 1.5 }
    );

  // --- Page numbers -------------------------------------------------------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // Writing into the bottom margin would trigger an extra blank page,
    // so drop the bottom margin for the duration of the stamp.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(SOFT)
      .text(`Page ${i - range.start + 1} of ${range.count}`, 64, doc.page.height - 44, {
        align: "center",
        width: doc.page.width - 128,
        lineBreak: false,
      });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
}

function rule(doc) {
  const y = doc.y;
  doc.moveTo(64, y).lineTo(doc.page.width - 64, y).lineWidth(0.75).strokeColor(RULE).stroke();
}

function heading(doc, text) {
  if (doc.y > doc.page.height - 140) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(ACCENT).text(text.toUpperCase(), { characterSpacing: 0.6 });
  doc.moveDown(0.35);
}

function section(doc, title, body) {
  if (!body) return;
  heading(doc, title);
  doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(String(body), { align: "left", lineGap: 2.5 });
  doc.moveDown(1);
}

function bulletSection(doc, title, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  heading(doc, title);
  doc.font("Helvetica").fontSize(10.5).fillColor(INK);
  for (const item of items) {
    if (doc.y > doc.page.height - 100) doc.addPage();
    doc.text(`•   ${String(item)}`, { align: "left", lineGap: 2, indent: 4 });
    doc.moveDown(0.28);
  }
  doc.moveDown(0.75);
}
