import { Module } from '@nestjs/common';
import { RetrievalController } from './retrieval.controller';
import { RetrievalService } from './retrieval.service';
import { GeminiModule } from "../gemini/gemini.module";

@Module({
  imports: [GeminiModule],
  controllers: [RetrievalController],
  providers: [RetrievalService]
})
export class RetrievalModule {}
