import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenAI } from "@google/genai";
import { jsonrepair } from "jsonrepair";


type TaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING";

@Injectable()
export class GeminiService {
  private readonly ai: GoogleGenAI;

  private readonly generationModel: string;
  private readonly embeddingModel: string;
  private readonly embeddingDim?: number;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY is missing");

    this.ai = new GoogleGenAI({ apiKey });

    this.generationModel =
      this.config.get<string>("GEMINI_GENERATION_MODEL") ?? "gemini-2.5-flash";
    this.embeddingModel =
      this.config.get<string>("GEMINI_EMBEDDING_MODEL") ?? "gemini-embedding-001";

    const dimRaw = this.config.get<string>("GEMINI_EMBEDDING_DIM");
    this.embeddingDim = dimRaw ? Number(dimRaw) : undefined;
  }

  // -------------------------
  // Text generation (free-form)
  // -------------------------
  async generateText(
    prompt: string,
    opts?: { model?: string; temperature?: number; maxOutputTokens?: number },
  ) {
    const model = opts?.model ?? this.generationModel;

    const resp = await this.withRetry(() =>
      this.ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: opts?.temperature ?? 0.4,
          maxOutputTokens: opts?.maxOutputTokens ?? 1400,
        },
      }),
    );

    return { model, text: this.extractText(resp) };
  }

  // -------------------------
  // JSON generation (NO schema)
  // -------------------------
  async generateJson<T = any>(
    prompt: string,
    opts?: { model?: string; maxOutputTokens?: number },
  ): Promise<{ model: string; json: T; raw: string }> {
    const model = opts?.model ?? this.generationModel;

    const resp = await this.withRetry(() =>
      this.ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0,
          maxOutputTokens: opts?.maxOutputTokens ?? 4200,
          responseMimeType: "application/json",
        },
      }),
    );

    const raw = this.extractText(resp);
    const trimmed = (raw ?? "").trim();
    if (!trimmed) throw new Error("EMPTY_JSON_RESPONSE");

    // helper: ambil potongan JSON terbesar yang masuk akal
    const extractCandidate = (s: string) => {
      const firstObj = s.indexOf("{");
      const lastObj = s.lastIndexOf("}");
      if (firstObj !== -1 && lastObj > firstObj) return s.slice(firstObj, lastObj + 1);

      const firstArr = s.indexOf("[");
      const lastArr = s.lastIndexOf("]");
      if (firstArr !== -1 && lastArr > firstArr) return s.slice(firstArr, lastArr + 1);

      return s;
    };

    const candidate = extractCandidate(trimmed);

    // 1) parse langsung
    try {
      return { model, raw: candidate, json: JSON.parse(candidate) as T };
    } catch (e1: any) {
      // 2) fallback: jsonrepair (fix comma/quote/bracket umum)
      try {
        const repaired = jsonrepair(candidate);
        return { model, raw: repaired, json: JSON.parse(repaired) as T };
      } catch (e2: any) {
        // 3) fallback terakhir: minta model memperbaiki JSON (1 request tambahan)
        //    biar hemat quota, potong panjangnya
        const maxChars = 12000;
        const snippet = candidate.length > maxChars ? candidate.slice(-maxChars) : candidate;

        const repairPrompt = `
  Kamu adalah parser. Perbaiki teks berikut menjadi JSON VALID saja.
  Aturan:
  - Output HANYA JSON valid (tanpa markdown, tanpa penjelasan).
  - Jangan mengubah makna konten, hanya perbaiki format JSON.
  - Jika ada kutip ganda di dalam string, WAJIB di-escape.
  Teks:
  ${snippet}
  `.trim();

        const repairResp = await this.withRetry(() =>
          this.ai.models.generateContent({
            model,
            contents: repairPrompt,
            config: {
              temperature: 0,
              maxOutputTokens: 2200,
              responseMimeType: "application/json",
            },
          }),
        );

        const repairedRaw = (this.extractText(repairResp) ?? "").trim();
        if (!repairedRaw) throw new Error("EMPTY_JSON_RESPONSE_AFTER_REPAIR");

        const repairedCandidate = extractCandidate(repairedRaw);

        try {
          return { model, raw: repairedCandidate, json: JSON.parse(repairedCandidate) as T };
        } catch (e3: any) {
          // coba jsonrepair sekali lagi setelah repair
          try {
            const repaired2 = jsonrepair(repairedCandidate);
            return { model, raw: repaired2, json: JSON.parse(repaired2) as T };
          } catch (e4: any) {
            const tail = repairedCandidate.slice(Math.max(0, repairedCandidate.length - 400));
            throw new Error(`JSON_PARSE_ERROR: ${e4?.message ?? e4}. tail=${tail}`);
          }
        }
      }
    }
  }

  // -------------------------
  // Embeddings (RAG)
  // -------------------------
  async embedDocuments(texts: string[], opts?: { dim?: number; title?: string }) {
    return this.embedMany(texts, {
      taskType: "RETRIEVAL_DOCUMENT",
      dim: opts?.dim ?? this.embeddingDim,
      title: opts?.title,
    });
  }

  async embedQuery(text: string, opts?: { dim?: number }) {
    const res = await this.embedMany([text], {
      taskType: "RETRIEVAL_QUERY",
      dim: opts?.dim ?? this.embeddingDim,
    });
    return { ...res, vector: res.vectors[0] };
  }

  private async embedMany(
    texts: string[],
    cfg: { taskType: TaskType; dim?: number; title?: string },
  ): Promise<{ model: string; dim?: number; vectors: number[][] }> {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error("texts must be a non-empty array");
    }

    const cleaned = texts.map((t, i) => {
      const v = (t ?? "").trim();
      if (!v) throw new Error(`texts[${i}] is empty`);
      return v;
    });

    const model = this.embeddingModel;

    const resp = await this.withRetry(() =>
      this.ai.models.embedContent({
        model,
        contents: cleaned,
        config: {
          taskType: cfg.taskType,
          title: cfg.taskType === "RETRIEVAL_DOCUMENT" ? cfg.title : undefined,
          outputDimensionality: cfg.dim,
        },
      }),
    );

    const embeddings =
      (resp as any).embeddings ??
      ((resp as any).embedding ? [(resp as any).embedding] : []);

    const vectors: number[][] = embeddings.map((e: any) => e.values as number[]);

    if (vectors.length !== cleaned.length) {
      throw new Error(
        `Embedding count mismatch. expected=${cleaned.length} got=${vectors.length}`,
      );
    }

    return { model, dim: cfg.dim, vectors };
  }

  // -------------------------
  // Utils
  // -------------------------
  private extractText(resp: any): string {
    const direct = resp?.text;
    if (typeof direct === "string" && direct.trim()) return direct.trim();

    const parts = resp?.candidates?.[0]?.content?.parts ?? [];
    return parts
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
  }

  private async withRetry<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
    let lastErr: any;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;

        const msg = String(err?.message ?? "");
        const isRetryable =
          msg.includes("429") ||
          msg.includes("RESOURCE_EXHAUSTED") ||
          msg.includes("503") ||
          msg.includes("UNAVAILABLE") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("ECONNRESET") ||
          msg.includes("EAI_AGAIN") ||
          msg.includes("JSON_PARSE_ERROR") ||
          msg.includes("EMPTY_JSON_RESPONSE") ||
          msg.includes("EMPTY_JSON_RESPONSE_AFTER_REPAIR");

        if (!isRetryable || attempt === retries) break;

        // baca retryDelay dari error Gemini (kalau ada)
        const retryInfo = err?.error?.details?.find(
          (d: any) => String(d?.["@type"] ?? "").includes("RetryInfo"),
        );
        const retryDelaySec = retryInfo?.retryDelay
          ? Number(String(retryInfo.retryDelay).replace("s", ""))
          : undefined;

        const base = 800 * Math.pow(2, attempt);
        const delayMs = retryDelaySec ? retryDelaySec * 1000 + 500 : base;

        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw lastErr;
  }
}