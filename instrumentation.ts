import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const sdkModule = await import('@opentelemetry/sdk-node');
    const exporterModule = await import('@opentelemetry/exporter-trace-otlp-http');
    const resourcesModule = await import('@opentelemetry/resources');
    const semconvModule = await import('@opentelemetry/semantic-conventions');
    const traceNodeModule = await import('@opentelemetry/sdk-trace-node');
    const autoInstModule = await import('@opentelemetry/auto-instrumentations-node');

    const NodeSDK = (sdkModule as any).NodeSDK || (sdkModule as any).default?.NodeSDK;
    const OTLPTraceExporter = (exporterModule as any).OTLPTraceExporter || (exporterModule as any).default?.OTLPTraceExporter;
    const Resource = (resourcesModule as any).Resource || (resourcesModule as any).default?.Resource;
    const ATTR_SERVICE_NAME = (semconvModule as any).ATTR_SERVICE_NAME || (semconvModule as any).default?.ATTR_SERVICE_NAME;
    const BatchSpanProcessor = (traceNodeModule as any).BatchSpanProcessor || (traceNodeModule as any).default?.BatchSpanProcessor;
    const getNodeAutoInstrumentations = (autoInstModule as any).getNodeAutoInstrumentations || (autoInstModule as any).default?.getNodeAutoInstrumentations;

    const axiomHost = process.env.AXIOM_HOST || 'api.axiom.co';
    const axiomToken = process.env.AXIOM_TOKEN;
    const axiomDataset = process.env.AXIOM_DATASET;

    if (!axiomToken || !axiomDataset) {
      console.warn('[instrumentation] AXIOM_TOKEN or AXIOM_DATASET is not set — skipping Axiom tracing.');
    } else {
      const sdk = new NodeSDK({
        resource: new Resource({
          [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'openmaic',
        }),
        spanProcessor: new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: `https://${axiomHost}/v1/traces`,
            headers: {
              Authorization: `Bearer ${axiomToken}`,
              'X-Axiom-Dataset': axiomDataset,
            },
          })
        ),
        instrumentations: [
          getNodeAutoInstrumentations({
            // disable fs instrumentation as it can be very noisy
            '@opentelemetry/instrumentation-fs': {
              enabled: false,
            },
          }),
        ],
      });

      sdk.start();
      console.log(`[instrumentation] Axiom tracing active (NodeSDK) → dataset: ${axiomDataset}`);
    }

    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
