-- AddPromptTemplates

-- CreateEnum
CREATE TYPE "PromptCategory" AS ENUM ('SYSTEM', 'GENERATION', 'GRADING', 'ANALYSIS', 'CHAT');

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "category" "PromptCategory" NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_key_key" ON "prompt_templates"("key");
