'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Trophy, Star, Award, Share2, Download, X, CheckCircle2, Copy } from 'lucide-react';
import { CertificateCard } from './certificate-card';
import { calculateGrade, LetterGrade } from '@/lib/utils/grading';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface CongratulationsPopupProps {
  isOpen: boolean;
  onClose: () => void;
  studentName: string;
  courseName: string;
  courseId: string;
  stats: {
    slidesViewed: number;
    totalSlides: number;
    quizScoreAverage: number;
    engagementCount: number;
    topics?: string[];
  };
}

export function CongratulationsPopup({
  isOpen,
  onClose,
  studentName,
  courseName,
  courseId,
  stats,
}: CongratulationsPopupProps) {
  const [isClaiming, setIsClaiming] = useState(false);
  const [certificateId, setCertificateId] = useState<string | null>(null);
  
  const result = calculateGrade(stats);
  const topics = stats.topics || ["Course Mastery", "Topic Discovery"];

  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  // Fallback safe save PDF routine using html-to-image + jsPDF
  const handleSavePdf = async () => {
    setIsGeneratingPdf(true);
    try {
      // Load both libraries
      await Promise.all([
        new Promise((resolve, reject) => {
          if ((window as any).htmlToImage) return resolve(null);
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js';
          script.onload = resolve;
          script.onerror = reject;
          document.body.appendChild(script);
        }),
        new Promise((resolve, reject) => {
          if ((window as any).jspdf) return resolve(null);
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.body.appendChild(script);
        })
      ]);
      
      const element = document.getElementById('certificate-download');
      if (!element) throw new Error('Certificate element not found');

      // Small delay for rendering
      await new Promise(r => setTimeout(r, 500));
      
      const { toJpeg } = (window as any).htmlToImage;
      const { jsPDF } = (window as any).jspdf;

      // Capture high-quality but compressed JPEG to keep file size small
      const dataUrl = await toJpeg(element, { 
        quality: 0.8,
        pixelRatio: 2, // 2x is plenty for high-quality print while keeping size in check
        backgroundColor: '#ffffff',
        style: {
          transform: 'scale(1)',
          transformOrigin: 'top left'
        }
      });
      
      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a4'
      });

      const imgProps = pdf.getImageProperties(dataUrl);
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
      
      pdf.addImage(dataUrl, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
      pdf.save(`Slate_Certificate_${studentName.replace(/[^a-z0-9]/gi, '_')}.pdf`);
      
      toast.success('Certificate downloaded successfully!');
    } catch (err) {
      console.error('PDF Generation Error:', err);
      toast.error('Direct PDF export failed. Falling back to Print system.');
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const handleClaim = async () => {
    setIsClaiming(true);
    try {
      const response = await fetch('/api/certificates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId,
          courseName,
          studentName,
          grade: result.grade,
          score: result.score,
          topics,
          watchTimePercentage: result.breakdown.completion,
          quizScoreAverage: result.breakdown.quiz,
          engagementCount: stats.engagementCount,
        }),
      });

      if (!response.ok) throw new Error('Failed to claim certificate');
      
      const json = await response.json();
      setCertificateId(json.id);
      toast.success('Certificate claimed successfully!');
    } catch (err) {
      console.error(err);
      toast.error('Could not claim certificate. Please try again.');
    } finally {
      setIsClaiming(false);
    }
  };

  const shareLink = certificateId ? `${window.location.origin}/c/${certificateId}` : '';

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareLink);
    toast.success('Link copied to clipboard!');
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-slate-950/80 backdrop-blur-md print:hidden"
        />

        {/* Modal Content */}
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          className="relative w-[95vw] max-w-[1200px] bg-white dark:bg-slate-900 rounded-[40px] shadow-2xl overflow-hidden border border-slate-200/50 dark:border-slate-800/50 print:border-none print:shadow-none print:w-full print:max-w-none print:overflow-visible print:bg-transparent dark:print:bg-transparent print:m-0 print:rounded-none"
        >
          <div className="absolute top-6 right-6 z-50 print:hidden">
            <button onClick={onClose} className="p-2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex flex-col h-full max-h-[90vh] overflow-y-auto overflow-x-hidden print:overflow-visible print:max-h-none print:block">
            
            {/* Single Column: Certificate Preview & Actions */}
            <div className="flex-1 p-6 md:p-10 flex flex-col items-center justify-start print:p-0 print:block w-full">
              <div id="certificate-download" className="relative w-full max-w-[1000px] flex-1 min-h-0 flex flex-col justify-start mb-8 print:max-w-none print:w-[297mm] print:mb-0 print:mx-auto">
                <CertificateCard
                  studentName={studentName}
                  courseName={courseName}
                  grade={result.grade}
                  score={result.score}
                  date={new Date().toLocaleDateString()}
                  topics={topics}
                  breakdown={result.breakdown}
                />
              </div>

              <div className="mt-auto flex flex-col gap-4 print:hidden w-full max-w-[800px]">
                {!certificateId ? (
                  <button
                    onClick={handleClaim}
                    disabled={isClaiming}
                    className="w-full h-14 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white font-bold rounded-2xl shadow-xl shadow-violet-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-3"
                  >
                    {isClaiming ? (
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <>
                        <Award className="w-5 h-5" />
                        Claim My Certificate
                      </>
                    )}
                  </button>
                ) : (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <button
                        onClick={handleCopyLink}
                        className="h-14 bg-slate-50 hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 font-bold rounded-2xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 text-sm shadow-sm"
                        title="Copy Share Link"
                      >
                        <Copy className="w-4 h-4 text-slate-400" />
                        Copy Link
                      </button>
                      <button
                        onClick={async () => {
                          if (navigator.share) {
                            try {
                              await navigator.share({
                                title: 'My Slate Certificate',
                                text: `I just completed "${courseName}" on Slate Academy!`,
                                url: shareLink
                              });
                            } catch (err: any) {
                              if (err.name !== 'AbortError') {
                                console.error('Error sharing certificate:', err);
                              }
                            }
                          } else {
                            handleCopyLink();
                          }
                        }}
                        className="h-14 bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-700/50 font-bold rounded-2xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 text-sm"
                        title="Share Certificate"
                      >
                        <Share2 className="w-4 h-4" />
                        Share
                      </button>
                      <button
                        onClick={handleSavePdf}
                        disabled={isGeneratingPdf}
                        className="h-14 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold rounded-2xl shadow-xl shadow-emerald-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2 text-sm"
                      >
                        {isGeneratingPdf ? (
                           <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                           <Download className="w-4 h-4" />
                        )}
                        {isGeneratingPdf ? 'Generating PDF...' : 'Save PDF'}
                      </button>
                    </div>
                    <p className="text-center text-xs text-slate-400 mt-2">
                       Your certificate is now public and can be shared with anyone.
                    </p>
                  </div>
                )}
                
                <button
                  onClick={onClose}
                  className="text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 uppercase tracking-widest py-2"
                >
                  I'll do this later
                </button>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Floating Celebration Particles */}
        <div className="print:hidden">
          <CelebrationParticles />
        </div>
      </div>
    </AnimatePresence>
  );
}

function CelebrationParticles() {
  const particles = Array.from({ length: 20 });
  const icons = [Star, Trophy, Award];

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {particles.map((_, i) => {
        const Icon = icons[i % icons.length];
        const x = Math.random() * 100;
        const delay = Math.random() * 2;
        const duration = 2 + Math.random() * 2;
        const size = 16 + Math.random() * 16;

        return (
          <motion.div
            key={i}
            initial={{ y: '110vh', x: `${x}vw`, rotate: 0, opacity: 0 }}
            animate={{ 
              y: '-10vh', 
              rotate: 360,
              opacity: [0, 1, 1, 0]
            }}
            transition={{ 
              duration, 
              delay, 
              repeat: Infinity,
              ease: "linear"
            }}
            className="absolute text-yellow-400/40"
            style={{ width: size, height: size }}
          >
            <Icon className="w-full h-full" />
          </motion.div>
        );
      })}
    </div>
  );
}
