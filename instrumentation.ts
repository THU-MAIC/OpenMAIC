export async function register(): Promise<void> {
  // Next compiles this entry for both Node.js and Edge. Keep every Node-only
  // API in a separate module so the Edge compiler never analyzes it.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeInstrumentation } = await import('./instrumentation-node');
    await registerNodeInstrumentation();
  }
}
