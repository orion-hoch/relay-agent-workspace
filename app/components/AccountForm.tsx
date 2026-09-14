'use client';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { call } from '@/lib/buzz/store';

export function AccountForm({ join = false }: { join?: boolean }) {
  const [state, setState] = useState<{
    configured: boolean;
    name?: string;
  } | null>(null);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (join) setInvite(window.location.hash.slice(1).trim());
    }, 0);
    void call<{ configured: boolean; name?: string }>('/api/auth', {})
      .then(setState)
      .catch((error) => setError(error.message));
    return () => clearTimeout(timer);
  }, [join]);
  const creating = state && !state.configured;
  return (
    <main className="account-page">
      <form
        className="account-card team-form"
        aria-label={join ? 'Join workspace' : 'Sign in'}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          const values = Object.fromEntries(new FormData(event.currentTarget));
          try {
            await call('/api/auth', {
              method: 'POST',
              body: JSON.stringify({
                ...values,
                action: creating ? 'create' : join ? 'join' : 'login',
                invite,
                terminalEnabled: values.terminalEnabled === 'on',
              }),
            });
            window.location.replace('/');
          } catch (error) {
            setError(
              error instanceof Error ? error.message : 'Could not reach Shoal.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <header className="account-heading">
          <Image src="/shoal.svg" width={52} height={52} alt="Shoal" />
          <h1>{creating ? 'Create workspace' : join ? 'Join ' + (state?.name || 'your team') : 'Sign in'}</h1>
          {!creating && !join && state && <p>{state.name}</p>}
        </header>
        {creating && (
          <>
            <label>
              Setup code
              <input
                className="input"
                name="setupCode"
                type="password"
                required
                autoComplete="off"
              />
            </label>
            <small>
              Use the setup code printed by <code>npm run setup</code> on the
              host computer.
            </small>
            <label>
              Workspace name
              <input
                className="input"
                name="workspaceName"
                required
                maxLength={60}
                placeholder="Studio"
              />
            </label>
            <label>
              Working directory on this server
              <input
                className="input"
                name="workDirectory"
                placeholder="Default: .shoal/work"
              />
            </label>
          </>
        )}
        {(creating || join) && (
          <label>
            Your name
            <input
              className="input"
              name="name"
              required
              maxLength={60}
              autoComplete="name"
            />
          </label>
        )}
        <label>
          Username
          <input
            className="input"
            name="username"
            required
            minLength={3}
            maxLength={60}
            pattern={creating || join ? '[a-zA-Z0-9][a-zA-Z0-9._\\-]{2,59}' : undefined}
            title={creating || join ? '3–60 letters, numbers, periods, underscores, or hyphens' : undefined}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="username"
            placeholder="alex"
          />
        </label>
        <label>
          Password
          <input
            className="input"
            name="password"
            type="password"
            required
            minLength={creating || join ? 12 : 1}
            maxLength={256}
            autoComplete={
              creating || join ? 'new-password' : 'current-password'
            }
          />
        </label>
        {(creating || join) && (
          <small>
            At least 12 characters.
          </small>
        )}
        {creating && (
          <label className="team-check">
            <input type="checkbox" name="terminalEnabled" />
            Enable terminal commands
          </label>
        )}
        {error && (
          <p role="alert" className="team-error">
            {error}
          </p>
        )}
        <button
          className="btn btn-primary"
          disabled={!state || busy || (join && !invite)}
        >
          {busy
            ? 'Signing in'
            : creating
              ? 'Create workspace'
              : join
                ? 'Join workspace'
                : 'Sign in'}
        </button>
        {join && state && !invite && (
          <p role="alert">
            This link is missing its invitation code. Ask your admin for a new link.
          </p>
        )}
        {join && <Link href="/login">Already have an account? Sign in</Link>}
      </form>
    </main>
  );
}
