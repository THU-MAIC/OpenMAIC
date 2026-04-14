'use client';

import React, { useEffect, useState } from 'react';
import { 
  MessageSquare, 
  Bug, 
  Lightbulb, 
  HelpCircle, 
  ExternalLink,
  Calendar,
  User,
  Mail,
  Filter,
  ArrowLeft,
  Loader2,
  AlertCircle,
  Eye
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '@/lib/hooks/use-auth';

interface Feedback {
  id: string;
  created_at: string;
  user_email: string | null;
  type: 'bug' | 'feature' | 'other';
  content: string;
  screenshot_url: string | null;
  url: string | null;
  metadata: any;
}

export default function ReadFeedbacksPage() {
  const [feedbacks, setFeedbacks] = useState<Feedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'bug' | 'feature' | 'other'>('all');
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const ADMIN_EMAIL = 'chalk.core@gmail.com';

  useEffect(() => {
    if (!authLoading && (!user || user.email !== ADMIN_EMAIL)) {
      router.push('/');
    }
  }, [user, authLoading, router]);

  const fetchFeedbacks = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/feedback');
      const data = await response.json();
      if (data.success) {
        setFeedbacks(data.feedbacks);
      } else {
        throw new Error(data.error || 'Failed to fetch feedbacks');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.email === ADMIN_EMAIL) {
      fetchFeedbacks();
    }
  }, [user]);

  const filteredFeedbacks = feedbacks.filter(f => filter === 'all' || f.type === filter);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-8">
        <Loader2 className="w-10 h-10 animate-spin text-indigo-500 mb-4" />
        <p className="text-slate-500 dark:text-slate-400 font-medium">Loading feedback dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-8">
        <AlertCircle className="w-12 h-12 text-rose-500 mb-4" />
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">Oops!</h1>
        <p className="text-slate-500 dark:text-slate-400 mb-6">{error}</p>
        <Button onClick={() => fetchFeedbacks()}>Try Again</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <button 
              onClick={() => router.push('/')}
              className="flex items-center gap-2 text-sm text-slate-500 hover:text-indigo-500 transition-colors mb-2"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </button>
            <h1 className="text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight flex items-center gap-3">
              Feedback Dashboard
              <Badge variant="secondary" className="bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                ADMIN
              </Badge>
            </h1>
            <p className="text-slate-500 dark:text-slate-400">
              Manage and review feedbacks from Slate users.
            </p>
          </div>

          <div className="flex items-center gap-2 bg-white dark:bg-slate-900 p-1.5 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800">
            {[
              { id: 'all', label: 'All', icon: MessageSquare },
              { id: 'bug', label: 'Bugs', icon: Bug },
              { id: 'feature', label: 'Features', icon: Lightbulb },
              { id: 'other', label: 'Other', icon: HelpCircle },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setFilter(item.id as any)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all",
                  filter === item.id 
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/30" 
                    : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                )}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* Dashboard Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-white dark:bg-slate-900 border-none shadow-sm overflow-hidden">
            <div className="h-1 bg-indigo-500 w-full" />
            <CardHeader className="p-4">
              <CardTitle className="text-sm font-medium text-slate-500">Total Feedbacks</CardTitle>
              <p className="text-3xl font-bold">{feedbacks.length}</p>
            </CardHeader>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-none shadow-sm overflow-hidden">
            <div className="h-1 bg-rose-500 w-full" />
            <CardHeader className="p-4">
              <CardTitle className="text-sm font-medium text-slate-500">Active Bugs</CardTitle>
              <p className="text-3xl font-bold text-rose-500">{feedbacks.filter(f => f.type === 'bug').length}</p>
            </CardHeader>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-none shadow-sm overflow-hidden">
            <div className="h-1 bg-amber-500 w-full" />
            <CardHeader className="p-4">
              <CardTitle className="text-sm font-medium text-slate-500">Feature Requests</CardTitle>
              <p className="text-3xl font-bold text-amber-500">{feedbacks.filter(f => f.type === 'feature').length}</p>
            </CardHeader>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-none shadow-sm overflow-hidden">
            <div className="h-1 bg-blue-500 w-full" />
            <CardHeader className="p-4">
              <CardTitle className="text-sm font-medium text-slate-500">Other</CardTitle>
              <p className="text-3xl font-bold text-blue-500">{feedbacks.filter(f => f.type === 'other').length}</p>
            </CardHeader>
          </Card>
        </div>

        {/* Feedback List */}
        <div className="grid grid-cols-1 gap-6 pb-20">
          <AnimatePresence mode="popLayout">
            {filteredFeedbacks.length > 0 ? (
              filteredFeedbacks.map((f) => (
                <motion.div
                  key={f.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                >
                  <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden group hover:shadow-md transition-shadow">
                    <CardContent className="p-0 flex flex-col md:flex-row">
                      {/* Content Area */}
                      <div className="flex-1 p-6 space-y-4 border-r border-slate-100 dark:border-slate-800">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                             {f.type === 'bug' && <Badge variant="destructive" className="flex items-center gap-1 uppercase text-[10px] tracking-wider"><Bug className="w-3 h-3" /> Bug</Badge>}
                             {f.type === 'feature' && <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 flex items-center gap-1 uppercase text-[10px] tracking-wider border-none"><Lightbulb className="w-3 h-3" /> Feature</Badge>}
                             {f.type === 'other' && <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 flex items-center gap-1 uppercase text-[10px] tracking-wider border-none"><HelpCircle className="w-3 h-3" /> Other</Badge>}
                             <span className="text-slate-400 text-xs flex items-center gap-1">
                               <Calendar className="w-3 h-3" />
                               {new Date(f.created_at).toLocaleString()}
                             </span>
                          </div>
                        </div>

                        <p className="text-slate-800 dark:text-slate-200 text-lg leading-relaxed whitespace-pre-wrap">
                          {f.content}
                        </p>

                        <div className="flex flex-wrap items-center gap-4 pt-4 border-t border-slate-50 dark:border-slate-800">
                          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                            <Mail className="w-3.5 h-3.5" />
                            {f.user_email || 'Anonymous'}
                          </div>
                          {f.url && (
                            <a 
                              href={f.url} 
                              target="_blank" 
                              rel="noreferrer" 
                              className="flex items-center gap-2 text-xs font-medium text-indigo-500 hover:underline"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                              View Page
                            </a>
                          )}
                        </div>
                      </div>

                      {/* Screenshot Area */}
                      {f.screenshot_url && (
                        <div className="w-full md:w-[300px] bg-slate-50 dark:bg-slate-900/50 p-4 flex flex-col items-center justify-center relative group/img">
                          <div className="relative rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm transition-transform group-hover/img:scale-[1.02]">
                             <img 
                               src={f.screenshot_url} 
                               alt="Feedback screenshot" 
                               className="w-full h-auto max-h-[300px] md:max-h-[200px] object-cover cursor-pointer"
                               onClick={() => window.open(f.screenshot_url!, '_blank')}
                             />
                             <div className="absolute inset-0 bg-black/20 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
                               <Button variant="secondary" size="sm" asChild>
                                 <a href={f.screenshot_url} target="_blank" rel="noreferrer">
                                   <Eye className="w-4 h-4 mr-2" />
                                   Enlarge
                                 </a>
                               </Button>
                             </div>
                          </div>
                          <span className="text-[10px] text-slate-400 mt-2 font-medium uppercase tracking-widest">Screenshot Attached</span>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              ))
            ) : (
              <div className="py-20 flex flex-col items-center justify-center text-slate-400 space-y-4 bg-white dark:bg-slate-900 rounded-3xl border border-dashed border-slate-200 dark:border-slate-800">
                <MessageSquare className="w-12 h-12 opacity-20" />
                <p className="text-lg font-medium">No feedbacks found matching "{filter}"</p>
                <Button variant="outline" onClick={() => setFilter('all')}>View All</Button>
              </div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
