import { Pool, type PoolClient } from 'pg';

const BGE_VECTOR_DIMENSIONS = 1024;
const DEFAULT_WORKSPACE_ID = 'demo-default';

type GlobalWithPool = typeof globalThis & {
  __openmaicKnowledgePool?: Pool;
  __openmaicKnowledgeSchema?: Promise<void>;
};

const globalForPool = globalThis as GlobalWithPool;

export function getKnowledgeWorkspaceId(): string {
  return process.env.KNOWLEDGE_WORKSPACE_ID?.trim() || DEFAULT_WORKSPACE_ID;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured for the PostgreSQL knowledge base');
  }
  return databaseUrl;
}

export function getKnowledgePool(): Pool {
  if (!globalForPool.__openmaicKnowledgePool) {
    globalForPool.__openmaicKnowledgePool = new Pool({
      connectionString: requireDatabaseUrl(),
      max: 8,
    });
  }
  return globalForPool.__openmaicKnowledgePool;
}

export async function ensureKnowledgeSchema(): Promise<void> {
  if (!globalForPool.__openmaicKnowledgeSchema) {
    globalForPool.__openmaicKnowledgeSchema = initializeKnowledgeSchema().catch((error) => {
      globalForPool.__openmaicKnowledgeSchema = undefined;
      throw error;
    });
  }
  await globalForPool.__openmaicKnowledgeSchema;
}

async function initializeKnowledgeSchema(): Promise<void> {
  const client = await getKnowledgePool().connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id text PRIMARY KEY,
        workspace_id text NOT NULL,
        file_name text NOT NULL,
        mime_type text NOT NULL,
        file_size bigint NOT NULL,
        content_hash text NOT NULL,
        pdf_data bytea NOT NULL,
        parsed_text text,
        page_count integer,
        chunk_count integer NOT NULL DEFAULT 0,
        status text NOT NULL,
        embedding_model text NOT NULL,
        error_message text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, content_hash)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id text PRIMARY KEY,
        document_id text NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        workspace_id text NOT NULL,
        chunk_index integer NOT NULL,
        content text NOT NULL,
        embedding vector(${BGE_VECTOR_DIMENSIONS}) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (document_id, chunk_index)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS generation_rag_snapshots (
        id text PRIMARY KEY,
        workspace_id text NOT NULL,
        query_text text NOT NULL,
        retrieval_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        selection_confirmed boolean NOT NULL DEFAULT true,
        retrieved_chunks jsonb NOT NULL,
        rendered_context text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      ALTER TABLE generation_rag_snapshots
      ADD COLUMN IF NOT EXISTS retrieval_config jsonb NOT NULL DEFAULT '{}'::jsonb
    `);
    await client.query(`
      ALTER TABLE generation_rag_snapshots
      ADD COLUMN IF NOT EXISTS selection_confirmed boolean NOT NULL DEFAULT true
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS knowledge_chunks_workspace_document_idx
      ON knowledge_chunks (workspace_id, document_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx
      ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
    `);
  } finally {
    client.release();
  }
}

export async function withKnowledgeTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await ensureKnowledgeSchema();
  const client = await getKnowledgePool().connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export { BGE_VECTOR_DIMENSIONS };
