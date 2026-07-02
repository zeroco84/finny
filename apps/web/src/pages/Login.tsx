import { useState, type FormEvent } from 'react';
import type { SessionUser } from '@finny/shared';
import { api } from '../api';

export default function Login({ onSignedIn }: { onSignedIn: (u: SessionUser) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'processor' | 'lead'>('processor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await api.devLogin({ email, name: name || email.split('@')[0], role });
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1 className="wordmark login-mark">Finny</h1>
        <p className="login-tag">Finance Invoice Notification &amp; Navigation for You</p>
        <label>
          Work email
          <input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Name
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as 'processor' | 'lead')}>
            <option value="processor">AP Processor</option>
            <option value="lead">AP Lead / Finance Manager</option>
          </select>
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="login-note">
          Development sign-in. In production this is replaced by Entra ID SSO (see README).
        </p>
      </form>
    </div>
  );
}
