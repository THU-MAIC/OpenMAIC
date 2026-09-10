/**
 * Durable user-authored skills — the store contract plus the PURE validation
 * and patch logic.
 *
 * The store surface mirrors the agent-session module: types/interfaces here,
 * PostgreSQL backend in `./pg.js`. Everything in this file is importable
 * without a database driver — hosts of the HTTP backend and the server both
 * share the same validation and the same batch-patch fixpoint proof.
 *
 * The storage model is the anonymous-cookie owner (`owner_id` string, opaque).
 * There is deliberately NO owner-merge tombstone machinery here: identity
 * consolidation is a host concern, and the host can narrow reads/writes to the
 * final owner id before calling this store.
 */

export const USER_SKILL_LIMIT = 50;
export const USER_SKILL_CONTENT_MAX_BYTES = 65_536;
export const USER_SKILL_NAME_PATTERN = /^my-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type UserSkillErrorCode =
  | 'invalid-name'
  | 'invalid-title'
  | 'invalid-description'
  | 'invalid-content'
  | 'duplicate'
  | 'quota'
  /** No live Skill of this owner answers to the given id or handle. */
  | 'not-found'
  /** A patch op addressed a field that is not editable. */
  | 'invalid-path'
  /** A patch op was structurally wrong (missing/ill-typed argument). */
  | 'invalid-op'
  /** `str_replace` found neither its anchor nor its own post-state. */
  | 'anchor-not-found'
  /** `str_replace` without `replaceAll` matched more than once. */
  | 'anchor-ambiguous'
  /** Re-applying the whole batch to its own result would change it again. */
  | 'batch-not-idempotent'
  /** The result would contain a surrogate without its partner. */
  | 'unpaired-surrogate'
  /** The result would contain a character PG's `text` cannot store at all. */
  | 'unstorable-character';

export class UserSkillError extends Error {
  constructor(
    message: string,
    readonly code: UserSkillErrorCode,
  ) {
    super(message);
    this.name = 'UserSkillError';
  }
}

export interface UserSkillRecord {
  id: string;
  ownerId: string;
  name: string;
  title: string;
  description: string;
  content: string;
  version: 1;
  createdAt: Date;
  updatedAt: Date;
}

/** The three mutable fields, validated as a unit. */
export interface UserSkillFields {
  title: string;
  description: string;
  content: string;
}

/**
 * Fold a short label to one clean line.
 *
 * `title` and `description` are both single-line display strings that get echoed
 * back into TRUSTED prose — tool receipts, chat cards, prompt fragments — so a
 * newline or a bidi override inside one is never presentation, it is a way to
 * make user text look like it came from the system. Control characters and the
 * bidi/isolate range go the same way prompt sanitation handles them in the
 * runner, plus the marks it misses: U+061C, U+200E and U+200F also flip
 * direction. `content` is deliberately NOT folded, because it is long-form text
 * whose bytes must stay exact for anchors and which travels inside a fence.
 *
 * U+200B-200D are deliberately NOT stripped: U+200D is load-bearing inside emoji
 * sequences (a family emoji is joined by it), so folding it would corrupt titles
 * that are merely expressive rather than hostile.
 */
function collapseToSingleLine(value: string): string {
  return value
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Characters as PG's `length()` counts them: code points, not UTF-16 units. */
function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * THE storage normalization — the only transform between what an op computes and
 * what the row holds.
 *
 * Extracted so the replay simulation in `applyUserSkillPatchOps` can run on the
 * SAME values the database will hold. When the two disagreed, the fixpoint proof
 * was about a string that would never be stored: `[a→"a ", " "→"b "]` on `"a"`
 * produced `"ab "`, whose replay looked ambiguous and was waved through, while
 * the row actually held the TRIMMED `"ab"`, on which the replay succeeded and
 * appended again. Every field transform must live here, or that gap reopens.
 *
 * MUST STAY IDEMPOTENT: `normalize(normalize(x)) === normalize(x)`. The argument
 * that a row read from the database is already normalized — and therefore that
 * the simulation's first pass starts where the real replay starts — depends on
 * it. `normalize-idempotent` in the tests holds this.
 */
export function normalizeUserSkillFields(input: UserSkillFields): UserSkillFields {
  return {
    // `title` gets the same fold as `description`. The DB only bounds its LENGTH
    // (unlike description, which also has a `!~ '[\r\n]'` check), so without
    // this a title could carry newlines and pose as system text where it is echoed.
    title: collapseToSingleLine(input.title),
    description: collapseToSingleLine(input.description),
    // Only trimmed: the bytes in between are the user's prose and are what
    // patch anchors match against.
    content: input.content.trim(),
  };
}

export function validateUserSkillFields(input: {
  title: string;
  description: string;
  content: string;
}) {
  const { title, description, content } = normalizeUserSkillFields(input);
  // `title` and `description` are bounded by PG's `length()`, which counts
  // CHARACTERS (code points under UTF-8), while JS `.length` counts UTF-16 code
  // units. They disagree on everything outside the BMP: a title of 80 emoji is
  // 80 to PG and 160 to `.length`, so counting units would refuse a title the
  // column accepts. Measured against PG, not inferred.
  if (!title || codePointLength(title) > 80) {
    throw new UserSkillError(
      'Skill title must be non-empty and at most 80 characters.',
      'invalid-title',
    );
  }
  if (!description || codePointLength(description) > 500) {
    throw new UserSkillError(
      'Skill description must be non-empty and at most 500 characters.',
      'invalid-description',
    );
  }
  // `content` is different ON PURPOSE: its column constraint is
  // `octet_length(content) BETWEEN 1 AND 65536`, so that ceiling really is
  // BYTES. Chinese instructions are three bytes per character, so counting
  // characters here would let a ~22k-character skill pass and then fail in PG.
  if (!content || Buffer.byteLength(content, 'utf8') > USER_SKILL_CONTENT_MAX_BYTES) {
    throw new UserSkillError(
      'Skill instructions must be non-empty and at most 64 KiB.',
      'invalid-content',
    );
  }
  // The same storability gate the patch path applies to its result
  // (`applyUserSkillPatchOps`): a lone surrogate or a NUL is refused here
  // rather than reaching PG as a silent U+FFFD rewrite or an opaque database
  // error.
  assertStorableUserSkillFields({ title, description, content }, 'This Skill');
  return { title, description, content };
}

export function validateUserSkillInput(input: {
  name: string;
  title: string;
  description: string;
  content: string;
}) {
  const name = input.name.trim().toLowerCase();
  if (!USER_SKILL_NAME_PATTERN.test(name) || name.length > 64) {
    throw new UserSkillError(
      'Skill name must start with "my-", contain only lowercase letters, digits and single ' +
        'hyphens, and be at most 64 characters long.',
      'invalid-name',
    );
  }
  return { name, ...validateUserSkillFields(input) };
}

// ── Editing ───────────────────────────────────────────────────────────────────
//
// Editing exists because the create path is create-only. Three fields are
// editable and `name` deliberately is not — the
// handle is referenced by the session's `skillId`, by the SKILL.md read paths
// recorded in the durable pi transcript, and by the partial unique index, so a
// rename manufactures dangling references. Renaming means creating a new Skill.
// Deletion is a tombstone instead: old ids remain unavailable, while the partial
// unique index permits the owner to create a fresh row with the deleted handle.

/** The JSON Pointers a patch op may address. `/name` is excluded by design. */
export const USER_SKILL_EDITABLE_PATHS = ['/content', '/title', '/description'] as const;
export type UserSkillEditablePath = (typeof USER_SKILL_EDITABLE_PATHS)[number];

/**
 * A patch op as it arrives from the model — every field optional, because the
 * tool schema is a union flattened into one object. Structural checks happen in
 * `applyUserSkillPatchOps`.
 */
export interface UserSkillPatchOpInput {
  op: string;
  path?: string;
  value?: unknown;
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
}

export interface AppliedUserSkillOp {
  op: 'set' | 'str_replace';
  path: UserSkillEditablePath;
  /**
   * `already-applied` means the op's post-state was already in the stored text.
   * The runner delivers tool calls at least once, so a replayed `str_replace`
   * finds no anchor; that is success, not a failure.
   */
  status: 'applied' | 'already-applied';
}

function editablePath(raw: string | undefined, opLabel: string): UserSkillEditablePath {
  if (raw === '/name') {
    throw new UserSkillError(
      'Skill name (/name) is not editable: it is the handle referenced by sessions and ' +
        'history. To rename it, create a new Skill.',
      'invalid-path',
    );
  }
  if (!raw || !(USER_SKILL_EDITABLE_PATHS as readonly string[]).includes(raw)) {
    throw new UserSkillError(
      `${opLabel} path must be one of ${USER_SKILL_EDITABLE_PATHS.join(', ')}; got ${JSON.stringify(raw ?? null)}.`,
      'invalid-path',
    );
  }
  return raw as UserSkillEditablePath;
}

function pathFieldName(path: UserSkillEditablePath): keyof UserSkillFields {
  return path === '/content' ? 'content' : path === '/title' ? 'title' : 'description';
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** A surrogate code unit that lost its partner — unrepresentable in UTF-8. */
export function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * The storability gate every path that writes a row must pass. The create path
 * (`validateUserSkillFields`) and the patch path (`applyUserSkillPatchOps`)
 * share ONE check, so the same input fails the same way everywhere instead of
 * surfacing as an opaque database error or silently mangling stored text.
 *
 * PG is the last transform in the chain, and two inputs make it disagree with
 * what was computed:
 *
 *  - a LONE SURROGATE is silently rewritten to U+FFFD (measured, not assumed),
 *    which is irreversible damage to the user's text;
 *  - a NUL is rejected outright (`invalid byte sequence for encoding "UTF8"`),
 *    which would surface as an opaque database error.
 *
 * Everything else round-trips byte-for-byte, including tabs, newlines, emoji
 * and bidi marks, so `content` needs no further restriction.
 *
 * Runs on NORMALIZED fields, because that is exactly what the row will hold —
 * the patch path normalizes before this and the create path calls it after its
 * own normalization, so both refuse precisely the values the database would
 * receive.
 *
 * `subject` names the caller in the message ("This batch" from the patch path,
 * "This Skill" from the create path).
 */
function assertStorableUserSkillFields(fields: UserSkillFields, subject: string): void {
  for (const [label, value] of [
    ['title', fields.title],
    ['description', fields.description],
    ['content', fields.content],
  ] as const) {
    if (hasUnpairedSurrogate(value)) {
      throw new UserSkillError(
        `${subject} would leave ${label} with an incomplete character (half a surrogate pair); ` +
          'nothing was changed. A character was cut in half — e.g. using the high half of an emoji ' +
          'as an anchor or replacement. Use whole characters.',
        'unpaired-surrogate',
      );
    }
    if (value.includes('\u0000')) {
      throw new UserSkillError(
        `${subject} would leave ${label} with a NUL character the database cannot store; ` +
          'nothing was changed. Remove it.',
        'unstorable-character',
      );
    }
  }
}

/**
 * One mechanical pass of the batch. Knows nothing about replay: it validates
 * each op's arguments, resolves anchors, and splices. `applyUserSkillPatchOps`
 * wraps it with the two properties that decide whether the batch may land.
 *
 * Exported for the invariant test only. The wrapper swallows a `UserSkillError`
 * from the SECOND pass (a replay that errors is harmless), so which codes this
 * function can raise is load-bearing: if it could raise the batch-level codes,
 * that catch would silently admit a batch it should refuse. The test drives this
 * function directly and asserts it never raises them.
 */
export function applyOpsOnce(
  current: UserSkillFields,
  ops: readonly UserSkillPatchOpInput[],
): { fields: UserSkillFields; applied: AppliedUserSkillOp[] } {
  if (ops.length === 0) {
    throw new UserSkillError('patch_skill needs at least one op.', 'invalid-op');
  }
  const fields: UserSkillFields = { ...current };
  const applied: AppliedUserSkillOp[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]!;
    const label = `op ${index + 1} (${op.op})`;
    if (op.op === 'set') {
      const path = editablePath(op.path, label);
      if (typeof op.value !== 'string') {
        throw new UserSkillError(
          `${label} needs a string value; got ${op.value === undefined ? 'undefined' : typeof op.value}.`,
          'invalid-op',
        );
      }
      fields[pathFieldName(path)] = op.value;
      applied.push({ op: 'set', path, status: 'applied' });
      continue;
    }
    if (op.op !== 'str_replace') {
      throw new UserSkillError(
        `${label} is not a supported op; only set and str_replace are supported.`,
        'invalid-op',
      );
    }
    const path = editablePath(op.path, label);
    // str_replace is deliberately restricted to the long field. `title` and
    // `description` are one short line each, so `set` rewrites them exactly and
    // an anchor search over them buys nothing but another failure mode.
    if (path !== '/content') {
      throw new UserSkillError(
        `${label} only supports path "/content"; replace titles and descriptions with set.`,
        'invalid-path',
      );
    }
    if (typeof op.oldText !== 'string' || op.oldText === '') {
      throw new UserSkillError(`${label} needs a non-empty oldText.`, 'invalid-op');
    }
    if (typeof op.newText !== 'string') {
      throw new UserSkillError(
        `${label} needs a newText (pass an empty string to delete the anchor).`,
        'invalid-op',
      );
    }
    const field = pathFieldName(path);
    const before = fields[field];
    const hits = countOccurrences(before, op.oldText);
    if (hits === 0) {
      // A deletion's post-state is not verifiable. `newText === ''` is a
      // substring of every string, so "is newText already in place?" is
      // vacuously true and carries no evidence at all: a genuine replay and a
      // simply-wrong anchor are indistinguishable. Reporting success here would
      // make every typo'd deletion a silent no-op, so this fails loud. The cost
      // is that a truly replayed deletion also errors; the model re-reads the
      // source and sees the text is already gone.
      if (op.newText === '') {
        throw new UserSkillError(
          `${label} did not find oldText. A deletion (empty newText) cannot verify its ` +
            'post-state — an empty string is "already present" in every body, so a genuine ' +
            'replay and a wrong anchor are indistinguishable. Read the stored bytes with ' +
            'read_skill (detail:"source") first; if the passage is already gone, nothing to delete.',
          'anchor-not-found',
        );
      }
      // "Anchor gone, replacement present" is the shape a completed run of this
      // op leaves behind, so it is read as a replay. It is EVIDENCE, not proof —
      // see the accepted-limitation note on the patch path for the case where
      // this misjudges a concurrent edit.
      if (before.includes(op.newText)) {
        applied.push({ op: 'str_replace', path, status: 'already-applied' });
        continue;
      }
      throw new UserSkillError(
        `${label} did not find oldText, and newText is not in the body either; nothing was ` +
          'changed. Read the stored bytes with read_skill (detail:"source") first — the ' +
          'SKILL.md seen through the read tool carries extra preamble and is not a valid anchor source.',
        'anchor-not-found',
      );
    }
    // Several hits without an explicit `replaceAll` is ambiguous about WHICH
    // one was meant, and picking the first silently would also leave the rest
    // matching, so a replay could not tell the states apart either.
    if (hits > 1 && op.replaceAll !== true) {
      throw new UserSkillError(
        `${label} oldText matched ${hits} places; widen the anchor, or pass replaceAll: true explicitly.`,
        'anchor-ambiguous',
      );
    }
    // Spliced by index rather than via `String.prototype.replace`, which
    // interprets `$&`, `` $` ``, `$'` and `$<name>` in the REPLACEMENT even when
    // the pattern is a plain string. A skill body containing `$&` would
    // otherwise be stored as something other than what was asked for — and
    // `split`/`join` (the replaceAll branch) does not interpret them, so the two
    // branches would not even agree with each other.
    const at = before.indexOf(op.oldText);
    fields[field] =
      op.replaceAll === true
        ? before.split(op.oldText).join(op.newText)
        : before.slice(0, at) + op.newText + before.slice(at + op.oldText.length);
    applied.push({ op: 'str_replace', path, status: 'applied' });
  }
  return { fields, applied };
}

function sameFields(a: UserSkillFields, b: UserSkillFields): boolean {
  return a.title === b.title && a.description === b.description && a.content === b.content;
}

/**
 * Apply a patch batch in memory, admitting it only if it is safe to redeliver.
 * Pure: it never touches the database, so the caller can reject the whole batch
 * before a single write happens.
 *
 * Throws `UserSkillError` on the first failing op. That is the atomicity
 * mechanism — the store calls this INSIDE its transaction and before its
 * single UPDATE, so a batch whose second op fails leaves the first op's effect
 * only in this function's local copy.
 *
 * ── Why the rule is a BATCH FIXPOINT ────────────────────────────────────────
 *
 * The runner delivers at-least-once, so the unit that can be redelivered is the
 * WHOLE `patch_skill` call, and the property that matters is therefore a property
 * of the batch: applying it to its own result must change nothing. That is
 * checked directly — run the batch, run it again on the output, compare.
 *
 * Two earlier attempts were both per-op, and both were incomplete because they
 * reasoned about one op in isolation:
 *
 *  - `newText.includes(oldText)` guessed from the ARGUMENTS, and missed anchors
 *    that the splice boundary re-creates (`abbb` + ab→a = `abb`, still `ab`).
 *  - `after.includes(oldText)` fixed that but still looked at ONE op's result,
 *    so a batch whose LATER op rebuilds an EARLIER op's anchor slipped through:
 *    on `a`, the batch [a→b, b→aa] yields `aa`, and replaying it gives `aaaa`,
 *    doubling every time — while each op alone passes.
 *
 * The fixpoint check subsumes both (a self-matching single op cannot be a
 * fixpoint) and, unlike them, does not over-reject: `foo`→`foo` is a genuine
 * no-op, so it IS a fixpoint and is now allowed instead of being refused as
 * "self-matching".
 *
 * ── The simulation runs on STORED values ────────────────────────────────────
 *
 * Both passes are normalized with `normalizeUserSkillFields`, the same transform
 * the write path applies, and the second pass starts from the NORMALIZED first
 * result. Without that the proof was about a string that never reaches the row:
 * `[a→"a ", " "→"b "]` on `"a"` yields `"ab "`, whose replay looks ambiguous, so
 * the batch was admitted — but the row stores the trimmed `"ab"`, and replaying
 * on THAT succeeds and produces `"ab b"`. The mirror image also bit: `[a→b,
 * b→"b "]` was refused because `"b "` and `"b  "` differ, though both normalize
 * to `"b"` and the batch is perfectly storage-idempotent.
 *
 * ── Why "the second pass threw" now means "safe" ────────────────────────────
 *
 * `applyOpsOnce` is pure, and the second pass's input is now byte-identical to
 * what the row will hold, so a throw here is a SOUND PREDICTION that the real
 * redelivery throws too — and a throw writes nothing. That is what makes the
 * throw safe, and it is why the old code was wrong to treat `anchor-ambiguous`
 * as safe: not because ambiguity is special, but because it was predicting from
 * the wrong value. Reachable codes are `anchor-not-found` and
 * `anchor-ambiguous`; `invalid-op`/`invalid-path` depend only on the op
 * arguments, so pass 1 would already have thrown; every other code is raised by
 * this wrapper and not by `applyOpsOnce`. The error-code safety tests pin each
 * row.
 */
export function applyUserSkillPatchOps(
  current: UserSkillFields,
  ops: readonly UserSkillPatchOpInput[],
): { fields: UserSkillFields; applied: AppliedUserSkillOp[] } {
  const once = applyOpsOnce(current, ops);
  const first = { ...once, fields: normalizeUserSkillFields(once.fields) };
  // ── Storability, checked on the normalized result ────────────────────────
  //
  // PG is the last transform in the chain, and two inputs make it disagree with
  // what we computed. Both are refused here — by the SAME gate the create path
  // runs (`validateUserSkillFields`) — so the fixpoint below is reasoning about
  // a value that really can round-trip. See `assertStorableUserSkillFields`.
  assertStorableUserSkillFields(first.fields, 'This batch');
  let second: UserSkillFields;
  try {
    // Starts from `first.fields`, which IS the row's future content — so this
    // models the redelivery rather than an intermediate value.
    second = normalizeUserSkillFields(applyOpsOnce(first.fields, ops).fields);
  } catch (error) {
    // A replay that errors is acceptable: it changes nothing. Sound because the
    // input above is exactly what the replay will read.
    if (error instanceof UserSkillError) return first;
    throw error;
  }
  if (!sameFields(second, first.fields)) {
    throw new UserSkillError(
      'This batch would keep changing the text when replayed (applying it again to its own ' +
        'result produced different text); nothing was changed. The runner delivers at-least-once, ' +
        'so such a batch accumulates on every delivery. Widen the anchors so they no longer match ' +
        "after the replacement — note that a later op may rebuild an earlier op's anchor.",
      'batch-not-idempotent',
    );
  }
  return first;
}

export interface UserSkillPatchOutcome {
  skill: UserSkillRecord;
  applied: AppliedUserSkillOp[];
  /** False when every op was a replay: the row is untouched and `updated_at` is unchanged. */
  changed: boolean;
}

/**
 * The store surface a host binds a backend to.
 *
 * `ownerId` is the raw owner partition key. The store never resolves identity
 * chains itself; a host that consolidates identities must pass the FINAL owner
 * id (or narrow the lookup to it) before calling.
 */
export interface UserSkillStore {
  list(ownerId: string): Promise<UserSkillRecord[]>;
  find(id: string, ownerId: string): Promise<UserSkillRecord | null>;
  findByRef(ownerId: string, ref: string): Promise<UserSkillRecord | null>;
  create(
    ownerId: string,
    input: { name: string; title: string; description: string; content: string },
  ): Promise<UserSkillRecord>;
  /**
   * Soft-delete one live Skill in the owner's partition.
   *
   * Missing, already-deleted and foreign references all reject with the same
   * `not-found` error. The state transition is idempotent, but a retry after a
   * successful delete observes the tombstone and therefore reports not-found.
   * Because live-name uniqueness is enforced by a partial index, deletion frees
   * the handle for a new row owned by the same user.
   */
  delete(ownerId: string, ref: string): Promise<void>;
  patch(
    ownerId: string,
    ref: string,
    ops: readonly UserSkillPatchOpInput[],
  ): Promise<UserSkillPatchOutcome>;
}
