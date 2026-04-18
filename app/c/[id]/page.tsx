'use client';

import { useEffect, useState, use } from 'react';
import { motion } from 'motion/react';
import { CertificateCard } from '@/components/certificates/certificate-card';
import { calculateGrade } from '@/lib/utils/grading';
import { ArrowRight, Sparkles, Trophy, User } from 'lucide-react';
import Link from 'next/link';

export default function PublicCertificatePage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = use(paramsPromise);
  const [certificate, setCertificate] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchCertificate() {
      try {
        const res = await fetch(`/api/certificates?id=${params.id}`);
        if (!res.ok) throw new Error('Certificate not found');
        const json = await res.json();
        setCertificate(json);
      } catch (err) {
        setError('We couldn\'t find that certificate. It may have been removed or the link is incorrect.');
      } finally {
        setLoading(false);
      }
    }
    fetchCertificate();
  }, [params.id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-8">
        <div className="w-16 h-16 border-4 border-violet-500/20 border-t-violet-500 rounded-full animate-spin mb-4" />
        <p className="text-slate-400 font-medium animate-pulse">Verifying Achievement...</p>
      </div>
    );
  }

  if (error || !certificate) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-8 text-center">
        <div className="w-20 h-20 bg-slate-900 rounded-3xl flex items-center justify-center mb-6 text-slate-700">
          <Trophy className="w-10 h-10" />
        </div>
        <h1 className="text-2xl font-bold text-white mb-2">Achievement Not Found</h1>
        <p className="text-slate-400 max-w-md mb-8">{error}</p>
        <Link href="/" className="px-6 py-3 bg-violet-600 text-white font-bold rounded-2xl hover:bg-violet-700 transition-colors">
          Go to Slate Home
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 selection:bg-violet-500/30">
      {/* Dynamic Background */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden print:hidden">
        <div className="absolute top-0 right-0 w-[50%] h-[50%] bg-violet-600/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 left-0 w-[50%] h-[50%] bg-indigo-600/10 rounded-full blur-[120px]" />
      </div>

      <nav className="relative z-10 p-6 flex justify-between items-center max-w-7xl mx-auto print:hidden">
        <Link href="/" className="flex items-center gap-2 group">
          <div className="w-10 h-10 bg-violet-600 rounded-xl flex items-center justify-center shadow-lg shadow-violet-500/20 group-hover:scale-110 transition-transform">
            <span className="text-white font-black text-xl">S</span>
          </div>
          <span className="text-xl font-black text-white tracking-tight">SLATE UP</span>
        </Link>
      </nav>

      <main className="relative z-10 max-w-5xl mx-auto px-6 pt-8 pb-24 print:p-0 print:m-0 print:max-w-none">
        <div className="text-center mb-12 print:hidden">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400 text-sm font-bold uppercase tracking-widest mb-6"
          >
            <Sparkles className="w-4 h-4" />
            Verified Achievement
          </motion.div>

          <h1 className="text-4xl md:text-5xl font-black text-white tracking-tight mb-4">
            {certificate.student_name} has mastered a new skill!
          </h1>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto">
            <strong className="text-white">{certificate.student_name}</strong> has successfully completed <strong>{certificate.course_name}</strong> and earned this official Slate Achievement.
          </p>
        </div>

        {/* The Certificate */}
        <div className="mb-20 print:mb-0 print:w-[297mm] print:mx-auto">
          <CertificateCard
            studentName={certificate.student_name}
            courseName={certificate.course_name}
            grade={certificate.grade}
            score={Math.min(certificate.score, 100)}
            date={new Date(certificate.created_at).toLocaleDateString()}
            topics={certificate.topics || []}
            breakdown={
              calculateGrade({
                slidesViewed: certificate.watch_time_percentage || 0,
                totalSlides: 100,
                quizScoreAverage: certificate.quiz_score_average || 0,
                engagementCount: certificate.engagement_count || 0
              }).breakdown
            }
            isPublic
          />
        </div>

        {/* CTA Section */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="relative bg-gradient-to-br from-violet-600 to-indigo-700 rounded-[40px] p-8 md:p-16 overflow-hidden shadow-2xl shadow-violet-500/20 print:hidden"
        >
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl translate-x-1/2 -translate-y-1/2" />
          <div className="absolute bottom-0 left-0 w-64 h-64 bg-black/10 rounded-full blur-3xl -translate-x-1/2 translate-y-1/2" />

          <div className="relative z-10 flex flex-col md:flex-row items-center gap-12">
            <div className="flex-1 text-center md:text-left">
              <h2 className="text-3xl md:text-5xl font-black text-white leading-tight mb-6">
                Start your own journey with Slate today.
              </h2>
              <p className="text-violet-100 text-lg mb-10 max-w-xl">
                Create AI-powered courses on any topic, master new skills, and earn your own premium certificates.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center md:justify-start">
                <Link
                  href="/auth/login"
                  className="px-8 py-4 bg-white text-violet-700 font-black rounded-2xl flex items-center justify-center gap-2 hover:scale-105 active:scale-95 transition-all shadow-xl shadow-black/10"
                >
                  Join Slate for Free
                  <ArrowRight className="w-5 h-5" />
                </Link>
                <Link
                  href="/"
                  className="px-8 py-4 bg-violet-500/20 text-white font-bold rounded-2xl border border-white/20 hover:bg-violet-500/30 transition-all"
                >
                  Learn More
                </Link>
              </div>
            </div>

            <div className="w-full md:w-1/3 flex flex-col gap-4">
              {[
                { icon: Sparkles, text: "AI-Powered Learning" },
                { icon: Trophy, text: "Global Hall of Fame" },
                { icon: User, text: "Expert AI Tutors" }
              ].map((item, i) => (
                <div key={i} className="bg-white/10 backdrop-blur-md rounded-2xl p-4 border border-white/10 flex items-center gap-4">
                  <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                    <item.icon className="w-5 h-5 text-white" />
                  </div>
                  <span className="text-white font-bold">{item.text}</span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </main>

      {/* Standard Footer */}
      <footer className="relative z-10 py-12 border-t border-slate-900 text-center print:hidden">
        <p className="text-slate-500 text-sm">
          &copy; {new Date().getFullYear()} Slate Academy. All certificates are cryptographically verified.
        </p>
      </footer>
    </div>
  );
}
