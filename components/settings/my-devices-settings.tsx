'use client';

/**
 * Cài đặt › Máy của tôi — cho một máy khác dùng chung lựa chọn của người dùng.
 *
 * Một mã nhận dùng MỘT LẦN, hạn ngắn: máy đã khai lựa chọn xin mã, máy mới
 * nhập mã, và máy chủ cấp lại đúng danh tính chủ sở hữu cho máy mới. Không mật
 * khẩu, không nhà cung cấp đăng nhập — và khi deployment chưa bật lưu trữ phía
 * máy chủ thì mục này nói thẳng là tính năng đang tắt thay vì trưng một nút
 * không làm gì.
 *
 * Mọi trạng thái dưới đây có id `ST-maycuatoi-*` khớp bảng trạng thái trong đặc
 * tả UX của hồ sơ nghiệm thu; phép đo E13 chụp mỗi dòng một khung.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, MonitorSmartphone, RefreshCw } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/hooks/use-i18n';
import { isBrowserPersistenceEnabled } from '@/lib/persistence/bootstrap';
import { adoptChoicesFromCode, normalizeClaimCode } from '@/lib/persistence/adopt-choices';

type MintState =
  | { kind: 'idle' }
  | { kind: 'minting' }
  | { kind: 'minted'; code: string; expiresAt: number }
  | { kind: 'unreachable' };

type RedeemState =
  | { kind: 'idle' }
  | { kind: 'confirming'; code: string }
  | { kind: 'redeeming' }
  | { kind: 'failed' }
  | { kind: 'unreachable' }
  | { kind: 'done' };

function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export interface MyDevicesSettingsProps {
  /**
   * Nạp lại lựa chọn sau khi nhận xong. Bắt buộc: cookie đã đổi chủ sở hữu
   * nhưng trạng thái trong bộ nhớ vẫn là của máy này, nên nếu không nạp lại thì
   * màn báo "đã dùng chung" trong khi sản phẩm vẫn chạy bằng lựa chọn cũ.
   */
  onAdopted?: () => Promise<void> | void;
  /** True khi máy này đã có lựa chọn riêng — nhận mã sẽ thay chúng. */
  hasLocalChoices?: boolean;
}

export function MyDevicesSettings({ onAdopted, hasLocalChoices = false }: MyDevicesSettingsProps) {
  const { t } = useI18n();
  const enabled = isBrowserPersistenceEnabled();

  const [mint, setMint] = useState<MintState>({ kind: 'idle' });
  const [redeem, setRedeem] = useState<RedeemState>({ kind: 'idle' });
  const [entry, setEntry] = useState('');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Hết hạn SUY RA từ đồng hồ, không giữ thành một trạng thái thứ hai: hai
  // nguồn cho cùng một sự thật là hai nguồn để lệch nhau.
  const liveCode = mint.kind === 'minted' && secondsLeft(mint.expiresAt, now) > 0 ? mint : null;
  const staleCode = mint.kind === 'minted' && secondsLeft(mint.expiresAt, now) === 0;
  const entryRef = useRef<HTMLInputElement>(null);

  // Đồng hồ chỉ để HIỂN THỊ. Máy chủ vẫn là bên quyết mã còn sống hay không —
  // một đồng hồ trình duyệt lệch giờ không được phép nới hạn của mã.
  useEffect(() => {
    if (mint.kind !== 'minted') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [mint.kind]);

  const requestCode = useCallback(async () => {
    setMint({ kind: 'minting' });
    setCopied(false);
    try {
      const res = await fetch('/api/claim', { method: 'POST' });
      if (!res.ok) {
        setMint({ kind: 'unreachable' });
        return;
      }
      const body = (await res.json()) as { code?: string; expiresAt?: number };
      if (typeof body.code !== 'string' || typeof body.expiresAt !== 'number') {
        setMint({ kind: 'unreachable' });
        return;
      }
      setNow(Date.now());
      setMint({ kind: 'minted', code: body.code, expiresAt: body.expiresAt });
    } catch {
      setMint({ kind: 'unreachable' });
    }
  }, []);

  const submitCode = useCallback(
    async (code: string) => {
      setRedeem({ kind: 'redeeming' });
      // Thứ tự nạp-lại-rồi-mới-báo-xong sống trong chính sách, không ở màn này.
      const outcome = await adoptChoicesFromCode(code, {
        rehydrate: () => onAdopted?.(),
      });
      if (outcome === 'rejected') {
        setRedeem({ kind: 'failed' });
        entryRef.current?.focus();
        return;
      }
      if (outcome === 'unreachable') {
        setRedeem({ kind: 'unreachable' });
        return;
      }
      setRedeem({ kind: 'done' });
    },
    [onAdopted],
  );

  const onSubmit = useCallback(() => {
    const code = normalizeClaimCode(entry);
    if (code === '') return;
    if (hasLocalChoices) {
      setRedeem({ kind: 'confirming', code });
      return;
    }
    void submitCode(code);
  }, [entry, hasLocalChoices, submitCode]);

  // ST-maycuatoi-tat
  if (!enabled) {
    return (
      <section data-state="ST-maycuatoi-tat" className="space-y-3">
        <Header t={t} />
        <p className="text-sm text-muted-foreground">{t('settings.myDevices.disabled')}</p>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <Header t={t} />

      {/* Nửa trên: máy này cho máy khác dùng chung */}
      <div
        data-state={
          liveCode
            ? 'ST-maycuatoi-co-ma'
            : staleCode
              ? 'ST-maycuatoi-ma-het-han'
              : mint.kind === 'unreachable'
                ? 'ST-maycuatoi-may-chu-im'
                : 'ST-maycuatoi-san-sang'
        }
        className="space-y-3"
      >
        <h3 className="text-sm font-medium">{t('settings.myDevices.shareTitle')}</h3>

        {liveCode ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <code className="rounded-md bg-muted px-3 py-2 font-mono text-lg tracking-widest">
                {liveCode.code}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(liveCode.code);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                <span className="ml-1.5">{t('settings.myDevices.copy')}</span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.myDevices.expiresIn', {
                seconds: secondsLeft(liveCode.expiresAt, now),
              })}
            </p>
          </div>
        ) : staleCode ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('settings.myDevices.expired')}</p>
            <Button variant="outline" size="sm" onClick={() => void requestCode()}>
              <RefreshCw className="h-4 w-4" />
              <span className="ml-1.5">{t('settings.myDevices.newCode')}</span>
            </Button>
          </div>
        ) : mint.kind === 'unreachable' ? (
          <div className="space-y-2">
            <Alert variant="destructive">
              <AlertDescription>{t('settings.myDevices.serverSilent')}</AlertDescription>
            </Alert>
            <Button variant="outline" size="sm" onClick={() => void requestCode()}>
              <RefreshCw className="h-4 w-4" />
              <span className="ml-1.5">{t('settings.myDevices.retry')}</span>
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('settings.myDevices.shareHint')}</p>
            <Button size="sm" disabled={mint.kind === 'minting'} onClick={() => void requestCode()}>
              {mint.kind === 'minting' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              <span className={mint.kind === 'minting' ? 'ml-1.5' : ''}>
                {t('settings.myDevices.getCode')}
              </span>
            </Button>
          </div>
        )}
      </div>

      {/* Nửa dưới: máy này nhận lựa chọn từ máy khác */}
      <div
        data-state={
          redeem.kind === 'confirming'
            ? 'ST-maycuatoi-se-ghi-de'
            : redeem.kind === 'redeeming'
              ? 'ST-maycuatoi-dang-nhan'
              : redeem.kind === 'failed'
                ? 'ST-maycuatoi-nhan-loi'
                : redeem.kind === 'unreachable'
                  ? 'ST-maycuatoi-may-chu-im'
                  : redeem.kind === 'done'
                    ? 'ST-maycuatoi-xong'
                    : 'ST-maycuatoi-san-sang'
        }
        className="space-y-3 border-t pt-6"
      >
        <h3 className="text-sm font-medium">{t('settings.myDevices.adoptTitle')}</h3>

        {redeem.kind === 'done' ? (
          <p className="text-sm text-muted-foreground">{t('settings.myDevices.adopted')}</p>
        ) : redeem.kind === 'confirming' ? (
          <div className="space-y-3">
            <Alert>
              <AlertDescription>{t('settings.myDevices.willReplace')}</AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void submitCode(redeem.code)}>
                {t('settings.myDevices.confirmReplace')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRedeem({ kind: 'idle' })}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {redeem.kind === 'failed' ? (
              <Alert variant="destructive">
                <AlertDescription>{t('settings.myDevices.codeRejected')}</AlertDescription>
              </Alert>
            ) : null}
            {redeem.kind === 'unreachable' ? (
              <Alert variant="destructive">
                <AlertDescription>{t('settings.myDevices.serverSilent')}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex gap-2">
              <Input
                ref={entryRef}
                value={entry}
                disabled={redeem.kind === 'redeeming'}
                placeholder={t('settings.myDevices.codePlaceholder')}
                onChange={(event) => setEntry(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSubmit();
                }}
                className="max-w-xs font-mono tracking-widest"
              />
              <Button
                size="sm"
                disabled={redeem.kind === 'redeeming' || normalizeClaimCode(entry) === ''}
                onClick={onSubmit}
              >
                {redeem.kind === 'redeeming' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                <span className={redeem.kind === 'redeeming' ? 'ml-1.5' : ''}>
                  {t('settings.myDevices.adopt')}
                </span>
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Header({ t }: { t: (key: string, options?: Record<string, unknown>) => string }) {
  return (
    <div className="flex items-center gap-2">
      <MonitorSmartphone className="h-5 w-5 text-muted-foreground" />
      <div>
        <h2 className="text-lg font-semibold">{t('settings.myDevices.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.myDevices.description')}</p>
      </div>
    </div>
  );
}
