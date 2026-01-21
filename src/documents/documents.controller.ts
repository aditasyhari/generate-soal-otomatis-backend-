import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import { mkdirSync } from "node:fs";
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";

import { DocumentsService } from "./documents.service";
import { DocumentsJobsService } from "./jobs/documents-jobs.service";
import { UploadDocumentDto } from "./dto/upload-document.dto";

// Pastikan folder uploads ada
mkdirSync("uploads", { recursive: true });

@ApiTags("documents")
@Controller("documents")
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly jobs: DocumentsJobsService,
  ) {}

  @Post("upload")
  @ApiOperation({ summary: "Upload dokumen (.pdf/.docx)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        subject: { type: "string" },
        grade: { type: "string" },
        language: { type: "string" },
        file: { type: "string", format: "binary" },
      },
      required: ["title", "file"],
    },
  })
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: "uploads",
        filename: (_req, file, cb) => {
          const ext = (file.originalname.split(".").pop() || "").toLowerCase();
          const safeExt = ["pdf", "docx"].includes(ext) ? ext : "bin";
          const name = `${Date.now()}-${Math.random().toString(16).slice(2)}.${safeExt}`;
          cb(null, name);
        },
      }),
      // optional: batas ukuran file (mis. 20MB)
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadDocumentDto,
  ) {
    if (!file) throw new BadRequestException("file is required");

    const ext = (file.filename.split(".").pop() || "").toLowerCase();
    if (!["pdf", "docx"].includes(ext)) {
      throw new BadRequestException("Only .pdf or .docx supported");
    }

    // file.path => path lokal yang bisa dibaca worker parse
    const fileUrl = file.path;

    const doc = await this.documentsService.createDocument({
      title: body.title,
      subject: body.subject,
      grade: body.grade,
      language: body.language ?? "id",
      fileUrl,
      fileType: ext,
    });

    return doc;
  }

  @Get(":id")
  @ApiOperation({ summary: "Get document by id" })
  @ApiParam({ name: "id" })
  async get(@Param("id") id: string) {
    const doc = await this.documentsService.getById(id);
    if (!doc) throw new BadRequestException("Document not found");
    return doc;
  }

  @Post(":id/parse")
  @ApiOperation({ summary: "Enqueue parse: Document -> DocumentPage" })
  @ApiParam({ name: "id" })
  async parse(@Param("id") id: string) {
    const doc = await this.documentsService.getById(id);
    if (!doc) throw new BadRequestException("Document not found");

    const job = await this.jobs.enqueueParse(id, false);
    return {
      queued: true,
      queue: "documents",
      jobId: job.id,
      jobName: job.name,
      documentId: id,
    };
  }

  @Post(":id/index")
  @ApiOperation({
    summary:
      "Enqueue indexing: (if needed) parse -> chunk -> embed (RAG ready)",
  })
  @ApiParam({ name: "id" })
  async index(@Param("id") id: string) {
    const doc = await this.documentsService.getById(id);
    if (!doc) throw new BadRequestException("Document not found");

    // Kalau belum parsed: parse lalu chain ke chunk+embed
    if (doc.status === "UPLOADED" || doc.status === "FAILED") {
      const job = await this.jobs.enqueueParse(id, true);
      return {
        queued: true,
        via: "parse->chunk->embed",
        queue: "documents",
        jobId: job.id,
        jobName: job.name,
        documentId: id,
        currentStatus: doc.status,
      };
    }

    // Kalau sudah parsed / sudah pernah indexed: langsung chunk (reset default true)
    if (doc.status === "PARSED" || doc.status === "INDEXED") {
      const job = await this.jobs.enqueueChunk(id, 600, true);
      return {
        queued: true,
        via: "chunk->embed",
        queue: "indexing",
        jobId: job.id,
        jobName: job.name,
        documentId: id,
        currentStatus: doc.status,
      };
    }

    // Kalau sedang proses (PARSING/INDEXING)
    return {
      queued: false,
      message: "Document is currently being processed.",
      documentId: id,
      currentStatus: doc.status,
    };
  }

  @Get(":id/pages")
  async pages(@Param("id") id: string) {
    const doc = await this.documentsService.getById(id);
    if (!doc) throw new BadRequestException("Document not found");

    return this.documentsService.listPages(id);
  }

  @Get(":id/chunks")
  async chunks(@Param("id") id: string) {
    const doc = await this.documentsService.getById(id);
    if (!doc) throw new BadRequestException("Document not found");

    return this.documentsService.listChunks(id);
  }
}