import { Suspense } from 'react';
import { PricingClient } from './pricing-client';

export default function PricingPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f0f4f8] py-16 px-4" />}>
      <PricingClient />
    </Suspense>
  );
}
