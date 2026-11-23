/**
 * Loopback HTTP transport for one configured chat route (desktop-to-pipeline
 * route; today only route card 07, in baseRewriteRoute.ts).
 *
 * The only main-process file allowed `node:http` (tests/contract/offline.test.ts).
 * It reaches exactly one destination: the literal address 127.0.0.1 (no name
 * resolution, no IPv6) and the port its route card names, never anything a
 * renderer or a reply supplies. Each request uses its own connection
 * (`agent: false`, `Connection: close`), follows no redirect (`node:http`
 * never does), and stops on the job's abort signal.
 *
 * What it reports, for the chat-rewrite core's failure mapping:
 * - an error before the TCP connection opened (refused, unreachable) →
 *   NotSent: no byte of the request left this process;
 * - any error after it opened, including an abort → that error, which the
 *   runner reports as unknown_outcome;
 * - a reply → its status, content type and at most maxReplyBytes + 1 bytes
 *   of body (it stops reading there).
 * It logs nothing: no request, reply, address or error text.
 */
import http from 'node:http';
import type { ChatReply, ChatRequest, ChatTransport } from './chatRewrite.ts';
import { NotSent } from './chatRewrite.ts';

export const LOOPBACK_HOST = '127.0.0.1';

export interface LoopbackConfig {
  /** The route card's port on 127.0.0.1. */
  readonly port: number;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export function createLoopbackTransport(config: LoopbackConfig): ChatTransport {
  const { port } = config;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('loopback transport needs a port from 1 to 65535');

  return {
    send(request: ChatRequest, signal: AbortSignal): Promise<ChatReply> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new NotSent());
          return;
        }
        let connected = false;
        let settled = false;
        const finish = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          outcome();
        };

        const req = http.request({
          host: LOOPBACK_HOST,
          port,
          method: 'POST',
          path: request.path,
          // Load-bearing: a fresh agent per request, never the global one. With
          // NODE_USE_ENV_PROXY (Node 24+, Electron 45's Node), the global agent
          // sends requests to HTTP_PROXY; this one cannot.
          agent: false,
          headers: { ...request.headers, 'content-length': String(request.body.byteLength), connection: 'close' },
        });
        const onAbort = () => {
          req.destroy(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });

        req.on('socket', (socket) => {
          socket.once('connect', () => {
            connected = true;
          });
        });
        req.on('error', (error) => {
          finish(() => reject(connected ? error : new NotSent()));
        });
        req.on('response', (res) => {
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

        req.end(Buffer.from(request.body));
      });
    },
  };
}
