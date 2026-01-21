/*
  Warnings:

  - A unique constraint covering the columns `[runId,blueprintItemId]` on the table `Question` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Question_runId_blueprintItemId_key" ON "Question"("runId", "blueprintItemId");
