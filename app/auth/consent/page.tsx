'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function ConsentPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function giveConsent() {
    setLoading(true);
    await fetch('/api/user/consent', { method: 'POST' });
    setLoading(false);
    router.replace('/');
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-950 to-slate-900 px-4">
      <div className="w-full max-w-lg">
        <div className="bg-white/5 border border-white/10 rounded-2xl p-8 backdrop-blur-sm shadow-xl">
          <div className="flex items-center gap-3 mb-6">
            <ShieldCheck className="w-8 h-8 text-purple-400 flex-shrink-0" />
            <h1 className="text-xl font-bold text-white">Privacy Notice & Consent</h1>
          </div>
          <p className="text-slate-300 text-sm leading-relaxed mb-4">
            In compliance with <strong className="text-white">Thailand's Personal Data Protection Act (PDPA)</strong> (พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล), OpenMAIC collects and processes the following personal data:
          </p>
          <ul className="list-disc list-inside text-slate-400 text-sm space-y-1 mb-6 ml-2">
            <li>Name and email address for account management</li>
            <li>Login timestamps for security and audit purposes</li>
            <li>Classroom interaction data to support your learning</li>
            <li>IP address and browser information for security monitoring</li>
          </ul>
          <p className="text-slate-300 text-sm leading-relaxed mb-6">
            Your data is stored securely and will not be shared with third parties without your consent. You have the right to <strong className="text-white">access, correct, and delete</strong> your data at any time from your profile settings.
          </p>
          <div className="flex items-start gap-3 p-4 bg-purple-500/10 border border-purple-500/20 rounded-lg mb-6">
            <ShieldCheck className="w-5 h-5 text-purple-400 flex-shrink-0 mt-0.5" />
            <p className="text-slate-300 text-sm">
              This platform is operated in accordance with PDPA regulations. Data retention period: 3 years from last login, or until account deletion.
            </p>
          </div>
          <Button
            type="button"
            onClick={giveConsent}
            disabled={loading}
            className="w-full bg-purple-600 hover:bg-purple-700 text-white font-medium py-3 rounded-lg"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Recording consent…
              </span>
            ) : (
              'I understand and agree – Continue'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
