import { SandboxError } from '@/lib/sandbox/errors';
import { verifyGatewayRequest } from '@/lib/server/sandbox/preview';
import { SandboxService } from '@/lib/server/sandbox/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Machine-only duplex transport. The signed descriptor selects an authorized port, never a URL. */
export async function POST(request: Request) {
  const headers = { 'cache-control': 'no-store', 'content-type': 'application/octet-stream' };
  const descriptor = request.headers.get('x-openmaic-preview-request') ?? '';
  try {
    if (
      descriptor.length > 8192 ||
      !request.body ||
      !verifyGatewayRequest(descriptor, request.headers.get('x-openmaic-preview-gateway'))
    )
      return new Response(null, { status: 403, headers });
    const { ticket, host } = JSON.parse(descriptor);
    if (typeof ticket !== 'string' || typeof host !== 'string')
      return new Response(null, { status: 403, headers });
    const connection = await SandboxService.openPreviewConnection(ticket, host, request.signal);
    const reader = connection.output.getReader();
    // Consume input concurrently with the response. Bound each connection's transferred input.
    const input = request.body.getReader();
    void (async () => {
      let total = 0;
      try {
        while (true) {
          const { done, value } = await input.read();
          if (done) break;
          total += value.byteLength;
          if (total > 17 * 1024 * 1024) throw new Error('Preview input limit');
          await connection.write(value);
        }
      } catch {
        await connection.close();
      } finally {
        input.releaseLock();
      }
    })();
    const output = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Uint8Array.of(1));
      }, // Flush headers before the HTTP client sends bytes.
      async pull(c) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            c.close();
            await connection.close();
            await input.cancel().catch(() => {});
          } else c.enqueue(value);
        } catch {
          c.error(new Error('Preview disconnected.'));
          await connection.close();
          await input.cancel().catch(() => {});
        }
      },
      async cancel() {
        await connection.close();
        await input.cancel().catch(() => {});
      },
    });
    return new Response(output, { headers });
  } catch (error) {
    const status =
      error instanceof SandboxError && error.code === 'SANDBOX_PREVIEW_CAPACITY' ? 429 : 403;
    return new Response(null, { status, headers });
  }
}
