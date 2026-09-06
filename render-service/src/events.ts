/**
 * Operational events for the render service.
 *
 * The service is otherwise silent: it logs one startup banner and nothing else,
 * so a deployment can observe that renders happen (CPU, memory) but cannot
 * answer how many succeeded, how long they took, or how long they waited for a
 * slot. Job state lives in `JobStore` — in memory by default — so it is gone
 * the moment the process restarts, and a failed render is reported to the
 * client as a perfectly healthy `200` whose *body* says `status: 'failed'`,
 * which makes failures invisible to any proxy or gateway counting status codes.
 *
 * These events close that gap with one JSON line per lifecycle transition on
 * stdout, which every container log pipeline already collects.
 *
 * They deliberately carry only bounded, low-cardinality dimensions: an opaque
 * job id, a state, a duration, a reason code. No client identity, no file or
 * directory names, no scene content, and no raw error strings — a render works
 * on untrusted, model-authored input, and none of it belongs in an operational
 * log. `error_code` is a fixed vocabulary, not a message.
 */

/** Lifecycle and admission transitions worth a log line. */
export type RenderEventName =
  | 'render_job_submitted'
  | 'render_job_started'
  | 'render_job_finished'
  | 'render_admission_rejected'
  | 'preview_request';

export type RenderOutcome = 'succeeded' | 'failed' | 'cancelled';

export interface RenderEvent {
  event: RenderEventName;
  /** Opaque per-job id. Not derived from user input. */
  jobId?: string;
  outcome?: RenderOutcome;
  /** Time from submission to being granted an execution slot. */
  queueWaitMs?: number;
  /**
   * Wall time the event closes: submission to completion on
   * `render_job_finished`, and request to response on `preview_request`. On a
   * finished job this INCLUDES `queueWaitMs`; subtract it, or use `renderMs`,
   * to get the cost of the render itself.
   */
  durationMs?: number;
  /** Time from being granted an execution slot to finishing. */
  renderMs?: number;
  /** Other jobs still queued when the event fired, excluding this one. */
  queued?: number;
  /**
   * Jobs dequeued and not yet finished. These are usually executing, but a job
   * is counted from the moment it leaves the queue, and it may still be waiting
   * on the execution permit it shares with `/preview` — so read this as
   * "admitted to run", not "currently rendering".
   */
  running?: number;
  /** Fixed vocabulary — never a raw error message. */
  errorCode?: string;
  /** Which admission cap rejected the caller, or which route served it. */
  reason?: string;
  route?: string;
  /** HTTP status the caller received, for the synchronous preview route. */
  status?: number;
}

/** Receives an event. Injectable so tests can assert without touching stdout. */
export type RenderEventSink = (event: RenderEvent) => void;

/**
 * The exact fields allowed on the wire. Serializing an explicit list rather
 * than `Object.entries(event)` makes the redaction promise in the header
 * structural: a future caller that spreads a job record or a failure object
 * into an event cannot leak it, because anything not named here is dropped.
 * Excess-property checking alone would not catch that — spread properties are
 * exempt from it.
 */
const SERIALIZED_FIELDS = [
  'event',
  'jobId',
  'outcome',
  'queueWaitMs',
  'durationMs',
  'renderMs',
  'queued',
  'running',
  'errorCode',
  'reason',
  'route',
  'status',
] as const satisfies readonly (keyof RenderEvent)[];

function nonEmpty(event: RenderEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SERIALIZED_FIELDS) {
    const value = event[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/**
 * Human-readable summary. Kept short and dimension-only so a log pipeline can
 * index it as text without it ever carrying content.
 */
function summarize(event: RenderEvent): string {
  switch (event.event) {
    case 'render_job_submitted':
      return `render job queued (queued=${event.queued ?? 0}, running=${event.running ?? 0})`;
    case 'render_job_started':
      return `render job started after ${event.queueWaitMs ?? 0}ms in queue`;
    case 'render_job_finished':
      return `render job ${event.outcome ?? 'finished'} in ${event.durationMs ?? 0}ms`;
    case 'render_admission_rejected':
      return `admission rejected (${event.reason ?? 'unknown'}) on ${event.route ?? 'unknown'}`;
    case 'preview_request':
      return `preview ${event.status ?? 0} in ${event.durationMs ?? 0}ms`;
  }
}

/**
 * Default sink: one JSON line per event on stdout.
 *
 * `console.error` for a failed render so a pipeline that only forwards stderr
 * still sees failures; everything else goes to stdout.
 */
export const emitRenderEvent: RenderEventSink = (event) => {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: event.outcome === 'failed' ? 'ERROR' : 'INFO',
    service: 'render-service',
    component: event.event === 'preview_request' ? 'preview' : 'render',
    message: summarize(event),
    ...nonEmpty(event),
  });
  if (event.outcome === 'failed') console.error(line);
  else console.log(line);
};
