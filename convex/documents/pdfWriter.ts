import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { winAnsi } from "./pdfText";

/**
 * A small flowing-layout writer over pdf-lib for the generated billing documents. Metadata is fixed
 * from the document's own data (`asOf`), so the same inputs always produce byte-identical files.
 */

export type PageSize = "portrait" | "landscape";

const SIZES: Record<PageSize, [number, number]> = { portrait: [612, 792], landscape: [792, 612] };
const MARGIN = 40;
const FOOTER_SPACE = 30;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.4, 0.45);
const RULE = rgb(0.72, 0.74, 0.78);

export type TableColumn = {
  title: string;
  width: number;
  align?: "left" | "right";
  /** Long text wraps onto extra lines in this column instead of being cut. */
  wrap?: boolean;
};

export type TextOptions = { size?: number; bold?: boolean; muted?: boolean; indent?: number };

export class PdfWriter {
  private page!: PDFPage;
  private y = 0;
  private pageSize: PageSize;
  private readonly pages: PDFPage[] = [];

  private constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
    pageSize: PageSize,
    private readonly footerText: string,
  ) {
    this.pageSize = pageSize;
    this.addPage(pageSize);
  }

  static async create(meta: { title: string; subject: string; asOf: number; pageSize?: PageSize; footer: string }): Promise<PdfWriter> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const at = new Date(meta.asOf);
    doc.setTitle(winAnsi(meta.title));
    doc.setSubject(winAnsi(meta.subject));
    doc.setAuthor("TradePulse Pay");
    doc.setCreator("TradePulse Pay");
    doc.setProducer("TradePulse Pay");
    doc.setCreationDate(at);
    doc.setModificationDate(at);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    return new PdfWriter(doc, font, bold, meta.pageSize ?? "portrait", meta.footer);
  }

  get contentWidth(): number {
    return SIZES[this.pageSize][0] - 2 * MARGIN;
  }

  addPage(size: PageSize = this.pageSize): void {
    this.pageSize = size;
    this.page = this.doc.addPage(SIZES[size]);
    this.pages.push(this.page);
    this.y = SIZES[size][1] - MARGIN;
  }

  private ensure(height: number): boolean {
    if (this.y - height >= MARGIN + FOOTER_SPACE) return false;
    this.addPage();
    return true;
  }

  space(points: number): void {
    this.y -= points;
  }

  private fontOf(bold?: boolean): PDFFont {
    return bold ? this.bold : this.font;
  }

  /** Splits text into lines that fit `width` at `size`; words longer than a line are broken. */
  wrapText(text: string, width: number, size: number, bold = false): string[] {
    const font = this.fontOf(bold);
    const out: string[] = [];
    for (const para of text.split(/\r?\n/)) {
      const words = winAnsi(para).split(" ").filter((w) => w.length > 0);
      if (words.length === 0) {
        out.push("");
        continue;
      }
      let line = "";
      for (let word of words) {
        while (font.widthOfTextAtSize(word, size) > width && word.length > 1) {
          let cut = word.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width) cut--;
          if (line) {
            out.push(line);
            line = "";
          }
          out.push(word.slice(0, cut));
          word = word.slice(cut);
        }
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
        else {
          out.push(line);
          line = word;
        }
      }
      if (line) out.push(line);
    }
    return out;
  }

  private draw(text: string, x: number, size: number, opts: { bold?: boolean; muted?: boolean } = {}): void {
    this.page.drawText(winAnsi(text), { x, y: this.y, size, font: this.fontOf(opts.bold), color: opts.muted ? MUTED : INK });
  }

  /** A wrapped paragraph. */
  text(text: string, opts: TextOptions = {}): void {
    const size = opts.size ?? 10;
    const indent = opts.indent ?? 0;
    const leading = size * 1.35;
    for (const line of this.wrapText(text, this.contentWidth - indent, size, opts.bold)) {
      this.ensure(leading);
      this.y -= size;
      if (line) this.draw(line, MARGIN + indent, size, opts);
      this.y -= leading - size;
    }
  }

  heading(text: string, size = 15): void {
    this.ensure(size * 2);
    this.text(text, { size, bold: true });
    this.space(2);
  }

  rule(): void {
    this.ensure(8);
    this.y -= 4;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + this.contentWidth, y: this.y },
      thickness: 0.5,
      color: RULE,
    });
    this.y -= 6;
  }

  /** Label / value pairs, one per line; long values wrap within the value column. */
  fields(rows: readonly (readonly [string, string])[], opts: { size?: number; labelWidth?: number } = {}): void {
    const size = opts.size ?? 9.5;
    const labelWidth = opts.labelWidth ?? 150;
    const leading = size * 1.4;
    for (const [label, value] of rows) {
      const lines = this.wrapText(value, this.contentWidth - labelWidth, size);
      lines.forEach((line, i) => {
        this.ensure(leading);
        this.y -= size;
        if (i === 0) this.draw(label, MARGIN, size, { muted: true });
        this.draw(line, MARGIN + labelWidth, size);
        this.y -= leading - size;
      });
    }
  }

  /**
   * Numbered summary lines with a right-aligned amount, e.g. G702 lines 1-9. Each row is drawn as
   * "label" plus the amount, so text extraction keeps the label and its figure together.
   */
  amountLines(rows: readonly { label: string; amount: string; bold?: boolean }[], opts: { size?: number } = {}): void {
    const size = opts.size ?? 10;
    const leading = size * 1.6;
    const right = MARGIN + this.contentWidth;
    for (const row of rows) {
      const labelLines = this.wrapText(row.label, this.contentWidth - 130, size, row.bold);
      labelLines.forEach((line, i) => {
        this.ensure(leading);
        this.y -= size;
        this.draw(line, MARGIN, size, { bold: row.bold });
        if (i === 0) {
          const font = this.fontOf(row.bold);
          const text = winAnsi(row.amount);
          this.draw(text, right - font.widthOfTextAtSize(text, size), size, { bold: row.bold });
        }
        this.y -= leading - size;
      });
    }
  }

  /** A table with a header row repeated on every page; `bold` rows (totals) are set in bold. */
  table(columns: readonly TableColumn[], rows: readonly { cells: readonly string[]; bold?: boolean }[], opts: { size?: number } = {}): void {
    const size = opts.size ?? 7.5;
    const leading = size * 1.35;
    const pad = 3;
    const drawRow = (cells: readonly string[], bold: boolean, header: boolean) => {
      const font = this.fontOf(bold || header);
      const wrapped = columns.map((col, i) => {
        const text = winAnsi(cells[i] ?? "");
        if (col.wrap || header) return this.wrapText(text, col.width - 2 * pad, size, bold || header);
        let t = text;
        while (t.length > 1 && font.widthOfTextAtSize(t, size) > col.width - 2 * pad) t = t.slice(0, -1);
        return [t];
      });
      const height = Math.max(1, ...wrapped.map((w) => w.length)) * leading + 3;
      const brokePage = this.ensure(height);
      if (brokePage && !header) drawHeader();
      let x = MARGIN;
      const top = this.y;
      columns.forEach((col, i) => {
        let lineY = top;
        for (const line of wrapped[i]) {
          lineY -= size;
          const w = font.widthOfTextAtSize(line, size);
          const tx = col.align === "right" ? x + col.width - pad - w : x + pad;
          this.page.drawText(line, { x: tx, y: lineY, size, font, color: header ? MUTED : INK });
          lineY -= leading - size;
        }
        x += col.width;
      });
      this.y = top - height;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y + 1.5 },
        end: { x, y: this.y + 1.5 },
        thickness: header ? 0.75 : 0.25,
        color: RULE,
      });
    };
    const drawHeader = () => drawRow(columns.map((c) => c.title), true, true);
    this.ensure(leading * 4);
    drawHeader();
    for (const row of rows) drawRow(row.cells, row.bold === true, false);
    this.space(6);
  }

  /** Writes "page n of m" footers and returns the file bytes. */
  async save(): Promise<Uint8Array> {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      const [width] = [page.getWidth()];
      const text = winAnsi(`${this.footerText}  |  Page ${i + 1} of ${total}`);
      const size = 7;
      page.drawText(text, {
        x: width - MARGIN - this.font.widthOfTextAtSize(text, size),
        y: MARGIN - 18,
        size,
        font: this.font,
        color: MUTED,
      });
    });
    return await this.doc.save({ useObjectStreams: false });
  }
}
