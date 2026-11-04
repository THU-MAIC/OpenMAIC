import { notFound } from 'next/navigation';

import SandboxLab from './sandbox-lab';

export const dynamic = 'force-dynamic';

export default function SandboxLabPage() {
  if (process.env.OPENMAIC_SANDBOX_LAB !== 'true') notFound();
  return <SandboxLab />;
}
