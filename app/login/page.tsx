'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ExternalLink, Loader2, LogIn, RefreshCw, ShieldAlert, X } from 'lucide-react';

interface SessionInfo {
  ssoEnabled: boolean;
  connectUrl: string;
  connectOrigin: string;
  user: { nick?: string | null; role: string } | null;
}

type Phase = 'checking' | 'ready' | 'exchanging' | 'error' | 'unavailable';

function safeRedirect(raw: string | null): string {
  if (typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//')) {
    return raw;
  }
  return '/';
}

/**
 * The vendor's `redirect_uri` is the bare domain (`eduku.cn`), so the page
 * that posts `classai-login` may live on either `www.eduku.cn` or `eduku.cn`.
 * Accept both — same scheme/port, www prefix toggled.
 */
function allowedOrigins(origin: string): string[] {
  const list = [origin];
  try {
    const url = new URL(origin);
    const variant = url.host.startsWith('www.')
      ? url.origin.replace('//www.', '//')
      : url.origin.replace('//', '//www.');
    if (variant !== origin && !list.includes(variant)) list.push(variant);
  } catch {
    // Keep the configured origin only.
  }
  return list;
}

/** The vendor contract sends the code as `data.data`; tolerate `{code}` too. */
function extractCode(data: unknown): string | null {
  if (typeof data === 'string' && data.trim() !== '') return data.trim();
  if (data && typeof data === 'object') {
    const code = (data as Record<string, unknown>).code;
    if (typeof code === 'string' && code.trim() !== '') return code.trim();
  }
  return null;
}

function LoginCard() {
  const searchParams = useSearchParams();
  const redirect = searchParams.get('redirect');
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState<string | null>(null);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [showFrame, setShowFrame] = useState(false);
  const [frameNonce, setFrameNonce] = useState(0);
  const popupRef = useRef<Window | null>(null);
  const exchangeStartedRef = useRef(false);

  const exchange = useCallback(
    async (code: string) => {
      if (exchangeStartedRef.current) return;
      exchangeStartedRef.current = true;
      setPhase('exchanging');
      setError(null);
      // Close every login surface the moment the vendor code arrives: the
      // embedded form is removed and any popup is closed before the exchange
      // completes, so a slow network never leaves a stale login window open.
      setShowFrame(false);
      popupRef.current?.close();
      popupRef.current = null;
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const data = (await res.json()) as { success: boolean; error?: string };
        if (!res.ok || !data.success) {
          exchangeStartedRef.current = false;
          setPhase('error');
          setError(data.error || `登录失败 (HTTP ${res.status})`);
          return;
        }
        window.location.assign(safeRedirect(redirect));
      } catch {
        exchangeStartedRef.current = false;
        setPhase('error');
        setError('网络错误，登录失败，请重试');
      }
    },
    [redirect],
  );

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/session', { headers: { accept: 'application/json' } })
      .then((res) => res.json())
      .then((data: SessionInfo & { success: boolean }) => {
        if (cancelled) return;
        if (data.user) {
          // Already logged in — go straight to the destination.
          window.location.replace(safeRedirect(redirect));
          return;
        }
        if (!data.ssoEnabled) {
          setPhase('unavailable');
          return;
        }
        setSessionInfo(data);
        // The connect page is designed to be embedded: it posts the code to
        // `window.parent`. Open it inline right away (no extra click).
        setShowFrame(true);
        setPhase('ready');
      })
      .catch(() => {
        if (!cancelled) {
          setPhase('error');
          setError('无法连接服务器，请刷新重试');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [redirect]);

  // The vendor page posts `{ event: 'classai-login', data: CODE }` to its
  // parent (embedded iframe) or opener (popup fallback). Accept it only from
  // the configured vendor origins.
  useEffect(() => {
    if (!sessionInfo) return;
    const origins = allowedOrigins(sessionInfo.connectOrigin);
    const handleMessage = (event: MessageEvent) => {
      if (!origins.includes(event.origin)) return;
      const data = event.data as { event?: unknown; data?: unknown } | null;
      if (!data || data.event !== 'classai-login') return;
      const code = extractCode(data.data);
      if (!code) return;
      void exchange(code);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [sessionInfo, exchange]);

  // Whatever happens (navigation, unmount), never leave a stray popup behind.
  useEffect(
    () => () => {
      popupRef.current?.close();
    },
    [],
  );

  const openPopup = useCallback(() => {
    if (!sessionInfo) return;
    popupRef.current = window.open(
      sessionInfo.connectUrl,
      'eduku-login',
      'width=404,height=432,popup=yes',
    );
  }, [sessionInfo]);

  const retry = useCallback(() => {
    exchangeStartedRef.current = false;
    setError(null);
    setShowFrame(true);
    setFrameNonce((n) => n + 1);
    setPhase('ready');
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-950 dark:to-gray-900 p-4">
      <div
        className={`w-full ${showFrame && phase === 'ready' ? 'max-w-[470px]' : 'max-w-sm'} bg-white dark:bg-gray-900 rounded-2xl shadow-xl border border-gray-100 dark:border-gray-800 p-8`}
      >
        <div className="flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center mb-4 shadow-lg shadow-violet-200/50">
            <LogIn className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">登录后观看课件</h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1.5 leading-relaxed">
            使用课堂AI账号登录，观看记录与答题、对话数据将关联到你的账号
          </p>
        </div>

        <div className="mt-8">
          {phase === 'checking' && (
            <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              正在检查登录状态…
            </div>
          )}

          {phase === 'ready' && showFrame && sessionInfo && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={openPopup}
                  className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  登录框打不开？在新窗口登录
                </button>
                <button
                  type="button"
                  onClick={() => setShowFrame(false)}
                  title="收起登录框"
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <iframe
                key={frameNonce}
                src={sessionInfo.connectUrl}
                title="课堂AI登录"
                className="w-[404px] h-[432px] max-w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white"
              />
            </div>
          )}

          {phase === 'ready' && !showFrame && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setFrameNonce((n) => n + 1);
                  setShowFrame(true);
                }}
                className="w-full px-4 py-3 rounded-xl bg-gradient-to-r from-violet-500 to-purple-500 text-white text-sm font-semibold shadow-lg shadow-violet-200/50 dark:shadow-violet-900/40 hover:shadow-violet-300/50 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                <LogIn className="w-4 h-4" />
                使用课堂AI账号登录
              </button>
              <button
                type="button"
                onClick={openPopup}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center justify-center gap-2"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                在新窗口打开登录页
              </button>
            </div>
          )}

          {phase === 'exchanging' && (
            <div className="flex items-center justify-center gap-2 text-sm text-violet-600 dark:text-violet-400">
              <Loader2 className="w-4 h-4 animate-spin" />
              登录中，正在验证账号…
            </div>
          )}

          {phase === 'error' && (
            <div className="text-center">
              <p className="text-sm text-red-500 mb-3">{error}</p>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={retry}
                  className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  重新登录
                </button>
                <button
                  type="button"
                  onClick={openPopup}
                  className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center gap-1.5"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  新窗口登录
                </button>
              </div>
            </div>
          )}

          {phase === 'unavailable' && (
            <div className="flex flex-col items-center gap-2 text-sm text-gray-400">
              <ShieldAlert className="w-5 h-5" />
              <p>登录系统未配置，请联系管理员</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginCard />
    </Suspense>
  );
}
