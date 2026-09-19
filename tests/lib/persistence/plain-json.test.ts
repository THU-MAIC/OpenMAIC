import { describe, expect, it } from 'vitest';

import { omitUndefinedObjectMembers } from '@/lib/persistence/plain-json';

describe('omitUndefinedObjectMembers', () => {
  it('omits nested optional object members without mutating app state', () => {
    const source = {
      content: {
        projectV2: {
          milestones: [
            {
              microtasks: [{ id: 'mt-1', internalAssessment: undefined }],
            },
          ],
        },
      },
    };

    const canonical = omitUndefinedObjectMembers(source);

    expect(canonical).toEqual({
      content: {
        projectV2: {
          milestones: [{ microtasks: [{ id: 'mt-1' }] }],
        },
      },
    });
    expect(source.content.projectV2.milestones[0]!.microtasks[0]).toHaveProperty(
      'internalAssessment',
      undefined,
    );
  });

  it('omits undefined runtime event members', () => {
    expect(
      omitUndefinedObjectMembers({
        event: {
          kind: 'message_created',
          actorType: 'user',
          actorRoleId: undefined,
        },
      }),
    ).toEqual({
      event: {
        kind: 'message_created',
        actorType: 'user',
      },
    });
  });

  it('preserves values that strict storage validation must reject', () => {
    class Example {
      constructor(readonly value: string) {}
    }

    const date = new Date('2026-01-01T00:00:00.000Z');
    const map = new Map([['key', 'value']]);
    const instance = new Example('value');
    const source = {
      date,
      map,
      instance,
      arrayUndefined: [undefined],
      sparse: new Array(1),
    };

    const canonical = omitUndefinedObjectMembers(source);

    expect(canonical.date).toBe(date);
    expect(canonical.map).toBe(map);
    expect(canonical.instance).toBe(instance);
    expect(canonical.arrayUndefined).toEqual([undefined]);
    expect(Object.hasOwn(canonical.sparse, 0)).toBe(false);
  });
});
