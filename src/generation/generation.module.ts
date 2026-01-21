import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { GeminiModule } from "../gemini/gemini.module";
import { GenerationController } from "./generation.controller";
import { GenerationService } from "./generation.service";
import { GenerationConsumer } from "./generation.consumer";
import { QUEUE_GENERATION } from "../queues/queue.constants";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_GENERATION }),
    GeminiModule,
  ],
  controllers: [GenerationController],
  providers: [GenerationService, GenerationConsumer],
})
export class GenerationModule {}