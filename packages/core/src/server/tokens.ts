import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, URL-safe (session cookies and overlay tokens). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as their SHA-256 hash. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
