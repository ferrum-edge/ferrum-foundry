/* ------------------------------------------------------------------ */
/*  "Discard my draft and reload" for a refused full-replacement save  */
/* ------------------------------------------------------------------ */

import { useCallback, useRef, useState } from "react";

interface FreshRead<T> {
  data?: T;
  isError?: boolean;
}

/**
 * Runs a detail editor's deliberate restart after a refused save. The
 * conflict dialog and the old draft stay on screen, the reload action busy,
 * until a fresh read of the resource lands; only then does the caller adopt
 * it and remount the form. A failed read keeps the draft and the dialog, so
 * the operator can retry or keep editing. "Keep my draft" (`abandon`) drops a
 * reload still in flight, whose result is then ignored.
 *
 * Closing the dialog before the read landed left the old draft editable for
 * the length of the read, with nothing saying it was about to be replaced.
 */
export function useDraftReload() {
  const [reloading, setReloading] = useState(false);
  const ticket = useRef(0);
  const inFlight = useRef(false);

  const reload = useCallback(async <T,>(
    read: () => Promise<FreshRead<T>>,
    adopt: (data: T) => void,
    onFailure: () => void,
  ): Promise<void> => {
    if (inFlight.current) return;
    const mine = ++ticket.current;
    inFlight.current = true;
    setReloading(true);
    try {
      const fresh = await read().catch(() => undefined);
      if (mine !== ticket.current) return;
      if (!fresh || fresh.isError || fresh.data === undefined) {
        onFailure();
        return;
      }
      adopt(fresh.data);
    } finally {
      if (mine === ticket.current) {
        inFlight.current = false;
        setReloading(false);
      }
    }
  }, []);

  const abandon = useCallback(() => {
    ticket.current += 1;
    inFlight.current = false;
    setReloading(false);
  }, []);

  return { reloading, reload, abandon };
}
