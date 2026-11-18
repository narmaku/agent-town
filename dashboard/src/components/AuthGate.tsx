import type React from "react";
import { useCallback, useEffect, useState } from "react";

import { apiFetch, getToken, setToken, UNAUTHORIZED_EVENT } from "../auth";
import { API } from "../utils";

interface AuthGateProps {
  children: React.ReactNode;
}

/**
 * Renders the dashboard only once an access token is held. Without one (or
 * after the server rejects it) it shows a token prompt instead.
 */
export function AuthGate({ children }: AuthGateProps): React.JSX.Element {
  const [authenticated, setAuthenticated] = useState(() => getToken() !== null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const onUnauthorized = (): void => {
      setAuthenticated(false);
      setError("The access token was rejected. Paste the current token to continue.");
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const token = draft.trim();
      if (!token) return;
      setChecking(true);
      setError(null);
      setToken(token);
      try {
        // A 401 here clears the token again and fires UNAUTHORIZED_EVENT
        const resp = await apiFetch(API.MACHINES);
        if (resp.ok) {
          setDraft("");
          setAuthenticated(true);
        } else if (resp.status !== 401) {
          setError(`Server responded ${resp.status}. Is Agent Town running?`);
        }
      } catch (err) {
        setError(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setChecking(false);
      }
    },
    [draft],
  );

  if (authenticated) return <>{children}</>;

  return (
    <div className="modal-overlay">
      <form className="modal-panel" onSubmit={handleSubmit} aria-label="Sign in to Agent Town">
        <div className="modal-header">
          <h2 className="modal-title">Agent Town</h2>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label" htmlFor="auth-token">
              Access token
            </label>
            <input
              id="auth-token"
              className="form-input"
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Access token"
            />
            <span className="form-hint">
              Open the login URL printed by <code>./dev.sh</code>, or paste the contents of{" "}
              <code>~/.agent-town/token</code> from the server machine.
            </span>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="submit" className="send-btn" disabled={checking || !draft.trim()} aria-label="Sign in">
            {checking ? "Checking..." : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}
