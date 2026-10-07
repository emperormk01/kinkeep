import { timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

export function isValidBearerAuthorization(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header);
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

export function validConfiguredToken(token: string | undefined): token is string {
  return !!token && /^[A-Za-z0-9_-]{43,}$/.test(token) && Buffer.byteLength(token) >= TOKEN_BYTES;
}
