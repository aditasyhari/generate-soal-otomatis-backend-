import { Injectable } from "@nestjs/common";
import * as mammoth from "mammoth";

// pdf-parse v2/v3: gunakan named export PDFParse (bukan function call) :contentReference[oaicite:1]{index=1}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PDFParse } = require("pdf-parse");

@Injectable()
export class DocumentParserService {
  cleanText(input: string) {
    return input
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  estimateQualityScore(cleaned: string) {
    const len = cleaned.length;
    if (len < 200) return 10;

    const letters =
      (cleaned.match(/[A-Za-zÀ-ÿ\u0100-\u024F\u1E00-\u1EFF\u0400-\u04FF]/g) ?? [])
        .length;
    const ratio = letters / Math.max(1, len);

    if (len > 2000 && ratio > 0.5) return 90;
    if (len > 800 && ratio > 0.35) return 75;
    if (len > 400 && ratio > 0.25) return 55;
    return 30;
  }

  async parseBuffer(
    fileType: "pdf" | "docx",
    buf: Buffer,
  ): Promise<{ pages: string[]; qualityScore: number }> {
    let raw = "";

    if (fileType === "docx") {
      const res = await mammoth.extractRawText({ buffer: buf });
      raw = res.value ?? "";
    } else {
      if (!PDFParse) throw new Error("PDFParse export not found from pdf-parse");

      // v2/v3: buffer dimasukkan lewat { data: buf } :contentReference[oaicite:2]{index=2}
      const parser = new PDFParse({ data: buf });

      try {
        const result = await parser.getText(); // result.text
        raw = result?.text ?? "";
      } finally {
        // penting untuk release memory :contentReference[oaicite:3]{index=3}
        await parser.destroy();
      }
    }

    const cleaned = this.cleanText(raw);
    const qualityScore = this.estimateQualityScore(cleaned);

    // MVP: 1 page dulu
    return { pages: [cleaned], qualityScore };
  }
}
