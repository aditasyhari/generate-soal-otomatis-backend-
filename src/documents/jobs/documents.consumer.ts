import { Injectable, Logger } from "@nestjs/common";
import { Processor, WorkerHost, InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { DocumentParserService } from "../pipeline/document-parser.service";
import {
  JOB_DOCUMENT_PARSE,
  JOB_DOCUMENT_CHUNK,
  QUEUE_DOCUMENTS,
  QUEUE_INDEXING,
} from "../../queues/queue.constants";
import { readFile } from "node:fs/promises";

@Processor(QUEUE_DOCUMENTS)
@Injectable()
export class DocumentsConsumer extends WorkerHost {
  private readonly logger = new Logger(DocumentsConsumer.name);
  constructor(
    private prisma: PrismaService,
    private parser: DocumentParserService,
    @InjectQueue(QUEUE_INDEXING) private indexingQueue: Queue,
  ) {
    super();
  }

  // BullMQ: gunakan WorkerHost + switch job.name (bukan @Process('name'))
  // :contentReference[oaicite:5]{index=5}
  async process(job: Job<any, any, string>) {
    this.logger.log(`PROCESS job=${job.name} id=${job.id}`);
    switch (job.name) {
      case JOB_DOCUMENT_PARSE:
        return this.handleParse(job);
      default:
        return null;
    }
  }

  private async handleParse(job: Job<{ documentId: string; chainIndex?: boolean }>) {
    const { documentId, chainIndex } = job.data;

    try {
        const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
        if (!doc) throw new Error("Document not found");

        await this.prisma.document.update({
            where: { id: documentId },
            data: { status: "PARSING" },
        });

        const filePath = doc.fileUrl;
        const buf = await readFile(filePath);

        const { pages, qualityScore } = await this.parser.parseBuffer(doc.fileType as any, buf);

        await this.prisma.documentPage.deleteMany({ where: { documentId } });
        await this.prisma.documentPage.createMany({
        data: pages.map((t, idx) => ({
            documentId,
            pageNo: idx + 1,
            rawText: t,
            cleanedText: t,
        })),
        });

        await this.prisma.document.update({
            where: { id: documentId },
            data: { status: "PARSED", qualityScore },
        });

        if (chainIndex) {
            await this.indexingQueue.add(JOB_DOCUMENT_CHUNK, { documentId, tokenTarget: 600, reset: true });
        }

        return { pages: pages.length, qualityScore, chained: !!chainIndex };
    } catch (err: any) {
        this.logger.error(
            `DOCUMENT_PARSE failed documentId=${documentId} msg=${err?.message}`,
            err?.stack,
        );
        await this.prisma.document.update({
            where: { id: documentId },
            data: { status: "FAILED" },
        });
        throw err;
    }
  }

}