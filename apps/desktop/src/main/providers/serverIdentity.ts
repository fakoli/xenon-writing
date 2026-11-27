/**
 * Server identity proof for the local base rewrite route: the client half of
 * `loopback-model-identity/v1`. The service half is the launcher of the model
 * service the owner runs, which is specified and tested outside this repository.
 *
 * At each start the service writes a fresh 32-byte secret to a file only the
 * owner can read. Before the transcript leaves the app, the transport sends
 * the request headers with `Expect: 100-continue` and a fresh nonce; the
 * service answers `100 Continue` with an HMAC-SHA256, under that secret, of
 * the nonce, both ends of this TCP connection and the model it was started
 * with. Only a matching proof lets the body go out, on the same connection.
 *
 * Pure functions only: reading the file is `identityFile.ts`, the exchange is
 * `loopbackHttp.ts`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const IDENTITY_SCHEMA = 'loopback-model-identity/v1';
export const NONCE_HEADER = 'x-anvil-identity-nonce';
export const PROOF_HEADER = 'x-anvil-identity-proof';
const SECRET_BYTES = 32;
const NONCE_BYTES = 32;
const PROOF_BYTES = 32;

/** What the identity file must say for this route. */
export interface IdentityExpectation {
  readonly model: string;
  readonly port: number;
}

/** Why an identity could not be established. Never carries the secret or file contents. */
export class IdentityUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'IdentityUnavailable';
  }
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Decodes unpadded base64url of exactly `length` bytes, canonical form only. */
export function decodeBase64urlExact(text: string, length: number): Uint8Array | undefined {
  if (text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.byteLength !== length || bytes.toString('base64url') !== text) return undefined;
  return new Uint8Array(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks the identity file's text and returns this start's secret. Refuses
 * another schema, model or port: then the service is not the one the card names.
 */
export function parseIdentityRecord(text: string, expected: IdentityExpectation): Uint8Array {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IdentityUnavailable('identity file is not JSON');
  }
  if (!isRecord(value) || value.schema !== IDENTITY_SCHEMA) throw new IdentityUnavailable('identity file has another schema');
  if (value.model !== expected.model) throw new IdentityUnavailable('identity file names another model');
  if (value.port !== expected.port) throw new IdentityUnavailable('identity file names another port');
  const secret = typeof value.secret === 'string' ? decodeBase64urlExact(value.secret, SECRET_BYTES) : undefined;
  if (secret === undefined) throw new IdentityUnavailable('identity file has no valid secret');
  return secret;
}

/** `host:port`, IPv6 in brackets, as the service formats it. */
export function endpoint(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** The exact bytes the proof covers. */
export function proofMessage(nonce: string, server: string, client: string, model: string): Uint8Array {
  return new TextEncoder().encode([IDENTITY_SCHEMA, `nonce=${nonce}`, `server=${server}`, `client=${client}`, `model=${model}`].join('\n'));
}

export function computeProof(secret: Uint8Array, nonce: string, server: string, client: string, model: string): string {
  return base64url(createHmac('sha256', secret).update(proofMessage(nonce, server, client, model)).digest());
}

export function newNonce(): string {
  return base64url(randomBytes(NONCE_BYTES));
}

/** Constant-time comparison of a received proof with the expected one. */
export function proofMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const want = decodeBase64urlExact(expected, PROOF_BYTES);
  const got = decodeBase64urlExact(received, PROOF_BYTES);
  return want !== undefined && got !== undefined && timingSafeEqual(want, got);
}
