import { PDFDocument } from 'pdf-lib';
import * as unpdf from 'unpdf';
import { afterEach, expect, it, vi } from 'vitest';
import { parsePDF } from '@/lib/pdf/pdf-providers';

vi.mock('unpdf', { spy: true });

afterEach(() => vi.clearAllMocks());

const config = { providerId: 'unpdf', textOnly: true } as const;

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Sample lesson');
  return Buffer.from(await pdf.save());
}

it('rejects a cancelled unpdf read before opening the document', async () => {
  const reason = new Error('Read cancelled');
  await expect(
    parsePDF({ ...config, signal: AbortSignal.abort(reason) }, await samplePdf()),
  ).rejects.toBe(reason);
  expect(unpdf.getResolvedPDFJS).not.toHaveBeenCalled();
  expect(unpdf.extractText).not.toHaveBeenCalled();
});

it('stops the loading task if the caller cancels before the document opens', async () => {
  const controller = new AbortController();
  const reason = new Error('Read cancelled');
  const pdfjs = await unpdf.getResolvedPDFJS();
  const getDocument = vi.fn((...args: Parameters<typeof pdfjs.getDocument>) => {
    const task = pdfjs.getDocument(...args);
    queueMicrotask(() => controller.abort(reason));
    return task;
  });
  vi.mocked(unpdf.getResolvedPDFJS).mockResolvedValueOnce({ ...pdfjs, getDocument });

  await expect(parsePDF({ ...config, signal: controller.signal }, await samplePdf())).rejects.toBe(
    reason,
  );
  expect(getDocument.mock.results[0].value.destroyed).toBe(true);
  expect(unpdf.extractText).not.toHaveBeenCalled();
});

it('destroys the PDF.js task when a read is cancelled during text extraction', async () => {
  const controller = new AbortController();
  type Document = Awaited<ReturnType<typeof unpdf.getDocumentProxy>>;
  const extracting = Promise.withResolvers<Document>();
  const paused = Promise.withResolvers<void>();
  vi.mocked(unpdf.extractText).mockImplementationOnce(async (pdf) => {
    if (!pdf || typeof pdf !== 'object' || !('loadingTask' in pdf)) {
      throw new Error('Expected an open PDF document');
    }
    extracting.resolve(pdf);
    await paused.promise;
    return { totalPages: 1, text: 'Late text' };
  });

  const result = parsePDF({ ...config, signal: controller.signal }, await samplePdf()).catch(
    (error: unknown) => error,
  );
  const pdf = await extracting.promise;
  const reason = new Error('Read cancelled');
  controller.abort(reason);
  try {
    await vi.waitFor(() => expect(pdf.loadingTask.destroyed).toBe(true));
    expect(await result).toBe(reason);
  } finally {
    paused.resolve();
  }
});

it('still extracts text from a real PDF when the signal stays active', async () => {
  const result = await parsePDF(
    { ...config, signal: new AbortController().signal },
    await samplePdf(),
  );
  expect(result.text).toContain('Sample lesson');
});
