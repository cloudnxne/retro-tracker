import { useEffect, useState } from 'react';
import { claimGuestData, setSetting, switchAccount } from '../../db/repo';
import { sendCode, verifyCode } from '../../sync/supabase';
import { syncNow } from '../../sync/runner';

/**
 * Email → 6-digit code (typed into the app, never a magic link: on iOS a link
 * opens Safari, which has separate storage from the installed app).
 * On success: claim this phone's guest data into the account, switch DB, sync.
 */
export function SignIn({ onDone, onSkip }: { onDone: () => void; onSkip?: () => void }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendCode(email.trim());
      setStep('code');
      setResendIn(30);
    } catch (e) {
      setError(e instanceof Error && /rate/i.test(e.message) ? 'Too many codes sent. Wait a minute and try again.' : "Couldn't send the code. Check the email address.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const userId = await verifyCode(email.trim(), value);
      await claimGuestData(userId);
      switchAccount(userId);
      await setSetting('email', email.trim());
      void syncNow();
      onDone();
    } catch {
      setCode('');
      setError("That code didn't work. Check it or get a new one.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="frame-screen">
      <div className="sun small" aria-hidden="true" />
      <h1 className="display">{step === 'email' ? 'Back up your training' : 'Check your email'}</h1>
      {!online && (
        <p role="alert" className="banner info">
          No signal. You'll need it once to sign in, then the app works offline.
        </p>
      )}
      {step === 'email' ? (
        <>
          <p className="muted" style={{ margin: '12px 0 8px' }}>
            Sign in so your workouts are safe if you lose your phone, and show up on your other devices.
          </p>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && email.includes('@') && void send()}
            />
          </label>
          <div className="stack">
            <button className="btn-primary" disabled={busy || !online || !email.includes('@')} onClick={send}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
            {onSkip && (
              <button className="btn-link" onClick={onSkip}>
                Skip for now (data stays on this phone)
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="muted" style={{ margin: '12px 0 8px' }}>
            We sent a 6-digit code to {email}.
          </p>
          <label className="field">
            <span>Code</span>
            <input
              className={`otp ${error ? 'shake' : ''}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              aria-invalid={!!error}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                setCode(v);
                if (v.length === 6) void verify(v);
              }}
            />
          </label>
          <div className="stack">
            <button className="btn-primary" disabled={busy || code.length !== 6 || !online} onClick={() => verify(code)}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button className="btn-link" disabled={resendIn > 0 || busy} onClick={send}>
              {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
            </button>
            <button className="btn-link" onClick={() => setStep('email')}>
              Use a different email
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--warn)', marginTop: 12 }}>
          {error}
        </p>
      )}
    </main>
  );
}
