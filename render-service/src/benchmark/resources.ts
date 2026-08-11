import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResourceMetrics } from './types.js';

interface ResourceSnapshot {
  cpuUsec: number;
  rssBytes: number;
}

async function directorySize(path: string): Promise<number> {
  const { readdir, stat } = await import('node:fs/promises');
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) total += (await stat(absolute).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

async function cgroupV2Root(): Promise<string | null> {
  if (!existsSync('/.dockerenv')) return null;
  try {
    const line = (await readFile('/proc/self/cgroup', 'utf8'))
      .split('\n')
      .find((entry) => entry.startsWith('0::'));
    if (!line) return null;
    return join('/sys/fs/cgroup', line.slice(3));
  } catch {
    return null;
  }
}

async function processTreeRssBytes(rootPid = process.pid): Promise<number> {
  const pending = [rootPid];
  const visited = new Set<number>();
  let total = 0;
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const [status, children] = await Promise.all([
      readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
      readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => ''),
    ]);
    const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (rss) total += Number(rss[1]) * 1024;
    for (const child of children.trim().split(/\s+/)) {
      if (child) pending.push(Number(child));
    }
  }
  return total;
}

function parseCpuUsec(cpuStat: string): number {
  const match = /^usage_usec\s+(\d+)$/m.exec(cpuStat);
  if (!match) throw new Error('cgroup cpu.stat has no usage_usec');
  return Number(match[1]);
}

async function readCgroupSnapshot(root: string): Promise<ResourceSnapshot> {
  const [cpuStat, rssBytes] = await Promise.all([
    readFile(join(root, 'cpu.stat'), 'utf8'),
    processTreeRssBytes(),
  ]);
  return { cpuUsec: parseCpuUsec(cpuStat), rssBytes };
}

async function readProcessSnapshot(): Promise<ResourceSnapshot> {
  const cpu = process.cpuUsage();
  return { cpuUsec: cpu.user + cpu.system, rssBytes: await processTreeRssBytes() };
}

export class ResourceSampler {
  private interval: NodeJS.Timeout | null = null;
  private cgroupRoot: string | null = null;
  private scope: ResourceMetrics['scope'] = 'process';
  private first: ResourceSnapshot = { cpuUsec: 0, rssBytes: 0 };
  private previous = this.first;
  private previousAt = performance.now();
  private last = this.first;
  private peakCpuPercent = 0;
  private peakRssBytes = this.first.rssBytes;
  private temporaryDiskPeakBytes = 0;
  private diskSample: Promise<void> | null = null;

  constructor(
    private readonly temporaryRoot: string,
    private readonly intervalMs = 250,
  ) {}

  async start(): Promise<void> {
    this.cgroupRoot = await cgroupV2Root();
    this.scope = this.cgroupRoot ? 'cgroup-v2' : 'process';
    this.first = await this.readSnapshot();
    this.previous = this.first;
    this.last = this.first;
    this.previousAt = performance.now();
    await this.sample();
    this.interval = setInterval(() => void this.sample(), this.intervalMs);
  }

  private async readSnapshot(): Promise<ResourceSnapshot> {
    if (this.cgroupRoot) {
      try {
        return await readCgroupSnapshot(this.cgroupRoot);
      } catch {
        this.cgroupRoot = null;
        this.scope = 'process';
      }
    }
    return readProcessSnapshot();
  }

  private async sample(): Promise<void> {
    const now = performance.now();
    const current = await this.readSnapshot();
    const elapsedSeconds = Math.max(0.001, (now - this.previousAt) / 1000);
    const cpuSeconds = Math.max(0, current.cpuUsec - this.previous.cpuUsec) / 1_000_000;
    this.peakCpuPercent = Math.max(this.peakCpuPercent, (cpuSeconds / elapsedSeconds) * 100);
    this.peakRssBytes = Math.max(this.peakRssBytes, current.rssBytes);
    this.previous = current;
    this.last = current;
    this.previousAt = now;
    if (!this.diskSample) {
      this.diskSample = directorySize(this.temporaryRoot)
        .then((bytes) => {
          this.temporaryDiskPeakBytes = Math.max(this.temporaryDiskPeakBytes, bytes);
        })
        .finally(() => {
          this.diskSample = null;
        });
    }
  }

  async stop(): Promise<ResourceMetrics> {
    if (this.interval) clearInterval(this.interval);
    await this.sample();
    if (this.diskSample) await this.diskSample;
    return {
      scope: this.scope,
      cpuSeconds: Math.max(0, this.last.cpuUsec - this.first.cpuUsec) / 1_000_000,
      cpuPeakPercent: this.peakCpuPercent,
      peakRssBytes: this.peakRssBytes,
      temporaryDiskPeakBytes: this.temporaryDiskPeakBytes,
    };
  }
}
