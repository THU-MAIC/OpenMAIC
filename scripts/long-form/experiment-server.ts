/**
 * A local console for the long-form revision experiment.
 *
 * The revision loop has only ever been exercised by unit tests: the prompts
 * were written, the parser was tested, and no model has ever read either. This
 * server closes that gap without asking anyone to run the whole 90-call
 * pipeline — it drives the real critique and repair prompts over a real outline
 * and reports eleven checkpoints, so a failure names which part of the loop is
 * broken instead of just producing a bad course.
 *
 * It reuses the production prompts and the production parsers. If the
 * experiment passes, the thing that passed is the thing that ships.
 *
 * Usage:
 *   npx tsx --conditions=import scripts/long-form/experiment-server.ts
 *   → open http://localhost:8787
 *
 * Outbound endpoints go through the server's URL guard, so a mock provider on
 * loopback needs `ALLOW_LOCAL_NETWORKS=1`. The guard is not optional: the page is
 * reachable from any tab the developer has open.
 *
 * The API key is typed into the page, held in this process's memory for the
 * duration of one request, and never written anywhere.
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import {
  auditOutline,
  applyRevisionPatch,
  buildLongFormBrief,
  CRITIQUE_DIMENSIONS,
  critiquePasses,
  extractJsonObject,
  formatCritiqueForRevision,
  isSafeRevision,
  mergeAuditIntoCritique,
  pageCeilingFor,
  pageFloorFor,
  parseCritique,
  parseRevisionPatch,
  planLongFormCourse,
  serializeOutlineForCritic,
  shouldRevise,
  type Critique,
  type LongFormCoursePlan,
  type OutlineAudit,
} from '@/lib/generation/long-form';
import { normalizeSceneOutlines } from '@/lib/server/generation/outline-schema';
import { createValidatedDispatcher } from '@/lib/server/pinned-dispatcher';
import { allowLocalNetworksEnabled, validateUrlForSSRFWithPolicy } from '@/lib/server/ssrf-guard';
import type { Dispatcher } from 'undici';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  PROMPT_IDS as GENERATION_PROMPT_IDS,
  buildPrompt as buildGenerationPrompt,
} from '@openmaic/generation';
import type { SceneOutline } from '@/lib/types/generation';

const PORT = Number.parseInt(process.env.EXPERIMENT_PORT ?? '8787', 10);
const FIXTURE = join(process.cwd(), 'eval', 'long-form', 'scenarios', 'ch18-analgesics.json');
const PAGE = join(process.cwd(), 'scripts', 'long-form', 'experiment.html');

type Status = 'pass' | 'fail' | 'skip' | 'running';

interface Checkpoint {
  id: string;
  label: string;
  status: Status;
  detail: string;
}

interface ChatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface FixturePage {
  id: string;
  title: string;
  section: string;
  minutes: number;
  purpose: string;
  talk: string[];
  transition: string;
}

interface Fixture {
  meta: { minutes: number; pages: number; title: string };
  pages: FixturePage[];
}

/** The completion endpoint for a base URL that may or may not already name it. */
function completionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

/** Redirects followed before giving up. Every hop is re-validated. */
const MAX_REDIRECTS = 3;

/**
 * The connect-time half of the guard.
 *
 * `validateUrlForSSRFWithPolicy` resolves the hostname once; `fetch` resolves it
 * again, so a rebindable name can answer with a public address to the check and a
 * private or metadata one to the socket. `createValidatedDispatcher` installs a
 * `connect.lookup` that classifies the addresses it actually hands to undici, so
 * the socket can only reach an address that was checked in the same lookup.
 *
 * Created once, lazily: it owns a connection pool, and the policy it reads is the
 * process's `ALLOW_LOCAL_NETWORKS`, fixed at start-up.
 */
let dispatcher: Dispatcher | undefined;
function guardedDispatcher(): Dispatcher {
  dispatcher ??= createValidatedDispatcher({ allowLocalNetworks: allowLocalNetworksEnabled() });
  return dispatcher;
}

/**
 * `fetch` with the URL guard applied to the target, to every redirect, and to
 * the address the socket actually connects to.
 *
 * This console listens on loopback, but loopback does not make it private: any
 * page the developer has open can POST to it as a simple request, with no
 * preflight to stop it, and an unvalidated `baseUrl` would then turn this machine
 * into a proxy for whatever address that page named — including the ones the
 * server's own guard exists to refuse. The guard is the same module the rest of
 * the server uses, so a local mock endpoint still works under
 * `ALLOW_LOCAL_NETWORKS=1`.
 */
async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const refusal = await validateUrlForSSRFWithPolicy(target, {
      allowLocalNetworks: allowLocalNetworksEnabled(),
    });
    if (refusal) {
      throw new Error(`端点被拒绝：${refusal}（本地 mock 端点需要 ALLOW_LOCAL_NETWORKS=1）`);
    }

    const result = await fetch(target, {
      ...init,
      redirect: 'manual',
      // Node's fetch accepts an undici dispatcher; `RequestInit` does not type it.
      dispatcher: guardedDispatcher(),
    } as RequestInit & { dispatcher: Dispatcher });
    if (result.status < 300 || result.status >= 400) return result;

    const location = result.headers.get('location');
    if (!location) return result;

    // Same origin only — scheme, host and port. The request carries
    // `Authorization: Bearer <key>`, and a redirect is chosen by the server, not
    // by the person who typed the key. Comparing hostnames alone let
    // `https://api.example` be redirected to `http://api.example` (the key in
    // cleartext) or to `https://api.example:8443` (a different service on the same
    // machine). A provider that redirects elsewhere has to be named as the Base
    // URL instead.
    const current = new URL(target);
    const next = new URL(location, target);
    if (next.origin !== current.origin) {
      throw new Error(
        `端点重定向到另一个源，已拒绝：${current.origin} → ${next.origin}。` +
          `请直接填写最终的 Base URL —— 密钥不会跨源转发。`,
      );
    }
    target = next.href;
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次：${url}`);
}

interface ChatResult {
  text: string;
  ms: number;
  promptChars: number;
  outputChars: number;
  /** Which field the text came from, when it was not `message.content`. */
  source?: string;
}

/**
 * What came back, without the content.
 *
 * "The model returned no content" is not a diagnosis — an empty `content` with
 * a full `reasoning_content` and `finish_reason: "length"` means the token
 * budget went to thinking, while an empty `content` with no `choices` at all
 * means the endpoint is not the chat-completions shape we assumed. Those need
 * opposite fixes, so the error has to carry which one happened.
 */
function responseShape(json: unknown): Record<string, unknown> {
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const shape: Record<string, unknown> = { topLevelKeys: Object.keys(record) };

  if (Array.isArray(record.choices)) {
    shape.choiceCount = record.choices.length;
    const first = record.choices[0] as Record<string, unknown> | undefined;
    if (first) {
      shape.choiceKeys = Object.keys(first);
      if (first.finish_reason !== undefined) shape.finishReason = first.finish_reason;
      const message = first.message as Record<string, unknown> | undefined;
      if (message) {
        shape.messageKeys = Object.keys(message);
        shape.contentLength = typeof message.content === 'string' ? message.content.length : null;
        shape.reasoningLength =
          typeof message.reasoning_content === 'string' ? message.reasoning_content.length : null;
      }
      if (typeof first.text === 'string') shape.textLength = first.text.length;
    }
  }

  if (record.usage) shape.usage = record.usage;
  if (record.error) shape.error = record.error;
  return shape;
}

/** The text a choice carries, wherever this provider put it. */
function pickText(json: unknown, acceptReasoning: boolean): { text: string; source?: string } {
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;

  const content = typeof message.content === 'string' ? message.content : '';
  if (content.trim()) return { text: content };

  if (typeof first.text === 'string' && first.text.trim())
    return { text: first.text, source: 'choice.text' };

  const reasoning =
    typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message.reasoning === 'string'
        ? message.reasoning
        : '';
  // Only the connectivity probe accepts reasoning as an answer: for a real call
  // the reasoning is not the answer, and treating it as one would feed a
  // half-finished thought into the parser.
  if (acceptReasoning && reasoning.trim()) {
    return { text: reasoning, source: 'reasoning_content' };
  }

  return { text: '' };
}

async function chat(
  config: ChatConfig,
  system: string,
  user: string,
  maxTokens: number,
  options: { acceptReasoning?: boolean; timeoutMs?: number; label?: string } = {},
): Promise<ChatResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 240_000;
  const label = options.label ?? 'call';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  // A provider that accepts the connection and never answers would otherwise
  // hang the experiment forever: `fetch` has no default timeout, and the page
  // has no way to tell a slow model from a dead one.
  const signal = AbortSignal.timeout(timeoutMs);

  console.log(
    `[call] ${label} start (max_tokens=${maxTokens}, timeout=${Math.round(timeoutMs / 1000)}s)`,
  );

  // Providers disagree about how large a completion may be, and a reasoning
  // model counts its thinking against the same budget. Rather than make the
  // page ask, step down until the endpoint accepts: 400s about the token cap
  // and rejections of `temperature` are the two shapes this hits.
  const attempts: Array<Record<string, unknown>> = [
    { max_tokens: maxTokens, temperature: 0.3 },
    { max_tokens: Math.min(maxTokens, 4096), temperature: 0.3 },
    { max_tokens: Math.min(maxTokens, 2048) },
  ];

  let response: Response | null = null;
  let lastBody = '';
  for (const extra of attempts) {
    try {
      response = await guardedFetch(completionsUrl(config.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, messages, ...extra }),
        signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && /abort|timeout/i.test(error.message);
      const message = aborted
        ? `请求超时（${Math.round(timeoutMs / 1000)}s 没有返回）。可能是模型太慢，或该端点需要流式请求`
        : `请求失败：${error instanceof Error ? error.message : String(error)}`;
      console.log(`[call] ${label} FAILED ${message}`);
      throw new Error(message);
    }

    if (response.ok) break;

    lastBody = await response.text();
    console.log(`[call] ${label} HTTP ${response.status}: ${lastBody.slice(0, 200)}`);
    // Only a parameter complaint is worth retrying; a 401 or a 404 will not
    // improve by sending fewer tokens.
    const parameterProblem =
      response.status === 400 &&
      /max_tokens|max_completion_tokens|temperature|too large|invalid/i.test(lastBody);
    if (!parameterProblem) throw new Error(`HTTP ${response.status}: ${lastBody.slice(0, 400)}`);
    response = null;
  }

  if (!response) throw new Error(`HTTP 400（参数被拒，已试过三档）: ${lastBody.slice(0, 400)}`);

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`response was not JSON: ${body.slice(0, 200)}`);
  }

  const { text, source } = pickText(parsed, options.acceptReasoning === true);
  if (!text.trim()) {
    console.log(`[call] ${label} EMPTY ${JSON.stringify(responseShape(parsed))}`);
    throw new Error(
      `模型没有返回内容。响应结构：${JSON.stringify(responseShape(parsed))}` +
        `（常见原因：max_tokens=${maxTokens} 被推理过程耗尽，或该端点不是 chat/completions 结构）`,
    );
  }

  console.log(`[call] ${label} done ${Date.now() - started}ms, ${text.length} chars`);
  return {
    text,
    ms: Date.now() - started,
    promptChars: system.length + user.length,
    outputChars: text.length,
    ...(source ? { source } : {}),
  };
}

/** A real 61-minute outline, taken from the deck a person actually taught. */
function goodOutline(fixture: Fixture): SceneOutline[] {
  return fixture.pages.map((page, index) => ({
    id: `scene_${index + 1}`,
    type: /小测|自测|提问|请回答|作答/.test(page.talk.join('')) ? 'quiz' : 'slide',
    title: page.title,
    description: `${page.purpose} ${page.transition}`.trim(),
    keyPoints: page.talk.slice(0, 4),
    teachingObjective: page.purpose.slice(0, 80),
    estimatedDuration: page.minutes * 60,
    order: index + 1,
  })) as SceneOutline[];
}

/**
 * The same course with its teaching removed: topic labels instead of claims, no
 * objectives, every page a minute long, no retrieval. This is the failure mode
 * the contracts exist for, and a critic that cannot tell it apart from the real
 * outline is not reading.
 */
function degradedOutline(good: readonly SceneOutline[]): SceneOutline[] {
  return good.map((scene, index) => ({
    id: scene.id,
    type: 'slide' as const,
    title: scene.title,
    description: `介绍${scene.title}`,
    keyPoints: [scene.title],
    estimatedDuration: 60,
    order: index + 1,
  }));
}

function meanScore(critique: Critique): number {
  const values = Object.values(critique.scores);
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function critiqueOf(
  config: ChatConfig,
  plan: LongFormCoursePlan,
  outlines: readonly SceneOutline[],
  requirement: string,
  emit: (event: unknown) => void,
  label: string,
): Promise<{ critique: Critique | null; audit: OutlineAudit; raw: string; ms: number }> {
  const audit = auditOutline(plan, outlines);
  const prompts = buildPrompt(PROMPT_IDS.LONG_FORM_CRITIQUE, {
    requirement,
    budget: buildLongFormBrief(plan),
    outline: serializeOutlineForCritic(outlines),
    audit: audit.summary,
  });
  if (!prompts) throw new Error('critique prompt template is missing');

  emit({ type: 'call', label, phase: 'start' });
  const result = await chat(config, prompts.system, prompts.user, 16000, {
    timeoutMs: 240_000,
    label,
  });
  emit({ type: 'call', label, phase: 'done', ms: result.ms });

  return { critique: parseCritique(result.text), audit, raw: result.text, ms: result.ms };
}

async function runExperiment(
  config: ChatConfig,
  options: { generateReal: boolean },
  emit: (event: unknown) => void,
): Promise<void> {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Fixture;
  const requirement = `做一个 ${fixture.meta.minutes} 分钟的药理学课：镇痛药。面向大二医学生。`;
  const plan = planLongFormCourse({ minutes: fixture.meta.minutes, language: 'zh' });

  const checkpoints: Checkpoint[] = [];
  const record = (checkpoint: Checkpoint) => {
    checkpoints.push(checkpoint);
    emit({ type: 'checkpoint', checkpoint });
  };

  emit({
    type: 'plan',
    plan: {
      minutes: plan.minutes,
      modules: plan.modules.length,
      pages: plan.scenes.length,
      speech: plan.totalSpeechBudget,
      decisionModules: plan.decisionModules,
      patchModules: plan.patchModules,
    },
    fixture: {
      title: fixture.meta.title,
      pages: fixture.meta.pages,
      minutes: fixture.meta.minutes,
    },
  });

  const good = goodOutline(fixture);
  const bad = degradedOutline(good);

  // ── C1 connectivity ──
  emit({ type: 'call', label: '连通性', phase: 'start' });
  try {
    // 512, not 32: a reasoning model spends its budget thinking first, and a
    // 32-token ceiling leaves nothing for the answer — which reads as "the model
    // returned no content" and looks like a broken endpoint.
    const ping = await chat(config, 'You are a test.', '只回答两个字：可用', 512, {
      timeoutMs: 60_000,
      label: '连通性',
      acceptReasoning: true,
    });
    emit({ type: 'call', label: '连通性', phase: 'done', ms: ping.ms });
    record({
      id: 'C1',
      label: '接口连通',
      status: 'pass',
      detail: `${ping.ms}ms，返回「${ping.text.trim().slice(0, 20)}」${ping.source ? `（取自 ${ping.source}）` : ''}`,
    });
  } catch (error) {
    record({
      id: 'C1',
      label: '接口连通',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
    emit({ type: 'done', checkpoints });
    return;
  }

  // ── C2–C5: critique the degraded outline ──
  let badCritique: Critique | null = null;
  let badAudit: OutlineAudit | null = null;
  let badRaw = '';
  try {
    const result = await critiqueOf(config, plan, bad, requirement, emit, '审校（劣质稿）');
    badCritique = result.critique;
    badAudit = result.audit;
    badRaw = result.raw;
    emit({ type: 'artifact', name: 'critique-bad', content: result.raw });

    record({
      id: 'C2',
      label: '审校返回可解析的 JSON',
      status: badCritique ? 'pass' : 'fail',
      detail: badCritique
        ? `${result.ms}ms，${badRaw.length} 字符`
        : `无法解析：${badRaw.slice(0, 160)}`,
    });

    // `parseCritique` fills a dimension the model left out with a default score,
    // so counting the parsed keys always returns five and C3 could never fail.
    // The question it asks is whether the model answered all five, which only
    // the raw object can answer.
    // The five *named* dimensions, each with a number. A key count proves neither:
    // a critic that omits `structure` and adds `overall` still returns five keys,
    // and `parseCritique` fills the missing score with a default, so the parsed
    // object cannot answer this either.
    const rawScores = (extractJsonObject(badRaw) as { scores?: unknown } | null)?.scores;
    const scoreRecord =
      rawScores && typeof rawScores === 'object' ? (rawScores as Record<string, unknown>) : {};
    const suppliedScores = CRITIQUE_DIMENSIONS.filter(
      (dimension) => typeof scoreRecord[dimension] === 'number',
    ).length;

    record({
      id: 'C3',
      label: '五个维度都有分数',
      status: suppliedScores === CRITIQUE_DIMENSIONS.length ? 'pass' : 'fail',
      detail: badCritique
        ? `原始返回 ${suppliedScores}/${CRITIQUE_DIMENSIONS.length} 个命名维度 · ${Object.entries(
            badCritique.scores,
          )
            .map(([key, value]) => `${key}=${value}`)
            .join(' ')}`
        : '没有分数',
    });

    const withPages = badCritique?.defects.filter((defect) => defect.pageIndex !== null) ?? [];
    record({
      id: 'C4',
      label: '缺陷指向具体页码',
      status: withPages.length > 0 ? 'pass' : 'fail',
      detail: badCritique
        ? `${badCritique.defects.length} 条缺陷，其中 ${withPages.length} 条带页码`
        : '无缺陷',
    });

    const actionable = badCritique?.defects.filter((defect) => defect.fix.trim().length > 0) ?? [];
    record({
      id: 'C5',
      label: '每条缺陷都有可执行的修法',
      status:
        actionable.length === (badCritique?.defects.length ?? 0) && actionable.length > 0
          ? 'pass'
          : 'fail',
      detail: `${actionable.length}/${badCritique?.defects.length ?? 0} 条带 fix`,
    });

    record({
      id: 'C6a',
      label: '劣质稿被判为需要修改',
      // The production loop's own stop condition, not just the scores: a critic
      // that answers `verdict: "pass"` with low scores stops the loop there, so
      // C6a must fail for it — otherwise the console reports that the repair path
      // was exercised on a draft production would have shipped as-is.
      status:
        badCritique && !critiquePasses(badCritique) && shouldRevise(badCritique, 0)
          ? 'pass'
          : 'fail',
      detail: badCritique
        ? `均分 ${round(meanScore(badCritique))}，判定 ${badCritique.verdict}，${badCritique.defects.length} 条缺陷`
        : '—',
    });
  } catch (error) {
    record({
      id: 'C2',
      label: '审校返回可解析的 JSON',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // ── C6b: the same critic on the real outline ──
  let goodCritique: Critique | null = null;
  try {
    const result = await critiqueOf(config, plan, good, requirement, emit, '审校（真人稿）');
    goodCritique = result.critique;
    emit({ type: 'artifact', name: 'critique-good', content: result.raw });

    const distinguishes =
      badCritique !== null &&
      goodCritique !== null &&
      meanScore(goodCritique) > meanScore(badCritique);
    record({
      id: 'C6b',
      label: '能区分真人稿与劣质稿',
      status: distinguishes ? 'pass' : 'fail',
      detail:
        goodCritique && badCritique
          ? `真人稿均分 ${round(meanScore(goodCritique))} vs 劣质稿 ${round(meanScore(badCritique))}`
          : '缺少一次审校结果',
    });
  } catch (error) {
    record({
      id: 'C6b',
      label: '能区分真人稿与劣质稿',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // ── C7–C9: repair the degraded outline ──
  if (badCritique && badAudit) {
    try {
      const prompts = buildPrompt(PROMPT_IDS.LONG_FORM_REVISE, {
        requirement,
        budget: buildLongFormBrief(plan),
        outline: serializeOutlineForCritic(bad),
        // The same merge production runs. The critic is told not to repeat the
        // arithmetic, so passing its critique alone would withhold exactly the
        // defects the audit is certain about — and C9 would then report no
        // arithmetic improvement even when the model followed every instruction
        // it was given.
        defects: formatCritiqueForRevision(mergeAuditIntoCritique(badCritique, badAudit)),
      });
      if (!prompts) throw new Error('revise prompt template is missing');

      emit({ type: 'call', label: '修复（劣质稿）', phase: 'start' });
      const repaired = await chat(config, prompts.system, prompts.user, 16000, {
        timeoutMs: 240_000,
        label: '修复（劣质稿）',
      });
      emit({ type: 'call', label: '修复（劣质稿）', phase: 'done', ms: repaired.ms });
      emit({ type: 'artifact', name: 'patch', content: repaired.text });

      const patch = parseRevisionPatch(repaired.text);
      record({
        id: 'C7',
        label: '修复返回可解析的补丁',
        status: patch ? 'pass' : 'fail',
        detail: patch
          ? `${patch.edits.length} 处修改 · ${patch.inserts.length} 处新增 · ${patch.removals.length} 处删除`
          : `无法解析：${repaired.text.slice(0, 160)}`,
      });

      if (patch) {
        const applied = applyRevisionPatch(bad, patch);
        record({
          id: 'C8',
          label: '补丁可以安全应用',
          status: applied.ok ? 'pass' : 'fail',
          detail: applied.ok ? `${bad.length} 页 → ${applied.outlines.length} 页` : applied.reason,
        });

        if (applied.ok) {
          const safe = isSafeRevision(bad, applied.outlines);
          const before = badAudit.defects.length;
          const after = auditOutline(plan, applied.outlines);
          const improved = after.defects.length < before;
          record({
            id: 'C9',
            label: '修复让算术缺陷变少',
            status: improved ? 'pass' : 'fail',
            detail: `缺陷 ${before} → ${after.defects.length}（安全校验 ${safe.ok ? '通过' : '未通过'}）`,
          });
          emit({
            type: 'after',
            before: badAudit.summary,
            after: after.summary,
            pages: applied.outlines.length,
            preview: applied.outlines.slice(0, 6).map((scene, index) => ({
              page: index + 1,
              title: scene.title,
              keyPoints: scene.keyPoints,
              objective: scene.teachingObjective ?? null,
              seconds: scene.estimatedDuration ?? null,
            })),
          });
        }
      }
    } catch (error) {
      record({
        id: 'C7',
        label: '修复返回可解析的补丁',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    for (const id of ['C7', 'C8', 'C9']) {
      record({ id, label: '修复链路', status: 'skip', detail: '前置审校未通过，未执行' });
    }
  }

  // ── Optional: generate a real outline and critique it ──
  if (options.generateReal) {
    try {
      const outlinePrompt = buildGenerationPrompt(GENERATION_PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
        requirement,
        pdfContent: 'None',
        availableImages: 'None',
        userProfile: '',
        hasSourceImages: false,
        imageEnabled: false,
        videoEnabled: false,
        mediaEnabled: false,
        researchContext: 'None',
        teacherContext: '',
        longFormMode: true,
        longFormBrief: buildLongFormBrief(plan),
        durationGuidance:
          '- Course duration: **already fixed by the Long-Form Budget above — do not re-infer it**',
        sceneCountGuidance:
          '- **Scene count**: exactly the page counts in the Long-Form Budget table, in its module order. Set `estimatedDuration` on every scene from the page budgets.',
      });
      if (!outlinePrompt) throw new Error('outline prompt template is missing');

      emit({ type: 'call', label: '真实大纲生成', phase: 'start' });
      const generated = await chat(config, outlinePrompt.system, outlinePrompt.user, 16000, {
        timeoutMs: 600_000,
        label: '真实大纲生成',
      });
      emit({ type: 'call', label: '真实大纲生成', phase: 'done', ms: generated.ms });
      emit({ type: 'artifact', name: 'generated-outline', content: generated.text });

      // R1 feeds the console's readiness verdict, so a substring is not enough:
      // "I cannot produce outlines" contains `outlines`, and so does a response
      // truncated at `"outlines": [`. Parse the wrapper and run the production
      // normalizer — with the plan's own bounds, which production passes too, so a
      // one-page or 200-page answer fails here exactly as it would there.
      const parsedOutline = extractJsonObject(generated.text) as { outlines?: unknown } | null;
      const normalized = normalizeSceneOutlines(parsedOutline?.outlines, {
        minScenes: pageFloorFor(plan),
        maxScenes: pageCeilingFor(plan),
      });
      record({
        id: 'R1',
        label: '真实大纲生成',
        status: normalized.ok && normalized.value.length > 0 ? 'pass' : 'fail',
        detail: normalized.ok
          ? `${generated.ms}ms，${generated.outputChars} 字符，${normalized.value.length} 页可用`
          : `${generated.ms}ms，${generated.outputChars} 字符，不可用：${normalized.message}`,
      });
    } catch (error) {
      record({
        id: 'R1',
        label: '真实大纲生成',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  emit({ type: 'done', checkpoints });
}

/**
 * One raw round trip, reported in full.
 *
 * The experiment needs the endpoint to behave a particular way; when it does
 * not, guessing from "no content" wastes turns. This returns the status, the
 * response shape and a trimmed body so the failure names itself.
 */
async function probeEndpoint(config: ChatConfig): Promise<Record<string, unknown>> {
  const started = Date.now();
  const response = await guardedFetch(completionsUrl(config.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: 'You are a test.' },
        { role: 'user', content: '只回答两个字：可用' },
      ],
      temperature: 0.3,
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const body = await response.text();
  const ms = Date.now() - started;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* reported below */
  }

  const picked = parsed ? pickText(parsed, true) : { text: '' };

  return {
    url: completionsUrl(config.baseUrl),
    status: response.status,
    ms,
    shape: parsed ? responseShape(parsed) : null,
    text: picked.text.slice(0, 300),
    source: picked.source ?? (picked.text ? 'message.content' : null),
    bodyPreview: body.slice(0, 2000),
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  if (request.method === 'GET' && request.url === '/api/health') {
    // The page asks this on load. A page opened straight from disk or from a
    // static preview has no server behind it, and every button on it would fail
    // silently — so it says so up front instead.
    sendJson(response, 200, { ok: true, service: 'long-form-experiment' });
    return;
  }

  if (request.method === 'GET' && (request.url === '/' || request.url === '/index.html')) {
    try {
      const html = readFileSync(PAGE);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('experiment.html is missing next to this script');
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/probe') {
    let raw = '';
    for await (const chunk of request) raw += chunk;

    let payload: { baseUrl?: string; apiKey?: string; model?: string };
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(response, 400, { error: 'body is not JSON' });
      return;
    }

    const baseUrl = (payload.baseUrl ?? '').trim();
    const apiKey = (payload.apiKey ?? '').trim();
    const model = (payload.model ?? '').trim();
    if (!baseUrl || !apiKey || !model) {
      sendJson(response, 400, { error: 'baseUrl, apiKey and model are all required' });
      return;
    }

    try {
      sendJson(response, 200, await probeEndpoint({ baseUrl, apiKey, model }));
    } catch (error) {
      sendJson(response, 200, {
        error: error instanceof Error ? error.message : String(error),
        url: completionsUrl(baseUrl),
      });
    }
    return;
  }

  if (request.method === 'POST' && request.url === '/api/run') {
    let raw = '';
    for await (const chunk of request) raw += chunk;

    let payload: { baseUrl?: string; apiKey?: string; model?: string; generateReal?: boolean };
    try {
      payload = JSON.parse(raw);
    } catch {
      sendJson(response, 400, { error: 'body is not JSON' });
      return;
    }

    const baseUrl = (payload.baseUrl ?? '').trim();
    const apiKey = (payload.apiKey ?? '').trim();
    const model = (payload.model ?? '').trim();
    if (!baseUrl || !apiKey || !model) {
      sendJson(response, 400, { error: 'baseUrl, apiKey and model are all required' });
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const emit = (event: unknown) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await runExperiment(
        { baseUrl, apiKey, model },
        { generateReal: payload.generateReal === true },
        emit,
      );
    } catch (error) {
      emit({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
    } finally {
      response.end();
    }
    return;
  }

  sendJson(response, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log(`  长课修订实验控制台  ${url}`);
  console.log('  在这个页面里填 Base URL / API Key / Model，然后点「开始实验」。');
  console.log('  密钥只在本次请求的内存里，不落盘、不打印。');
  console.log('');
  console.log('  关掉这个窗口就停止服务。');

  // Open the browser so the console is one step, not two. A failure to open is
  // not a failure to serve — the URL is printed either way.
  if (!process.env.EXPERIMENT_NO_OPEN) {
    const command =
      process.platform === 'win32'
        ? 'start "" '
        : process.platform === 'darwin'
          ? 'open '
          : 'xdg-open ';
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:child_process').exec(`${command}${url}`, () => {});
    } catch {
      /* the URL is on screen */
    }
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用了。换一个：EXPERIMENT_PORT=8788 pnpm experiment:long-form`);
  } else {
    console.error('启动失败：', error.message);
  }
  process.exit(1);
});
