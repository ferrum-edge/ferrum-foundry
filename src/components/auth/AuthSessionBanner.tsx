import { useAuth } from "@/stores/auth";

/**
 * Session notices shown inside the signed-in workspace: a BFF authentication
 * lockout, and a sign-out the BFF did not confirm.
 *
 * Rendered in `AppShell`'s `<main>`, beside the gateway banner, so the fixed
 * header and sidebar never cover it. The workspace and any unsaved edits stay
 * mounted while it shows. Both clear on the next successful session check,
 * and a sign-out failure also on the next sign-out attempt.
 */
export function AuthSessionBanner() {
  const { session } = useAuth();
  const lockout = session.status === "lockedOut" ? session.lockout : null;
  const signOutError = session.status === "authenticated" || session.status === "lockedOut"
    ? session.signOutError
    : null;
  if (!lockout && !signOutError) return null;
  return (
    <>
      {lockout && (
        <div
          className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-text-secondary"
          role="alert"
        >
          <strong className="text-danger">Sign-in locked:</strong> {lockout}
        </div>
      )}
      {signOutError && (
        <div
          className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-text-secondary"
          role="alert"
        >
          <strong className="text-danger">Not signed out:</strong> {signOutError}
        </div>
      )}
    </>
  );
}
