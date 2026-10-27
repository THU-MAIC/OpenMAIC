import { z } from 'zod';
export interface StageSkillProtocol {
  digest?: string;
  progression: string[];
  final: string;
}
export const SKILL_REVIEW_TOOL = 'request_skill_review';
const receiptSchema = z.object({
  file: z.string(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string(),
  question: z.string().min(1),
  approval: z.boolean().optional(),
});
export const guidedSkillStateSchema = z
  .object({
    protocolDigest: z.string(),
    activeFile: z.string(),
    reviewedFiles: z.array(z.string()).max(16),
    pending: receiptSchema.optional(),
    handoff: z
      .object({
        runId: z.string(),
        question: z.string().min(1),
        kind: z.literal('support').optional(),
      })
      .optional(),
    welcome: z.enum(['pending', 'ready']).optional(),
    approval: z
      .object({
        stageKey: z.string(),
        artifactDigest: z.string(),
        studentSeq: z.number().int().positive(),
      })
      .optional(),
    coverage: z
      .object({
        stageKey: z.string(),
        artifactDigest: z.string(),
        studentSeq: z.number().int().positive(),
      })
      .optional(),
  })
  .strict();
export type GuidedSkillState = z.infer<typeof guidedSkillStateSchema>;
interface StudentMessage {
  seq: number;
  text: string;
}

/** Each part includes production + understanding + review, separated by real student turns. */
export class GuidedSkillReview {
  state: GuidedSkillState;
  private runId = '';
  private stageKey = '';
  private messages: readonly StudentMessage[] = [];
  private eligible = false;
  private advanced = false;
  private ended = false;

  constructor(
    readonly protocol: StageSkillProtocol,
    restored?: GuidedSkillState,
    projectWelcome = false,
    private readonly requiresApproval = false,
  ) {
    const files = protocol.progression.slice(1);
    const index = restored ? files.indexOf(restored.activeFile) : -1;
    const valid =
      restored !== undefined &&
      restored.protocolDigest === protocol.digest &&
      ((index >= 0 &&
        JSON.stringify(restored.reviewedFiles) === JSON.stringify(files.slice(0, index))) ||
        (restored.activeFile === '' &&
          restored.reviewedFiles.length === 0 &&
          !restored.pending &&
          restored.handoff?.kind === 'support')) &&
      (!restored.pending || restored.pending.file === restored.activeFile) &&
      (!projectWelcome || restored.welcome !== undefined);
    this.state = valid
      ? structuredClone(restored!)
      : { protocolDigest: protocol.digest!, activeFile: '', reviewedFiles: [] };
    if (projectWelcome) this.state.welcome = valid ? restored!.welcome : 'pending';
  }

  beginRun(
    stageKey: string,
    messages: readonly StudentMessage[],
    eligible: boolean,
    turnSequence = messages.at(-1)?.seq ?? 0,
  ): void {
    this.stageKey = stageKey;
    this.messages = messages;
    this.runId = `${stageKey}:${turnSequence}`;
    this.eligible = eligible;
    this.advanced = false;
    // A retry is still the same student turn, not permission to revise their review.
    this.ended =
      this.state.pending?.runId === this.runId || this.state.handoff?.runId === this.runId;
    if (this.state.handoff?.runId !== this.runId) delete this.state.handoff;
  }

  /** Keep local protocol flags aligned with a tool's committed database result. */
  async withRollback<T>(work: () => Promise<T>): Promise<T> {
    const state = structuredClone(this.state),
      advanced = this.advanced,
      ended = this.ended;
    try {
      return await work();
    } catch (error) {
      this.state = state;
      this.advanced = advanced;
      this.ended = ended;
      throw error;
    }
  }

  /** A blocked build can return control without creating review/approval evidence. */
  handoff(question: string): void {
    if (!question.trim()) throw new Error('A concrete learner question is required.');
    this.assertWritable();
    delete this.state.pending;
    delete this.state.coverage;
    this.state.handoff = { runId: this.runId, question };
    this.finishRun();
  }

  /** Answer a help-only turn without replacing a pending review or creating learner evidence. */
  support(response: string): void {
    if (!response.trim()) throw new Error('A learner-facing response is required.');
    if (this.ended || this.advanced)
      throw new Error('Answer assistance before opening/advancing a section and end this turn.');
    this.state.handoff = { runId: this.runId, question: response, kind: 'support' };
    this.finishRun();
  }

  /** The runner supplies durable user events, never model-authored quotes or assistant turns. */
  studentResponses(): readonly StudentMessage[] {
    const pending = this.state.pending;
    const prefix = `${this.stageKey}:`;
    if (!pending?.runId.startsWith(prefix)) return [];
    const sequence = pending.runId.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(sequence)) return [];
    const after = Number(sequence);
    if (!Number.isSafeInteger(after)) return [];
    return this.messages.filter((message) => message.seq > after && message.text.trim());
  }

  assertWritable(): void {
    if (!this.state.activeFile || this.ended)
      throw new Error('先读取当前段协议；提交学生审查任务后必须结束本轮');
  }

  finishRun(): void {
    // A new part can reveal a design conflict that needs a student answer first.
    // Ending that clarification creates no review receipt: advance() and complete()
    // still require the needed real feedback, or already verified same-version coverage.
    this.ended = true;
  }

  private assertFeedback(feedback: string | undefined, digest: string): void {
    const pending = this.state.pending;
    if (!pending || pending.runId === this.runId || !this.eligible)
      throw new Error('当前段必须先提交审查任务并等待新的学生回复');
    if (pending.artifactDigest !== digest)
      throw new Error('计划或代码已变化，请复查受影响部分并重新提交当前版本的审查任务');
    if (!this.studentResponses().length)
      throw new Error('当前审查任务尚无新的学生回复；不能用助手自查或旧对话代替');
    // The Skill assesses meaning across the actual replies. Formatting or paraphrasing
    // this assessment cannot establish (or invalidate) the existence of a student reply.
    if (!feedback?.trim()) throw new Error('请说明学生回复如何回答了当前审查任务');
  }

  private assertCovered(feedback: string | undefined, digest: string): void {
    const coverage = this.state.coverage;
    if (
      this.state.pending ||
      !this.eligible ||
      !coverage ||
      coverage.stageKey !== this.stageKey ||
      coverage.artifactDigest !== digest ||
      !this.messages.some((message) => message.seq === coverage.studentSeq && message.text.trim())
    )
      throw new Error(
        '只能沿用当前环节、当前版本已验证的真实学生回复；新问题和文件变化仍需重新确认',
      );
    if (!feedback?.trim()) throw new Error('请说明已有学生回复如何覆盖当前段的目标');
  }

  startTeaching(feedback: string | undefined, digest: string): void {
    if (this.state.welcome !== 'pending' || this.advanced || this.ended)
      throw new Error('项目导览尚未等待新的就绪回复');
    this.assertFeedback(feedback, digest);
    this.state.welcome = 'ready';
    delete this.state.pending;
    delete this.state.coverage; // Readiness is not evidence of conceptual understanding.
    this.advanced = true;
  }

  advance(file: string, feedback: string | undefined, digest: string, reuseFeedback = false): void {
    if ((this.advanced && !reuseFeedback) || this.ended)
      throw new Error('本轮只能展开一个内容部分；交付并等待学生反馈后再继续');
    const expected =
      this.protocol.progression[this.state.reviewedFiles.length + (this.state.activeFile ? 2 : 1)];
    if (file !== expected) throw new Error('不能跳过当前段或改变协议顺序');
    if (this.state.activeFile) {
      if (this.state.welcome === 'pending')
        throw new Error('先完成项目导览并等待学生准备好，再开始第一段教学');
      if (reuseFeedback) this.assertCovered(feedback, digest);
      else {
        this.assertFeedback(feedback, digest);
        this.state.coverage = {
          stageKey: this.stageKey,
          artifactDigest: digest,
          studentSeq: this.studentResponses().at(-1)!.seq,
        };
        if (this.state.pending?.approval) this.state.approval = { ...this.state.coverage };
      }
      this.state.reviewedFiles.push(this.state.activeFile);
    }
    this.state.activeFile = file;
    delete this.state.pending;
    this.advanced = true;
  }

  checkpoint(question: string, digest: string, approval = false): GuidedSkillState {
    if (!question.trim()) throw new Error('请给出当前段的具体检查任务');
    // The welcome is already supplied by the host prompt. Recording readiness
    // may be the model's first tool call; it must not depend on a redundant read.
    // Keep it inside A, without opening the lesson or crediting any feedback.
    if (this.state.welcome === 'pending' && !this.state.activeFile)
      this.advance(this.protocol.progression[1]!, undefined, digest);
    this.assertWritable();
    this.state.pending = {
      file: this.state.activeFile,
      artifactDigest: digest,
      runId: this.runId,
      question,
      ...(approval ? { approval: true } : {}),
    };
    this.ended = true;
    return structuredClone(this.state);
  }

  assertCompletable(): void {
    if (
      this.ended ||
      this.state.welcome === 'pending' ||
      this.state.activeFile !== this.protocol.final ||
      JSON.stringify(this.state.reviewedFiles) !==
        JSON.stringify(this.protocol.progression.slice(1, -1))
    )
      throw new Error(
        '必须完成各段学生反馈和最终确认，不能以协议已读代替审查。' +
          'Use teachingContext and read_next_skill to deliver the unfinished section, ' +
          'then reuse verified same-version feedback if the goal is already covered; otherwise request_skill_review and wait for its real reply.',
      );
  }

  assertComplete(feedback: string | undefined, digest: string, reuseFeedback = false): void {
    this.assertCompletable();
    if (reuseFeedback) this.assertCovered(feedback, digest);
    else this.assertFeedback(feedback, digest);
    const prior = this.state.approval;
    const approved =
      (!reuseFeedback && this.state.pending?.approval) ||
      (prior?.stageKey === this.stageKey &&
        prior.artifactDigest === digest &&
        this.messages.some((message) => message.seq === prior.studentSeq && message.text.trim()));
    if (this.requiresApproval && !approved)
      throw new Error(
        'Request approval of the current artifact with request_skill_review and wait for the learner reply; understanding feedback cannot approve an artifact.',
      );
  }

  complete(feedback: string | undefined, digest: string, reuseFeedback = false): void {
    this.assertComplete(feedback, digest, reuseFeedback);
    this.ended = true;
  }
}
