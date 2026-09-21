/* ------------------------------------------------------------------ */
/*  Ferrum Foundry starter preflight (issue #384)                      */
/* ------------------------------------------------------------------ */

/**
 * Non-destructive checks for a Foundry deployment, run before anyone tries to
 * configure a route through it.
 *
 * Three verdicts, and the third one matters as much as the other two:
 *
 *   pass     the check was performed and the answer was good
 *   fail     the check was performed and the answer was bad
 *   unknown  the check could not be performed — a missing input, a value only
 *            the deployment can confirm, a probe this process is not allowed
 *            to make. An unknown is never rounded up to a pass.
 *
 * It reads and probes; it writes nothing. It never prints a secret: values are
 * reported by length and shape only.
 *
 *   node scripts/starter-preflight.mjs
 *   node scripts/starter-preflight.mjs --env deploy/starter/.env
 *   node scripts/starter-preflight.mjs --json
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { signAdminJwt } from "../shared/admin-jwt.js";

export const PASS = "pass";
export const FAIL = "fail";
export const UNKNOWN = "unknown";

const MIN_SECRET_LENGTH = 32;

/* ------------------------------------------------------------------ */
/*  .env parsing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Parse a Compose-style `.env`. Deliberately minimal: `KEY=value`, `#`
 * comments, optional surrounding quotes. No interpolation, no `export`, so a
 * value is exactly the bytes on the line.
 */
export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/* ------------------------------------------------------------------ */
/*  Individual checks                                                  */
/* ------------------------------------------------------------------ */

function check(name, status, detail, remedy) {
  return remedy ? { name, status, detail, remedy } : { name, status, detail };
}

/** Values that must be present and long enough to be worth anything. */
export function checkSecrets(env) {
  const results = [];
  for (const key of ["FERRUM_JWT_SECRET", "FERRUM_TRUSTED_PROXY_SECRET"]) {
    const value = env[key];
    if (!value) {
      results.push(
        check(key, FAIL, "not set", `Set ${key} in .env. Generate one with: openssl rand -base64 48`),
      );
    } else if (value.length < MIN_SECRET_LENGTH) {
      results.push(
        check(
          key,
          FAIL,
          `${value.length} characters; the BFF requires at least ${MIN_SECRET_LENGTH}`,
          `Replace ${key} with a longer random value.`,
        ),
      );
    } else if (/replace[-_]?me/i.test(value)) {
      results.push(
        check(key, FAIL, "still the placeholder from .env.example", `Generate a real ${key}.`),
      );
    } else {
      results.push(check(key, PASS, `${value.length} characters`));
    }
  }
  return results;
}

/** `FERRUM_ADMIN_URL` must be a bare origin; the BFF refuses anything else. */
export function checkAdminUrl(env) {
  const raw = env.FERRUM_ADMIN_URL;
  if (!raw) {
    return check(
      "FERRUM_ADMIN_URL",
      FAIL,
      "not set",
      "Set it to the gateway admin API origin, e.g. https://ferrum-admin.internal:9000",
    );
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return check("FERRUM_ADMIN_URL", FAIL, `${raw} is not a URL`, "Use scheme://host[:port].");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return check("FERRUM_ADMIN_URL", FAIL, `unsupported scheme ${url.protocol}`, "Use http or https.");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    return check(
      "FERRUM_ADMIN_URL",
      FAIL,
      "carries a path, query, fragment, or credentials",
      "The BFF requires a bare origin: scheme://host[:port].",
    );
  }
  if (url.protocol === "http:") {
    return check(
      "FERRUM_ADMIN_URL",
      UNKNOWN,
      `${url.origin} is plaintext`,
      "Acceptable only for a disposable local stack. Use https and admin TLS elsewhere.",
    );
  }
  return check("FERRUM_ADMIN_URL", PASS, url.origin);
}

/** A private gateway certificate needs a readable CA bundle inside its root. */
export async function checkTlsTrust(env, fs = { stat }) {
  const path = env.FERRUM_TLS_CA_PATH;
  const root = env.FERRUM_TLS_CA_ROOT;
  const admin = env.FERRUM_ADMIN_URL ?? "";

  if (!path) {
    if (admin.startsWith("https://")) {
      return check(
        "gateway TLS trust",
        UNKNOWN,
        "no extra CA bundle configured",
        "Fine if the gateway presents a publicly trusted chain. If it presents a private certificate, set FERRUM_TLS_CA_PATH — Foundry cannot tell from here which it is.",
      );
    }
    return check("gateway TLS trust", UNKNOWN, "not applicable to a plaintext admin URL");
  }
  if (!root) {
    return check(
      "gateway TLS trust",
      UNKNOWN,
      "FERRUM_TLS_CA_PATH is set without FERRUM_TLS_CA_ROOT",
      "The BFF defaults the root to the bundle's directory; set it explicitly so the approved root is part of the configuration.",
    );
  }
  if (!resolve(path).startsWith(resolve(root))) {
    return check(
      "gateway TLS trust",
      FAIL,
      "FERRUM_TLS_CA_PATH resolves outside FERRUM_TLS_CA_ROOT",
      "The BFF refuses a bundle outside its approved root.",
    );
  }
  try {
    const info = await fs.stat(path);
    if (!info.isFile()) {
      return check("gateway TLS trust", FAIL, `${path} is not a regular file`);
    }
    if (info.size === 0 || info.size > 1024 * 1024) {
      return check(
        "gateway TLS trust",
        FAIL,
        `${path} is ${info.size} bytes; the BFF accepts 1 byte to 1 MiB`,
      );
    }
    return check(
      "gateway TLS trust",
      UNKNOWN,
      `${path} is readable (${info.size} bytes)`,
      "Foundry has not verified that this bundle actually anchors the gateway's certificate; the connection check below is what proves it.",
    );
  } catch (error) {
    return check(
      "gateway TLS trust",
      FAIL,
      `${path} could not be read (${error.code ?? error.message})`,
      "Mount the CA bundle into the container and check permissions.",
    );
  }
}

/** Reachability of the admin API. Read-only: `GET /health`. */
export async function checkGatewayReachable(env, fetchImpl = fetch) {
  const origin = env.FERRUM_ADMIN_URL;
  if (!origin) return check("gateway reachable", UNKNOWN, "FERRUM_ADMIN_URL is not set");
  try {
    const response = await fetchImpl(`${origin}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return check(
        "gateway reachable",
        FAIL,
        `GET ${origin}/health returned ${response.status}`,
        "The gateway is answering but not healthy. Check its logs before configuring routes.",
      );
    }
    return check("gateway reachable", PASS, `GET ${origin}/health returned 200`);
  } catch (error) {
    const cause = error?.cause?.code ?? error?.code ?? error?.name ?? "unknown";
    const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|altnames/i.test(String(error?.cause?.code ?? ""));
    return check(
      "gateway reachable",
      FAIL,
      `GET ${origin}/health failed (${cause})`,
      tls
        ? "The gateway's certificate did not verify. Point FERRUM_TLS_CA_PATH at the issuing CA; do not disable FERRUM_TLS_VERIFY."
        : "Check the admin URL, network reachability, and that the gateway is running.",
    );
  }
}

/**
 * Prove the signing key, audience, and namespace claim the BFF will send are
 * the ones the gateway accepts — the failure that otherwise shows up as a
 * blank page and a 401 after the operator has already logged in.
 */
export async function checkAdminCredentials(env, fetchImpl = fetch) {
  const origin = env.FERRUM_ADMIN_URL;
  const secret = env.FERRUM_JWT_SECRET;
  const namespace = env.FERRUM_NAMESPACE;
  if (!origin || !secret) {
    return [check("admin API authentication", UNKNOWN, "admin URL or signing key missing")];
  }
  if (!namespace) {
    return [
      check(
        "admin API authentication",
        UNKNOWN,
        "FERRUM_NAMESPACE is not set, so no namespace claim can be tested",
        "Set FERRUM_NAMESPACE to the namespace this deployment administers.",
      ),
    ];
  }

  // Minted through `shared/admin-jwt.js`, the same signer the BFF uses, so
  // this proves the BFF's own token would be accepted — not that some other
  // token shape would be.
  let token;
  try {
    token = await signAdminJwt({
      secret,
      issuer: env.FERRUM_JWT_ISSUER || "ferrum-edge",
      subject: "ferrum-foundry-preflight",
      role: "admin",
      audience: env.FERRUM_JWT_AUDIENCE
        ? env.FERRUM_JWT_AUDIENCE.split(",").map((entry) => entry.trim()).filter(Boolean)
        : undefined,
      namespaces: [namespace],
      ttlSeconds: 120,
    });
  } catch (error) {
    return [
      check(
        "admin API authentication",
        FAIL,
        `the configured values cannot mint a token (${error.message})`,
        "Fix the reported input; the BFF applies the same rules at startup.",
      ),
    ];
  }

  try {
    const response = await fetchImpl(`${origin}/proxies?offset=0&limit=1`, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token}`,
        "x-ferrum-namespace": namespace,
      },
    });
    if (response.status === 401) {
      return [
        check(
          "admin API authentication",
          FAIL,
          "the gateway rejected a token signed with FERRUM_JWT_SECRET",
          "FERRUM_JWT_SECRET must equal the gateway's FERRUM_ADMIN_JWT_SECRET, and FERRUM_JWT_AUDIENCE must equal its FERRUM_ADMIN_JWT_AUDIENCE.",
        ),
      ];
    }
    if (response.status === 403) {
      return [
        check("admin API authentication", PASS, "signing key and audience accepted"),
        check(
          `namespace grant for ${namespace}`,
          FAIL,
          "the gateway refused this namespace",
          "The gateway must serve this namespace (FERRUM_NAMESPACE / FERRUM_CP_NAMESPACES), and the identity proxy must grant it in X-Ferrum-Namespaces.",
        ),
      ];
    }
    if (!response.ok) {
      return [
        check(
          "admin API authentication",
          UNKNOWN,
          `the gateway answered ${response.status}`,
          "Not an authentication answer. Check the gateway's logs.",
        ),
      ];
    }
    return [
      check("admin API authentication", PASS, "signing key and audience accepted"),
      check(`namespace grant for ${namespace}`, PASS, "the gateway served the namespace"),
    ];
  } catch (error) {
    return [
      check(
        "admin API authentication",
        UNKNOWN,
        `could not be tested (${error?.cause?.code ?? error?.message ?? "unknown"})`,
        "Resolve the reachability failure above first.",
      ),
    ];
  }
}

/**
 * The BFF must refuse a request that does not come through the proxy, and the
 * proxy must not be reachable without an identity.
 */
export async function checkTrustBoundary(env, fetchImpl = fetch) {
  const front = env.FOUNDRY_PREFLIGHT_URL;
  if (!front) {
    return [
      check(
        "identity proxy refuses an anonymous request",
        UNKNOWN,
        "FOUNDRY_PREFLIGHT_URL is not set",
        "Set it to the URL browsers use, e.g. https://foundry.example.com, to test the front door from here.",
      ),
    ];
  }

  const results = [];
  try {
    const response = await fetchImpl(`${front}/api/proxy/proxies?offset=0&limit=1`, {
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    results.push(
      response.status === 401 || response.status === 302 || response.status === 403
        ? check(
            "identity proxy refuses an anonymous request",
            PASS,
            `answered ${response.status}`,
          )
        : check(
            "identity proxy refuses an anonymous request",
            FAIL,
            `answered ${response.status}; an unauthenticated caller reached an admin route`,
            "Check the auth_request block and that the BFF publishes no host port.",
          ),
    );
  } catch (error) {
    results.push(
      check(
        "identity proxy refuses an anonymous request",
        UNKNOWN,
        `could not be tested (${error?.cause?.code ?? error?.message ?? "unknown"})`,
      ),
    );
  }

  // A client that can set its own identity headers is an administrator. The
  // proxy must overwrite every one of them.
  try {
    const response = await fetchImpl(`${front}/api/proxy/proxies?offset=0&limit=1`, {
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
      headers: {
        "X-Ferrum-Auth-Secret": env.FERRUM_TRUSTED_PROXY_SECRET ?? "",
        "X-Forwarded-User": "preflight-forged",
        "X-Ferrum-Role": "admin",
        "X-Ferrum-Namespaces": env.FERRUM_NAMESPACE ?? "",
      },
    });
    results.push(
      response.ok
        ? check(
            "client identity headers are stripped",
            FAIL,
            "a forged X-Ferrum-Role: admin request was served",
            "The proxy must set all four identity headers with proxy_set_header so a client copy is replaced.",
          )
        : check("client identity headers are stripped", PASS, `answered ${response.status}`),
    );
  } catch (error) {
    results.push(
      check(
        "client identity headers are stripped",
        UNKNOWN,
        `could not be tested (${error?.cause?.code ?? error?.message ?? "unknown"})`,
      ),
    );
  }

  return results;
}

/* ------------------------------------------------------------------ */
/*  Runner                                                             */
/* ------------------------------------------------------------------ */

export async function runPreflight(env, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const results = [
    ...checkSecrets(env),
    checkAdminUrl(env),
    await checkTlsTrust(env, deps.fs),
    await checkGatewayReachable(env, fetchImpl),
    ...(await checkAdminCredentials(env, fetchImpl)),
    ...(await checkTrustBoundary(env, fetchImpl)),
  ];
  return {
    results,
    failed: results.filter((result) => result.status === FAIL).length,
    unknown: results.filter((result) => result.status === UNKNOWN).length,
  };
}

function render(report) {
  const mark = { [PASS]: "PASS   ", [FAIL]: "FAIL   ", [UNKNOWN]: "UNKNOWN" };
  const lines = report.results.map((result) => {
    const head = `${mark[result.status]}  ${result.name}: ${result.detail}`;
    return result.remedy ? `${head}\n           ${result.remedy}` : head;
  });
  lines.push(
    "",
    `${report.failed} failed, ${report.unknown} unknown, ` +
      `${report.results.length - report.failed - report.unknown} passed.`,
  );
  if (report.unknown > 0) {
    lines.push(
      "An unknown is not a pass. It means this check could not be performed " +
        "from here — the deployment still has to confirm it.",
    );
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const envIndex = argv.indexOf("--env");
  const envPath = envIndex === -1 ? "deploy/starter/.env" : argv[envIndex + 1];

  let fileEnv = {};
  try {
    fileEnv = parseEnvFile(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.error(`No ${envPath}; using the process environment only.`);
  }

  // The process environment wins, so a deployment that injects configuration
  // without a file is checked as it actually runs.
  const env = { ...fileEnv, ...process.env };
  const report = await runPreflight(env);

  console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : render(report));
  process.exit(report.failed > 0 ? 1 : 0);
}
