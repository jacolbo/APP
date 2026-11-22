import { useState } from 'react';
import { Brand } from '../brand';

/** First open on a phone: the client confirms the name the booking is under. */
export function JoinScreen({
  locked,
  attemptsLeft,
  onJoin,
}: {
  locked: boolean;
  attemptsLeft: number;
  onJoin: (name: string) => Promise<string | null>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (locked) {
    return (
      <div className="center-screen join">
        <Brand large />
        <div className="pane join-card">
          <span className="eyebrow">Private gallery</span>
          <h1>Please ask the studio</h1>
          <p className="muted">
            For your privacy this gallery is locked after several names that didn’t match. A member of the studio team
            will help you.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="center-screen join">
      <Brand large />
      <form
        className="pane join-card"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          const err = await onJoin(name);
          setBusy(false);
          if (err) setError(err);
        }}
      >
        <span className="eyebrow">Private gallery</span>
        <h1>Welcome</h1>
        <p className="muted">To view your photos, please type the full name your booking is under.</p>
        <label className="sr-only" htmlFor="join-name">
          Full name
        </label>
        <input
          id="join-name"
          className="join-input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError('');
          }}
          placeholder="Full name"
          autoComplete="name"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          maxLength={120}
          autoFocus
        />
        {error && (
          <p className="error" role="alert">
            {error}
            {attemptsLeft > 0 && attemptsLeft < 5 && ` ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.`}
          </p>
        )}
        <button className="btn" disabled={busy || !name.trim()}>
          {busy ? 'One moment…' : 'View my photos'}
        </button>
      </form>
    </div>
  );
}
