import { Injectable } from "@nestjs/common";

@Injectable()
export class ChunkingService {
  estimateTokens(text: string) {
    // heuristik: 1 token ~ 0.75 kata
    const words = (text.match(/\S+/g) ?? []).length;
    return Math.ceil(words / 0.75);
  }

  buildChunks(pages: string[], tokenTarget = 600) {
    const chunks: { chunkText: string; tokenCount: number; metadata: any }[] = [];

    let current = "";
    let pageStart = 1;

    const flush = (pageEnd: number) => {
      const txt = current.trim();
      if (!txt) return;
      const tokenCount = this.estimateTokens(txt);
      chunks.push({
        chunkText: txt,
        tokenCount,
        metadata: { pageStart, pageEnd },
      });
      current = "";
      pageStart = pageEnd;
    };

    for (let i = 0; i < pages.length; i++) {
      const pageNo = i + 1;
      const paras = pages[i].split(/\n\n+/).map(p => p.trim()).filter(Boolean);

      for (const p of paras) {
        const next = current ? current + "\n\n" + p : p;
        const t = this.estimateTokens(next);

        if (t > tokenTarget && current) {
          flush(pageNo);
          current = p;
          pageStart = pageNo;
        } else {
          current = next;
        }
      }
      // selesai 1 halaman
      flush(pageNo);
    }

    return chunks;
  }
}