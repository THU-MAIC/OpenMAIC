/** Longest failure reason a log line may carry. */
export const FAILURE_REASON_MAX_LENGTH = 300;

/**
 * Bound a render failure message for an operational log line.
 *
 * The message is kept (an allowlist of known phrases would hide exactly the
 * unknown failures this field exists to explain), but the parts most likely to
 * identify a job or a person are masked first: URLs (which may carry tokens in
 * their query) and absolute filesystem paths (job directories, file names).
 * Control characters and newlines are collapsed so one failure stays one log
 * line, and the result is capped. Redaction runs before truncation so a cut
 * cannot turn a partially masked URL or path into a loggable fragment.
 */
export function sanitizeFailureReason(message: string): string {
  const reason = message
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|data:)[^\s<>"'`]+/gi, '[url]')
    // A quoted path is masked through the last matching quote on its line, so
    // spaces or quote characters inside a directory or file name cannot leave
    // its tail in the log. Over-masking a little trailing text is the safe side.
    .replace(/(['"`])(?:[a-z]:[\\/]|\\\\|\/)[^\n]*\1/gi, '$1[path]$1')
    .replace(/(?<![\w\]])(?:[a-z]:[\\/]|\\\\|\/)[^\s<>"'`]+/gi, '[path]')
    // eslint-disable-next-line no-control-regex -- Strip control characters from log output.
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .trim();
  if (!reason) return '[empty]';
  return reason.length > FAILURE_REASON_MAX_LENGTH
    ? `${reason.slice(0, FAILURE_REASON_MAX_LENGTH - 1)}…`
    : reason;
}
