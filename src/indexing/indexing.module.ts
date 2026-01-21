import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { IndexingConsumer } from "./indexing.consumer";
import { GeminiModule } from "../gemini/gemini.module";
import { ChunkingService } from "../documents/pipeline/chunking.service";
import { QUEUE_INDEXING } from "../queues/queue.constants";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_INDEXING }),
    GeminiModule, // ✅ supaya GeminiService tersedia
  ],
  providers: [
    ChunkingService, // dipakai IndexingConsumer
    IndexingConsumer,
  ],
  exports: [],
})
export class IndexingModule {}