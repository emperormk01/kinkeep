import { timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

// Extract the token from an Authorization header. Only the header form is
// accepted; a token in the query string is never read.
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header);
  return match ? match[1] : null;
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isValidBearerAuthorization(header: string | undefined, token: string): boolean {
  const supplied = bearerToken(header);
  return supplied !== null && timingSafeStringEqual(supplied, token);
}

export function validConfiguredToken(token: string | undefined): token is string {
  return !!token && /^[A-Za-z0-9_-]{43,}$/.test(token) && Buffer.byteLength(token) >= TOKEN_BYTES;
}
