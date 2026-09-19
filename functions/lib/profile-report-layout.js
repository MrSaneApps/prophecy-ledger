import { rgb } from "pdf-lib";

const PAGE = Object.freeze({ width: 960, height: 540, margin: 56, bottom: 42 });
export const COLORS = Object.freeze({
  background: rgb(0.025, 0.039, 0.057),
  panel: rgb(0.055, 0.086, 0.12),
  panelBright: rgb(0.075, 0.12, 0.16),
  cyan: rgb(0.27, 0.93, 0.88),
  cyanSoft: rgb(0.48, 0.73, 0.72),
  cream: rgb(0.96, 0.94, 0.88),
  muted: rgb(0.66, 0.73, 0.76),
  amber: rgb(1, 0.70, 0.35),
  rust: rgb(1, 0.44, 0.32),
  green: rgb(0.40, 0.91, 0.66),
  black: rgb(0.01, 0.02, 0.025),
});

function ascii(value) {
  return String(value ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2011]/g, "-")
    .replace(/\u2026/g, "...")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E\n]/g, "");
}

export function titleCase(value) {
  return ascii(value).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function splitLongToken(token, font, size, maxWidth) {
  const parts = [];
  let current = "";
  for (const character of token) {
    const candidate = current + character;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      parts.push(current);
      current = character;
    } else current = candidate;
  }
  if (current) parts.push(current);
  return parts;
}

function wrap(text, font, size, maxWidth) {
  const lines = [];
  for (const paragraph of ascii(text).split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean).flatMap((word) =>
      font.widthOfTextAtSize(word, size) > maxWidth
        ? splitLongToken(word, font, size, maxWidth) : [word]);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

export class Composer {
  constructor(pdf, fonts) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.pages = [];
    this.page = null;
    this.y = 0;
    this.sectionName = "EVIDENCE REPORT";
  }

  addPage(sectionName = this.sectionName) {
    this.sectionName = sectionName;
    this.page = this.pdf.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.page.drawRectangle({
      x: 0, y: 0, width: PAGE.width, height: PAGE.height, color: COLORS.background,
    });
    this.page.drawCircle({
      x: PAGE.width - 60, y: PAGE.height - 30, size: 120,
      color: COLORS.cyan, opacity: 0.035,
    });
    this.page.drawText("SANEAPPS LAB / THE PROPHECY LEDGER", {
      x: PAGE.margin, y: PAGE.height - 35, size: 8, font: this.fonts.sansBold,
      color: COLORS.cyan, characterSpacing: 1.5,
    });
    const section = ascii(sectionName).toUpperCase();
    this.page.drawText(section, {
      x: PAGE.width - PAGE.margin - this.fonts.sansBold.widthOfTextAtSize(section, 8),
      y: PAGE.height - 35, size: 8, font: this.fonts.sansBold,
      color: COLORS.muted, characterSpacing: 1.1,
    });
    this.page.drawLine({
      start: { x: PAGE.margin, y: PAGE.height - 46 },
      end: { x: PAGE.width - PAGE.margin, y: PAGE.height - 46 },
      thickness: 0.7, color: COLORS.cyan, opacity: 0.42,
    });
    this.y = PAGE.height - 72;
  }

  ensure(height, sectionName = this.sectionName) {
    if (!this.page || this.y - height < PAGE.bottom) this.addPage(sectionName);
  }

  text(value, options = {}) {
    const font = options.font || this.fonts.sans;
    const size = options.size || 10;
    const width = options.width || PAGE.width - (PAGE.margin * 2);
    const x = options.x ?? PAGE.margin;
    const lineHeight = options.lineHeight || size * 1.42;
    const lines = wrap(value, font, size, width);
    this.ensure((lines.length * lineHeight) + (options.after || 0), options.sectionName);
    for (const line of lines) {
      this.page.drawText(line, {
        x, y: this.y, size, font, color: options.color || COLORS.cream,
      });
      this.y -= lineHeight;
    }
    this.y -= options.after || 0;
    return lines.length;
  }

  label(value, after = 8, color = COLORS.cyan) {
    this.text(ascii(value).toUpperCase(), {
      size: 8, font: this.fonts.sansBold, color, lineHeight: 10, after,
    });
  }

  heading(value, level = 2) {
    const size = level === 1 ? 34 : level === 2 ? 21 : 14;
    this.ensure((size * 1.3) + 12);
    this.text(value, {
      size, font: this.fonts.sansBold, lineHeight: size * 1.05,
      color: COLORS.cream, after: level === 1 ? 15 : 10,
    });
  }

  rule(after = 16) {
    this.ensure(after + 2);
    this.page.drawLine({
      start: { x: PAGE.margin, y: this.y },
      end: { x: PAGE.width - PAGE.margin, y: this.y },
      thickness: 0.7, color: COLORS.cyanSoft, opacity: 0.38,
    });
    this.y -= after;
  }

  panel(title, body, options = {}) {
    const inset = 18;
    const width = options.width || PAGE.width - (PAGE.margin * 2);
    const bodyFont = options.bodyFont || this.fonts.sans;
    const bodySize = options.bodySize || 10.5;
    const bodyLines = wrap(body, bodyFont, bodySize, width - (inset * 2));
    const height = 48 + (bodyLines.length * (options.lineHeight || 15));
    this.ensure(height + (options.after ?? 14), options.sectionName);
    const top = this.y;
    this.page.drawRectangle({
      x: options.x ?? PAGE.margin, y: top - height, width, height,
      color: options.color || COLORS.panel,
      borderColor: options.borderColor || COLORS.cyanSoft,
      borderWidth: options.borderWidth ?? 0.8,
      opacity: options.opacity ?? 1,
    });
    const x = (options.x ?? PAGE.margin) + inset;
    this.page.drawText(ascii(title).toUpperCase(), {
      x, y: top - 21, size: 8, font: this.fonts.sansBold,
      color: options.titleColor || COLORS.cyan, characterSpacing: 0.8,
    });
    let lineY = top - 42;
    for (const line of bodyLines) {
      this.page.drawText(line, {
        x, y: lineY, size: bodySize, font: bodyFont,
        color: options.bodyColor || COLORS.cream,
      });
      lineY -= options.lineHeight || 15;
    }
    this.y = top - height - (options.after ?? 14);
  }

  quote(value) {
    this.panel("The speaker's exact words", `"${ascii(value)}"`, {
      bodyFont: this.fonts.serifBold, bodySize: 15, lineHeight: 20,
      color: COLORS.panelBright, borderColor: COLORS.cyan, after: 17,
    });
  }

  bullet(value, options = {}) {
    const size = options.size || 9.5;
    const width = options.width || PAGE.width - (PAGE.margin * 2) - 24;
    const lines = wrap(value, this.fonts.sans, size, width);
    this.ensure((lines.length * 13.5) + 6);
    this.page.drawRectangle({
      x: PAGE.margin, y: this.y + 2, width: 6, height: 6, color: options.color || COLORS.cyan,
    });
    let lineY = this.y;
    for (const line of lines) {
      this.page.drawText(line, {
        x: PAGE.margin + 18, y: lineY, size, font: this.fonts.sans,
        color: COLORS.cream,
      });
      lineY -= 13.5;
    }
    this.y = lineY - 5;
  }

  bulletHeight(value) {
    return (wrap(value, this.fonts.sans, 9.5, PAGE.width - (PAGE.margin * 2) - 24).length * 13.5) + 5;
  }

  keepBulletSection(title, items) {
    const titleHeight = 34;
    const required = titleHeight + items.reduce((sum, item) => sum + this.bulletHeight(item), 0) + 14;
    this.ensure(required, "HOW A DECISION BECOMES FINAL");
    const startPage = this.pages.length;
    this.heading(title, 2);
    items.forEach((item) => this.bullet(item, { color: COLORS.amber }));
    return { startPage, endPage: this.pages.length };
  }

  metricRow(metrics) {
    const gap = 14;
    const width = (PAGE.width - (PAGE.margin * 2) - (gap * 2)) / 3;
    const height = 72;
    this.ensure(height + 20);
    const top = this.y;
    metrics.forEach((metric, index) => {
      const x = PAGE.margin + (index * (width + gap));
      this.page.drawRectangle({
        x, y: top - height, width, height, color: COLORS.panel,
        borderColor: COLORS.cyanSoft, borderWidth: 0.7,
      });
      this.page.drawText(ascii(metric.value), {
        x: x + 16, y: top - 31, size: 24, font: this.fonts.sansBold,
        color: metric.color || COLORS.cyan,
      });
      this.page.drawText(ascii(metric.label).toUpperCase(), {
        x: x + 16, y: top - 53, size: 7.5, font: this.fonts.sansBold,
        color: COLORS.muted, characterSpacing: 0.6,
      });
    });
    this.y = top - height - 20;
  }

  sourceCard(reference) {
    const width = PAGE.width - (PAGE.margin * 2);
    const noteLines = wrap(reference.note, this.fonts.sans, 8.5, width - 36);
    const urlLines = wrap(reference.url, this.fonts.sans, 7.2, width - 36);
    const height = 54 + (noteLines.length * 12) + (urlLines.length * 10);
    this.ensure(height + 10, "SOURCES");
    const top = this.y;
    this.page.drawRectangle({
      x: PAGE.margin, y: top - height, width, height, color: COLORS.panel,
      borderColor: COLORS.cyanSoft, borderWidth: 0.55,
    });
    const roleLabel = ({
      original_statement: "ORIGINAL VIDEO",
      speaker_archive: "TROY'S LATER ACCOUNT",
      independent_outcome: "INDEPENDENT REPORTING",
      prior_public_information: "PUBLISHED BEFORE THE CLAIM",
      context: "BACKGROUND",
    })[reference.role] || "SOURCE";
    this.page.drawText(roleLabel, {
      x: PAGE.margin + 16, y: top - 19, size: 7.2, font: this.fonts.sansBold,
      color: reference.role === "prior_public_information" ? COLORS.amber : COLORS.cyan,
    });
    const date = reference.publishedAt ? ` | ${reference.publishedAt}` : "";
    this.page.drawText(ascii(reference.title + date), {
      x: PAGE.margin + 16, y: top - 37, size: 10.5, font: this.fonts.sansBold,
      color: COLORS.cream,
    });
    let lineY = top - 55;
    for (const line of noteLines) {
      this.page.drawText(line, {
        x: PAGE.margin + 16, y: lineY, size: 8.5,
        font: this.fonts.sans, color: COLORS.muted,
      });
      lineY -= 12;
    }
    for (const line of urlLines) {
      this.page.drawText(line, {
        x: PAGE.margin + 16, y: lineY, size: 7.2,
        font: this.fonts.sans, color: COLORS.cyan,
      });
      lineY -= 10;
    }
    this.y = top - height - 10;
  }

  finish() {
    const footerMark = "The Prophecy Ledger | Public preview";
    this.pages.forEach((page, index) => {
      const footer = `WORKING REPORT / ${index + 1} OF ${this.pages.length}`;
      page.drawText(footer, {
        x: PAGE.margin, y: 21, size: 7, font: this.fonts.sansBold, color: COLORS.muted,
      });
      page.drawText(footerMark, {
        x: PAGE.width - PAGE.margin - this.fonts.sans.widthOfTextAtSize(footerMark, 7),
        y: 21, size: 7, font: this.fonts.sans, color: COLORS.muted,
      });
    });
    return { pageCount: this.pages.length, footerMark };
  }
}
