/**
 * Node.js-only process-scoped startup work invoked from `instrumentation.ts`.
 *
 * Kept in its own module and dynamically imported behind
 * `process.env.NEXT_RUNTIME === 'nodejs'` so Next.js's Edge instrumentation
 * compiler does not flag `process.once` during static analysis.
 */
export async function registerNodeInstrumentation(): Promise<void> {
  const { warnIfDefaultDatabasePasswordIsPublished } =
    await import('@/lib/server/database-password-warning');
  warnIfDefaultDatabasePasswordIsPublished();

  // A boot that fails here must stop the process. Next.js logs a throw from
  // `register` as "Failed to prepare server" but keeps listening and answers
  // every request with a 500, so the throw alone leaves a deployment that
  // looks alive and serves nothing. exitOnBootFailure prints the failure and
  // exits non-zero (see lib/server/boot-failure.ts): a refused configuration as
  // one line with the original message, anything else with its stack. The
  // rethrow is reached only where the exit is stubbed (tests).
  try {
    await validateBootConfiguration();
  } catch (error) {
    const { exitOnBootFailure } = await import('@/lib/server/boot-failure');
    await exitOnBootFailure(error);
    throw error;
  }

  // Warn-only checks on the configuration that passed validation: single-user
  // mode without ACCESS_CODE serves one library to whoever can reach the
  // server. Its warning names ACCESS_CODE itself, so the generic unset-code
  // warning is skipped then: one warning, not two.
  const { warnAboutOwnerIdentityConfiguration } = await import('@/lib/server/identity/registry');
  if (!warnAboutOwnerIdentityConfiguration()) {
    const { warnIfAccessCodeIsUnset } = await import('@/lib/server/access-code-warning');
    warnIfAccessCodeIsUnset(process.env.ACCESS_CODE);
  }

  // Imported dynamically so the Edge bundle never pulls in `pg`.
  const { startAssetCollectorSchedule } =
    await import('@/lib/persistence/asset-collector-schedule');
  const assetSchedule = startAssetCollectorSchedule();

  // Warn-first boot-time validation of model routing config (MODEL_ROUTES,
  // DEFAULT_MODEL, <PREFIX>_MODELS). Cheap and non-throwing: broken config
  // surfaces here as [config] warnings instead of failing at request time.
  // Imported dynamically so the Edge bundle never pulls in the fs/js-yaml
  // backed provider config it reads.
  const { validateServerConfig } = await import('@/lib/server/config-validation');
  validateServerConfig();

  let runner: import('@/lib/server/agent-runtime/runner').AgentRunnerHandle | undefined;
  let extractionRunner:
    | import('@/lib/server/material-extraction/runner').MaterialExtractionRunnerHandle
    | undefined;
  let stopAgentEventNotifyBus: (() => Promise<void>) | null = null;
  try {
    const { isAgentRuntimeConfigured } = await import('@/lib/config/feature-flags');
    if (isAgentRuntimeConfigured()) {
      // One dedicated LISTEN connection per application instance. The HTTP
      // SSE routes and the runner share its in-process fanout registry; it is
      // not a pool client and never scales with the number of streams.
      const { startAgentEventNotifyBus } =
        await import('@/lib/server/agent-runtime/event-notify-bus');
      const eventNotifyBus = startAgentEventNotifyBus();
      stopAgentEventNotifyBus = () => eventNotifyBus.stop();
      // startAgentRunner only installs a timer. Store/schema initialization is
      // retained behind the store's lazy promise and never blocks register().
      const runtime = await import('@/lib/server/agent-runtime/runner');
      runner = runtime.startAgentRunner();
      const extraction = await import('@/lib/server/material-extraction/runner');
      extractionRunner = extraction.startMaterialExtractionRunner();
    }
  } catch (error) {
    console.error('[instrumentation] Agent runtime startup failed', error);
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      // Park sessions before any pool they use is closed. This preserves the
      // last durable entry-tree checkpoint for immediate takeover.
      try {
        await extractionRunner?.stop();
      } catch (error) {
        console.error('[instrumentation] Material extraction runner drain failed', error);
      }
      try {
        await runner?.stop();
      } catch (error) {
        console.error('[instrumentation] Agent runner drain failed', error);
      }
      try {
        await stopAgentEventNotifyBus?.();
      } catch (error) {
        console.error('[instrumentation] Agent event notify bus drain failed', error);
      }
      try {
        await assetSchedule?.stop();
      } catch (error) {
        console.error('[instrumentation] Asset collector drain failed', error);
      }
      const connectionString = process.env.DATABASE_URL?.trim();
      if (connectionString) {
        try {
          const { getServerPersistenceProvider } =
            await import('@/lib/persistence/server-provider');
          const { pool } = await getServerPersistenceProvider(connectionString);
          await pool.end();
        } catch (error) {
          console.error('[instrumentation] Persistence pool shutdown failed', error);
        }
      }
    })();
    return shutdownPromise;
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

/**
 * The fatal boot validations: each throws on a configuration the server must
 * not start with, and the throw stops the process (see `register`). Warnings (the unset ACCESS_CODE warning, the model-routing
 * checks in `validateServerConfig`) are not here and never stop the process.
 */
async function validateBootConfiguration(): Promise<void> {
  // Each check runs through runConfigurationCheck, so only what the check
  // itself throws is reported as a refused configuration; a module that fails
  // to load is reported as a startup failure, with its stack.
  const { runConfigurationCheck } = await import('@/lib/server/boot-configuration-error');

  // The database, before anything else: every course, chat and asset lives in
  // it and there is no browser-storage fallback, so a server without one would
  // boot, pass its health check and then fail every persistence request. The
  // refusal names the fix (`pnpm db:up` locally, DATABASE_URL or
  // `docker compose up` for a deployment).
  const { requireDatabaseUrl } = await import('@/lib/server/database-requirement');
  runConfigurationCheck(() => requireDatabaseUrl());

  // The asset quota, read here rather than at the first persistence request.
  // The provider that consumes it is lazy and memoised, so a malformed ceiling
  // would otherwise let the process boot, pass its health check, and then fail
  // every persistence request -- documents and runtime included -- until it was
  // fixed and the process restarted. `register` runs before the server is
  // ready, so throwing here is what makes a misconfigured deployment fail to
  // start instead of failing to work. First, so the throw cannot skip the
  // teardown registration for something `register` has already started.
  const { resolveAssetQuotaBytes } = await import('@/lib/persistence/asset-quota');
  runConfigurationCheck(resolveAssetQuotaBytes);

  // The pending-allocation window, for the same reason and at the same moment.
  // Too short is worse than malformed: it silently expires allocations whose
  // document write was still coming, so it must fail the process rather than
  // the request that discovers it.
  const { resolveAssetPendingTtlMs } = await import('@/lib/persistence/asset-pending-ttl');
  runConfigurationCheck(resolveAssetPendingTtlMs);

  // Owner identity, for the same reason and at the same moment. A malformed
  // PERSISTENCE_SHARED_OWNER_ID or single-user setting, the two together, or a
  // setting a host registration would ignore,
  // would otherwise boot, pass its health check, and then fail (or silently
  // mis-identify) every owner-scoped request — and an operator has no way to
  // tell from the outside that their setting was not accepted. An empty value
  // is treated as unset, so this only rejects values that are present and
  // unusable.
  //
  // A host that brings its own identity registers its owner auth methods
  // here, in the order they are asked, before validation and before the
  // server serves a request, and with them any host extension hooks (course
  // creation, library listing, upload admission, the asset byte store):
  //
  //   const { configureOwnerAuthentication } = await import('@/lib/server/identity');
  //   configureOwnerAuthentication({ methods: [myOwnerAuthMethod] });
  //   const { configurePersistenceHooks, configureAssetByteStore } =
  //     await import('@/lib/server/persistence-hooks');
  //   configurePersistenceHooks(myPersistenceHooks);
  //   configureAssetByteStore(myAssetByteStore);
  //
  // A registration that throws stops the process too, reported as a startup
  // failure with its stack (it is host code, not a setting).
  const { validateOwnerIdentityConfiguration } = await import('@/lib/server/identity/registry');
  runConfigurationCheck(validateOwnerIdentityConfiguration);

  // The registered hooks, for the same reason and at the same moment: a host
  // byte store that cannot sign under ASSET_BYTE_EGRESS=redirect would
  // otherwise be discovered by the first asset read.
  const { validatePersistenceHooksConfiguration } =
    await import('@/lib/server/persistence-hooks/registry');
  runConfigurationCheck(validatePersistenceHooksConfiguration);
}
