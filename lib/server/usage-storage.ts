import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { hasBillableTokens, type NormalizedUsage } from '@/lib/usage/normalize';
import { computeCost, resolveModelPricing, type ModelPricing } from '@/lib/usage/pricing';

const log = createLogger('UsageStorage');

/** Base directory for usage logs; lands in the openmaic-data volume in Docker. */
function usageDir(baseDir?: string): string {
  return baseDir ?? path.join(process.cwd(), 'data', 'usage');
}

/** Current month's jsonl file name, e.g. usage/2026-06.jsonl. */
function monthlyFile(dir: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return path.join(dir, `${y}-${m}.jsonl`);
}

/** Input to record one LLM call's usage. */
export interface UsageRecordInput {
  source: string;
  providerId: string;
  modelId: string;
  modelString: string;
  usage: NormalizedUsage;
}

/** A persisted usage row — self-describing (carries a pricing snapshot via costs). */
export interface UsageRecord {
  id: string;
  createdAt: number;
  source: string;
  providerId: string;
  modelId: string;
  modelString: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheCreationCostUsd: number;
  totalCostUsd: number;
  /** True when the model had no pricing entry — tokens recorded, cost is 0/unknown. */
  costNull?: boolean;
}

interface RecordOptions {
  baseDir?: string;
  /** Override pricing table (defaults to bundled DEFAULT_PRICING). */
  pricingTable?: ModelPricing[];
  /** Injected clock for deterministic tests. */
  now?: Date;
}

let counter = 0;
function makeId(now: Date): string {
  counter = (counter + 1) % 1_000_000;
  return `${now.getTime()}-${counter.toString(36)}`;
}

/**
 * Records one LLM call's usage as a jsonl line. Fire-and-forget: never throws —
 * a logging failure must not break generation. Skips rows with no billable
 * tokens (e.g. an OpenAI-compatible stream that omitted usage).
 */
export async function recordUsage(input: UsageRecordInput, opts: RecordOptions = {}): Promise<void> {
  try {
    if (!hasBillableTokens(input.usage)) return;

    const now = opts.now ?? new Date();
    const pricing = resolveModelPricing(input.modelId, opts.pricingTable);
    const cost = computeCost(input.usage, pricing);

    const record: UsageRecord = {
      id: makeId(now),
      createdAt: now.getTime(),
      source: input.source,
      providerId: input.providerId,
      modelId: input.modelId,
      modelString: input.modelString,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheCreationTokens: input.usage.cacheCreationTokens,
      reasoningTokens: input.usage.reasoningTokens,
      inputCostUsd: cost?.inputCostUsd ?? 0,
      outputCostUsd: cost?.outputCostUsd ?? 0,
      cacheReadCostUsd: cost?.cacheReadCostUsd ?? 0,
      cacheCreationCostUsd: cost?.cacheCreationCostUsd ?? 0,
      totalCostUsd: cost?.totalCostUsd ?? 0,
      costNull: cost === null ? true : undefined,
    };

    const dir = usageDir(opts.baseDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(monthlyFile(dir, now), JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    log.warn('Failed to record usage (ignored):', err);
  }
}

interface ReadOptions {
  baseDir?: string;
  /** Limit to specific YYYY-MM month files; defaults to all files in the dir. */
  months?: string[];
}

/**
 * Reads all usage records (across monthly files). Returns [] when the dir is
 * absent. Malformed lines are skipped, not fatal.
 */
export async function readUsageRecords(opts: ReadOptions = {}): Promise<UsageRecord[]> {
  const dir = usageDir(opts.baseDir);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  if (opts.months?.length) {
    files = files.filter((f) => opts.months!.some((m) => f.startsWith(m)));
  }

  const records: UsageRecord[] = [];
  for (const file of files.sort()) {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as UsageRecord);
      } catch {
        // skip malformed line
      }
    }
  }
  return records;
}
