export class SearchError extends Error {
  // kind: no_key | bad_key | out_of_credits | rate_limited | blocked | network | unknown
  constructor(message, { kind = "unknown", backend = "", status, retryAfterMs = 0 } = {}) {
    super(message);
    this.kind = kind;
    this.backend = backend;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
