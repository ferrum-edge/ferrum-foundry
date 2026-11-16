/* ------------------------------------------------------------------ */
/*  Fetch one upstream file at a pinned ref, for the drift checks      */
/* ------------------------------------------------------------------ */

/**
 * The drift checks (`plugin-schema-drift.mjs`, `plugin-sensitivity-drift.mjs`)
 * compare a Foundry transcription with a Ferrum Edge source file at a pinned
 * ref. An outage must not be reported as drift, and it must not pass either:
 * transport failures are retried, and an HTTP error is fatal at once. Which
 * file, which ref, and what to do with it stay with each check.
 */

const ATTEMPTS = 4;
const ATTEMPT_TIMEOUT_MS = 30_000;
const BACKOFF_STEP_MS = 2_000;
const TRANSPORT_FAILURE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed/i;

/** The raw-content URL of `source.path` in `source.repository` at `ref`. */
export function pinnedSourceUrl(source, ref) {
  return `https://raw.githubusercontent.com/${source.repository}/${ref}/${source.path}`;
}

/**
 * Fetch `source` (`{ repository, path }`) at `ref` as text. `fetchImpl` and
 * `sleep` exist for tests.
 */
export async function fetchPinnedSource(
  source,
  ref,
  { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  const url = pinnedSourceUrl(source, ref);
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (!TRANSPORT_FAILURE.test(String(error?.message ?? error))) throw error;
      if (attempt < ATTEMPTS) await sleep(attempt * BACKOFF_STEP_MS);
    }
  }
  throw new Error(`Could not fetch ${url}: ${lastError?.message ?? "unknown error"}`);
}
