-- Add student_id to users and keep it unique when present
ALTER TABLE "users"
ADD COLUMN "student_id" TEXT;

CREATE UNIQUE INDEX "users_student_id_key" ON "users"("student_id");
