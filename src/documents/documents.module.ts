import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";
import { DocumentsJobsService } from "./jobs/documents-jobs.service";
import { DocumentsConsumer } from "./jobs/documents.consumer";
import { DocumentParserService } from "./pipeline/document-parser.service";
import { QUEUE_DOCUMENTS, QUEUE_INDEXING } from "../queues/queue.constants";

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_DOCUMENTS },
      { name: QUEUE_INDEXING },
    ),
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentsService,
    DocumentsJobsService,
    DocumentParserService,
    DocumentsConsumer,
  ],
})
export class DocumentsModule {}