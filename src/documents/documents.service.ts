import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService) {}

  async createDocument(params: {
    title: string;
    subject?: string;
    grade?: string;
    language?: string;
    fileUrl: string;
    fileType: string;
  }) {
    return this.prisma.document.create({
      data: {
        title: params.title,
        subject: params.subject,
        grade: params.grade,
        language: params.language ?? "id",
        fileUrl: params.fileUrl,
        fileType: params.fileType,
      },
    });
  }

  async getById(id: string) {
    return this.prisma.document.findUnique({ where: { id } });
  }

  async listPages(documentId: string) {
    return this.prisma.documentPage.findMany({
      where: { documentId },
      orderBy: { pageNo: "asc" },
      select: { id: true, pageNo: true, cleanedText: true },
    });
  }

  async listChunks(documentId: string) {
    return this.prisma.chunk.findMany({
      where: { documentId },
      orderBy: { createdAt: "asc" },
      select: { id: true, tokenCount: true, metadata: true, chunkText: true },
    });
  }
}