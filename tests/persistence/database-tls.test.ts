import { describe, expect, it } from 'vitest';

import { databaseTlsFromEnv } from '@/lib/persistence/database-tls';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

describe('databaseTlsFromEnv', () => {
  it('leaves connections as they were when no CA is configured', () => {
    expect(databaseTlsFromEnv({})).toBeUndefined();
    expect(databaseTlsFromEnv({ DATABASE_CA_CERT: '   ' })).toBeUndefined();
  });

  it('pins the configured CA and refuses unverified servers', () => {
    expect(databaseTlsFromEnv({ DATABASE_CA_CERT: PEM })).toEqual({
      ca: PEM,
      rejectUnauthorized: true,
    });
  });

  it('accepts a PEM pasted with escaped newlines', () => {
    const escaped = PEM.replace(/\n/g, '\\n');
    expect(databaseTlsFromEnv({ DATABASE_CA_CERT: escaped })?.ca).toBe(PEM);
  });
});
