import type { ArtifactLocation, ArtifactStore } from '../../src/artifact-store.js';
import type { JobStore } from '../../src/job-store.js';
import type { RenderExecutor } from '../../src/render-executor.js';
import type { RenderJobRecord } from '../../src/types.js';

export function createMemoryJobStore(): JobStore {
  const jobs = new Map<string, RenderJobRecord>();
  return {
    async create(record) {
      jobs.set(record.id, record);
    },
    async get(id) {
      return jobs.get(id) ?? null;
    },
    async update(id, patch) {
      const current = jobs.get(id);
      if (current) jobs.set(id, { ...current, ...patch, updatedAtMs: Date.now() });
    },
    async remove(id) {
      jobs.delete(id);
    },
    async list() {
      return [...jobs.values()];
    },
    async countActiveForUser(userId) {
      return [...jobs.values()].filter(
        (job) => job.userId === userId && (job.status === 'queued' || job.status === 'running'),
      ).length;
    },
  };
}

export function createMemoryArtifactStore(): {
  paths: Map<string, string>;
  store: ArtifactStore;
} {
  const paths = new Map<string, string>();
  const store: ArtifactStore = {
    async put(id, sourcePath) {
      paths.set(id, sourcePath);
    },
    async locate(id): Promise<ArtifactLocation | null> {
      const path = paths.get(id);
      return path ? { kind: 'file', path } : null;
    },
    async remove(id) {
      paths.delete(id);
    },
  };
  return { paths, store };
}

export const succeedingExecutor: RenderExecutor = {
  async execute() {
    return { status: 'succeeded' };
  },
};
