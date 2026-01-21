import { Injectable, Logger } from "@nestjs/common";
import { Processor, WorkerHost, InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ChunkingService } from "../documents/pipeline/chunking.service";
import { GeminiService } from "../gemini/gemini.service";
import {
  JOB_CHUNK_EMBED_AND_INDEX,
  JOB_DOCUMENT_CHUNK,
  QUEUE_INDEXING,
} from "../queues/queue.constants";

@Processor(QUEUE_INDEXING)
@Injectable()
export class IndexingConsumer extends WorkerHost {
  private readonly logger = new Logger(IndexingConsumer.name);

  constructor(
    private prisma: PrismaService,
    private chunking: ChunkingService,
    private gemini: GeminiService,
    @InjectQueue(QUEUE_INDEXING) private indexingQueue: Queue,
  ) {
    super();
    this.logger.log("IndexingConsumer LOADED");
  }

  async process(job: Job<any, any, string>) {
    this.logger.log(`PROCESS job=${job.name} id=${job.id}`);

    try {
      switch (job.name) {
        case JOB_DOCUMENT_CHUNK:
          return await this.handleChunk(job);
        case JOB_CHUNK_EMBED_AND_INDEX:
          return await this.handleEmbed(job);
        default:
          return null;
      }
    } catch (err: any) {
      this.logger.error(`JOB FAILED name=${job.name} id=${job.id} msg=${err?.message}`, err?.stack);

      const documentId = job.data?.documentId;
      if (documentId) {
        await this.prisma.document.update({
          where: { id: documentId },
          data: { status: "FAILED" },
        }).catch(() => {});
      }
      throw err;
    }
  }

  private async handleChunk(job: Job<{ documentId: string; tokenTarget?: number; reset?: boolean }>) {
    const { documentId, tokenTarget = 600, reset = true } = job.data;

    const doc = await this.prisma.document.findUnique({ where: { id: documentId } });
    if (!doc) throw new Error("Document not found");

    await this.prisma.document.update({ where: { id: documentId }, data: { status: "INDEXING" } });

    const pages = await this.prisma.documentPage.findMany({
      where: { documentId },
      orderBy: { pageNo: "asc" },
    });

    const pageTexts = pages.map(p => p.cleanedText ?? "").filter(Boolean);
    const chunks = this.chunking.buildChunks(pageTexts, tokenTarget);

    if (reset) await this.prisma.chunk.deleteMany({ where: { documentId } });

    for (const c of chunks) {
      await this.prisma.chunk.create({
        data: {
          documentId,
          chunkText: c.chunkText,
          tokenCount: c.tokenCount,
          metadata: c.metadata,
        },
      });
    }

    // enqueue embedding job
    const embedJob = await this.indexingQueue.add(
      JOB_CHUNK_EMBED_AND_INDEX,
      { documentId, batchSize: 8 }, 
      { attempts: 3, backoff: { type: "exponential", delay: 1000 } },
    );

    this.logger.log(`Enqueued ${JOB_CHUNK_EMBED_AND_INDEX} jobId=${embedJob.id} chunks=${chunks.length}`);

    return { chunksCreated: chunks.length, embedJobId: embedJob.id };
  }

  private async handleEmbed(job: Job<{ documentId: string; batchSize?: number }>) {
    const { documentId, batchSize = 8 } = job.data;

    const chunks = await this.prisma.chunk.findMany({
        where: {
            documentId,
            OR: [
                { embedding: { equals: Prisma.DbNull } },
                { embedding: { equals: Prisma.JsonNull } }, // optional, jaga-jaga
            ],
        },
        orderBy: { createdAt: "asc" },
    });

    this.logger.log(`Embedding start documentId=${documentId} remaining=${chunks.length}`);

    let done = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const texts = batch.map((c) => c.chunkText);

        const { vectors, model, dim } = await this.gemini.embedDocuments(texts);

        for (let j = 0; j < batch.length; j++) {
        await this.prisma.chunk.update({
            where: { id: batch[j].id },
            data: {
            embedding: vectors[j],
            metadata: {
                ...(batch[j].metadata as any),
                embeddingModel: model,
                embeddingDim: dim,
            },
            },
        });
        }

        done += batch.length;
        await job.updateProgress(Math.round((done / Math.max(1, chunks.length)) * 100));
    }

    await this.prisma.document.update({
        where: { id: documentId },
        data: { status: "INDEXED" },
    });

    this.logger.log(`Embedding done documentId=${documentId} embedded=${done}`);
    return { embedded: done };
  }
}