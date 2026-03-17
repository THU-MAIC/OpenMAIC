/**
 * Infrastructure Configuration
 *
 * Database connection, Redis client, and observability setup.
 * All infrastructure services are optional - the platform gracefully
 * degrades to client-side storage when not available.
 */

/**
 * Database configuration
 */
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  maxConnections: number;
}

/**
 * Redis configuration
 */
export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  maxRetries: number;
}

/**
 * Observability configuration
 */
export interface ObservabilityConfig {
  enabled: boolean;
  otlpEndpoint?: string;
  serviceName: string;
  environment: string;
}

/**
 * Get database config from environment variables
 */
export function getDatabaseConfig(): DatabaseConfig {
  return {
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'openmaic',
    user: process.env.POSTGRES_USER ?? 'openmaic',
    password: process.env.POSTGRES_PASSWORD ?? '',
    ssl: process.env.POSTGRES_SSL === 'true',
    maxConnections: parseInt(process.env.POSTGRES_MAX_CONNECTIONS ?? '20', 10),
  };
}

/**
 * Get Redis config from environment variables
 */
export function getRedisConfig(): RedisConfig {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB ?? '0', 10),
    maxRetries: parseInt(process.env.REDIS_MAX_RETRIES ?? '3', 10),
  };
}

/**
 * Get observability config from environment variables
 */
export function getObservabilityConfig(): ObservabilityConfig {
  return {
    enabled: process.env.OTEL_ENABLED === 'true',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'openmaic',
    environment: process.env.NODE_ENV ?? 'development',
  };
}
