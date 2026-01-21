import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from './health/health.module';
import { DocumentsModule } from './documents/documents.module';
import { GeminiModule } from './gemini/gemini.module';
import { IndexingModule } from "./indexing/indexing.module";
import { RetrievalModule } from './retrieval/retrieval.module';
import { BlueprintsModule } from './blueprints/blueprints.module';
import { GenerationModule } from './generation/generation.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,

    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>("REDIS_HOST"),
          port: Number(config.get<string>("REDIS_PORT")),
        },
      }),
    }),

    HealthModule,
    DocumentsModule,
    GeminiModule,
    IndexingModule,
    RetrievalModule,
    BlueprintsModule,
    GenerationModule
  ],
})
export class AppModule {}
