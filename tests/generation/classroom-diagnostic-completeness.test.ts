import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserRequirements } from "@openmaic/generation";
import {
  CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS,
  ClassroomContentReviewError,
  matchesClassroomContentProof,
  matchesClassroomScopeLedger,
  reviewClassroomContentScoped,
  type ClassroomReviewPacket,
  type ClassroomContentCallbacks,
  type ClassroomScopeEntry,
} from "@/lib/server/classroom-content-review";

afterEach(() => vi.useRealTimers());
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const requirements: UserRequirements = {
  requirement:
    "Review this source-bound classroom without changing supplied material.",
  codeContextRequired: true,
  codemateSource: {
    title: "Echo",
    content: "Read one line and output the same line.",
    code: "x = input()\nprint(x)\n",
    correctedCode: "x = input()\nprint(x)\n",
    language: "Python",
    referenceValidation: { status: "unknown", scope: "not_supplied" },
  },
};
function material(shards = false, count = 3) {
  const pad = shards
    ? "A source-bound explanation. ".repeat(520)
    : "An explanation.";
  return {
    stage: { id: "stage", name: "source-bound" },
    scenes: Array.from({ length: count }, (_, i) => ({
      id: `slide-${i}`,
      type: "slide",
      stageId: "stage",
      title: `Title ${i}`,
      content: {
        type: "slide",
        canvas: {
          elements: [
            { id: `e${i}`, type: "text", content: "<p>Read a line.</p>" },
          ],
        },
      },
      actions: [{ id: `a${i}`, type: "speech", text: pad }],
    })),
  };
}
function answer(p: ClassroomReviewPacket, findings: unknown[] = []) {
  const s = p.reviewScope!;
  return JSON.stringify({
    review_version: p.binding.reviewVersion,
    source_digest: p.binding.sourceDigest,
    material_digest: p.binding.materialDigest,
    review_snapshot_digest: p.binding.reviewSnapshotDigest,
    scope_version: s.version,
    scope_id: s.id,
    scope_kind: s.kind,
    scope_digest: s.digest,
    reviewed_scene_ids: s.sceneIds,
    content_pass: findings.length === 0,
    findings,
  });
}
function row(
  p: ClassroomReviewPacket,
  path?: string,
  changes: Record<string, unknown> = {},
) {
  const field = path
    ? p.fieldPathCatalog[0].fields.find((f) => f.path === path)!
    : p.fieldPathCatalog[0].fields[0];
  expect(field).toBeDefined();
  return {
    field_ref: field.fieldRef,
    reason: "The supplied statement has one concrete discrepancy.",
    required_change: "Correct the stated boundary.",
    kind: "fact",
    affects_code: false,
    affects_root: false,
    ...changes,
  };
}
function repairAnswer(
  p: Parameters<NonNullable<ClassroomContentCallbacks["repair"]>>[0],
  newText: string,
) {
  return JSON.stringify({
    review_version: p.binding.reviewVersion,
    source_digest: p.binding.sourceDigest,
    material_digest: p.binding.materialDigest,
    review_snapshot_digest: p.binding.reviewSnapshotDigest,
    patches: [{ field_ref: p.findings[0].fieldRef, new_text: newText }],
  });
}
function run(
  m: ReturnType<typeof material>,
  callbacks: ClassroomContentCallbacks,
  recordScope?: (e: ClassroomScopeEntry) => void,
  options = {},
) {
  return reviewClassroomContentScoped({
    requirements: copy(requirements),
    material: m,
    callbacks,
    expectedSceneCount: m.scenes.length,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 1800000,
    recordScope,
    ...options,
  });
}

describe("complete local diagnosis before immutable critical rejection", () => {
  it("collects every local packet after early critical, then rejects without cross or repair", async () => {
    const ids: string[] = [],
      entries: ClassroomScopeEntry[] = [];
    const repair = vi.fn();
    const original = material(true);
    await expect(
      run(
        original,
        {
          review: async (p) => {
            ids.push(p.reviewScope!.id);
            return answer(
              p,
              p.reviewScope!.id === "scene:1#1"
                ? [row(p, undefined, { kind: "root", affects_root: true })]
                : [],
            );
          },
          repair,
        },
        (e) => entries.push(e),
      ),
    ).rejects.toMatchObject({ code: "requires_regeneration" });
    expect(ids).toEqual([
      "scene:1#1",
      "scene:2#1",
      "scene:3#1",
      "scene:1#2",
      "scene:2#2",
      "scene:3#2",
    ]);
    expect(entries.map((e) => e.scope.id).sort()).toEqual([
      "scene:1",
      "scene:2",
      "scene:3",
    ]);
    expect(entries.every((e) => e.requestDigests!.length === 2)).toBe(true);
    expect(
      entries.find((e) => e.scope.id === "scene:1")!.findings[0].affectsRoot,
    ).toBe(true);
    expect(repair).not.toHaveBeenCalled();
    expect(original).toEqual(material(true));
  });

  it("retains distributed defects and two different defects on the same field", async () => {
    const entries: ClassroomScopeEntry[] = [];
    await expect(
      run(
        material(true),
        {
          review: async (p) => {
            const id = p.reviewScope!.id;
            if (id === "scene:1#1")
              return answer(p, [
                row(p, undefined, {
                  kind: "root",
                  affects_root: true,
                  reason: "Concrete defect A.",
                }),
                row(p, undefined, {
                  kind: "root",
                  affects_root: true,
                  reason: "Different concrete defect B.",
                }),
              ]);
            if (id === "scene:2#2")
              return answer(p, [
                row(p, undefined, {
                  kind: "code_logic",
                  affects_code: true,
                  reason: "Displayed code omits required output.",
                }),
              ]);
            if (id === "scene:3#1")
              return answer(p, [
                row(p, undefined, {
                  kind: "fact",
                  reason:
                    "Calculation line is incorrectly called the output line.",
                }),
              ]);
            return answer(p);
          },
        },
        (e) => entries.push(e),
      ),
    ).rejects.toMatchObject({ code: "requires_regeneration" });
    expect(entries.flatMap((e) => e.findings).map((f) => f.reason)).toEqual([
      "Concrete defect A.",
      "Different concrete defect B.",
      "Displayed code omits required output.",
      "Calculation line is incorrectly called the output line.",
    ]);
    expect(
      entries
        .flatMap((e) => e.findings)
        .filter((f) => f.affectsCode || f.affectsRoot),
    ).toHaveLength(3);
  });

  it("uses an idle worker for another part while that same scene has a slow first part", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ids: string[] = [],
      entries: ClassroomScopeEntry[] = [];
    let active = 0,
      peak = 0;
    const pending = run(
      material(true),
      {
        review: async (p) => {
          const id = p.reviewScope!.id;
          ids.push(id);
          peak = Math.max(peak, ++active);
          try {
            if (id === "scene:1#1") await barrier;
            return answer(p);
          } finally {
            active--;
          }
        },
      },
      (e) => entries.push(e),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const secondPartStartedBeforeFirstEnded = ids.includes("scene:1#2");
    const incompleteSceneAlreadyRecorded = entries.some(
      (e) => e.scope.id === "scene:1",
    );
    release();
    const result = await pending;
    expect(secondPartStartedBeforeFirstEnded).toBe(true);
    expect(incompleteSceneAlreadyRecorded).toBe(false);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(
      result.ledger.entries.find((e) => e.scope.id === "scene:1")!
        .requestDigests,
    ).toHaveLength(2);
  });

  it("keeps a correct classroom unchanged and waits for all locals before full cross", async () => {
    const ids: string[] = [],
      entries: ClassroomScopeEntry[] = [];
    const original = material(true);
    const result = await run(
      original,
      {
        review: async (p) => {
          ids.push(p.reviewScope!.id);
          if (p.reviewScope!.kind === "cross_scene")
            expect(entries).toHaveLength(3);
          return answer(p);
        },
      },
      (e) => entries.push(e),
    );
    expect(ids).toHaveLength(7);
    expect(ids.at(-1)).toBe("cross:complete");
    expect(result.material).toEqual(original);
    expect(
      matchesClassroomScopeLedger(requirements, result.material, result.ledger),
    ).toBe(true);
    expect(
      matchesClassroomContentProof(requirements, result.material, result.proof),
    ).toBe(true);
  });

  it("still records and immediately rejects a critical complete cross response", async () => {
    const entries: ClassroomScopeEntry[] = [];
    const repair = vi.fn();
    await expect(
      run(
        material(),
        {
          review: async (p) =>
            answer(
              p,
              p.reviewScope!.kind === "cross_scene"
                ? [row(p, "/title", { affects_code: true, kind: "code_logic" })]
                : [],
            ),
          repair,
        },
        (e) => entries.push(e),
      ),
    ).rejects.toMatchObject({ code: "requires_regeneration" });
    expect(entries).toHaveLength(4);
    expect(entries.at(-1)!.scope.kind).toBe("cross_scene");
    expect(entries.at(-1)!.findings[0].affectsCode).toBe(true);
    expect(repair).not.toHaveBeenCalled();
  });

  it("does not fabricate a completed scene when a later same-scene part has invalid schema", async () => {
    const entries: ClassroomScopeEntry[] = [],
      ids: string[] = [];
    const settled = await run(
      material(true, 1),
      {
        review: async (p) => {
          ids.push(p.reviewScope!.id);
          return p.reviewScope!.id === "scene:1#1"
            ? answer(p, [
                row(p, undefined, { kind: "root", affects_root: true }),
              ])
            : "{}";
        },
      },
      (e) => entries.push(e),
    ).then(
      () => ({ code: "unexpected_success" }),
      (error) => ({ code: error.code }),
    );
    expect(settled.code).toBe("review_unavailable");
    expect(ids).toEqual(["scene:1#1", "scene:1#2"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].scope.id).toBe("scene:1#1");
    expect(entries[0].requestDigests).toEqual([entries[0].scope.digest]);
    expect(entries[0].contentPass).toBe(false);
    expect(entries[0].findings[0].affectsRoot).toBe(true);
    expect(entries.some((e) => e.scope.id === "scene:1")).toBe(false);
  });

  it("a later ordinary timeout remains a safety failure, even with a completed critical scene", async () => {
    vi.useFakeTimers();
    const entries: ClassroomScopeEntry[] = [],
      ids: string[] = [];
    const pending = run(
      material(true),
      {
        review: async (p, context) => {
          const id = p.reviewScope!.id;
          ids.push(id);
          if (id === "scene:2#1")
            return new Promise<string>((_resolve, reject) =>
              context!.signal.addEventListener(
                "abort",
                () => reject(context!.signal.reason),
                { once: true },
              ),
            );
          return answer(
            p,
            id === "scene:1#1"
              ? [row(p, undefined, { kind: "root", affects_root: true })]
              : [],
          );
        },
      },
      (e) => entries.push(e),
    ).then(
      () => ({ code: "unexpected_success" }),
      (error) => ({ code: error.code }),
    );
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS * 2);
    expect((await pending).code).toBe("review_timeout");
    expect(ids).not.toContain("cross:complete");
    expect(ids.filter((id) => id === "scene:2#1")).toHaveLength(2);
    expect(
      entries.find((e) => e.scope.id === "scene:1")!.findings[0].affectsRoot,
    ).toBe(true);
    expect(entries.filter((e) => e.scope.id === "scene:1")).toHaveLength(1);
    expect(entries.some((e) => e.scope.id === "scene:1#1")).toBe(false);
  });

  it("still bounds seven required packets plus two shared retries to nine callbacks", async () => {
    const seen = new Map<string, number>(),
      ids: string[] = [];
    const result = await run(material(true), {
      review: async (p) => {
        const id = p.reviewScope!.id,
          n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        ids.push(id);
        return answer(
          p,
          ["scene:1#1", "scene:2#1"].includes(id) && n === 1
            ? [row(p, undefined, { required_change: "无需修改。" })]
            : [],
        );
      },
    });
    expect(ids).toHaveLength(9);
    expect([...seen.values()].every((n) => n <= 2)).toBe(true);
    expect(
      matchesClassroomScopeLedger(requirements, result.material, result.ledger),
    ).toBe(true);
  });

  it("invalidates all old scopes after one permitted repair and keeps the seven-call bound", async () => {
    const versions: number[] = [],
      repair = vi.fn(async (p) => repairAnswer(p, "Necessary new title"));
    const result = await run(material(true, 1), {
      review: async (p) => {
        versions.push(p.binding.reportVersion);
        const target =
          p.reviewScope!.kind === "scene" &&
          p.fieldPathCatalog[0].fields.some((f) => f.path === "/title");
        return answer(
          p,
          target && p.binding.reportVersion === 1
            ? [row(p, "/title", { kind: "text" })]
            : [],
        );
      },
      repair,
    });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(versions).toEqual([1, 1, 1, 2, 2, 2]);
    expect(result.ledger.binding.reportVersion).toBe(2);
    expect(
      matchesClassroomScopeLedger(requirements, result.material, result.ledger),
    ).toBe(true);
  });

  it("does not start a new round after repair increases its required packet count beyond budget", async () => {
    const versions: number[] = [],
      repair = vi.fn(async (p) =>
        repairAnswer(p, "Expanded description ".repeat(700)),
      );
    await expect(
      run(material(), {
        review: async (p) => {
          versions.push(p.binding.reportVersion);
          return answer(
            p,
            p.reviewScope!.id === "scene:1" && p.binding.reportVersion === 1
              ? [row(p, "/title", { kind: "text" })]
              : [],
          );
        },
        repair,
      }),
    ).rejects.toMatchObject({ code: "content_unresolved" });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(versions).toEqual([1, 1, 1, 1]);
  });
  it.each(["schema", "binding"])(
    "ordinary %s failure cancels active siblings and stops queued work",
    async (kind) => {
      const ids: string[] = [],
        entries: ClassroomScopeEntry[] = [];
      let aborted = false;
      const result = await run(
        material(true),
        {
          review: async (p, context) => {
            ids.push(p.reviewScope!.id);
            if (p.reviewScope!.id === "scene:1#1") {
              if (kind === "schema") return "{}";
              const invalid = JSON.parse(answer(p));
              invalid.scope_digest = "0".repeat(64);
              return JSON.stringify(invalid);
            }
            return new Promise<string>((_resolve, reject) => {
              const stop = () => {
                aborted = true;
                reject(context!.signal.reason);
              };
              if (context!.signal.aborted) stop();
              else
                context!.signal.addEventListener("abort", stop, { once: true });
            });
          },
        },
        (e) => entries.push(e),
      ).then(
        () => ({ code: "unexpected_success" }),
        (error) => ({ code: error.code }),
      );
      expect(result.code).toBe(
        kind === "schema" ? "review_unavailable" : "binding_mismatch",
      );
      expect(ids.length).toBeLessThanOrEqual(2);
      expect(ids).not.toContain("cross:complete");
      expect(aborted).toBe(true);
      expect(entries).toHaveLength(0);
    },
  );

  it("does not dispatch any packet when its parent is already cancelled", async () => {
    const parent = new AbortController();
    parent.abort();
    const review = vi.fn();
    await expect(
      run(material(true), { review }, undefined, { signal: parent.signal }),
    ).rejects.toMatchObject({ code: "review_timeout" });
    expect(review).not.toHaveBeenCalled();
  });

  it("rejects source drift rather than using previously captured review evidence", async () => {
    const mutable = copy(requirements),
      ids: string[] = [];
    const result = await run(
      material(true),
      {
        review: async (p) => {
          ids.push(p.reviewScope!.id);
          mutable.requirement = "changed after snapshot";
          return answer(p);
        },
      },
      undefined,
      { requirements: mutable },
    ).then(
      () => ({ code: "unexpected_success" }),
      (error) => ({ code: error.code }),
    );
    expect(result.code).toBe("binding_mismatch");
    expect(ids.length).toBeLessThanOrEqual(2);
    expect(ids).not.toContain("cross:complete");
  });

  it("retains completed partial critical evidence after same-scene timeout without changing the timeout", async () => {
    vi.useFakeTimers();
    const entries: ClassroomScopeEntry[] = [];
    const pending = run(
      material(true, 1),
      {
        review: async (p, context) => {
          if (p.reviewScope!.id === "scene:1#1")
            return answer(p, [
              row(p, undefined, { kind: "root", affects_root: true }),
            ]);
          return new Promise<string>((_resolve, reject) =>
            context!.signal.addEventListener(
              "abort",
              () => reject(context!.signal.reason),
              { once: true },
            ),
          );
        },
      },
      (e) => entries.push(e),
    ).then(
      () => ({ code: "unexpected_success" }),
      (error) => ({ code: error.code }),
    );
    await vi.advanceTimersByTimeAsync(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS * 2);
    expect((await pending).code).toBe("review_timeout");
    expect(entries).toHaveLength(1);
    expect(entries[0].scope.id).toBe("scene:1#1");
    expect(entries[0].requestDigests).toEqual([entries[0].scope.digest]);
    expect(entries[0].findings[0].affectsRoot).toBe(true);
  });

  it("retains noncritical partial findings and does not invent a partial pass for empty findings", async () => {
    for (const withFinding of [true, false]) {
      const entries: ClassroomScopeEntry[] = [];
      await expect(
        run(
          material(true, 1),
          {
            review: async (p) =>
              p.reviewScope!.id === "scene:1#1"
                ? answer(p, withFinding ? [row(p)] : [])
                : "{}",
          },
          (e) => entries.push(e),
        ),
      ).rejects.toMatchObject({ code: "review_unavailable" });
      expect(entries).toHaveLength(withFinding ? 1 : 0);
      if (withFinding) {
        expect(entries[0].scope.id).toBe("scene:1#1");
        expect(entries[0].contentPass).toBe(false);
      }
    }
  });

  it("preserves the original review error if writing a partial diagnostic throws", async () => {
    const result = await run(
      material(true, 1),
      {
        review: async (p) =>
          p.reviewScope!.id === "scene:1#1"
            ? answer(p, [
                row(p, undefined, { kind: "root", affects_root: true }),
              ])
            : "{}",
      },
      () => {
        throw new Error("diagnostic sink failed");
      },
    ).then(
      () => ({ code: "unexpected_success" }),
      (error) => ({ code: error.code, message: error.message }),
    );
    expect(result.code).toBe("review_unavailable");
  });

  it("preserves the exact primary error object when failed-path diagnostic recording throws", async () => {
    const original = new ClassroomContentReviewError("binding_mismatch");
    let recorded = 0;
    const pending = run(
      material(true, 1),
      {
        review: async (p) => {
          if (p.reviewScope!.id === "scene:1#1")
            return answer(p, [
              row(p, undefined, { kind: "root", affects_root: true }),
            ]);
          await new Promise((resolve) => setImmediate(resolve));
          throw original;
        },
      },
      () => {
        recorded++;
        throw new Error("secondary recorder failure");
      },
    );
    await expect(pending).rejects.toBe(original);
    expect(recorded).toBe(1);
  });

  it("does not swallow recordScope errors during normal successful scene recording", async () => {
    const recorderError = new Error("normal-path recorder failure");
    const pending = run(material(), { review: async (p) => answer(p) }, () => {
      throw recorderError;
    });
    await expect(pending).rejects.toBe(recorderError);
  });
});
