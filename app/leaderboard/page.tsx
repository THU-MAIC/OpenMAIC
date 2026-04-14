'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Trophy, 
  MapPin, 
  Globe, 
  ArrowLeft, 
  Medal, 
  ChevronRight, 
  Loader2,
  Search,
  Users
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/hooks/use-auth';
import { cn } from '@/lib/utils';
import { COUNTRY_NAMES } from '@/lib/analytics/geo';

interface LeaderboardEntry {
  user_id: string;
  display_name: string;
  avatar_url: string;
  total_score: number;
  quizzes_completed: number;
  country_code: string;
  country_name: string;
  rank: number;
}

export default function LeaderboardPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [tab, setTab] = useState<'global' | 'local'>('global');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<LeaderboardEntry[]>([]);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [detectedCountry, setDetectedCountry] = useState<string | null>(null);

  // Auth redirect
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/auth/login?redirect=/leaderboard');
    }
  }, [user, authLoading, router]);

  // Fetch data when tab or selected country changes
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        let url = `/api/leaderboard?type=${tab}`;
        if (tab === 'local' && selectedCountry) {
          url += `&country=${selectedCountry}`;
        }
        
        const res = await fetch(url);
        const json = await res.json();
        if (json.success) {
          setData(json.leaderboard);
          if (json.meta.countryCode && !detectedCountry) {
            setDetectedCountry(json.meta.countryCode);
          }
        }
      } catch (err) {
        console.error('Leaderboard fetch error:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [tab, selectedCountry, detectedCountry]);

  const topThree = data.slice(0, 3);
  const restOfList = data.slice(3);

  return (
    <div className="min-h-screen bg-[#f8fafc] text-[#073b4c] font-sans">
      {/* Premium Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b-[3px] border-[#073b4c] px-4 py-4 md:px-8">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => router.push('/')}
              className="p-2 rounded-xl border-2 border-[#073b4c] hover:bg-[#f0f4f8] transition-all shadow-[2px_2px_0_#073b4c] active:translate-y-[1px] active:shadow-none"
            >
              <ArrowLeft className="size-5" />
            </button>
            <div>
              <h1 className="text-xl md:text-2xl font-black uppercase tracking-tight">Hall of Fame</h1>
              <p className="text-[10px] md:text-xs font-bold text-[#073b4c]/50 uppercase tracking-widest">Slate Global Rankings</p>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-2 px-4 py-2 bg-[#f0f4f8] rounded-2xl border-2 border-[#073b4c]/10">
            <Users className="size-4 text-[#118ab2]" />
            <span className="text-xs font-bold text-[#073b4c]/60">12,402 Active Students</span>
          </div>
        </div>
      </header>
222: 
      <main className="max-w-5xl mx-auto px-4 py-8 md:py-12">
        {authLoading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="size-12 animate-spin text-[#118ab2] mb-4" />
            <p className="font-black text-[#073b4c]/40 uppercase tracking-widest">Verifying Rank Access...</p>
          </div>
        ) : (
          <>
            {/* Tab Selection */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-6 mb-12">
          <div className="flex p-1.5 bg-white border-[3px] border-[#073b4c] rounded-2xl shadow-[4px_4px_0_#073b4c]">
            <button
              onClick={() => { setTab('global'); setSelectedCountry(null); }}
              className={cn(
                "flex items-center gap-2 px-6 py-2.5 rounded-xl font-black text-sm transition-all",
                tab === 'global' ? "bg-[#073b4c] text-white" : "text-[#073b4c]/60 hover:text-[#073b4c]"
              )}
            >
              <Globe className="size-4" />
              GLOBAL
            </button>
            <button
              onClick={() => setTab('local')}
              className={cn(
                "flex items-center gap-2 px-6 py-2.5 rounded-xl font-black text-sm transition-all",
                tab === 'local' ? "bg-[#073b4c] text-white" : "text-[#073b4c]/60 hover:text-[#073b4c]"
              )}
            >
              <MapPin className="size-4" />
              LOCAL
            </button>
          </div>

          {tab === 'local' && (
            <div className="flex items-center gap-3">
              <span className="text-xs font-black uppercase text-[#073b4c]/40 tracking-widest">Region:</span>
              <select 
                value={selectedCountry || detectedCountry || ''} 
                onChange={(e) => setSelectedCountry(e.target.value)}
                className="bg-white border-[3px] border-[#073b4c] rounded-xl px-4 py-2 font-bold text-sm shadow-[3px_3px_0_#073b4c] outline-none cursor-pointer"
              >
                {Object.entries(COUNTRY_NAMES).sort((a,b) => a[1].localeCompare(b[1])).map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="size-12 animate-spin text-[#118ab2] mb-4" />
            <p className="font-black text-[#073b4c]/40 uppercase tracking-widest">Synchronizing Ranks...</p>
          </div>
        ) : (
          <div className="animate__animated animate__fadeIn">
            {/* Podium */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12 items-end">
              {/* 2nd Place */}
              <div className="order-2 md:order-1">
                {topThree[1] && <PodiumCard entry={topThree[1]} place={2} color="#cbd5e1" />}
              </div>
              {/* 1st Place */}
              <div className="order-1 md:order-2 scale-105 md:scale-110 mb-4 md:mb-8">
                {topThree[0] && <PodiumCard entry={topThree[0]} place={1} color="#ffd166" />}
              </div>
              {/* 3rd Place */}
              <div className="order-3">
                {topThree[2] && <PodiumCard entry={topThree[2]} place={3} color="#cd7f32" />}
              </div>
            </div>

            {/* List */}
            <div className="bg-white border-[4px] border-[#073b4c] rounded-[40px] shadow-[8px_8px_0_#073b4c] overflow-hidden mb-12">
              <div className="hidden md:grid grid-cols-12 gap-4 px-8 py-4 bg-[#f0f4f8] border-b-[4px] border-[#073b4c] text-[10px] font-black uppercase tracking-widest text-[#073b4c]/40">
                <div className="col-span-1 text-center">Rank</div>
                <div className="col-span-6">Student</div>
                <div className="col-span-2 text-center">Quizzes</div>
                <div className="col-span-3 text-right">Total Score</div>
              </div>
              
              <div className="divide-y-[3px] divide-[#073b4c]/10">
                {restOfList.length > 0 ? restOfList.map((entry) => (
                  <RankRow key={entry.user_id} entry={entry} isMe={user?.id === entry.user_id} />
                )) : (
                  <div className="py-12 text-center text-[#073b4c]/30 font-bold">
                    No students ranked in this region yet.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function PodiumCard({ entry, place, color }: { entry: LeaderboardEntry, place: number, color: string }) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: place * 0.1 }}
      className="flex flex-col items-center"
    >
      <div className="relative group">
        <div 
          className="size-24 md:size-32 rounded-3xl border-[4px] border-[#073b4c] overflow-hidden shadow-[6px_6px_0_#073b4c] group-hover:translate-x-[-2px] group-hover:translate-y-[-2px] transition-all"
          style={{ backgroundColor: `${color}20` }}
        >
          {entry.avatar_url ? (
            <img src={entry.avatar_url} alt="" className="size-full object-cover" />
          ) : (
            <div className="size-full flex items-center justify-center text-3xl font-black text-[#073b4c]/20">
              {entry.display_name.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>
        <div 
          className="absolute -bottom-4 left-1/2 -translate-x-1/2 size-10 md:size-12 rounded-2xl border-[3px] border-[#073b4c] flex items-center justify-center shadow-[3px_3px_0_#073b4c]"
          style={{ backgroundColor: color }}
        >
          {place === 1 ? <Trophy className="size-5 md:size-6 text-[#073b4c]" /> : <span className="text-lg md:text-xl font-black">{place}</span>}
        </div>
      </div>
      
      <div className="mt-8 text-center">
        <h3 className="text-base md:text-lg font-black truncate max-w-[150px]">{entry.display_name}</h3>
        <div className="flex items-center justify-center gap-1.5 mt-1">
          <span className="text-[10px] md:text-xs font-black uppercase text-[#073b4c]/40">{entry.country_name}</span>
        </div>
        <div className="mt-3 px-4 py-1.5 bg-[#ef476f] text-white rounded-full border-2 border-[#073b4c] shadow-[3px_3px_0_#073b4c] font-black text-sm md:text-base">
          {entry.total_score.toLocaleString()} <span className="text-[10px] uppercase">pts</span>
        </div>
      </div>
    </motion.div>
  );
}

function RankRow({ entry, isMe }: { entry: LeaderboardEntry, isMe: boolean }) {
  return (
    <div className={cn(
      "grid grid-cols-7 md:grid-cols-12 gap-4 items-center px-4 md:px-8 py-4 md:py-6 transition-colors",
      isMe ? "bg-[#ffd166]/20" : "hover:bg-[#f8fafc]"
    )}>
      <div className="col-span-1 text-center">
        <span className="text-sm md:text-lg font-black text-[#073b4c]/30">#{entry.rank}</span>
      </div>
      
      <div className="col-span-4 md:col-span-6 flex items-center gap-3 md:gap-5">
        <div className="size-10 md:size-14 rounded-2xl border-[3px] border-[#073b4c] overflow-hidden bg-[#f0f4f8] shadow-[3px_3px_0_#073b4c] shrink-0">
          {entry.avatar_url ? (
            <img src={entry.avatar_url} alt="" className="size-full object-cover" />
          ) : (
            <div className="size-full flex items-center justify-center text-lg font-black text-[#073b4c]/20">
              {entry.display_name.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm md:text-base font-black truncate">
            {entry.display_name} {isMe && <span className="ml-2 text-[10px] bg-[#073b4c] text-white px-1.5 py-0.5 rounded-md uppercase tracking-tighter">You</span>}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5 md:mt-1">
             <MapPin className="size-2.5 text-[#118ab2]" />
             <span className="text-[10px] md:text-xs font-bold text-[#073b4c]/50 uppercase">{entry.country_name}</span>
          </div>
        </div>
      </div>

      <div className="hidden md:block md:col-span-2 text-center text-sm font-bold text-[#073b4c]/60">
        {entry.quizzes_completed}
      </div>

      <div className="col-span-2 md:col-span-3 text-right">
        <p className="text-base md:text-xl font-black text-[#ef476f] tracking-tight">{entry.total_score.toLocaleString()}</p>
        <p className="text-[9px] md:text-[10px] font-black text-[#073b4c]/30 uppercase tracking-widest mt-[-2px]">Experience Pts</p>
      </div>
    </div>
  );
}
