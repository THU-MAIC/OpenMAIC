import { renderChunk } from '@hyperframes/producer/distributed';

interface ChunkMessage {
  planDir: string;
  chunkIndex: number;
  outputPath: string;
}

process.on('message', async (message: ChunkMessage) => {
  try {
    const result = await renderChunk(message.planDir, message.chunkIndex, message.outputPath);
    process.send?.({ ok: true, result });
    process.disconnect?.();
    process.exit(0);
  } catch (error) {
    process.send?.({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.disconnect?.();
    process.exitCode = 1;
  }
});
