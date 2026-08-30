import type { Metadata } from 'next';
import { CyberphysicalClient } from './client';

export const metadata: Metadata = {
  title: 'Cyberphysical | OpenMAIC',
  description: 'Geospatial telemetry and live route visualization for physical AI agents.',
};

export default function CyberphysicalPage() {
  return <CyberphysicalClient />;
}
