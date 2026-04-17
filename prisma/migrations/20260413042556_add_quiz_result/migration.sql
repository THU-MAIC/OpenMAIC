-- CreateTable
CREATE TABLE "quiz_results" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "student_db_user_id" TEXT,
    "student_label" TEXT NOT NULL,
    "scene_id" TEXT NOT NULL,
    "scene_title" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "max_score" INTEGER NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "graded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graded_by" TEXT NOT NULL,

    CONSTRAINT "quiz_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quiz_results_classroom_id_idx" ON "quiz_results"("classroom_id");

-- CreateIndex
CREATE INDEX "quiz_results_classroom_id_student_db_user_id_idx" ON "quiz_results"("classroom_id", "student_db_user_id");
