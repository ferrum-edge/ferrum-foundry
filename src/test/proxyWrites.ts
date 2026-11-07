import type {
  CircuitBreakerConfig,
  CircuitBreakerConfigInput,
  Proxy,
  ProxyCreate,
  RetryConfig,
  RetryConfigInput,
} from "@/api/types";

/**
 * Edge's serde defaults for the nested matchers a proxy write may omit
 * (`default_failure_status_codes`, `default_retryable_status_codes`,
 * `default_retryable_methods` in ferrum-edge `src/config/types.rs`).
 */
const DEFAULT_FAILURE_STATUS_CODES = [500, 502, 503, 504];
const DEFAULT_RETRYABLE_STATUS_CODES: number[] = [];
const DEFAULT_RETRYABLE_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];

export function storedCircuitBreaker(input: CircuitBreakerConfigInput): CircuitBreakerConfig {
  return {
    ...input,
    failure_status_codes: input.failure_status_codes ?? [...DEFAULT_FAILURE_STATUS_CODES],
  };
}

export function storedRetry(input: RetryConfigInput): RetryConfig {
  return {
    ...input,
    retryable_status_codes: input.retryable_status_codes ?? [...DEFAULT_RETRYABLE_STATUS_CODES],
    retryable_methods: input.retryable_methods ?? [...DEFAULT_RETRYABLE_METHODS],
  };
}

/**
 * What a mock gateway stores and answers for a proxy write over `base`: the
 * body's fields, with the breaker and retry matchers the write omitted filled
 * in as Edge's deserializer does, so the result is a read-shaped `Proxy`.
 */
export function proxyFromWrite(base: Proxy, body: ProxyCreate): Proxy {
  const { circuit_breaker, retry, ...rest } = body;
  return {
    ...base,
    ...rest,
    ...(circuit_breaker !== undefined && {
      circuit_breaker: circuit_breaker && storedCircuitBreaker(circuit_breaker),
    }),
    ...(retry !== undefined && { retry: retry && storedRetry(retry) }),
  };
}
