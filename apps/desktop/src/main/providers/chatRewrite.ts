/**
 * Chat-rewrite provider core (desktop-to-pipeline route, slice 2).
 *
 * Speaks the narrow OpenAI-compatible chat subset that both the local base
 * rewrite service (the Swift reference's BaseRewriteClient) and the
 * writing_pipeline's chat view accept: one system message (a fixed rule plus
 * the steering) and one user message (the transcript), `stream: false`,
 * temperature 0. The route's identity is the exact model string: the request
 * names it and the reply must echo it, so the identity a job reports is the
 * one checked on the wire. The reply must also carry one choice that stopped
 * normally and fit the route's draft limit. The job ID goes out as the
 * Idempotency-Key, so a downstream that keeps receipts (the pipeline) dedupes
 * a repeat and a reconciliation can find the job.
 *
 * It sends nothing itself. The HTTP exchange goes through an injected
 * ChatTransport: the local base rewrite route's is `loopbackHttp.ts`, the only file that
 * opens a socket.
 *
 * Failure mapping, following the job runner's dispatch rule:
 * - input over the route's limits → invalid_input, before dispatch;
 * - the transport proves nothing was sent (NotSent) → route_unavailable;
 * - any other transport failure, or an abort, after dispatch → left to the
 *   runner, which reports unknown_outcome;
 * - HTTP 400, 401, 403, 404, 405, 413 or 415 → route_unavailable: the
 *   service refused the request before handling it;
 * - every other status but 200 → unknown_outcome. That includes 409, which
 *   the pipeline uses both for refusals and for `rewrite_outcome_unknown`;
 *   telling them apart would let the reply's own error code lower certainty.
 *   It also includes 5xx (a saturated pipeline's 503 is no permission to
 *   replay), other 2xx and 3xx;
 * - a reply for another model, or one whose pipeline metadata contradicts
 *   the route's mode → provider_mismatch;
 * - any other malformed, truncated, oversized or empty reply → invalid_response.
 * It never retries and never tries another route.
 */
import type { PublishedRoute } from '../../contracts/ipc.ts';
import { isToken } from '../../contracts/session.ts';
import { ProviderFailure } from '../jobs.ts';
import type { RewriteInput, RewriteProvider } from '../jobs.ts';

export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

/**
 * The fixed instruction ahead of the steering, adapted from the Swift
 * reference. It is a proposal: the wording is a product decision before any
 * live route.
 */
export const REWRITE_RULE =
  'Rewrite the transcript. Preserve all facts, names, numbers, dates, negations and commitments. ' +
  'Apply the steering only when it does not change meaning. Return only the rewritten text. ' +
  'Do not claim personalization. Steering: ';

/** One HTTP exchange as the transport performs it. Never a URL, host or credential. */
export interface ChatRequest {
  readonly path: typeof CHAT_COMPLETIONS_PATH;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /**
   * The transport stops reading once a reply exceeds this and delivers at
   * most this many bytes plus one, so the reply check refuses it as invalid
   * (the service did answer) without buffering an unbounded body.
   */
  readonly maxReplyBytes: number;
}

export interface ChatReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
}

/**
 * Sends one request to the route's single configured destination. Rejects
 * on any failure and stops when the signal aborts. Rejects with NotSent only
 * when it knows no byte of the request was written (for example, the
 * connection was refused); any other rejection may follow a send.
 */
export interface ChatTransport {
  send(request: ChatRequest, signal: AbortSignal): Promise<ChatReply>;
}

/** A transport's proof that the request never left this process. */
export class NotSent extends Error {
  constructor() {
    super('not sent');
    this.name = 'NotSent';
  }
}

/**
 * The writing pipeline chat view's own bounds, which a fixture route to it
 * must fit before anything is sent. It counts characters; the desktop counts
 * UTF-8 bytes, which are never fewer, so byte limits at or under these fit.
 * The pipeline checks the same numbers from its side against
 * tests/fixtures/chat-rewrite-v1.json.
 */
export const PIPELINE_CHAT_LIMITS = Object.freeze({
  userChars: 16_000,
  systemChars: 4_000,
  maxTokens: 8_192,
  identifier: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
});

/** Statuses that mean the service refused the request before handling it. */
const REFUSED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 405, 413, 415]);

export interface ChatRewriteConfig {
  /**
   * The published rewrite route this adapter serves. It supplies the limits,
   * and its identity is the exact model string requested and expected back.
   */
  readonly route: PublishedRoute;
  readonly maxTokens: number;
  /** This route's approved job timeout. */
  readonly timeoutMs: number;
  readonly maxReplyBytes: number;
  readonly transport: ChatTransport;
  /**
   * When set, every text the user wrote must contain this word (any case):
   * the transcript always, the steering whenever it is not empty. Otherwise
   * the job is `unsupported` before dispatch. The local base rewrite route's
   * synthetic-text-only exception; the Swift reference checks the transcript
   * only. An operator guard, not a privacy classifier.
   */
  readonly requireMarker?: string;
}

export interface ChatRewriteProvider extends RewriteProvider {
  /** How many requests reached the transport; tests assert exact counts. */
  readonly sends: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** The exact request body for one rewrite. Exported for the shared contract vectors. */
export function chatRequestBody(model: string, maxTokens: number, input: Pick<RewriteInput, 'transcript' | 'steering'>): Record<string, unknown> {
  return {
    model,
    stream: false,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: REWRITE_RULE + input.steering },
      { role: 'user', content: input.transcript },
    ],
  };
}

/**
 * Checks a reply and returns the draft text, or throws ProviderFailure.
 * Exported so the shared contract vectors can exercise it directly.
 */
export function readChatReply(route: PublishedRoute, maxReplyBytes: number, reply: ChatReply): string {
  if (reply.status !== 200) throw new ProviderFailure(REFUSED_STATUSES.has(reply.status) ? 'route_unavailable' : 'unknown_outcome');
  if (!/^application\/json(\s*;|$)/i.test(reply.contentType)) throw new ProviderFailure('invalid_response');
  if (reply.body.byteLength > maxReplyBytes) throw new ProviderFailure('invalid_response');

  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(reply.body));
  } catch {
    throw new ProviderFailure('invalid_response');
  }
  if (!isRecord(value)) throw new ProviderFailure('invalid_response');
  if (value.model !== route.identity) throw new ProviderFailure('provider_mismatch');

  // The writing_pipeline marks its replies; the model name alone does not say
  // whether a reply is synthetic. A fixture route must carry that mark, and
  // nothing may claim personalization on a fixture or base route.
  const metadata = value.writing_pipeline;
  if (metadata !== undefined) {
    if (!isRecord(metadata) || typeof metadata.synthetic_only !== 'boolean' || typeof metadata.personalized !== 'boolean') {
      throw new ProviderFailure('invalid_response');
    }
    if (metadata.personalized) throw new ProviderFailure('provider_mismatch');
    if (metadata.synthetic_only !== (route.mode === 'fixture')) throw new ProviderFailure('provider_mismatch');
  } else if (route.mode === 'fixture') {
    throw new ProviderFailure('provider_mismatch');
  }

  if (value.object !== 'chat.completion') throw new ProviderFailure('invalid_response');
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length !== 1) throw new ProviderFailure('invalid_response');
  const choice: unknown = choices[0];
  // 'length' means the model was cut off: a truncated draft is not a draft.
  if (!isRecord(choice) || choice.finish_reason !== 'stop') throw new ProviderFailure('invalid_response');
  const message = choice.message;
  if (!isRecord(message) || message.role !== 'assistant' || typeof message.content !== 'string') {
    throw new ProviderFailure('invalid_response');
  }
  const text = message.content;
  if (text.trim() === '' || utf8Bytes(text) > route.limits.draftBytes) throw new ProviderFailure('invalid_response');
  return text;
}

/**
 * Builds the adapter. Throws at startup on a config it cannot serve
 * honestly, so a misconfigured route fails closed.
 */
export function createChatRewriteProvider(config: ChatRewriteConfig): ChatRewriteProvider {
  const { route, maxTokens, timeoutMs, maxReplyBytes, transport, requireMarker } = config;
  if (requireMarker !== undefined && requireMarker.trim() === '') throw new Error('a required marker must not be blank');
  const model = route.identity;
  if (route.stage !== 'rewrite') throw new Error('chat rewrite serves the rewrite stage only');
  // Personalized output needs runtime readiness and activation, which do not exist.
  if (route.mode !== 'fixture' && route.mode !== 'base') throw new Error('chat rewrite serves fixture or base routes only');
  if (!isToken(model)) throw new Error('chat rewrite needs the exact model as the route identity');
  if (!isPositiveInteger(maxTokens) || !isPositiveInteger(timeoutMs) || !isPositiveInteger(maxReplyBytes)) {
    throw new Error('chat rewrite needs positive integer limits');
  }
  // The only synthetic destination that leaves the process is the pipeline's
  // chat view: a fixture route must fit its bounds, or requests that pass
  // main's checks would be refused after dispatch.
  if (route.mode === 'fixture') {
    const fits =
      PIPELINE_CHAT_LIMITS.identifier.test(model) &&
      route.limits.transcriptBytes <= PIPELINE_CHAT_LIMITS.userChars &&
      REWRITE_RULE.length + route.limits.steeringBytes <= PIPELINE_CHAT_LIMITS.systemChars &&
      maxTokens <= PIPELINE_CHAT_LIMITS.maxTokens;
    if (!fits) throw new Error('a fixture chat route must fit the pipeline chat view limits');
  }
  let sends = 0;

  return {
    routeKey: route.routeKey,
    mode: route.mode,
    identity: route.identity,
    timeoutMs,
    get sends() {
      return sends;
    },
    async run(input, control) {
      if (input.transcript.trim() === '' || utf8Bytes(input.transcript) > route.limits.transcriptBytes) {
        throw new ProviderFailure('invalid_input');
      }
      if (utf8Bytes(input.steering) > route.limits.steeringBytes) throw new ProviderFailure('invalid_input');
      if (requireMarker !== undefined) {
        const marked = (text: string) => text.toLowerCase().includes(requireMarker.toLowerCase());
        if (!marked(input.transcript) || (input.steering !== '' && !marked(input.steering))) throw new ProviderFailure('unsupported');
      }
      // Main issues job IDs; anything else must not reach a header.
      if (!PIPELINE_CHAT_LIMITS.identifier.test(input.jobId)) throw new ProviderFailure('invalid_input');
      const request: ChatRequest = {
        path: CHAT_COMPLETIONS_PATH,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': input.jobId },
        body: encoder.encode(JSON.stringify(chatRequestBody(model, maxTokens, input))),
        maxReplyBytes,
      };

      // Marked before the transport starts, which is earlier than the first
      // byte leaves: that can only turn a certain outcome into unknown_outcome,
      // never the reverse. Throws if the job already ended: then send nothing.
      control.dispatched();
      sends += 1;
      let reply: ChatReply;
      try {
        reply = await transport.send(request, control.signal);
      } catch (error) {
        if (error instanceof NotSent) throw new ProviderFailure('route_unavailable');
        throw error;
      }
      return { actualMode: route.mode, actualIdentity: route.identity, text: readChatReply(route, maxReplyBytes, reply) };
    },
  };
}
