import { useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "@/stores/auth";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/**
 * Gate the app behind a bearer-token prompt. The BFF protects its admin
 * endpoints with a static deployment-time token (`FERRUM_BFF_AUTH_TOKEN`);
 * the user pastes the same value here once per browser to authenticate.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const { token, setToken } = useAuth();
  const [input, setInput] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  if (token) {
    return <>{children}</>;
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    setToken(trimmed);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-base px-4">
      <Card className="w-full max-w-md">
        <h1 className="text-lg font-semibold text-text-primary mb-1">
          Sign in to Ferrum Foundry
        </h1>
        <p className="text-text-muted text-sm mb-6">
          Enter the BFF auth token (the value of{" "}
          <code className="text-text-secondary">FERRUM_BFF_AUTH_TOKEN</code>{" "}
          configured on the server).
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              htmlFor="bff-auth-token"
              className="text-text-secondary text-sm font-medium"
            >
              Auth Token
            </label>
            <div className="relative">
              <input
                id="bff-auth-token"
                type={showSecret ? "text" : "password"}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoFocus
                // API token, not a user password — don't invite the browser
                // password manager to store the shared BFF secret.
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                className="w-full min-w-0 bg-bg-input border border-border rounded-lg px-3 py-2 pr-10 text-text-primary text-sm placeholder:text-text-muted transition-colors duration-150 focus:border-orange focus:ring-1 focus:ring-orange/30"
                placeholder="paste token"
              />
              <button
                type="button"
                onClick={() => setShowSecret((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
                aria-label={showSecret ? "Hide token" : "Show token"}
              >
                {showSecret ? (
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-text-muted text-xs">
              The token is stored in this browser's localStorage and sent as a
              bearer header on every request to the BFF.
            </p>
          </div>

          <Button type="submit" disabled={!input.trim()} className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
