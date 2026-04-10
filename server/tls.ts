import { readFileSync } from 'node:fs';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent, type AgentOptions } from 'node:https';
import type { Config } from './config.js';

let cachedAgent: HttpAgent | HttpsAgent | undefined;
let cachedFingerprint: string | undefined;

function fingerprint(config: Config): string {
  return `${config.adminUrl}|${config.tlsCaPath ?? ''}|${config.tlsVerify}`;
}

export function createHttpAgent(config: Config): HttpAgent | HttpsAgent {
  const fp = fingerprint(config);
  if (cachedAgent && cachedFingerprint === fp) {
    return cachedAgent;
  }

  const isHttps = config.adminUrl.startsWith('https://');

  if (isHttps) {
    const options: AgentOptions = {
      keepAlive: true,
      rejectUnauthorized: config.tlsVerify,
    };

    if (config.tlsCaPath) {
      options.ca = readFileSync(config.tlsCaPath);
    }

    cachedAgent = new HttpsAgent(options);
  } else {
    cachedAgent = new HttpAgent({ keepAlive: true });
  }

  cachedFingerprint = fp;
  return cachedAgent;
}
