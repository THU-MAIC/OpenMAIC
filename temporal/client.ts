import { Connection, Client } from '@temporalio/client';
export { TASK_QUEUE } from './constants';

let _client: Client | null = null;

/**
 * Returns a singleton Temporal client.
 * - In dev: connects to local Temporal server (localhost:7233)
 * - In prod: connects to Temporal Cloud using TEMPORAL_API_KEY
 */
export async function getTemporalClient(): Promise<Client> {
  if (_client) return _client;

  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const apiKey = process.env.TEMPORAL_API_KEY;

  const connection = await Connection.connect({
    address,
    tls: apiKey ? {} : undefined,
    ...(apiKey ? { apiKey } : {}),
  });

  _client = new Client({ connection, namespace });
  return _client;
}
