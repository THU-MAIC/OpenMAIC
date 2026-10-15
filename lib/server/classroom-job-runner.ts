import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  getClassroomGenerationJobRunnerMap,
  readClassroomGenerationJob,
  releaseClassroomGenerationJobRunner,
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = getClassroomGenerationJobRunnerMap();

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  // Freeze the input exactly once before the first asynchronous boundary.
  const snapshot = structuredClone(input);
  const jobPromise = (async () => {
    try {
      const job = await readClassroomGenerationJob(jobId);
      if (!job || job.status !== 'queued') return;
      if (!(await markClassroomGenerationJobRunning(jobId, snapshot))) return;

      const result = await generateClassroom(snapshot, {
        baseUrl,
        onProgress: async (progress) => {
          const current = await updateClassroomGenerationJobProgress(jobId, progress);
          if (current.status !== 'running')
            throw new Error('Classroom generation job is no longer active');
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      releaseClassroomGenerationJobRunner(jobId);
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
