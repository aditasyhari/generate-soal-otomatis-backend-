import { Injectable, Logger } from "@nestjs/common";
import { Processor, WorkerHost, InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { GeminiService } from "../gemini/gemini.service";
import { JOB_QUESTION_GENERATE_BATCH, QUEUE_GENERATION } from "../queues/queue.constants";
import * as z from "zod";


const LIMITS = {
  mcq: { stem: 220, option: 120, explanation: 700 },
  essay: {
    stem: 260,
    expectedRingkas: 220,
    explanation: 850,
    rubricAspect: 60,
    keywordConcept: 60,
    keyword: 32,
  },
};

const McqOut = z.object({
  blueprintItemId: z.string().min(10),
  type: z.literal("MCQ"),
  stem: z.string().min(10).max(LIMITS.mcq.stem),
  options: z.array(z.string().min(3).max(LIMITS.mcq.option)).length(5),
  answerKey: z.enum(["A", "B", "C", "D", "E"]),
  explanation: z.string().min(20).max(LIMITS.mcq.explanation),
});

const EssayOut = z.object({
  blueprintItemId: z.string().min(10),
  type: z.literal("ESSAY"),
  stem: z.string().min(10).max(LIMITS.essay.stem),
  expectedAnswer: z.object({
    ringkas: z.string().min(20).max(LIMITS.essay.expectedRingkas),
    panjang: z.string().max(800).optional(),
  }),
  keywordGroups: z
    .array(
      z.object({
        concept: z.string().min(2).max(LIMITS.essay.keywordConcept),
        must_have_one_of: z.array(z.string().min(1).max(LIMITS.essay.keyword)).min(1).max(8),
      }),
    )
    .min(2)
    .max(6),
  rubric: z
    .array(
      z.object({
        aspect: z.string().min(2).max(LIMITS.essay.rubricAspect),
        points: z.number().int().min(1).max(10),
      }),
    )
    .min(1)
    .max(6),
  explanation: z.string().min(20).max(LIMITS.essay.explanation),
});

const QuestionOut = z.discriminatedUnion("type", [McqOut, EssayOut]);

const BatchResponseSchema = z.object({
  results: z.array(QuestionOut).min(1).max(10),
});

@Processor(QUEUE_GENERATION, { 
    concurrency: 1,
    limiter: { max: 4, duration: 60_000 }, // sisakan ruang retry 
})
@Injectable()
export class GenerationConsumer extends WorkerHost {
  private readonly logger = new Logger(GenerationConsumer.name);
  private readonly MAX_CONTEXT_CHARS_PER_ITEM = 800;

  constructor(
    private prisma: PrismaService,
    private gemini: GeminiService,
    @InjectQueue(QUEUE_GENERATION) private queue: Queue,
  ) {
    super();
    this.logger.log("GenerationConsumer LOADED (BATCH MODE)");
  }

  async process(job: Job<any, any, string>) {
    this.logger.log(`PROCESS job=${job.name} id=${job.id}`);
    if (job.name !== JOB_QUESTION_GENERATE_BATCH) return null;

    const { runId, blueprintItemIds, batchNo } = job.data as {
      runId: string;
      blueprintItemIds: string[];
      batchNo?: number;
    };

    try {
      if (!Array.isArray(blueprintItemIds) || blueprintItemIds.length === 0) {
        throw new Error("blueprintItemIds empty");
      }

      // skip call to Gemini if already generated for all items in batch
      const existing = await this.prisma.question.findMany({
        where: { runId, blueprintItemId: { in: blueprintItemIds } },
        select: { blueprintItemId: true },
      });
      const existingSet = new Set(existing.map((e) => e.blueprintItemId));
      const missingIds = blueprintItemIds.filter((id) => !existingSet.has(id));

      if (missingIds.length === 0) {
        this.logger.log(`BATCH SKIP runId=${runId} batchNo=${batchNo ?? "-"} (all questions already exist)`);
        await this.finalizeRunIfDone(runId);
        return { ok: true, created: 0, skipped: true };
      }

      const items = await this.prisma.blueprintItem.findMany({
        where: { id: { in: missingIds } },
        include: { blueprint: { include: { document: true } } },
        orderBy: { no: "asc" },
      });

      if (items.length !== missingIds.length) {
        throw new Error(`Some blueprint items not found. expected=${missingIds.length} got=${items.length}`);
      }

      const documentId = items[0].blueprint.documentId;

      const chunks = await this.prisma.chunk.findMany({
        where: { documentId },
        orderBy: { createdAt: "asc" },
        select: { id: true, chunkText: true },
      });
      if (chunks.length === 0) throw new Error("No chunks found for document");

      const tasks = items.map((it) => {
        const idx = (it.no - 1) % chunks.length;
        const picked = chunks[idx];

        let ctx = (picked.chunkText ?? "").trim();
        if (ctx.length > this.MAX_CONTEXT_CHARS_PER_ITEM) ctx = ctx.slice(0, this.MAX_CONTEXT_CHARS_PER_ITEM);

        return {
          blueprintItemId: it.id,
          type: it.type,
          cognitive: it.cognitive,
          difficulty: it.difficulty,
          chunkId: picked.id,
          context: ctx,
        };
      });

      const prompt = this.buildBatchPrompt(tasks);

      // JSON mode only (NO schema) to avoid nesting-depth error
      const { json } = await this.gemini.generateJson<any>(prompt, { maxOutputTokens: 8000 });

      // coerce output shape -> always { results: [...] }
      const coerced = this.coerceBatchResponse(json);

      // normalize content (truncate/convert options object->string)
      const normalized = this.normalizeBatch(coerced);

      // if still bad shape, throw clear error
      if (!normalized || typeof normalized !== "object") {
        throw new Error(`MODEL_OUTPUT_BAD_SHAPE: non-object`);
      }
      if (!Array.isArray((normalized as any).results)) {
        throw new Error(`MODEL_OUTPUT_BAD_SHAPE: keys=${Object.keys(normalized).join(",")}`);
      }

      const parsed = BatchResponseSchema.parse(normalized);

      // Validate: results must cover all missingIds
      const expectedSet = new Set(missingIds);
      const gotSet = new Set(parsed.results.map((r) => r.blueprintItemId));
      if (gotSet.size !== parsed.results.length) throw new Error("Duplicate blueprintItemId in results");

      const missing = [];
      for (const id of expectedSet) {
        if (!gotSet.has(id)) missing.push(id);
        }

        // Jangan gagal total. Requeue yang missing aja.
        if (missing.length > 0) {
        this.logger.warn(
            `PARTIAL RESULTS runId=${runId} batchNo=${batchNo ?? "-"} missing=${missing.length}/${missingIds.length}`,
        );

        // enqueue ulang sebagai batch kecil (size 1) biar pasti lengkap
        for (const missId of missing) {
            await this.queue.add(
                JOB_QUESTION_GENERATE_BATCH,
                { runId, blueprintItemIds: [missId], batchNo: `${batchNo ?? "?"}-retry-${missId}` },
                {
                    attempts: 6,
                    backoff: { type: "exponential", delay: 2000 },
                    // jobId unik biar gak dobel spam
                    jobId: `${runId}:miss:${missId}`,
                    removeOnComplete: true,
                    removeOnFail: false,
                },
            );
        }
      }

      let createdCount = 0;

      for (const r of parsed.results) {
        const it = items.find((x) => x.id === r.blueprintItemId);
        if (!it) continue;

        const existed = await this.prisma.question.findUnique({
          where: { runId_blueprintItemId: { runId, blueprintItemId: it.id } },
          select: { id: true },
        });

        const sourceChunkId = tasks.find((t) => t.blueprintItemId === it.id)?.chunkId;

        if (!existed) {
          await this.prisma.question.create({
            data: {
              runId,
              blueprintItemId: it.id,
              type: it.type,
              cognitive: it.cognitive,
              difficulty: it.difficulty,

              stem: r.stem,
              options: r.type === "MCQ" ? r.options : null,
              answerKey: r.type === "MCQ" ? r.answerKey : null,
              explanation: r.explanation,

              expectedAnswer: r.type === "ESSAY" ? r.expectedAnswer : null,
              keywordGroups: r.type === "ESSAY" ? r.keywordGroups : null,
              rubric: r.type === "ESSAY" ? r.rubric : null,

              sourceChunkIds: sourceChunkId ? [sourceChunkId] : null,
            },
          });
          createdCount++;
        } else {
          await this.prisma.question.update({
            where: { runId_blueprintItemId: { runId, blueprintItemId: it.id } },
            data: {
              stem: r.stem,
              options: r.type === "MCQ" ? r.options : null,
              answerKey: r.type === "MCQ" ? r.answerKey : null,
              explanation: r.explanation,

              expectedAnswer: r.type === "ESSAY" ? r.expectedAnswer : null,
              keywordGroups: r.type === "ESSAY" ? r.keywordGroups : null,
              rubric: r.type === "ESSAY" ? r.rubric : null,

              sourceChunkIds: sourceChunkId ? [sourceChunkId] : null,
            },
          });
        }
      }

      if (createdCount > 0) {
        await this.prisma.generationRun.update({
          where: { id: runId },
          data: { doneItems: { increment: createdCount } },
        });
      }

      await this.finalizeRunIfDone(runId);

      this.logger.log(`BATCH OK runId=${runId} batchNo=${batchNo ?? "-"} created=${createdCount}`);
      return { ok: true, created: createdCount };
    } catch (err: any) {
      this.logger.error(`GEN BATCH FAILED runId=${runId} batchNo=${batchNo ?? "-"} msg=${err?.message}`, err?.stack);

      const attempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attempts;

      if (isFinalAttempt) {
        const missing = await this.countMissing(runId, blueprintItemIds);
        if (missing > 0) {
          await this.prisma.generationRun
            .update({
              where: { id: runId },
              data: { failedItems: { increment: missing } },
            })
            .catch(() => {});
        }
        await this.finalizeRunIfDone(runId);
      }

      throw err;
    }
  }

  // ------------------------
  // Prompt builder
  // ------------------------
  private buildBatchPrompt(
    tasks: Array<{
      blueprintItemId: string;
      type: "MCQ" | "ESSAY";
      cognitive: "LOTS" | "MOTS" | "HOTS";
      difficulty: "EASY" | "MEDIUM" | "HARD";
      chunkId: string;
      context: string;
    }>,
  ) {
    const rules = `
Kamu adalah dosen pembuat soal & pembahasan.
WAJIB memakai context per item. Jangan menambah fakta di luar context.
Bahasa: Indonesia.

WAJIB output JSON valid persis format:
{ "results": [ ... ] }
JANGAN tulis teks lain selain JSON (tanpa markdown, tanpa penjelasan).
Jangan gunakan tanda petik ganda " di dalam teks jawaban. Jika perlu, pakai tanda petik tunggal ' atau tanpa tanda petik.

WAJIB: "results" harus berisi tepat ${tasks.length} item.
Setiap item HARUS memiliki "blueprintItemId" yang SAMA persis seperti di TASKS.
Jika kamu tidak yakin membuat semua item, tetap WAJIB buat semua item. Jangan mengurangi jumlah results.

Batas panjang (WAJIB PATUH):
- MCQ: stem <= ${LIMITS.mcq.stem}, options <= ${LIMITS.mcq.option} per opsi, explanation <= ${LIMITS.mcq.explanation}
- ESAI: stem <= ${LIMITS.essay.stem}, expectedAnswer.ringkas <= ${LIMITS.essay.expectedRingkas}, explanation <= ${LIMITS.essay.explanation}
- ESAI: rubric.aspect <= ${LIMITS.essay.rubricAspect}

FORMAT WAJIB PER TYPE:

1) MCQ item WAJIB punya field:
{
  "blueprintItemId": "...",
  "type": "MCQ",
  "stem": "...",
  "options": ["A. ...","B. ...","C. ...","D. ...","E. ..."],
  "answerKey": "A|B|C|D|E",
  "explanation": "..."
}

PENTING UNTUK MCQ:
- "options" HARUS ARRAY OF STRING (bukan object).
  ✅ Benar: "options": ["A. ...","B. ...","C. ...","D. ...","E. ..."]
  ❌ Salah:  "options": [{"label":"A","text":"..."}, ...]
- Opsi harus jawaban pendek & spesifik (JANGAN "Peserta didik dapat ...")
- Tepat 1 jawaban benar.
- Jangan tulis label terpisah (jangan pakai {label,text}). Cukup string yang diawali "A. ", "B. ", dst.
- "answerKey" HARUS salah satu dari: "A","B","C","D","E" (tanpa titik, tanpa kata lain).
- "explanation" WAJIB selalu ada, meski ringkas.

2) ESSAY item WAJIB punya field:
{
  "blueprintItemId": "...",
  "type": "ESSAY",
  "stem": "...",
  "expectedAnswer": { "ringkas": "..." },
  "keywordGroups": [
    { "concept": "...", "must_have_one_of": ["...","..."] }
  ],
  "rubric": [
    { "aspect": "Ketepatan konsep", "points": 4 }
  ],
  "explanation": "..."
}

ATURAN ISI:
- Gunakan HANYA informasi dari context masing-masing TASK.
- Jangan menyebut "Sumber 1", "chunkId", atau kata "context" dalam output.
- Stem jangan kepanjangan. Langsung to the point.

OUTPUT FINAL HARUS satu JSON object dengan key "results".
`.trim();

    const taskText = tasks
      .map(
        (t, i) => `
TASK ${i + 1}:
- blueprintItemId: ${t.blueprintItemId}
- type: ${t.type}
- cognitive: ${t.cognitive}
- difficulty: ${t.difficulty}
- context (chunkId=${t.chunkId}):
${t.context}
`.trim(),
      )
      .join("\n\n---\n\n");

    return `${rules}\n\nTASKS:\n\n${taskText}`.trim();
  }

  // ------------------------
  // Output coercion: accept multiple shapes
  // ------------------------
  private coerceBatchResponse(input: any): { results: any[] } {
    // If model returned array directly
    if (Array.isArray(input)) return { results: input };

    if (input && typeof input === "object") {
      if (Array.isArray((input as any).results)) return { results: (input as any).results };
      if (Array.isArray((input as any).result)) return { results: (input as any).result };
      if (Array.isArray((input as any).data)) return { results: (input as any).data };
      if (Array.isArray((input as any).items)) return { results: (input as any).items };

      // single item object
      if ((input as any).type && (input as any).blueprintItemId) {
        return { results: [input] };
      }

      // results is a single object
      if ((input as any).results && typeof (input as any).results === "object") {
        return { results: [(input as any).results] };
      }
    }

    return { results: [] };
  }

  // ------------------------
  // Normalizers
  // ------------------------
  private clampStr(v: any, max: number) {
    if (typeof v !== "string") return v;
    const s = v.trim();
    return s.length > max ? s.slice(0, max) : s;
  }

  private normalizeBatch(obj: any) {
    const out: any = { ...obj };
    if (!out || typeof out !== "object") return out;
    if (!Array.isArray(out.results)) return out;

    const pickExplanation = (x: any) => {
        const alt =
        x.explanation ??
        x.rationale ??
        x.pembahasan ??
        x.penjelasan ??
        x.analysis ??
        x.reason ??
        (x.expectedAnswer?.ringkas ? `Pembahasan ringkas: ${x.expectedAnswer.ringkas}` : null);

        const s = typeof alt === "string" ? alt.trim() : "";
        return s || "Pembahasan ringkas berdasarkan materi pada konteks yang diberikan.";
    };

    const normalizeAnswerKey = (raw: any) => {
        if (typeof raw === "string") {
        const up = raw.toUpperCase();

        // match "A", "A.", "A)", "Jawaban: B", "(C)", dll
        const m1 = up.match(/\b([A-E])\b/);
        if (m1?.[1]) return m1[1];

        const m2 = up.match(/^([A-E])[\.\)\:\-]/);
        if (m2?.[1]) return m2[1];
        }

        if (typeof raw === "number") {
        const map = ["A", "B", "C", "D", "E"];
        return map[raw - 1];
        }

        return "A";
    };

    out.results = out.results.map((r: any) => {
        const x: any = { ...r };

        // normalize type early
        if (typeof x.type === "string") x.type = x.type.toUpperCase();

        // stem fallback
        if (typeof x.stem !== "string" || !x.stem.trim()) x.stem = "Buat pertanyaan berdasarkan konteks.";
        x.stem = this.clampStr(x.stem, x.type === "MCQ" ? LIMITS.mcq.stem : LIMITS.essay.stem);

        // explanation: ALWAYS ensure exists BEFORE clamp
        x.explanation = pickExplanation(x);
        x.explanation = this.clampStr(
        x.explanation,
        x.type === "MCQ" ? LIMITS.mcq.explanation : LIMITS.essay.explanation,
        );

      if (x.type === "MCQ") {
        // options normalize (string only, ensure 5)
        if (!Array.isArray(x.options)) x.options = [];

        x.options = x.options.slice(0, 5).map((opt: any) => {
            // string option
            if (typeof opt === "string") {
            let s = opt.trim().replace(/^Peserta didik\s+dapat\s+/i, "");
            return this.clampStr(s, LIMITS.mcq.option);
            }

            // object option -> try common fields
            const text = (opt?.text ?? opt?.value ?? opt?.content ?? opt?.option ?? "").toString().trim();
            const label = (opt?.label ?? opt?.key ?? opt?.id ?? "").toString().trim();

            let s = text || "";
            if (!s) {
            try {
                s = JSON.stringify(opt);
            } catch {
                s = String(opt ?? "");
            }
            }
            if (label && text) s = `${label}. ${text}`;
            s = s.replace(/^Peserta didik\s+dapat\s+/i, "");
            return this.clampStr(s.trim(), LIMITS.mcq.option);
        });

        while (x.options.length < 5) x.options.push("...");

        // answerKey normalize + fallback
        x.answerKey = normalizeAnswerKey(x.answerKey);
        if (!["A", "B", "C", "D", "E"].includes(x.answerKey)) x.answerKey = "A";

        // ensure explanation still present after any changes
        if (typeof x.explanation !== "string" || !x.explanation.trim()) {
            x.explanation = "Jawaban benar sesuai materi pada konteks yang diberikan.";
        }
        x.explanation = this.clampStr(x.explanation, LIMITS.mcq.explanation);
      }

      if (x.type === "ESSAY") {
        // expectedAnswer normalize
        if (x.expectedAnswer && typeof x.expectedAnswer === "object") {
            x.expectedAnswer = { ...x.expectedAnswer };
            const ringkas = typeof x.expectedAnswer.ringkas === "string" ? x.expectedAnswer.ringkas : "";
            x.expectedAnswer.ringkas = this.clampStr(
                ringkas.trim() || "Jawaban ideal ringkas berdasarkan materi pada konteks.",
                LIMITS.essay.expectedRingkas,
            );
            if (x.expectedAnswer.panjang) x.expectedAnswer.panjang = this.clampStr(x.expectedAnswer.panjang, 800);
        } else {
            x.expectedAnswer = { ringkas: "Jawaban ideal ringkas berdasarkan materi pada konteks." };
        }

        // keywordGroups normalize + auto-pad min 2
        if (!Array.isArray(x.keywordGroups)) x.keywordGroups = [];

        x.keywordGroups = x.keywordGroups.slice(0, 6).map((kg: any) => {
            const k: any = { ...kg };
            k.concept = this.clampStr(
                (typeof k.concept === "string" ? k.concept : "Konsep inti").trim(),
                LIMITS.essay.keywordConcept,
            );

            if (!Array.isArray(k.must_have_one_of)) k.must_have_one_of = [];
            k.must_have_one_of = k.must_have_one_of
            .slice(0, 8)
            .map((w: any) => this.clampStr(String(w ?? "").trim() || "kata_kunci", LIMITS.essay.keyword))
            .filter((w: string) => w.length > 0);

            if (k.must_have_one_of.length === 0) k.must_have_one_of = ["kata_kunci"];
            return k;
        });

        while (x.keywordGroups.length < 2) {
            x.keywordGroups.push({
                concept: "Konsep inti tambahan",
                must_have_one_of: ["kata_kunci_tambahan"],
            });
        }

        // rubric normalize + auto-pad min 1
        if (!Array.isArray(x.rubric)) x.rubric = [];

        x.rubric = x.rubric.slice(0, 6).map((rb: any) => {
            const rr: any = { ...rb };
            rr.aspect = this.clampStr(
                (typeof rr.aspect === "string" ? rr.aspect : "Ketepatan konsep").trim(),
                LIMITS.essay.rubricAspect,
            );

            let pts = Number(rr.points);
            if (!Number.isFinite(pts)) pts = 3;
            if (pts < 1) pts = 1;
            if (pts > 10) pts = 10;
            rr.points = Math.round(pts);
            return rr;
        });

        if (x.rubric.length === 0) {
            x.rubric = [
                { aspect: "Ketepatan konsep", points: 4 },
                { aspect: "Kejelasan penjelasan", points: 3 },
                { aspect: "Kelengkapan poin penting", points: 3 },
            ].map((rr) => ({
                aspect: this.clampStr(rr.aspect, LIMITS.essay.rubricAspect),
                points: rr.points,
            }));
        }

        // ensure explanation still present (essay)
        if (typeof x.explanation !== "string" || !x.explanation.trim()) {
            x.explanation = pickExplanation({ ...x, explanation: null });
        }
        x.explanation = this.clampStr(x.explanation, LIMITS.essay.explanation);
      }

        return x;
    });

    return out;
  }

  // ------------------------
  // Missing count helper
  // ------------------------
  private async countMissing(runId: string, blueprintItemIds: string[]) {
    const existing = await this.prisma.question.findMany({
      where: { runId, blueprintItemId: { in: blueprintItemIds } },
      select: { blueprintItemId: true },
    });
    const existingSet = new Set(existing.map((e) => e.blueprintItemId));
    let missing = 0;
    for (const id of blueprintItemIds) if (!existingSet.has(id)) missing++;
    return missing;
  }

  // ------------------------
  // Finalize run
  // ------------------------
  private async finalizeRunIfDone(runId: string) {
    const run = await this.prisma.generationRun.findUnique({ where: { id: runId } });
    if (!run) return;

    if (run.doneItems + run.failedItems >= run.totalItems) {
      await this.prisma.generationRun.update({
        where: { id: runId },
        data: { status: run.failedItems > 0 ? "FAILED" : "COMPLETED" },
      });
    }
  }
}
