'use client';
// Full navigation avoids retaining authenticated route state in client caches.
/* eslint-disable @next/next/no-html-link-for-pages */
import { useState, type FormEvent } from 'react';
import { adminRequest, ClientFailure } from '../../lib/admin/client';
const notices: Record<string, string> = {
  expired: 'Your session has expired. Please sign in again.',
  forbidden: 'This account does not have administrator access.',
  unavailable: 'Administrative services are unavailable. Please try again.',
  configuration:
    'Administrator sign-in is not configured. Contact the site operator.',
  'signed-out': 'You have signed out.',
  'local-sign-out':
    'You have signed out of this browser. Provider-wide sign-out could not be confirmed; other sessions may remain active.',
};
export function Login({ reason = '' }: { reason?: string }) {
  const [challenge, setChallenge] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    setBusy(true);
    setError('');
    const body = challenge
      ? { answer: values.get('answer') }
      : { username: values.get('username'), password: values.get('password') };
    form.reset();
    try {
      const result = await adminRequest(
        challenge ? 'challenge' : 'login',
        body,
      );
      if (result.authenticated === true) {
        window.location.replace('/admin');
        return;
      }
      setChallenge(result.challenge);
    } catch (e) {
      setError(
        e instanceof ClientFailure
          ? e.message
          : 'Unable to reach sign-in services. Please try again.',
      );
      if (e instanceof ClientFailure && e.status === 401) setChallenge('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-login">
      <a className="admin-brand" href="/">
        Batch &amp; Batter<span>COOKIE CO.</span>
      </a>
      <section className="admin-card">
        <p className="admin-eyebrow">Administration</p>
        <h1>
          {challenge === 'NEW_PASSWORD_REQUIRED'
            ? 'Set your password'
            : challenge
              ? 'Verify your sign-in'
              : 'Welcome back'}
        </h1>
        <p>Sign in to view your assigned Drop.</p>
        {notices[reason] && <p role="status">{notices[reason]}</p>}
        {/* Native submission must remain POST even before hydration or without JS.
            The existing JSON-only endpoints reject this fallback safely. */}
        <form
          method="post"
          action={challenge ? '/api/admin/challenge' : '/api/admin/login'}
          onSubmit={submit}
          aria-busy={busy}
        >
          {!challenge ? (
            <>
              <label htmlFor="username">Username</label>
              <input
                id="username"
                name="username"
                autoComplete="username"
                required
                maxLength={128}
                disabled={busy}
              />
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                disabled={busy}
              />
            </>
          ) : (
            <>
              <label htmlFor="answer">
                {challenge === 'NEW_PASSWORD_REQUIRED'
                  ? 'New password'
                  : challenge === 'SMS_MFA'
                    ? 'Code from your text message'
                    : 'Code from your authenticator'}
              </label>
              <input
                key={challenge}
                autoFocus
                id="answer"
                name="answer"
                type={
                  challenge === 'NEW_PASSWORD_REQUIRED' ? 'password' : 'text'
                }
                inputMode={
                  challenge === 'NEW_PASSWORD_REQUIRED' ? undefined : 'numeric'
                }
                autoComplete={
                  challenge === 'NEW_PASSWORD_REQUIRED'
                    ? 'new-password'
                    : 'one-time-code'
                }
                pattern={
                  challenge === 'NEW_PASSWORD_REQUIRED' ? undefined : '[0-9]{6}'
                }
                required
                maxLength={challenge === 'NEW_PASSWORD_REQUIRED' ? 256 : 6}
                disabled={busy}
              />
            </>
          )}
          {error && (
            <p role="alert" className="admin-error">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? 'Checking…' : challenge ? 'Continue' : 'Sign in'}
          </button>
          {challenge && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setChallenge('');
                setError('');
              }}
            >
              Restart sign-in
            </button>
          )}
        </form>
        <p className="admin-muted">
          Administrator access only. Sessions expire after 15 minutes.
        </p>
      </section>
    </main>
  );
}
