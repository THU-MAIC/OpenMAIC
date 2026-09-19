import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const imageFilesMock = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    imageFiles: imageFilesMock,
  },
}));

import {
  extractOriginalImageId,
  loadImageMapping,
  loadPdfBlob,
  storeImages,
  storePdfBlob,
} from '@/lib/utils/image-storage';

class TestFileReader {
  result: string | ArrayBuffer | null = null;
  onloadend: FileReader['onloadend'] = null;
  onerror: FileReader['onerror'] = null;

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onloadend?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>);
      },
      () => {
        this.onerror?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>);
      },
    );
  }
}

function bytesOf(buffer: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(buffer));
}

beforeAll(() => {
  vi.stubGlobal('FileReader', TestFileReader);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  imageFilesMock.get.mockReset();
  imageFilesMock.put.mockReset();
  imageFilesMock.delete.mockReset();
});

describe('image file persistence', () => {
  it('stores a PDF as an ArrayBuffer with its exact metadata', async () => {
    const bytes = [0x25, 0x50, 0x44, 0x46, 0x01, 0xff];
    const file = new File([Uint8Array.from(bytes)], 'lesson.pdf', {
      type: 'application/pdf',
    });

    const storageKey = await storePdfBlob(file);

    expect(imageFilesMock.put).toHaveBeenCalledOnce();
    const record = imageFilesMock.put.mock.calls[0][0];
    expect(record.id).toBe(storageKey);
    expect(record.blob).toBeInstanceOf(ArrayBuffer);
    expect(bytesOf(record.blob)).toEqual(bytes);
    expect(record.mimeType).toBe('application/pdf');
    expect(record.filename).toBe('lesson.pdf');
    expect(record.size).toBe(record.blob.byteLength);
  });

  it('stores a page image as an ArrayBuffer with its decoded bytes and MIME type', async () => {
    const bytes = [0x00, 0x01, 0x02, 0xfd, 0xfe];
    const src = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;

    await storeImages([{ id: 'img_1', src, pageNumber: 1 }]);

    expect(imageFilesMock.put).toHaveBeenCalledOnce();
    const record = imageFilesMock.put.mock.calls[0][0];
    expect(record.blob).toBeInstanceOf(ArrayBuffer);
    expect(bytesOf(record.blob)).toEqual(bytes);
    expect(record.mimeType).toBe('image/jpeg');
    expect(record.size).toBe(record.blob.byteLength);
  });

  it('loads an ArrayBuffer PDF record as a Blob with exact bytes and MIME type', async () => {
    const bytes = [0x25, 0x50, 0x44, 0x46, 0x02];
    imageFilesMock.get.mockResolvedValue({
      blob: Uint8Array.from(bytes).buffer,
      mimeType: 'application/pdf',
    });

    const blob = await loadPdfBlob('pdf-key');

    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('application/pdf');
    expect(bytesOf(await blob!.arrayBuffer())).toEqual(bytes);
  });

  it('returns a legacy typed Blob unchanged', async () => {
    const legacyBlob = new Blob([Uint8Array.from([1, 2, 3])], { type: 'application/pdf' });
    imageFilesMock.get.mockResolvedValue({
      blob: legacyBlob,
      mimeType: 'application/pdf',
    });

    await expect(loadPdfBlob('legacy-pdf')).resolves.toBe(legacyBlob);
  });

  it('reconstructs a legacy empty-type Blob with the record MIME type and exact bytes', async () => {
    const bytes = [3, 1, 4, 1, 5];
    const legacyBlob = new Blob([Uint8Array.from(bytes)]);
    imageFilesMock.get.mockResolvedValue({
      blob: legacyBlob,
      mimeType: 'application/pdf',
    });

    const blob = await loadPdfBlob('legacy-empty-type-pdf');

    expect(blob).toBeInstanceOf(Blob);
    expect(blob).not.toBe(legacyBlob);
    expect(blob?.type).toBe('application/pdf');
    expect(bytesOf(await blob!.arrayBuffer())).toEqual(bytes);
  });

  it('loads an ArrayBuffer page-image record as an exact data URL mapping', async () => {
    const bytes = [0xde, 0xad, 0xbe, 0xef];
    imageFilesMock.get.mockResolvedValue({
      blob: Uint8Array.from(bytes).buffer,
      mimeType: 'image/webp',
    });

    await expect(loadImageMapping(['session_abc123def4_img_1'])).resolves.toEqual({
      img_1: `data:image/webp;base64,${Buffer.from(bytes).toString('base64')}`,
    });
  });

  it('rolls back every earlier image when a later write fails and preserves the cause', async () => {
    const writeFailure = new Error('IndexedDB write failed');
    imageFilesMock.put
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(writeFailure);
    imageFilesMock.delete.mockResolvedValue(undefined);
    const images = [
      { id: 'img_1', src: 'data:image/png;base64,AQ==' },
      { id: 'img_2', src: 'data:image/png;base64,Ag==' },
      { id: 'img_3', src: 'data:image/png;base64,Aw==' },
    ];

    const result = storeImages(images);

    await expect(result).rejects.toMatchObject({
      message: 'Failed to store image bundle at image img_3',
      cause: writeFailure,
    });
    const successfulIds = imageFilesMock.put.mock.calls.slice(0, 2).map(([record]) => record.id);
    expect(imageFilesMock.delete.mock.calls.map(([id]) => id)).toEqual(successfulIds);
  });
});

describe('extractOriginalImageId', () => {
  it('extracts an image id from a normal session storage id', () => {
    expect(extractOriginalImageId('session_abc123def4_img_15')).toBe('img_15');
  });

  it('does not truncate a nanoid containing underscores', () => {
    expect(extractOriginalImageId('session_ab_cd_efgh_img_20')).toBe('img_20');
  });

  it('preserves nonnumeric image ids', () => {
    expect(extractOriginalImageId('session_abc123def4_img_data')).toBe('img_data');
  });

  it('preserves image ids containing an image-like delimiter', () => {
    expect(extractOriginalImageId('session_abc123def4_hero_img_1')).toBe('hero_img_1');
  });

  it('rejects malformed storage ids', () => {
    expect(extractOriginalImageId('session_abc123')).toBeUndefined();
    expect(extractOriginalImageId('session_abc123def4_')).toBeUndefined();
    expect(extractOriginalImageId('other_abc123def4_img_1')).toBeUndefined();
  });
});
