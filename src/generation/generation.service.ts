import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { JOB_QUESTION_GENERATE_BATCH, QUEUE_GENERATION } from "../queues/queue.constants";

@Injectable()
export class GenerationService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue(QUEUE_GENERATION) private queue: Queue,
  ) {}

  async startRun(blueprintId: string) {
    const bp = await this.prisma.blueprint.findUnique({
      where: { id: blueprintId },
      include: { document: true, items: { orderBy: { no: "asc" } } },
    });
    if (!bp) throw new BadRequestException("Blueprint not found");
    if (bp.document.status !== "INDEXED") throw new BadRequestException("Document must be INDEXED");

    if (!bp.items?.length) throw new BadRequestException("Blueprint items kosong. Jalankan POST /blueprints/:id/build dulu.");

    const run = await this.prisma.generationRun.create({
      data: {
        blueprintId,
        status: "QUEUED",
        totalItems: bp.items.length,
        doneItems: 0,
        failedItems: 0,
      },
    });

    // generate 10 soal per batch
    const BATCH_SIZE = 10;

    // enqueue per batch
    let batchNo = 0;
    for (let i = 0; i < bp.items.length; i += BATCH_SIZE) {
      batchNo++;
      const batch = bp.items.slice(i, i + BATCH_SIZE);
      const blueprintItemIds = batch.map((it) => it.id);

      await this.queue.add(
        JOB_QUESTION_GENERATE_BATCH,
        { runId: run.id, blueprintItemIds, batchNo },
        {
          // penting untuk 429
          attempts: 8,
          backoff: { type: "exponential", delay: 2000 },
          // idempotent jobId biar ga dobel kalau enqueue kepanggil ulang
          jobId: `${run.id}:batch:${batchNo}`,
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    }

    await this.prisma.generationRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });

    return {
      runId: run.id,
      total: bp.items.length,
      batchSize: BATCH_SIZE,
      batches: Math.ceil(bp.items.length / BATCH_SIZE),
    };
  }

  async getRun(runId: string) {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId } });
    if (!run) throw new BadRequestException("Run not found");
    return run;
  }

  async getQuestions(runId: string) {
    return this.prisma.question.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });
  }
}