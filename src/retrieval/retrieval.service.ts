import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GeminiService } from "../gemini/gemini.service";

@Injectable()
export class RetrievalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gemini: GeminiService,
  ) {}

  private dot(a: number[], b: number[]) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  private norm(a: number[]) {
    return Math.sqrt(this.dot(a, a));
  }

  private cosineSim(a: number[], b: number[]) {
    const na = this.norm(a);
    const nb = this.norm(b);
    if (na === 0 || nb === 0) return 0;
    return this.dot(a, b) / (na * nb);
  }

  async search(documentId: string, query: string, topK: number) {
    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new BadRequestException("Document not found");
    if (doc.status !== "INDEXED") throw new BadRequestException(`Document must be INDEXED. Current: ${doc.status}`);

    const chunks = await this.prisma.chunk.findMany({
      where: { documentId, embedding: { not: null } },
      select: { id: true, chunkText: true, metadata: true, embedding: true },
    });

    if (chunks.length === 0) throw new BadRequestException("No embedded chunks found");

    const { vector: qvec } = await this.gemini.embedQuery(query);

    const scored = chunks.map((c) => {
      const vec = c.embedding as unknown as number[];
      const score = this.cosineSim(qvec, vec);
      return {
        id: c.id,
        score,
        metadata: c.metadata,
        snippet: c.chunkText.slice(0, 400),
      };
    });

    scored.sort((a, b) => b.score - a.score);

    return {
      documentId,
      query,
      topK,
      results: scored.slice(0, topK),
    };
  }
}