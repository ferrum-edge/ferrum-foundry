import { useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "@/stores/auth";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export function LoginGate({ children }: { children: ReactNode }) {
  const { status, mode, loginUrl, error, login, refreshSession } = useAuth();
  const [input, setInput] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (status === "authenticated") return <>{children}</>;

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <p className="text-sm text-text-muted" role="status">Checking your session…</p>
      </div>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = input.trim();
    if (!token) return;
    setSubmitting(true);
    try {
      await login(token);
      setInput("");
    } catch {
      // The auth store renders the redacted failure message.
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "trusted-proxy") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary px-4">
        <Card className="w-full max-w-md">
          <h1 className="text-lg font-semibold text-text-primary mb-1">Sign in to Ferrum Foundry</h1>
          <p className="text-text-muted text-sm mb-6">
            Your organization&apos;s identity provider did not supply a valid Foundry session.
          </p>
          {error && <p className="mb-4 text-sm text-danger" role="alert">{error}</p>}
          {loginUrl ? (
            <Button className="w-full" onClick={() => window.location.assign(loginUrl)}>
              Continue with SSO
            </Button>
          ) : (
            <Button className="w-full" onClick={() => void refreshSession()}>
              Check session again
            </Button>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary px-4">
      <Card className="w-full max-w-md">
        <h1 className="text-lg font-semibold text-text-primary mb-1">Local development sign in</h1>
        <p className="text-text-muted text-sm mb-6">
          Enter the development token configured on the BFF. It is exchanged once for a bounded,
          HttpOnly session and is never saved in browser storage.
        </p>

        {error && <p className="mb-4 text-sm text-danger" role="alert">{error}</p>}
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="bff-auth-token" className="text-text-secondary text-sm font-medium">
              Development token
            </label>
            <div className="relative">
              <input
                id="bff-auth-token"
                type={showSecret ? "text" : "password"}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                autoFocus
                autoComplete="off"
                className="w-full min-w-0 bg-bg-input border border-border rounded-lg px-3 py-2 pr-10 text-text-primary text-sm placeholder:text-text-muted focus:border-orange focus:ring-1 focus:ring-orange/30"
                placeholder="paste token"
              />
              <button
                type="button"
                onClick={() => setShowSecret((visible) => !visible)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-secondary cursor-pointer"
                aria-label={showSecret ? "Hide token" : "Show token"}
              >
                {showSecret ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <Button type="submit" disabled={!input.trim() || submitting} loading={submitting} className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
