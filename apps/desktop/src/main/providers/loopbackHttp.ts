/**
 * Loopback HTTP transport for one configured chat route (desktop-to-pipeline
 * route; today only the local base rewrite route, in baseRewriteRoute.ts).
 *
 * The only main-process file allowed `node:http` (tests/contract/offline.test.ts).
 * It reaches exactly one destination: the literal address 127.0.0.1 (no name
 * resolution, no IPv6) and the port its route card names, never anything a
 * renderer or a reply supplies. Each request uses its own connection
 * (`agent: false`, `Connection: close`), follows no redirect (`node:http`
 * never does), and stops on the job's abort signal.
 *
 * With an identity check (the local base rewrite route), the body waits for proof of which
 * process answers (serverIdentity.ts): the transport reads this start's
 * secret first, sends only the headers with `Expect: 100-continue` and a
 * fresh nonce, and writes the body on the same connection only after the
 * `100 Continue` carries the HMAC it expects for this connection's two ends.
 * A missing or unsafe identity file, a missing, wrong or late proof, or a
 * final reply before the proof, closes the connection with the body unsent.
 *
 * What it reports, for the chat-rewrite core's failure mapping:
 * - an error while no byte of the body can have left (the connection never
 *   opened, the identity was not proved, or an abort came first) →
 *   NotSent;
 * - any error after that, including an abort → that error, which the
 *   runner reports as unknown_outcome;
 * - a reply → its status, content type and at most maxReplyBytes + 1 bytes
 *   of body (it stops reading there).
 * It logs nothing: no request, reply, address, secret or error text.
 */
import http from 'node:http';
import type { ChatReply, ChatRequest, ChatTransport } from './chatRewrite.ts';
import { NotSent } from './chatRewrite.ts';
import { NONCE_HEADER, PROOF_HEADER, computeProof, endpoint, newNonce, proofMatches } from './serverIdentity.ts';

export const LOOPBACK_HOST = '127.0.0.1';

/** Proof of which process answers, required before the body is sent. */
export interface ServerIdentityCheck {
  /** The model the service must have been started with: the route identity. */
  readonly model: string;
  /** This start's secret. Rejects when it cannot be read safely; then nothing is sent. */
  readonly readSecret: () => Promise<Uint8Array>;
  /** How long after the connection opens the proof may take. */
  readonly proofTimeoutMs: number;
}

export interface LoopbackConfig {
  /** The route card's port on 127.0.0.1. */
  readonly port: number;
  readonly identity?: ServerIdentityCheck;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export function createLoopbackTransport(config: LoopbackConfig): ChatTransport {
  const { port, identity } = config;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('loopback transport needs a port from 1 to 65535');
  if (identity !== undefined && (!Number.isSafeInteger(identity.proofTimeoutMs) || identity.proofTimeoutMs < 1)) {
    throw new Error('an identity check needs a positive proof timeout');
  }

  function exchange(request: ChatRequest, signal: AbortSignal, secret: Uint8Array | undefined): Promise<ChatReply> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new NotSent());
        return;
      }
      // An abort while waiting for the proof leaves the body unsent, so it is
      // NotSent too: the chat core reports route_unavailable, not an unknown
      // outcome, because nothing of the text can have reached the service.
      // Whether any byte of the body may have left this process. Without an
      // identity check the body follows the headers once the connection opens.
      let bodyMayHaveLeft = false;
      let settled = false;
      let proofTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(proofTimer);
        signal.removeEventListener('abort', onAbort);
        outcome();
      };
      const nonce = secret === undefined ? undefined : newNonce();
      const proofHeaders: Record<string, string> = nonce === undefined ? {} : { expect: '100-continue', [NONCE_HEADER]: nonce };

      const req = http.request({
        host: LOOPBACK_HOST,
        port,
        method: 'POST',
        path: request.path,
        // Load-bearing: a fresh agent per request, never the global one. With
        // NODE_USE_ENV_PROXY (Node 24+, Electron 45's Node), the global agent
        // sends requests to HTTP_PROXY; this one cannot.
        agent: false,
        headers: { ...request.headers, 'content-length': String(request.body.byteLength), connection: 'close', ...proofHeaders },
      });
      const onAbort = () => {
        req.destroy(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Closes the connection. NotSent only while the body is certainly unsent.
      const refuse = () => {
        const unsent = !bodyMayHaveLeft;
        finish(() => reject(unsent ? new NotSent() : new Error('refused after the body')));
        req.destroy();
      };
      // The proof's clock starts with the request, so it never depends on the
      // connection's events.
      if (identity !== undefined) proofTimer = setTimeout(refuse, identity.proofTimeoutMs);

      req.on('socket', (socket) => {
        socket.once('connect', () => {
          if (identity === undefined) bodyMayHaveLeft = true;
        });
      });
      req.on('information', (info) => {
        if (settled || secret === undefined || nonce === undefined || identity === undefined || bodyMayHaveLeft || info.statusCode !== 100) return;
        // This connection's two ends as this side sees them: a relay forwarding
        // the nonce elsewhere gets a proof for its own connection, not this one.
        const socket: { remoteAddress?: string; remotePort?: number; localAddress?: string; localPort?: number } | null = req.socket;
        const { remoteAddress, remotePort, localAddress, localPort } = socket ?? {};
        const proved =
          remoteAddress !== undefined &&
          remotePort !== undefined &&
          localAddress !== undefined &&
          localPort !== undefined &&
          proofMatches(computeProof(secret, nonce, endpoint(remoteAddress, remotePort), endpoint(localAddress, localPort), identity.model), info.headers[PROOF_HEADER]);
        if (!proved) {
          refuse();
          return;
        }
        clearTimeout(proofTimer);
        bodyMayHaveLeft = true;
        req.end(Buffer.from(request.body));
      });
      req.on('error', (error) => {
        finish(() => reject(bodyMayHaveLeft ? error : new NotSent()));
      });
      req.on('response', (res) => {
        if (settled) return;
        // A final reply before the proof: the service answered without the body.
        if (!bodyMayHaveLeft) {
          refuse();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const deliver = () => {
          if (done) return;
          done = true;
          const body = new Uint8Array(Buffer.concat(chunks, Math.min(size, request.maxReplyBytes + 1)));
          finish(() => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body }));
          req.destroy();
        };
        res.on('data', (chunk: Buffer) => {
          if (done) return;
          chunks.push(chunk);
          size += chunk.byteLength;
          // Enough to prove the reply is over the cap: stop reading.
          if (size > request.maxReplyBytes) deliver();
        });
        res.on('end', deliver);
        res.on('error', (error) => {
          if (!done) finish(() => reject(error));
        });
        res.on('aborted', () => {
          if (!done) finish(() => reject(new Error('reply aborted')));
        });
      });

      if (secret === undefined) req.end(Buffer.from(request.body));
      else req.flushHeaders();
    });
  }

  return {
    async send(request: ChatRequest, signal: AbortSignal): Promise<ChatReply> {
      if (identity === undefined) return exchange(request, signal, undefined);
      // An abort before or during the read is caught by exchange(), before any connection.
      let secret: Uint8Array;
      try {
        secret = await identity.readSecret();
      } catch {
        throw new NotSent();
      }
      return exchange(request, signal, secret);
    },
  };
}
