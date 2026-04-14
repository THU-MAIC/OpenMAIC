'use client';

import { useEffect, useState } from 'react';
import { Trophy, Medal, MapPin, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/hooks/use-auth';

interface LeaderboardEntry {
  user_id: string;
  display_name: string;
  avatar_url: string;
  total_score: number;
  quizzes_completed: number;
  country_code: string;
  rank: number;
}

interface LeaderboardCardProps {
  type?: 'global' | 'local';
  limit?: number;
  className?: string;
}

export function LeaderboardCard({ type = 'global', limit = 5, className }: LeaderboardCardProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<LeaderboardEntry[]>([]);
  const { user } = useAuth();

  useEffect(() => {
    async function fetchLeaderboard() {
      try {
        const res = await fetch(`/api/leaderboard?type=${type}&limit=${limit}`);
        if (res.ok) {
          const json = await res.json();
          setData(json.leaderboard || []);
        }
      } catch (err) {
        console.error('Failed to fetch leaderboard:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchLeaderboard();
  }, [type, limit]);

  if (loading) {
    return (
      <div className={cn("flex flex-col items-center justify-center p-8 bg-white dark:bg-slate-900 rounded-3xl border-[3px] border-[#073b4c]", className)}>
        <Loader2 className="size-6 animate-spin text-[#118ab2] mb-2" />
        <p className="text-xs font-bold text-[#073b4c]/40">Loading ranking...</p>
      </div>
    );
  }

  return (
    <div className={cn("bg-white dark:bg-slate-900 rounded-3xl border-[3px] border-[#073b4c] shadow-[4px_4px_0_#073b4c] overflow-hidden", className)}>
      <div className="bg-[#f0f4f8] border-b-[3px] border-[#073b4c] px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Trophy className="size-4 text-[#ffd166]" />
          <h3 className="text-xs font-black uppercase tracking-wider text-[#073b4c]">
            {type === 'global' ? 'Global Top' : 'Local Top'}
          </h3>
        </div>
        <span className="text-[10px] font-bold text-[#073b4c]/40">Top {limit}</span>
      </div>

      <div className="divide-y-[2px] divide-[#073b4c]/10">
        <AnimatePresence mode="popLayout">
          {data.map((entry) => {
            const isMe = user?.id === entry.user_id;
            return (
              <motion.div
                key={entry.user_id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 transition-colors",
                  isMe ? "bg-[#ffd166]/20" : "hover:bg-[#f0f4f8]"
                )}
              >
                <div className="w-6 flex justify-center shrink-0">
                  {entry.rank === 1 ? (
                    <Trophy className="size-4 text-[#ffd166]" />
                  ) : entry.rank === 2 ? (
                    <Medal className="size-4 text-[#cbd5e1]" />
                  ) : entry.rank === 3 ? (
                    <Medal className="size-4 text-[#cd7f32]" />
                  ) : (
                    <span className="text-xs font-black text-[#073b4c]/30">{entry.rank}</span>
                  )}
                </div>

                <div className="size-8 rounded-full border-2 border-[#073b4c] overflow-hidden bg-[#f0f4f8] shrink-0">
                  {entry.avatar_url ? (
                    <img src={entry.avatar_url} alt="" className="size-full object-cover" />
                  ) : (
                    <div className="size-full bg-[#118ab2] flex items-center justify-center text-[10px] font-black text-white">
                      {entry.display_name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-[#073b4c] truncate">
                    {entry.display_name} {isMe && "(You)"}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] font-bold text-[#073b4c]/50">
                      {entry.quizzes_completed} quizzes
                    </span>
                    {entry.country_code !== 'XX' && (
                      <span className="text-[10px] text-[#073b4c]/30 flex items-center gap-0.5">
                        <MapPin className="size-2" /> {entry.country_code}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-right">
                  <p className="text-xs font-black text-[#ef476f]">{entry.total_score}</p>
                  <p className="text-[9px] font-bold text-[#073b4c]/40 uppercase tracking-tighter">pts</p>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
