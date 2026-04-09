import type { LMSProvider } from '@/lib/lms/types';
import { MoodleLTIProvider } from './providers/moodle';
import { OdooLMSProvider } from './providers/odoo';
import { DolibarrProvider } from './providers/dolibarr';

const PROVIDERS: Record<string, () => LMSProvider> = {
  moodle: () => new MoodleLTIProvider(),
  odoo: () => new OdooLMSProvider(),
  dolibarr: () => new DolibarrProvider(),
};

export function getLMSProvider(id: string): LMSProvider {
  const factory = PROVIDERS[id];
  if (!factory) throw new Error(`Unknown LMS provider: ${id}`);
  return factory();
}

export function listLMSProviders(): Array<{ id: string; name: string; type: string }> {
  return Object.entries(PROVIDERS).map(([id, factory]) => {
    const p = factory();
    return { id, name: p.name, type: p.type };
  });
}
