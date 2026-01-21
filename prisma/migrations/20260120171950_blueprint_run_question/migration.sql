-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('MCQ', 'ESSAY');

-- CreateEnum
CREATE TYPE "CognitiveLevel" AS ENUM ('LOTS', 'MOTS', 'HOTS');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Blueprint" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Blueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlueprintItem" (
    "id" TEXT NOT NULL,
    "blueprintId" TEXT NOT NULL,
    "no" INTEGER NOT NULL,
    "type" "QuestionType" NOT NULL,
    "cognitive" "CognitiveLevel" NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "objective" TEXT,
    "sourceChunkIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlueprintItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationRun" (
    "id" TEXT NOT NULL,
    "blueprintId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "doneItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "blueprintItemId" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL,
    "cognitive" "CognitiveLevel" NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "stem" TEXT NOT NULL,
    "options" JSONB,
    "answerKey" TEXT,
    "explanation" TEXT NOT NULL,
    "expectedAnswer" JSONB,
    "keywordGroups" JSONB,
    "rubric" JSONB,
    "sourceChunkIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Blueprint_documentId_idx" ON "Blueprint"("documentId");

-- CreateIndex
CREATE INDEX "BlueprintItem_blueprintId_idx" ON "BlueprintItem"("blueprintId");

-- CreateIndex
CREATE UNIQUE INDEX "BlueprintItem_blueprintId_no_key" ON "BlueprintItem"("blueprintId", "no");

-- CreateIndex
CREATE INDEX "GenerationRun_blueprintId_idx" ON "GenerationRun"("blueprintId");

-- CreateIndex
CREATE INDEX "Question_runId_idx" ON "Question"("runId");

-- CreateIndex
CREATE INDEX "Question_blueprintItemId_idx" ON "Question"("blueprintItemId");

-- AddForeignKey
ALTER TABLE "Blueprint" ADD CONSTRAINT "Blueprint_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlueprintItem" ADD CONSTRAINT "BlueprintItem_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "Blueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_blueprintId_fkey" FOREIGN KEY ("blueprintId") REFERENCES "Blueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_blueprintItemId_fkey" FOREIGN KEY ("blueprintItemId") REFERENCES "BlueprintItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
