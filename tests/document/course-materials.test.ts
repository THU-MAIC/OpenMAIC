import { describe, expect, it } from 'vitest';

import {
  courseMaterialFingerprint,
  dedupeCourseMaterialFiles,
} from '@/lib/document/course-materials';
import type { SelectedCourseMaterial } from '@/lib/types/generation';

function fileOf(name: string, content: string, lastModified: number): File {
  return new File([content], name, { type: 'text/plain', lastModified });
}

function material(file: File, id: string): SelectedCourseMaterial {
  return {
    id,
    file,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
    order: 1,
  };
}

describe('courseMaterialFingerprint', () => {
  it('is stable for the same name, size, and lastModified', () => {
    const a = fileOf('lesson.pdf', 'same bytes', 1_700_000_000_000);
    const b = fileOf('lesson.pdf', 'same bytes', 1_700_000_000_000);
    expect(courseMaterialFingerprint(a)).toBe(courseMaterialFingerprint(b));
  });

  it('changes when the name changes', () => {
    expect(courseMaterialFingerprint(fileOf('a.pdf', 'x', 1000))).not.toBe(
      courseMaterialFingerprint(fileOf('b.pdf', 'x', 1000)),
    );
  });

  it('changes when the size changes', () => {
    expect(courseMaterialFingerprint(fileOf('a.pdf', 'x', 1000))).not.toBe(
      courseMaterialFingerprint(fileOf('a.pdf', 'xy', 1000)),
    );
  });

  it('changes when lastModified changes', () => {
    expect(courseMaterialFingerprint(fileOf('a.pdf', 'x', 1000))).not.toBe(
      courseMaterialFingerprint(fileOf('a.pdf', 'x', 1001)),
    );
  });

  it('also fingerprints an existing SelectedCourseMaterial by the same fields', () => {
    const file = fileOf('a.pdf', 'x', 1000);
    expect(courseMaterialFingerprint(material(file, 'm1'))).toBe(courseMaterialFingerprint(file));
  });
});

describe('dedupeCourseMaterialFiles', () => {
  it('drops incoming files already present in the existing list', () => {
    const existing = fileOf('a.pdf', 'x', 1000);
    const incoming = fileOf('a.pdf', 'x', 1000);
    expect(dedupeCourseMaterialFiles([material(existing, 'm1')], [incoming])).toEqual([]);
  });

  it('drops duplicates within a single incoming batch', () => {
    const one = fileOf('a.pdf', 'x', 1000);
    const two = fileOf('a.pdf', 'x', 1000);
    const other = fileOf('b.pdf', 'y', 2000);
    expect(dedupeCourseMaterialFiles([], [one, two, other])).toEqual([one, other]);
  });

  it('keeps distinct files even when only one field differs', () => {
    const one = fileOf('a.pdf', 'x', 1000);
    const two = fileOf('a.pdf', 'x', 1001);
    expect(dedupeCourseMaterialFiles([], [one, two])).toEqual([one, two]);
  });
});
