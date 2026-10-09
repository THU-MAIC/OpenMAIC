import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import {
  buildStoredZip,
  crc32,
  isSafeArchivePath,
  STORED_ZIP_MAX_BYTES,
  STORED_ZIP_MAX_ENTRIES,
} from '@/lib/export/standalone-html/stored-zip';

const bytesOf = (text: string) => new TextEncoder().encode(text);

describe('crc32', () => {
  it('matches the standard check value and composes across chunks', () => {
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    const whole = bytesOf('The quick brown fox jumps over the lazy dog');
    expect(crc32(whole.subarray(10), crc32(whole.subarray(0, 10)))).toBe(crc32(whole));
    expect(crc32(whole)).toBe(0x414fa339);
  });
});

describe('isSafeArchivePath', () => {
  it('accepts plain relative paths only', () => {
    expect(isSafeArchivePath('classroom.html')).toBe(true);
    expect(isSafeArchivePath('media/asset-1.mp4')).toBe(true);
    expect(isSafeArchivePath('audio/中文.mp3')).toBe(true);
    for (const unsafe of [
      '',
      '/etc/passwd',
      '../x',
      'a/../../x',
      'a/./b',
      'a//b',
      'a/',
      'a\\b',
      'C:/x',
      'a\u0000b',
    ]) {
      expect(isSafeArchivePath(unsafe), unsafe).toBe(false);
    }
  });
});

describe('buildStoredZip', () => {
  it('writes stored entries any ZIP reader extracts with matching CRCs', async () => {
    const media = new Uint8Array(70_000).map((_, index) => (index * 31) & 0xff);
    const zipBlob = await buildStoredZip(
      [
        { path: 'classroom.html', data: new Blob(['<!doctype html>']) },
        { path: 'README.txt', data: '\uFEFF先解压\r\nExtract first\r\n' },
        { path: 'media/clip.mp4', data: new Blob([media], { type: 'video/mp4' }) },
        { path: 'audio/empty.mp3', data: new Blob([]) },
      ],
      { date: new Date(2026, 9, 8, 13, 45, 30) },
    );
    expect(zipBlob.type).toBe('application/zip');
    const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer(), { checkCRC32: true });
    expect(Object.keys(zip.files)).toEqual([
      'classroom.html',
      'README.txt',
      'media/clip.mp4',
      'audio/empty.mp3',
    ]);
    expect(await zip.file('classroom.html')!.async('string')).toBe('<!doctype html>');
    expect(await zip.file('README.txt')!.async('string')).toBe('\uFEFF先解压\r\nExtract first\r\n');
    expect(await zip.file('media/clip.mp4')!.async('uint8array')).toEqual(media);
    expect((await zip.file('audio/empty.mp3')!.async('uint8array')).length).toBe(0);
    // DOS times carry no zone; JSZip reads them as UTC fields.
    const date = zip.file('media/clip.mp4')!.date;
    expect([date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()]).toEqual([2026, 9, 8]);
    expect([date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]).toEqual([13, 45, 30]);
    // Stored: the archive is the data plus headers, nothing compressed away.
    const headers = 4 * (30 + 46) + 22;
    const names = ['classroom.html', 'README.txt', 'media/clip.mp4', 'audio/empty.mp3'];
    const nameBytes = names.reduce((sum, name) => sum + 2 * bytesOf(name).length, 0);
    const dataBytes = 15 + bytesOf('\uFEFF先解压\r\nExtract first\r\n').length + media.length;
    expect(zipBlob.size).toBe(headers + nameBytes + dataBytes);
  });

  it('flags names as UTF-8 and records Unix file permissions', async () => {
    const zipBlob = await buildStoredZip([{ path: 'audio/中文.mp3', data: 'x' }]);
    const view = new DataView(await zipBlob.arrayBuffer());
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(8, true)).toBe(0); // stored
    const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['audio/中文.mp3']);
    expect(zip.files['audio/中文.mp3'].unixPermissions).toBe(0o100644);
  });

  it('reads each entry a slice at a time and copies no entry Blob', async () => {
    const data = new Blob([new Uint8Array(1024)]);
    const slice = vi.spyOn(data, 'slice');
    const whole = vi.spyOn(data, 'arrayBuffer');
    await buildStoredZip([{ path: 'media/a.bin', data }]);
    expect(slice).toHaveBeenCalledTimes(1);
    expect(whole).not.toHaveBeenCalled();
  });

  it('refuses unsafe and duplicate paths', async () => {
    await expect(buildStoredZip([{ path: '../evil', data: 'x' }])).rejects.toThrow(/unsafe/);
    await expect(
      buildStoredZip([
        { path: 'a.txt', data: 'x' },
        { path: 'a.txt', data: 'y' },
      ]),
    ).rejects.toThrow(/duplicate/);
  });

  it('refuses an archive whose fields would reach the ZIP64 sentinel, before any CRC', async () => {
    // Local header (30 + 11 name bytes) + data ending exactly at 0xFFFFFFFF.
    const sentinel = new Blob(['x']);
    Object.defineProperty(sentinel, 'size', { value: 0xffffffff - 30 - 'media/a.mp4'.length });
    const slice = vi.spyOn(sentinel, 'slice');
    await expect(buildStoredZip([{ path: 'media/a.mp4', data: sentinel }])).rejects.toThrow(
      /4 GiB/,
    );
    expect(slice).not.toHaveBeenCalled();
  });

  it('refuses when only the central directory and end record would pass the limit', async () => {
    // The entry itself ends exactly at the largest allowed offset.
    const name = 'media/a.mp4';
    const fits = new Blob(['x']);
    Object.defineProperty(fits, 'size', { value: STORED_ZIP_MAX_BYTES - 30 - name.length });
    await expect(
      buildStoredZip([{ path: name, data: fits }], { crcChunkBytes: 2 ** 40 }),
    ).rejects.toThrow(/4 GiB/);
  });

  it('refuses 65,535 entries (the ZIP64 sentinel) and accepts one fewer', async () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ path: `f/${index}`, data: '' }));
    expect(STORED_ZIP_MAX_ENTRIES).toBe(0xfffe);
    await expect(buildStoredZip(entries(0xffff))).rejects.toThrow(/too many entries/);
    const zip = await buildStoredZip(entries(0xfffe));
    const view = new DataView(await zip.slice(zip.size - 22).arrayBuffer());
    expect(view.getUint16(8, true)).toBe(0xfffe);
    expect(view.getUint16(10, true)).toBe(0xfffe);
  }, 60_000);

  it('limits entry names by their UTF-8 bytes, not UTF-16 units', async () => {
    // 21,846 three-byte characters: 65,538 UTF-8 bytes in 21,846 UTF-16 units.
    const long = 'a/' + '中'.repeat(21_846);
    expect(long.length).toBeLessThan(0xffff);
    await expect(buildStoredZip([{ path: long, data: 'x' }])).rejects.toThrow(/too long/);
    const longest = 'a/' + 'b'.repeat(0xffff - 2);
    await expect(buildStoredZip([{ path: longest, data: 'x' }])).resolves.toBeInstanceOf(Blob);
  });

  it('carries the CRC across slices', async () => {
    const bytes = new Uint8Array(10_000).map((_, index) => (index * 7 + 3) & 0xff);
    const sliced = await buildStoredZip([{ path: 'a.bin', data: new Blob([bytes]) }], {
      crcChunkBytes: 333,
      date: new Date(2026, 0, 1),
    });
    const view = new DataView(await sliced.arrayBuffer());
    expect(view.getUint32(14, true)).toBe(crc32(bytes));
  });
});

/** Every field of a stored archive, read from the raw bytes. */
function parseArchive(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const end = buffer.byteLength - 22;
  const record = {
    signature: view.getUint32(end, true),
    disk: view.getUint16(end + 4, true),
    centralDisk: view.getUint16(end + 6, true),
    entriesOnDisk: view.getUint16(end + 8, true),
    entries: view.getUint16(end + 10, true),
    centralSize: view.getUint32(end + 12, true),
    centralOffset: view.getUint32(end + 16, true),
    commentLength: view.getUint16(end + 20, true),
  };
  const central = [];
  let at = record.centralOffset;
  for (let index = 0; index < record.entries; index++) {
    const nameLength = view.getUint16(at + 28, true);
    central.push({
      signature: view.getUint32(at, true),
      madeBy: view.getUint16(at + 4, true),
      needed: view.getUint16(at + 6, true),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      extraLength: view.getUint16(at + 30, true),
      commentLength: view.getUint16(at + 32, true),
      diskStart: view.getUint16(at + 34, true),
      internal: view.getUint16(at + 36, true),
      external: view.getUint32(at + 38, true),
      localOffset: view.getUint32(at + 42, true),
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
    });
    at += 46 + nameLength;
  }
  const local = central.map(({ localOffset }) => {
    const nameLength = view.getUint16(localOffset + 26, true);
    const extraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + nameLength + extraLength;
    const size = view.getUint32(localOffset + 22, true);
    return {
      signature: view.getUint32(localOffset, true),
      needed: view.getUint16(localOffset + 4, true),
      flags: view.getUint16(localOffset + 6, true),
      method: view.getUint16(localOffset + 8, true),
      time: view.getUint16(localOffset + 10, true),
      date: view.getUint16(localOffset + 12, true),
      crc: view.getUint32(localOffset + 14, true),
      compressedSize: view.getUint32(localOffset + 18, true),
      size,
      extraLength,
      name: decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + nameLength)),
      data: bytes.subarray(dataStart, dataStart + size),
      end: dataStart + size,
    };
  });
  return { record, central, local, end };
}

describe('buildStoredZip raw layout', () => {
  it('writes local headers that agree field by field with the central directory and end record', async () => {
    const big = new Uint8Array(3000).map((_, index) => (index * 13) & 0xff);
    const entries = [
      { path: 'classroom.html', data: '<!doctype html>' },
      { path: 'audio/中文.mp3', data: new Blob([big], { type: 'audio/mpeg' }) },
      { path: 'empty.txt', data: '' },
    ];
    const zip = await buildStoredZip(entries, {
      date: new Date(2026, 9, 8, 13, 45, 31),
      crcChunkBytes: 1000,
    });
    const { record, central, local, end } = parseArchive(await zip.arrayBuffer());

    expect(record).toEqual({
      signature: 0x06054b50,
      disk: 0,
      centralDisk: 0,
      entriesOnDisk: 3,
      entries: 3,
      centralSize: end - record.centralOffset,
      centralOffset: local[2].end,
      commentLength: 0,
    });
    const expectedData = [bytesOf('<!doctype html>'), big, new Uint8Array()];
    // DOS time: 13:45:30 (2-second resolution); date 2026-10-08.
    const time = (13 << 11) | (45 << 5) | 15;
    const date = ((2026 - 1980) << 9) | (10 << 5) | 8;
    central.forEach((header, index) => {
      const data = expectedData[index];
      expect(header).toEqual({
        signature: 0x02014b50,
        madeBy: (3 << 8) | 20,
        needed: 20,
        flags: 0x0800,
        method: 0,
        time,
        date,
        crc: crc32(data),
        compressedSize: data.length,
        size: data.length,
        extraLength: 0,
        commentLength: 0,
        diskStart: 0,
        internal: 0,
        external: (0o100644 << 16) >>> 0,
        localOffset: index === 0 ? 0 : local[index - 1].end,
        name: entries[index].path,
      });
      expect(local[index]).toMatchObject({
        signature: 0x04034b50,
        needed: header.needed,
        flags: header.flags,
        method: header.method,
        time: header.time,
        date: header.date,
        crc: header.crc,
        compressedSize: header.compressedSize,
        size: header.size,
        extraLength: 0,
        name: header.name,
      });
      expect(local[index].data).toEqual(data);
    });
    expect(record.centralSize).toBe(
      central.reduce((sum, header) => sum + 46 + bytesOf(header.name).length, 0),
    );
    expect(end + 22).toBe(zip.size);
  });

  it('clamps dates to the DOS range (1980 to 2107)', async () => {
    const dateField = async (when: Date) => {
      const zip = await buildStoredZip([{ path: 'a', data: '' }], { date: when });
      return parseArchive(await zip.arrayBuffer()).central[0].date >> 9;
    };
    expect(await dateField(new Date(1975, 5, 1))).toBe(0);
    expect(await dateField(new Date(2200, 5, 1))).toBe(2107 - 1980);
    expect(await dateField(new Date(2026, 5, 1))).toBe(2026 - 1980);
  });
});
