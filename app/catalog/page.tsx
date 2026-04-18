'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  Search,
  Filter,
  ChevronLeft,
  BookOpen,
  Users,
  ArrowRight,
  Loader2,
  X,
  Sparkles
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { setPendingIntroPayload } from '@/lib/classroom/pending-intro';

interface Course {
  id: string;
  title: string;
  headline?: string;
  description: string;
  slideCount: number;
  language: string;
  createdAt: string;
  tags: {
    subject?: string;
    age_range?: string;
    topic?: string;
    sub_topic?: string;
  };
}

const SUBJECTS = ['All', 'Mathematics', 'Science', 'History', 'Language Arts', 'Technology', 'Art', 'Music', 'Business'];
const AGE_RANGES = ['All', '5-10', '11-14', '15-18', '18+'];

function CatalogPageContent() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(searchParams.get('q') || '');
  const [selectedSubject, setSelectedSubject] = useState(searchParams.get('subject') || 'All');
  const [selectedAge, setSelectedAge] = useState(searchParams.get('age_range') || 'All');
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  useEffect(() => {
    fetchCatalog();
  }, [selectedSubject, selectedAge]);

  const fetchCatalog = async (q?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (selectedSubject !== 'All') params.set('subject', selectedSubject);
      if (selectedAge !== 'All') {
        const [min] = selectedAge.replace('+', '-99').split('-');
        params.set('age', min); // Simple mapping for the API
      }

      const res = await fetch(`/api/catalog?${params.toString()}`);
      const json = await res.json();
      if (json.success) {
        setCourses(json.courses);
      }
    } catch (err) {
      console.error('Failed to fetch catalog:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchCatalog(searchQuery);
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* ── Navigation Header ── */}
      <header className="sticky top-0 z-40 w-full bg-white/80 dark:bg-slate-950/80 backdrop-blur-md border-b-[3px] border-[#073b4c]">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => router.push('/')}
            className="group flex items-center gap-2 font-bold text-[#073b4c] hover:bg-[#f0f4f8]"
          >
            <ChevronLeft className="size-5 transition-transform group-hover:-translate-x-1" />
            <span>{t('common.back')}</span>
          </Button>

          <div className="flex items-center gap-2">
            <h1 className="text-xl md:text-2xl font-black text-[#073b4c] tracking-tight uppercase">
              Course Catalog
            </h1>
            <Sparkles className="size-5 text-[#ef476f]" />
          </div>

          <div className="w-20" /> {/* Spacer */}
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8">
        {/* ── Hero & Search Section ── */}
        <section className="mb-12 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-3xl mx-auto"
          >
            {/* <h2 className="text-4xl md:text-5xl font-black text-[#073b4c] mb-6 leading-tight">
              What do you want to <span className="text-[#ef476f] underline decoration-[6px]">learn</span> today?
            </h2> */}

            <form onSubmit={handleSearch} className="relative group max-w-2xl mx-auto">
              <div className="relative flex items-center">
                <Search className="absolute left-4 size-5 text-[#073b4c]/40 group-focus-within:text-[#073b4c] transition-colors" />
                <Input
                  type="text"
                  placeholder="Search courses by topic, title, or keywords..."
                  className="h-14 pl-12 pr-4 text-lg font-medium border-[3px] border-[#073b4c] rounded-2xl shadow-[6px_6px_0_#073b4c] focus-visible:ring-0 focus-visible:shadow-[8px_8px_0_#073b4c] transition-all"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <Button
                  type="submit"
                  className="absolute right-2 h-10 px-6 bg-[#ef476f] hover:bg-[#ef476f]/90 text-white font-bold rounded-xl border-2 border-[#073b4c] shadow-[3px_3px_0_#073b4c] active:shadow-none active:translate-x-[3px] active:translate-y-[3px] transition-all"
                >
                  Search
                </Button>
              </div>
            </form>
          </motion.div>
        </section>

        <div className="flex flex-col md:flex-row gap-8">
          {/* ── Desktop Filters Sidebar ── */}
          <aside className="hidden md:block w-64 space-y-8">
            <div>
              <h3 className="text-lg font-black text-[#073b4c] mb-4 uppercase tracking-wider flex items-center gap-2">
                <Filter className="size-4" />
                Subjects
              </h3>
              <div className="flex flex-col gap-2">
                {SUBJECTS.map((sub) => (
                  <button
                    key={sub}
                    onClick={() => setSelectedSubject(sub)}
                    className={cn(
                      "px-4 py-2 text-left font-bold rounded-xl border-2 transition-all",
                      selectedSubject === sub
                        ? "bg-[#ffd166] text-[#073b4c] border-[#073b4c] shadow-[4px_4px_0_#073b4c]"
                        : "bg-white text-[#073b4c]/60 border-transparent hover:border-[#073b4c]/20"
                    )}
                  >
                    {sub}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-lg font-black text-[#073b4c] mb-4 uppercase tracking-wider flex items-center gap-2">
                <Users className="size-4" />
                Age Range
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {AGE_RANGES.map((age) => (
                  <button
                    key={age}
                    onClick={() => setSelectedAge(age)}
                    className={cn(
                      "px-3 py-2 text-center text-sm font-bold rounded-xl border-2 transition-all",
                      selectedAge === age
                        ? "bg-[#118ab2] text-white border-[#073b4c] shadow-[4px_4px_0_#073b4c]"
                        : "bg-white text-[#073b4c]/60 border-transparent hover:border-[#073b4c]/20"
                    )}
                  >
                    {age}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          {/* ── Mobile Filters Toggle ── */}
          <div className="md:hidden flex gap-2 overflow-x-auto pb-4 no-scrollbar">
            <Button
              variant="outline"
              onClick={() => setIsFilterOpen(!isFilterOpen)}
              className="shrink-0 border-2 border-[#073b4c] font-bold"
            >
              <Filter className="size-4 mr-2" />
              Filters
            </Button>
            {/* Quick access dots or counts could go here */}
          </div>

          {/* ── Course Grid ── */}
          <div className="flex-1">
            {loading ? (
              <div className="h-64 flex flex-col items-center justify-center">
                <Loader2 className="size-10 text-[#118ab2] animate-spin mb-4" />
                <p className="font-bold text-[#073b4c]/60">Scanning library...</p>
              </div>
            ) : courses.length > 0 ? (
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                {courses.map((course, i) => (
                  <CourseCard
                    key={course.id}
                    course={course}
                    index={i}
                    onClick={() => {
                      setPendingIntroPayload({
                        stageId: course.id,
                        name: course.title,
                        description: course.description,
                        language: course.language,
                      });
                      router.push(`/classroom/${course.id}`);
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="h-96 flex flex-col items-center justify-center border-[3px] border-dashed border-[#073b4c]/20 rounded-3xl">
                <div className="size-20 bg-slate-100 rounded-full flex items-center justify-center mb-6">
                  <BookOpen className="size-10 text-[#073b4c]/20" />
                </div>
                <h3 className="text-2xl font-black text-[#073b4c] mb-2">No courses found</h3>
                <p className="text-[#073b4c]/60 font-medium">Try adjusting your filters or search term</p>
                <Button
                  variant="link"
                  onClick={() => {
                    setSelectedSubject('All');
                    setSelectedAge('All');
                    setSearchQuery('');
                    fetchCatalog('');
                  }}
                  className="mt-4 font-bold text-[#ef476f]"
                >
                  Clear all filters
                </Button>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ── Footer ── */}
      <footer className="mt-20 border-t-[3px] border-[#073b4c] bg-[#073b4c] py-12 text-white">
        <div className="container mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-8">
          <div>
            <h2 className="text-3xl font-black tracking-tighter mb-2">SLATE UP</h2>
            <p className="text-white/60 font-medium">The future of interactive learning, powered by AI.</p>
          </div>
          <div className="flex gap-6 font-bold uppercase tracking-widest text-sm">
            <a href="#" className="hover:text-[#ffd166] transition-colors">Catalog</a>
            <a href="#" className="hover:text-[#ef476f] transition-colors">Classroom</a>
            <a href="#" className="hover:text-[#06d6a0] transition-colors">Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function CatalogPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen flex-col items-center justify-center">
          <Loader2 className="size-10 animate-spin text-[#118ab2]" />
        </div>
      }
    >
      <CatalogPageContent />
    </Suspense>
  );
}

function CourseCard({ course, index, onClick }: { course: Course; index: number; onClick: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.05 }}
      whileHover={{ y: -8, x: -2 }}
      onClick={onClick}
      className="group cursor-pointer flex flex-col h-full bg-white border-[3px] border-[#073b4c] rounded-3xl overflow-hidden shadow-[6px_6px_0_#073b4c] hover:shadow-[10px_10px_0_#073b4c] transition-all"
    >
      {/* Thumbnail Placeholder */}
      <div className="h-40 bg-slate-100 border-b-[3px] border-[#073b4c] flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#ef476f]/5 to-[#118ab2]/5 group-hover:opacity-100 transition-opacity" />
        <BookOpen className="size-12 text-[#073b4c]/10 group-hover:scale-110 group-hover:text-[#073b4c]/20 transition-all duration-500" />

        {/* Course Meta Pills */}
        <div className="absolute bottom-3 left-3 flex flex-wrap gap-2">
          {course.tags.subject && (
            <span className="px-3 py-1 bg-[#ffd166] text-[#073b4c] text-[10px] font-black uppercase tracking-wider rounded-lg border-2 border-[#073b4c]">
              {course.tags.subject}
            </span>
          )}
          {course.tags.age_range && (
            <span className="px-3 py-1 bg-[#118ab2] text-white text-[10px] font-black uppercase tracking-wider rounded-lg border-2 border-[#073b4c]">
              Ages {course.tags.age_range}
            </span>
          )}
        </div>
      </div>

      <div className="p-6 flex-1 flex flex-col">
        <h3 className="text-xl font-black text-[#073b4c] mb-3 group-hover:text-[#ef476f] transition-colors line-clamp-2 leading-tight">
          {course.title}
        </h3>
        <p className="text-[#073b4c]/70 text-sm font-medium line-clamp-3 mb-6 flex-1">
          {course.headline || course.description}
        </p>

        <div className="pt-4 border-t-2 border-[#073b4c]/10 flex items-center justify-between mt-auto">
          <div className="flex items-center gap-2 text-xs font-black text-[#073b4c]/40 uppercase tracking-widest">
            <Users className="size-3" />
            <span>{course.slideCount} Slides</span>
          </div>

          <div className="size-8 bg-[#073b4c] rounded-full flex items-center justify-center text-white group-hover:bg-[#ef476f] transition-colors">
            <ArrowRight className="size-4" />
          </div>
        </div>
      </div>
    </motion.div>
  );
}
