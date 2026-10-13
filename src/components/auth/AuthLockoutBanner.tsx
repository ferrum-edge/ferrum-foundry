import { useAuth } from "@/stores/auth";

/**
 * The BFF authentication lockout, shown inside the signed-in workspace.
 *
 * Rendered in `AppShell`'s `<main>`, beside the gateway banner, so the fixed
 * header and sidebar never cover it. The workspace and any unsaved edits stay
 * mounted while it shows; it clears on the next successful session check.
 */
export function AuthLockoutBanner() {
  const { lockout } = useAuth();
  if (!lockout) return null;
  return (
    <div
      className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-text-secondary"
      role="alert"
    >
      <strong className="text-danger">Sign-in locked:</strong> {lockout}
    </div>
  );
}
