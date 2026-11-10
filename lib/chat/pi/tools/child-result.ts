/** Model-visible child outcome. Never interpolate raw provider errors here. */
export function formatChildResult(opts: {
  agentName: string;
  text: string;
  actionCount: number;
  status: 'completed' | 'failed' | 'exhausted';
  stopReason?: string;
}): { text: string; isError: boolean } {
  const isError = opts.status !== 'completed';
  let outcome: string;
  if (!isError) {
    if (opts.text) return { text: `${opts.agentName}: ${opts.text}`, isError };
    outcome =
      opts.actionCount > 0
        ? `completed ${opts.actionCount} classroom action(s) without visible speech`
        : 'stayed silent: completed without visible speech or classroom actions';
  } else {
    // Only exhausted runs have trusted runtime reason codes. A provider error
    // can contain arbitrary text, including a string that resembles such a code.
    const reasons: Record<string, string> = {
      native_duplicate_tool_call: 'duplicate tool call',
      output_token_limit: 'output token limit reached',
    };
    const reason =
      opts.status === 'exhausted'
        ? (reasons[opts.stopReason ?? ''] ?? 'execution budget exhausted')
        : 'provider or child execution error';
    outcome = `${opts.status}: ${reason}`;
  }
  return {
    text: `${opts.agentName}: [${outcome}]${opts.text ? `\nPartial visible response: ${opts.text}` : ''}`,
    isError,
  };
}
