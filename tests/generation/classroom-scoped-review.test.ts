import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserRequirements } from "@openmaic/generation";
import {
  CLASSROOM_SCOPE_LEDGER_VERSION,
  CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS,
  createClassroomContentCallbacks,
  matchesClassroomContentProof,
  matchesClassroomScopeLedger,
  reviewClassroomContentScoped,
  type ClassroomReviewPacket,
  type ClassroomContentCallbacks,
  type ClassroomReviewCallContext,
} from "@/lib/server/classroom-content-review";

afterEach(() => vi.useRealTimers());

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const requirements: UserRequirements = {
  requirement:
    "Read the complete supplied source and distinguish simulation from execution.",
  codeContextRequired: true,
  codemateSource: {
    title: "Echo",
    content: "Read one line and output that line.",
    code: "x = input()\nprint(x)\n",
    correctedCode: "x = input()\nprint(x)\n",
    language: "Python",
    referenceValidation: { status: "unknown", scope: "not_supplied" },
  },
};
function material() {
  return {
    stage: { id: "stage", name: "complete context" },
    scenes: [
      {
        id: "slide",
        type: "slide",
        stageId: "stage",
        title: "Original",
        content: {
          type: "slide",
          canvas: {
            elements: [
              { id: "e", type: "text", content: "<p>Read a line.</p>" },
            ],
          },
        },
        actions: [{ id: "a", type: "speech", text: "old wording" }],
      },
      {
        id: "widget",
        type: "interactive",
        stageId: "stage",
        title: "Simulation",
        content: {
          type: "interactive",
          html: "<p>Static fixture, not executed.</p>",
        },
        actions: [],
      },
      {
        id: "quiz",
        type: "quiz",
        stageId: "stage",
        title: "Check",
        content: {
          type: "quiz",
          questions: [
            {
              id: "q",
              type: "single",
              question: "What is echoed?",
              options: [
                { value: "A", label: "The line" },
                { value: "B", label: "Nothing" },
              ],
              answer: ["A"],
              analysis: "The output is the input line.",
            },
          ],
        },
        actions: [],
      },
    ],
  };
}
function answer(
  packet: ClassroomReviewPacket,
  findings: unknown[] = [],
  extra = {},
) {
  const scope = packet.reviewScope!;
  return JSON.stringify({
    review_version: packet.binding.reviewVersion,
    source_digest: packet.binding.sourceDigest,
    material_digest: packet.binding.materialDigest,
    review_snapshot_digest: packet.binding.reviewSnapshotDigest,
    scope_version: scope.version,
    scope_id: scope.id,
    scope_kind: scope.kind,
    scope_digest: scope.digest,
    reviewed_scene_ids: scope.sceneIds,
    content_pass: findings.length === 0,
    findings,
    ...extra,
  });
}
function finding(
  packet: ClassroomReviewPacket,
  sceneId: string,
  path: string,
  critical = false,
) {
  const field = packet.fieldPathCatalog
    .find((s) => s.sceneId === sceneId)!
    .fields.find((f) => f.path === path)!;
  return {
    field_ref: field.fieldRef,
    reason: "A specific inconsistency.",
    required_change: "Correct that inconsistency.",
    kind: critical ? "code_logic" : "text",
    affects_code: critical,
    affects_root: false,
  };
}
function run(callbacks: ClassroomContentCallbacks, options = {}) {
  return reviewClassroomContentScoped({
    requirements: copy(requirements),
    material: material(),
    callbacks,
    expectedSceneCount: 3,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    ...options,
  });
}

describe("versioned local coverage and complete cross-scene review", () => {
  it.each([
    ["missing", undefined],
    ["non-string", 42],
    ["empty", ""],
    ["whitespace", " \n\t "],
  ])(
    "rejects %s interactive HTML before review or repair",
    async (_name, html) => {
      const invalid = material();
      const content = invalid.scenes[1].content as Record<string, unknown>;
      if (html === undefined) delete content.html;
      else content.html = html;
      const review = vi.fn(async (p: ClassroomReviewPacket) => answer(p));
      const repair = vi.fn();
      await expect(
        run({ review, repair }, { material: invalid }),
      ).rejects.toMatchObject({
        code: "material_incomplete",
      });
      expect(review).not.toHaveBeenCalled();
      expect(repair).not.toHaveBeenCalled();
    },
  );

  it("keeps full requirements, one complete scene per local scope, full cross material, and global refs", async () => {
    const packets: ClassroomReviewPacket[] = [];
    const result = await run({
      review: async (p) => {
        packets.push(p);
        return answer(p);
      },
    });
    expect(packets).toHaveLength(4);
    const locals = packets.filter((p) => p.reviewScope!.kind === "scene");
    const cross = packets.find((p) => p.reviewScope!.kind === "cross_scene")!;
    expect(locals.map((p) => p.reviewScope!.sceneIds)).toEqual([
      ["slide"],
      ["widget"],
      ["quiz"],
    ]);
    for (const p of packets) {
      expect(p.requirements).toEqual(requirements);
      expect(p.binding).toEqual(cross.binding);
      expect(Object.isFrozen(p)).toBe(true);
      expect(p.reviewScope!.version).toBe(CLASSROOM_SCOPE_LEDGER_VERSION);
    }
    expect(
      locals.map((p) => p.fieldPathCatalog[0].fields[0].fieldRef.slice(0, 6)),
    ).toEqual(["scene1", "scene2", "scene3"]);
    expect(cross.material).toEqual(material());
    expect(cross.fieldPathCatalog.flatMap((s) => s.fields)).toEqual(
      locals.flatMap((p) => p.fieldPathCatalog.flatMap((s) => s.fields)),
    );
    expect(
      matchesClassroomScopeLedger(requirements, result.material, result.ledger),
    ).toBe(true);
    expect(
      matchesClassroomContentProof(requirements, result.material, result.proof),
    ).toBe(true);
    expect(Object.keys(result.proof).sort()).toEqual([
      "binding",
      "contentPass",
      "findings",
      "schemaVersion",
      "scope",
    ]);
  });

  it.each([
    ["missing", (p: ClassroomReviewPacket) => ({ reviewed_scene_ids: [] })],
    [
      "duplicate",
      (p: ClassroomReviewPacket) => ({
        reviewed_scene_ids: [
          p.reviewScope!.sceneIds[0],
          p.reviewScope!.sceneIds[0],
        ],
      }),
    ],
    ["wrong", () => ({ reviewed_scene_ids: ["other"] })],
    ["old scope", () => ({ scope_version: "old" })],
    ["wrong digest", () => ({ scope_digest: "0".repeat(64) })],
    ["binding drift", () => ({ material_digest: "0".repeat(64) })],
  ])("rejects %s response coverage", async (_name, change) => {
    await expect(
      run({ review: async (p) => answer(p, [], change(p)) }),
    ).rejects.toBeDefined();
  });

  it("rejects missing/duplicate/wrong ledger entries and mutated source/material", async () => {
    const result = await run({ review: async (p) => answer(p) });
    const malformed = [
      { ...result.ledger, entries: result.ledger.entries.slice(1) },
      {
        ...result.ledger,
        entries: [
          ...result.ledger.entries.slice(0, -1),
          result.ledger.entries[0],
        ],
      },
      { ...result.ledger, version: "old" },
    ];
    for (const ledger of malformed)
      expect(
        matchesClassroomScopeLedger(
          requirements,
          result.material,
          ledger as typeof result.ledger,
        ),
      ).toBe(false);
    const changed = copy(result.material);
    changed.scenes[0].title = "changed";
    expect(
      matchesClassroomScopeLedger(requirements, changed, result.ledger),
    ).toBe(false);
    expect(
      matchesClassroomScopeLedger(
        { ...requirements, requirement: "changed" },
        result.material,
        result.ledger,
      ),
    ).toBe(false);
  });

  it("does not accept local passes when complete cross review finds a critical contradiction", async () => {
    const repair = vi.fn();
    let calls = 0;
    await expect(
      run({
        review: async (p) => {
          calls++;
          return answer(
            p,
            p.reviewScope!.kind === "cross_scene"
              ? [finding(p, "quiz", "/content/questions/0/answer/0", true)]
              : [],
          );
        },
        repair,
      }),
    ).rejects.toMatchObject({ code: "requires_regeneration" });
    expect(calls).toBe(4);
    expect(repair).not.toHaveBeenCalled();
  });

  it("retains false model findings instead of filtering them into a pass", async () => {
    await expect(
      run({
        review: async (p) =>
          answer(
            p,
            p.reviewScope!.sceneIds.includes("slide")
              ? [
                  {
                    ...finding(p, "slide", "/title"),
                    reason: "The statement is correct.",
                    required_change: "Keep it unchanged.",
                  },
                ]
              : [],
          ),
      }),
    ).rejects.toMatchObject({ code: "requires_regeneration" });
  });

  it("uses at most two concurrent local calls and completes all locals before critical rejection", async () => {
    let active = 0,
      peak = 0,
      completed = 0;
    const ids: string[] = [];
    const entries: Array<{ scope: { id: string }; findings: unknown[] }> = [];
    const repair = vi.fn();
    await expect(
      run(
        {
          review: async (p) => {
            ids.push(p.reviewScope!.id);
            peak = Math.max(peak, ++active);
            try {
              await Promise.resolve();
              return answer(
                p,
                p.reviewScope!.id === "scene:1"
                  ? [finding(p, "slide", "/title", true)]
                  : [],
              );
            } finally {
              active--;
              completed++;
            }
          },
          repair,
        },
        {
          recordScope: (entry: (typeof entries)[number]) => entries.push(entry),
        },
      ),
    ).rejects.toMatchObject({ code: "requires_regeneration" });
    expect(peak).toBe(2);
    expect(completed).toBe(3);
    expect(active).toBe(0);
    expect(ids).toEqual(["scene:1", "scene:2", "scene:3"]);
    expect(entries).toHaveLength(3);
    expect(
      entries.find((entry) => entry.scope.id === "scene:1")!.findings,
    ).toHaveLength(1);
    expect(repair).not.toHaveBeenCalled();
  });

  it("does not dispatch with an expired deadline or pre-aborted parent", async () => {
    const review = vi.fn();
    await expect(
      run({ review }, { deadlineAt: Date.now() - 1 }),
    ).rejects.toMatchObject({
      code: "review_timeout",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      run({ review }, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "review_timeout",
    });
    expect(review).not.toHaveBeenCalled();
  });

  it("propagates parent cancellation and rejects late/unavailable results without cross review", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = run(
      {
        review: async (_p, context) => {
          calls++;
          await new Promise<void>((resolve) =>
            context!.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          return "{}";
        },
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "review_timeout" });
    expect(calls).toBe(2);
    await expect(
      run({
        review: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toMatchObject({ code: "review_unavailable" });
  });

  it("rejects no-op repair and never calls another review round", async () => {
    let reviews = 0;
    await expect(
      run({
        review: async (p) => {
          reviews++;
          return answer(
            p,
            p.reviewScope!.kind === "scene" &&
              p.reviewScope!.sceneIds[0] === "slide"
              ? [finding(p, "slide", "/actions/0/text")]
              : [],
          );
        },
        repair: async (p) =>
          JSON.stringify({
            review_version: p.binding.reviewVersion,
            source_digest: p.binding.sourceDigest,
            material_digest: p.binding.materialDigest,
            review_snapshot_digest: p.binding.reviewSnapshotDigest,
            patches: [
              { field_ref: p.findings[0].fieldRef, new_text: "old wording" },
            ],
          }),
      }),
    ).rejects.toMatchObject({ code: "repair_invalid" });
    expect(reviews).toBe(4);
  });

  it("invalidates the complete ledger after a permitted repair and rechecks all scopes (nine calls max)", async () => {
    const packets: ClassroomReviewPacket[] = [];
    let repairs = 0;
    const result = await run({
      review: async (p) => {
        packets.push(p);
        return answer(
          p,
          p.binding.reportVersion === 1 &&
            p.reviewScope!.kind === "scene" &&
            p.reviewScope!.sceneIds[0] === "slide"
            ? [finding(p, "slide", "/actions/0/text")]
            : [],
        );
      },
      repair: async (p) => {
        repairs++;
        expect(p.material).toEqual(material());
        expect(p.reviewScope).toBeUndefined();
        return JSON.stringify({
          review_version: p.binding.reviewVersion,
          source_digest: p.binding.sourceDigest,
          material_digest: p.binding.materialDigest,
          review_snapshot_digest: p.binding.reviewSnapshotDigest,
          patches: [
            {
              field_ref: p.findings[0].fieldRef,
              new_text: "New accurate wording.",
            },
          ],
        });
      },
    });
    expect(packets).toHaveLength(8);
    expect(repairs).toBe(1);
    expect(packets.length + repairs).toBe(9);
    expect(result.ledger.binding.reportVersion).toBe(2);
    expect(packets[0].reviewScope!.digest).not.toBe(
      packets[4].reviewScope!.digest,
    );
    expect(
      matchesClassroomScopeLedger(requirements, result.material, result.ledger),
    ).toBe(true);
  });

  it("preserves local and cross findings for one ref while requiring only one exact patch", async () => {
    let repairs = 0;
    const result = await run({
      review: async (p) =>
        answer(
          p,
          p.binding.reportVersion === 1 &&
            p.reviewScope!.sceneIds.includes("slide")
            ? [finding(p, "slide", "/actions/0/text")]
            : [],
        ),
      repair: async (p) => {
        repairs++;
        expect(p.findings).toHaveLength(2);
        expect(p.findings[0].fieldRef).toBe(p.findings[1].fieldRef);
        return JSON.stringify({
          review_version: p.binding.reviewVersion,
          source_digest: p.binding.sourceDigest,
          material_digest: p.binding.materialDigest,
          review_snapshot_digest: p.binding.reviewSnapshotDigest,
          patches: [
            {
              field_ref: p.findings[0].fieldRef,
              new_text: "One necessary correction.",
            },
          ],
        });
      },
    });
    expect(repairs).toBe(1);
    expect(result.material.scenes[0].actions[0].text).toBe(
      "One necessary correction.",
    );
    expect(result.ledger.entries).toHaveLength(4);
  });

  it("public helper supplies scoped schema and unchanged full input to the actual structured seam", async () => {
    const calls: Array<{ system: string; packet: ClassroomReviewPacket }> = [];
    const callbacks = createClassroomContentCallbacks(
      async () => {
        throw new Error("legacy path");
      },
      {
        structuredCall: async (system, user, schema, context) => {
          const p = JSON.parse(user) as ClassroomReviewPacket;
          expect(context!.signal).toBeInstanceOf(AbortSignal);
          const raw = answer(p);
          expect((await schema.validate!(JSON.parse(raw))).success).toBe(true);
          expect(
            (
              await schema.validate!({
                ...JSON.parse(raw),
                scope_digest: "bad",
              })
            ).success,
          ).toBe(false);
          calls.push({ system, packet: p });
          return raw;
        },
      },
    );
    await run(callbacks);
    expect(calls).toHaveLength(4);
    expect(
      calls.every(
        (c) =>
          c.system.includes("scope_version") &&
          c.system.includes("cross_scene"),
      ),
    ).toBe(true);
  });
});

function cancelledCallback(
  context: ClassroomReviewCallContext,
): Promise<string> {
  return new Promise((_resolve, reject) => {
    context.signal.addEventListener(
      "abort",
      () => reject(context.signal.reason),
      { once: true },
    );
  });
}
const longDeadline = () => ({ deadlineAt: Date.now() + 1800000 });
// Algorithm-only test allowance for four sequential timeout waves. This does
// not change the production 720-second job limit, which is tested below.
const retryAlgorithmDeadline = () => ({
  deadlineAt: Date.now() + CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS * 4 + 10_000,
});

describe("bounded retries only after an actual request timeout", () => {
  it("retries one settled cancellation with identical packet/schema and retains a complete ledger", async () => {
    vi.useFakeTimers();
    const calls: Array<{
      id: string;
      system: string;
      user: string;
      schema: string;
      signal: AbortSignal;
    }> = [];
    let firstSettled = false;
    let active = 0,
      peak = 0;
    const callbacks = createClassroomContentCallbacks(
      async () => {
        throw new Error("legacy");
      },
      {
        structuredCall: async (system, user, schema, context) => {
          const packet = JSON.parse(user) as ClassroomReviewPacket;
          const id = packet.reviewScope!.id;
          calls.push({
            id,
            system,
            user,
            schema: JSON.stringify(schema.jsonSchema),
            signal: context!.signal,
          });
          peak = Math.max(peak, ++active);
          try {
            if (
              id === "scene:1" &&
              calls.filter((c) => c.id === id).length === 1
            ) {
              try {
                return await cancelledCallback(context!);
              } finally {
                firstSettled = true;
              }
            }
            if (id === "scene:1") expect(firstSettled).toBe(true);
            return answer(packet);
          } finally {
            active--;
          }
        },
      },
    );
    const pending = run(callbacks, longDeadline());
    const completion = expect(pending).resolves.toMatchObject({
      ledger: { entries: expect.any(Array) },
    });
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS);
    await completion;
    const result = await pending;
    const attempts = calls.filter((c) => c.id === "scene:1");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].system).toBe(attempts[0].system);
    expect(attempts[1].user).toBe(attempts[0].user);
    expect(attempts[1].schema).toBe(attempts[0].schema);
    expect(attempts[0].signal.aborted).toBe(true);
    expect(attempts[1].signal).not.toBe(attempts[0].signal);
    expect(calls).toHaveLength(5);
    expect(peak).toBe(2);
    expect(result.ledger.entries).toHaveLength(4);
    expect(
      matchesClassroomScopeLedger(requirements, result.material, result.ledger),
    ).toBe(true);
  });

  it("stops after a second request timeout of the same bound scope", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          return p.reviewScope!.id === "scene:1"
            ? cancelledCallback(context!)
            : answer(p);
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({
      code: "review_timeout",
    });
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS * 2);
    await completion;
    expect(ids.filter((id) => id === "scene:1")).toHaveLength(2);
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain("cross:complete");
  });

  it("does not retry when the remaining job cannot contain another request and cancellation cleanup", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          return p.reviewScope!.id === "scene:1"
            ? cancelledCallback(context!)
            : answer(p);
        },
      },
      { deadlineAt: Date.now() + CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS * 2 },
    );
    const completion = expect(pending).rejects.toMatchObject({
      code: "review_timeout",
    });
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS);
    await completion;
    expect(ids.filter((id) => id === "scene:1")).toHaveLength(1);
    expect(ids).toHaveLength(3);
  });

  it("does not retry parent cancellation even though the callback settles with AbortError", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const review = vi.fn(
      async (_p: ClassroomReviewPacket, context?: ClassroomReviewCallContext) =>
        cancelledCallback(context!),
    );
    const pending = run(
      { review },
      { ...longDeadline(), signal: parent.signal },
    );
    const completion = expect(pending).rejects.toMatchObject({
      code: "review_timeout",
    });
    parent.abort(new DOMException("parent stopped", "AbortError"));
    await completion;
    await vi.advanceTimersByTimeAsync(
      CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS + 10_000,
    );
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("does not cancel healthy local siblings when another local has a critical finding", async () => {
    const ids: string[] = [];
    let completed = 0;
    const repair = vi.fn();
    await expect(
      run(
        {
          review: async (p, context) => {
            ids.push(p.reviewScope!.id);
            await Promise.resolve();
            expect(context!.signal.aborted).toBe(false);
            completed++;
            return answer(
              p,
              p.reviewScope!.id === "scene:2"
                ? [finding(p, "widget", "/title", true)]
                : [],
            );
          },
          repair,
        },
        longDeadline(),
      ),
    ).rejects.toMatchObject({ code: "requires_regeneration" });
    expect(ids).toEqual(["scene:1", "scene:2", "scene:3"]);
    expect(completed).toBe(3);
    expect(repair).not.toHaveBeenCalled();
  });

  it("does not retry a callback that ignores cancellation and reaches the request-plus-cleanup guard", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p) => {
          ids.push(p.reviewScope!.id);
          return p.reviewScope!.id === "scene:1"
            ? new Promise<string>(() => {})
            : answer(p);
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({
      code: "review_timeout",
    });
    await vi.advanceTimersByTimeAsync(
      CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS + 10_000,
    );
    await completion;
    expect(ids.filter((id) => id === "scene:1")).toHaveLength(1);
    expect(ids).toHaveLength(3);
  });

  it("does not trust an arbitrary TimeoutError before its own request deadline", async () => {
    const ids: string[] = [];
    await expect(
      run(
        {
          review: async (p) => {
            ids.push(p.reviewScope!.id);
            if (p.reviewScope!.id === "scene:1")
              throw new DOMException("untrusted", "TimeoutError");
            return answer(p);
          },
        },
        longDeadline(),
      ),
    ).rejects.toMatchObject({ code: "review_unavailable" });
    expect(ids.filter((id) => id === "scene:1")).toHaveLength(1);
  });

  it.each(["schema", "binding", "critical"] as const)(
    "never retries a %s response",
    async (kind) => {
      const ids: string[] = [];
      const repair = vi.fn();
      await expect(
        run(
          {
            review: async (p) => {
              ids.push(p.reviewScope!.id);
              if (p.reviewScope!.id !== "scene:1") return answer(p);
              if (kind === "schema") return "{}";
              if (kind === "binding")
                return answer(p, [], { material_digest: "0".repeat(64) });
              return answer(p, [finding(p, "slide", "/title", true)]);
            },
            repair,
          },
          longDeadline(),
        ),
      ).rejects.toBeDefined();
      expect(ids.filter((id) => id === "scene:1")).toHaveLength(1);
      expect(repair).not.toHaveBeenCalled();
    },
  );

  it("does not spend a repair when a prior retry leaves fewer than five complete-round callbacks", async () => {
    vi.useFakeTimers();
    let slideCalls = 0;
    const ids: string[] = [];
    const repair = vi.fn();
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          if (p.reviewScope!.id === "scene:1" && ++slideCalls === 1)
            return cancelledCallback(context!);
          return answer(
            p,
            p.reviewScope!.id === "scene:1"
              ? [finding(p, "slide", "/actions/0/text")]
              : [],
          );
        },
        repair,
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({
      code: "requires_regeneration",
    });
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS);
    await completion;
    expect(ids).toHaveLength(5);
    expect(repair).not.toHaveBeenCalled();
  });

  it("counts repair and both rounds together and does not spend the reserved cross call on a retry", async () => {
    vi.useFakeTimers();
    const packets: ClassroomReviewPacket[] = [];
    let repairs = 0;
    const pending = run(
      {
        review: async (p, context) => {
          packets.push(p);
          if (p.binding.reportVersion === 2 && p.reviewScope!.id === "scene:1")
            return cancelledCallback(context!);
          return answer(
            p,
            p.binding.reportVersion === 1 && p.reviewScope!.id === "scene:1"
              ? [finding(p, "slide", "/actions/0/text")]
              : [],
          );
        },
        repair: async (p) => {
          repairs++;
          return JSON.stringify({
            review_version: p.binding.reviewVersion,
            source_digest: p.binding.sourceDigest,
            material_digest: p.binding.materialDigest,
            review_snapshot_digest: p.binding.reviewSnapshotDigest,
            patches: [
              {
                field_ref: p.findings[0].fieldRef,
                new_text: "New accurate wording.",
              },
            ],
          });
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({
      code: "review_timeout",
    });
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS);
    await completion;
    expect(repairs).toBe(1);
    expect(
      packets.filter(
        (p) => p.binding.reportVersion === 2 && p.reviewScope!.id === "scene:1",
      ),
    ).toHaveLength(1);
    expect(packets.length + repairs).toBe(8);
    expect(packets.length + repairs).toBeLessThanOrEqual(9);
    expect(
      packets.filter(
        (p) =>
          p.binding.reportVersion === 2 &&
          p.reviewScope!.kind === "cross_scene",
      ),
    ).toHaveLength(0);
  });

  it("rejects source drift before spending a retry after the original request settles", async () => {
    vi.useFakeTimers();
    const external = copy(requirements);
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          if (p.reviewScope!.id !== "scene:1") return answer(p);
          return new Promise<string>((_resolve, reject) => {
            context!.signal.addEventListener(
              "abort",
              () => {
                external.requirement = "changed while the request was pending";
                reject(context!.signal.reason);
              },
              { once: true },
            );
          });
        },
      },
      { ...longDeadline(), requirements: external },
    );
    const completion = expect(pending).rejects.toMatchObject({
      code: "binding_mismatch",
    });
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS);
    await completion;
    expect(ids.filter((id) => id === "scene:1")).toHaveLength(1);
    expect(ids).toHaveLength(3);
  });

  it("does not reinterpret a schema error near its own cancellation as a transient timeout", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          if (p.reviewScope!.id !== "scene:1") return answer(p);
          return new Promise<string>((_resolve, reject) => {
            context!.signal.addEventListener(
              "abort",
              () => {
                const error = new Error("invalid output schema");
                error.name = "AI_NoObjectGeneratedError";
                reject(error);
              },
              { once: true },
            );
          });
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).rejects.toMatchObject({
      code: "review_unavailable",
    });
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS);
    await completion;
    expect(ids.filter((id) => id === "scene:1")).toHaveLength(1);
  });

  it("can retry the original complete cross packet without accepting only local passes", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          const id = p.reviewScope!.id;
          ids.push(id);
          if (
            id === "cross:complete" &&
            ids.filter((value) => value === id).length === 1
          )
            return cancelledCallback(context!);
          return answer(p);
        },
      },
      longDeadline(),
    );
    const completion = expect(pending).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS);
    await completion;
    const result = await pending;
    expect(ids.filter((id) => id === "cross:complete")).toHaveLength(2);
    expect(ids).toHaveLength(5);
    expect(result.ledger.entries).toHaveLength(4);
    expect(
      matchesClassroomScopeLedger(requirements, result.material, result.ledger),
    ).toBe(true);
  });

  it("keeps all four per-scope retries inside the shared callback ceiling and full ledger", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const pending = run(
      {
        review: async (p, context) => {
          const id = p.reviewScope!.id;
          ids.push(id);
          if (ids.filter((value) => value === id).length === 1)
            return cancelledCallback(context!);
          return answer(p);
        },
      },
      retryAlgorithmDeadline(),
    );
    const completion = expect(pending).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS * 3);
    await completion;
    const result = await pending;
    expect(ids).toHaveLength(8);
    for (const id of ["scene:1", "scene:2", "scene:3", "cross:complete"])
      expect(ids.filter((value) => value === id)).toHaveLength(2);
    expect(result.ledger.entries).toHaveLength(4);
    expect(
      matchesClassroomScopeLedger(requirements, result.material, result.ledger),
    ).toBe(true);
  });
  it("fails closed at the unchanged production 720-second deadline before incomplete full cross review", async () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    const large = material();
    // Six local shard requests occupy three waves; the full cross request then
    // starts with only 3 seconds left in the unchanged 720-second job budget.
    for (const scene of large.scenes) scene.title = "L".repeat(13_000);
    const pending = run(
      {
        review: async (p, context) => {
          ids.push(p.reviewScope!.id);
          return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
              () => resolve(answer(p)),
              CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS - 1_000,
            );
            context!.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(context!.signal.reason);
              },
              { once: true },
            );
          });
        },
      },
      { ...longDeadline(), material: large },
    );
    const completion = expect(pending).rejects.toMatchObject({
      code: "review_timeout",
    });
    await vi.advanceTimersByTimeAsync(1800000);
    await completion;
    expect(ids).toHaveLength(7);
    expect(ids.filter((id) => id === "cross:complete")).toHaveLength(1);
    expect(ids.length).toBeLessThanOrEqual(9);
  });
});

describe("explicit catalog targets retain all required dependencies", () => {
  function dependencyClassroom() {
    const value = material();
    const widget = value.scenes[1];
    widget.content = {
      type: "interactive",
      html: '<div id="state">ready</div><!--' + "context ".repeat(2000) + "-->",
    };
    widget.actions = Array.from({ length: 90 }, (_, index) => ({
      id: `dependency-${index}`,
      type: "speech",
      text:
        index === 0
          ? "The initial state node says idle."
          : `Supporting statement ${index}.`,
    }));
    return value;
  }

  it("supplies out-of-catalog HTML and source when reviewing an action that depends on them", async () => {
    const value = dependencyClassroom();
    let dependentTargetReviewed = false;
    let crossSeen = false;
    const callbacks = createClassroomContentCallbacks(
      async () => {
        throw new Error("legacy");
      },
      {
        structuredCall: async (system, user) => {
          const p = JSON.parse(user) as ClassroomReviewPacket;
          const fields = p.fieldPathCatalog[0].fields;
          const actionShard =
            p.reviewScope!.kind === "scene" &&
            p.reviewScope!.sceneIds[0] === "widget" &&
            fields.some((f) => f.path === "/actions/0/text") &&
            !fields.some((f) => f.path === "/content/html");
          if (actionShard) {
            expect(p.material).toEqual({
              ...value,
              scenes: [value.scenes[1]],
            });
            expect(p.requirements).toEqual(requirements);
            expect(system).toContain(
              "fieldPathCatalog 的全部目标字段及其必要依赖",
            );
            expect(system).toContain("这些必要依赖必须读全");
            expect(system).toContain("不得改报为本片字段的缺陷");
            dependentTargetReviewed = true;
          }
          if (p.reviewScope!.kind === "cross_scene") {
            expect(p.material).toEqual(value);
            expect(system).toContain(
              "kind=cross_scene 必须重新检查所附完整原始课堂和跨场景一致性",
            );
            crossSeen = true;
          }
          return answer(p);
        },
      },
    );
    const result = await run(callbacks, { material: value });
    expect(dependentTargetReviewed).toBe(true);
    expect(crossSeen).toBe(true);
    expect(result.material).toEqual(value);
    expect(
      matchesClassroomScopeLedger(requirements, result.material, result.ledger),
    ).toBe(true);
  });

  it("assigns the independent HTML target only to its own shard and rejects a foreign target", async () => {
    const value = dependencyClassroom();
    const packets: ClassroomReviewPacket[] = [];
    await run(
      {
        review: async (p) => {
          packets.push(p);
          return answer(p);
        },
      },
      { material: value },
    );
    const widgetPackets = packets.filter(
      (p) =>
        p.reviewScope!.kind === "scene" &&
        p.reviewScope!.sceneIds[0] === "widget",
    );
    const owners = widgetPackets.filter((p) =>
      p.fieldPathCatalog[0].fields.some((f) => f.path === "/content/html"),
    );
    expect(owners).toHaveLength(1);
    expect(widgetPackets).toHaveLength(2);
    const htmlRef = owners[0].fieldPathCatalog[0].fields.find(
      (f) => f.path === "/content/html",
    )!.fieldRef;
    const targetPacket = widgetPackets.find(
      (p) =>
        !p.fieldPathCatalog[0].fields.some((f) => f.path === "/content/html"),
    )!;
    const allFields = widgetPackets.flatMap(
      (p) => p.fieldPathCatalog[0].fields,
    );
    expect(new Set(allFields.map((f) => f.fieldRef)).size).toBe(
      allFields.length,
    );
    await expect(
      run(
        {
          review: async (p) =>
            answer(
              p,
              p.reviewScope!.digest === targetPacket.reviewScope!.digest
                ? [
                    {
                      field_ref: htmlRef,
                      reason:
                        "An independent HTML problem belongs to the HTML owner.",
                      required_change:
                        "Correct the HTML in its own assigned field.",
                      kind: "fact",
                      affects_code: false,
                      affects_root: false,
                    },
                  ]
                : [],
            ),
        },
        { material: value },
      ),
    ).rejects.toMatchObject({ code: "review_unavailable" });
  });
});

describe("semantic shard partition preserves complete original review coverage", () => {
  async function capture(value: ReturnType<typeof material>) {
    const packets: ClassroomReviewPacket[] = [];
    const result = await run(
      {
        review: async (p) => {
          packets.push(p);
          return answer(p);
        },
      },
      { material: value },
    );
    const cross = packets.find((p) => p.reviewScope!.kind === "cross_scene")!;
    expect(cross.material).toEqual(value);
    for (const packet of packets) {
      expect(packet.requirements).toEqual(requirements);
      expect(packet.binding).toEqual(cross.binding);
      if (packet.reviewScope!.kind === "scene") {
        const scene = value.scenes.find((s) => s.id === packet.reviewScope!.sceneIds[0])!;
        expect(packet.material).toEqual({ ...value, scenes: [scene] });
      }
    }
    for (const entry of cross.fieldPathCatalog) {
      const local = packets.filter((p) => p.reviewScope!.kind === "scene" && p.reviewScope!.sceneIds[0] === entry.sceneId);
      const localFields = local.flatMap((p) => p.fieldPathCatalog[0].fields);
      expect(localFields.map((f) => f.fieldRef).sort()).toEqual(entry.fields.map((f) => f.fieldRef).sort());
      expect(new Set(localFields.map((f) => f.fieldRef)).size).toBe(entry.fields.length);
      for (const p of local) {
        const refs = new Set(p.fieldPathCatalog[0].fields.map((f) => f.fieldRef));
        expect(p.fieldPathCatalog[0].fields).toEqual(entry.fields.filter((f) => refs.has(f.fieldRef)));
      }
    }
    expect(matchesClassroomScopeLedger(requirements, result.material, result.ledger)).toBe(true);
    return { packets, cross, result };
  }

  function splitSlide() {
    const value = material();
    value.scenes[0].content = {
      type: "slide",
      canvas: {
        elements: Array.from({ length: 32 }, (_, i) => ({
          id: `element-${i}`,
          type: i % 2 ? "shape" : "text",
          content: `Original visible or unknown element content ${i}`,
          fill: "#abcdef",
        })),
      },
    };
    return value;
  }

  it("keeps title, speech and text-element targets together without dropping unknown or presentation fields", async () => {
    const value = splitSlide();
    const { packets, cross, result } = await capture(value);
    const local = packets.filter((p) => p.reviewScope!.kind === "scene" && p.reviewScope!.sceneIds[0] === "slide");
    expect(local).toHaveLength(2);
    const paths = local[0].fieldPathCatalog[0].fields.map((f) => f.path);
    expect(paths).toContain("/title");
    expect(paths).toContain("/actions/0/text");
    expect(paths).toContain("/content/canvas/elements/0/content");
    expect(paths).not.toContain("/content/canvas/elements/1/content");
    expect(paths).not.toContain("/content/canvas/elements/0/fill");
    expect(local[1].fieldPathCatalog[0].fields.map((f) => f.path)).toContain("/content/canvas/elements/1/content");
    expect(local[0].reviewScope!.viewDigest).toBe(local[1].reviewScope!.viewDigest);
    expect(local[0].reviewScope!.catalogDigest).not.toBe(local[1].reviewScope!.catalogDigest);
    expect(packets).toHaveLength(5);
    expect(cross.fieldPathCatalog[0].fields.length).toBeGreaterThan(80);
    const stale = copy(result.ledger);
    stale.entries.find((entry) => entry.scope.kind === "scene" && entry.scope.sceneIds[0] === "slide")!.requestDigests!.reverse();
    expect(matchesClassroomScopeLedger(requirements, result.material, stale)).toBe(false);
  });

  it("isolates the indivisible HTML target while retaining full HTML/source dependencies in both packets", async () => {
    const value = splitSlide();
    const html = '<div data-state="unchanged"><script>const preserved = "dependency";</script>' + "x".repeat(13_000) + "</div>";
    value.scenes[1].content = { type: "interactive", html };
    value.scenes[1].actions = [{ id: "linked-action", type: "speech", text: "Describe the same unchanged HTML state." }];
    const { packets } = await capture(value);
    const local = packets.filter((p) => p.reviewScope!.kind === "scene" && p.reviewScope!.sceneIds[0] === "widget");
    expect(local).toHaveLength(2);
    expect(local[0].fieldPathCatalog[0].fields.map((f) => f.path)).toEqual(["/content/html"]);
    expect(local[1].fieldPathCatalog[0].fields.map((f) => f.path)).toContain("/actions/0/text");
    for (const p of local) expect((p.material as unknown as typeof value).scenes[0].content.html).toBe(html);
    // Same five local requests plus complete cross review as the existing large-scene policy.
    expect(packets).toHaveLength(6);
  });

  it.each(["unrecognized scene category", "empty semantic category"])(
    "retains midpoint fallback for %s without losing any target",
    async (kind) => {
      const value = material();
      const scene = value.scenes[0];
      scene.title = "";
      scene.actions = [];
      scene.content = {
        type: "slide",
        canvas: {
          elements: Array.from({ length: 32 }, (_, i) => ({ id: `unknown-${i}`, type: "shape", content: `Unknown ${i}`, fill: "#123456" })),
        },
      };
      if (kind === "unrecognized scene category") {
        scene.type = "pbl";
        scene.content.type = "pbl";
      }
      const { packets, cross } = await capture(value);
      const expected = cross.fieldPathCatalog.find((entry) => entry.sceneId === "slide")!.fields;
      const local = packets.filter((p) => p.reviewScope!.kind === "scene" && p.reviewScope!.sceneIds[0] === "slide");
      expect(local).toHaveLength(2);
      const mid = Math.ceil(expected.length / 2);
      expect(local[0].fieldPathCatalog[0].fields).toEqual(expected.slice(0, mid));
      expect(local[1].fieldPathCatalog[0].fields).toEqual(expected.slice(mid));
    },
  );

  it("collects actual findings from both semantic groups before rejecting critical material", async () => {
    const value = splitSlide();
    const refs: string[] = [];
    const recorded: Array<{ findings: Array<{ fieldRef: string }> }> = [];
    let crossStarted = false;
    await expect(run({
      review: async (p) => {
        if (p.reviewScope!.kind === "cross_scene") crossStarted = true;
        if (p.reviewScope!.kind === "scene" && p.reviewScope!.sceneIds[0] === "slide") {
          const target = p.fieldPathCatalog[0].fields[0];
          refs.push(target.fieldRef);
          return answer(p, [finding(p, "slide", target.path, true)]);
        }
        return answer(p);
      },
    }, {
      material: value,
      recordScope: (entry: { findings: Array<{ fieldRef: string }> }) => recorded.push(entry),
    })).rejects.toMatchObject({ code: "requires_regeneration" });
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    expect(recorded.flatMap((entry) => entry.findings.map((f) => f.fieldRef)).sort()).toEqual(refs.sort());
    expect(crossStarted).toBe(false);
  });
});

describe("original shard trigger boundaries remain unchanged", () => {
  it.each([12 * 1024, 12 * 1024 + 1])("preserves the scene-byte split boundary at %i bytes", async (bytes) => {
    const value = material();
    const slide = value.scenes[0];
    slide.title = "";
    slide.title = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(slide)));
    expect(Buffer.byteLength(JSON.stringify(slide))).toBe(bytes);
    const packets: ClassroomReviewPacket[] = [];
    await run({ review: async (p) => { packets.push(p); return answer(p); } }, { material: value });
    expect(packets.filter((p) => p.reviewScope!.kind === "scene" && p.reviewScope!.sceneIds[0] === "slide")).toHaveLength(bytes <= 12 * 1024 ? 1 : 2);
  });

  it.each([80, 81])("preserves the catalog split boundary at %i fields", async (count) => {
    const value = material();
    const slide = value.scenes[0] as unknown as Record<string, unknown>;
    const strings = (node: unknown): number => {
      if (typeof node === "string") return node.trim() ? 1 : 0;
      if (node && typeof node === "object") return Object.values(node).reduce<number>((n, child) => n + strings(child), 0);
      return 0;
    };
    slide.extra = Object.fromEntries(Array.from({ length: count - strings(slide) }, (_, i) => [`field-${i}`, "v"]));
    expect(strings(slide)).toBe(count);
    expect(Buffer.byteLength(JSON.stringify(slide))).toBeLessThan(12 * 1024);
    const packets: ClassroomReviewPacket[] = [];
    await run({ review: async (p) => { packets.push(p); return answer(p); } }, { material: value });
    const cross = packets.find((p) => p.reviewScope!.kind === "cross_scene")!;
    expect(cross.fieldPathCatalog[0].fields).toHaveLength(count);
    expect(packets.filter((p) => p.reviewScope!.kind === "scene" && p.reviewScope!.sceneIds[0] === "slide")).toHaveLength(count <= 80 ? 1 : 2);
  });
});
