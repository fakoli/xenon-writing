/**
 * Preload façade (Packet C): the only API the renderer gets.
 *
 * One named method per allowlisted intent. Each builds its payload with
 * exactly the contract's fields, so nothing extra crosses the bridge, and
 * returns a safe result instead of throwing. Events reach the renderer only if
 * they match a v1 event schema, as fresh frozen copies. The API has no generic
 * invoke or send, no channel names and no Electron objects.
 *
 * Electron is not imported. The app's preload entry passes a transport built
 * on `ipcRenderer.invoke` and `ipcRenderer.on`, then calls
 * `contextBridge.exposeInMainWorld('xenon', createDesktopApi(transport))`.
 */
import { CONTRACT_VERSION } from '../contracts/session.ts';
import type { Envelope, MainEvent, RewriteAccepted, RewriteRequest, TranscribeAccepted, TranscribeRequest } from '../contracts/session.ts';
import { CHANNELS, EVENT_SCHEMAS, REQUEST_SCHEMAS, checkSchema, isPlainRecord, pickSchemaFields } from '../contracts/ipc.ts';
import type {
  AcknowledgeOutcomeRequest,
  AcknowledgeResult,
  CancelRequest,
  CancelResult,
  Capabilities,
  ChooseAudioResult,
  DiscardCaptureResult,
  MicrophoneStatus,
  StartCaptureResult,
  CloseResult,
  CopyDraftRequest,
  CopyResult,
  Intent,
  IpcResult,
  SessionOpened,
} from '../contracts/ipc.ts';

/** The two IPC primitives the façade needs; provided by the preload entry. */
export interface PreloadTransport {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  /** Subscribes to a main → renderer channel; returns an unsubscribe function. */
  subscribe(channel: string, listener: (payload: unknown) => void): () => void;
}

export interface DesktopApi {
  createSession(): Promise<IpcResult<SessionOpened>>;
  closeSession(envelope: Envelope): Promise<IpcResult<CloseResult>>;
  getCapabilities(envelope: Envelope): Promise<IpcResult<Capabilities>>;
  rewrite(request: RewriteRequest): Promise<IpcResult<RewriteAccepted>>;
  cancel(request: CancelRequest): Promise<IpcResult<CancelResult>>;
  copyDraft(request: CopyDraftRequest): Promise<IpcResult<CopyResult>>;
  /** Opens the native audio chooser. Call only from a deliberate user action. */
  chooseAudio(envelope: Envelope): Promise<IpcResult<ChooseAudioResult>>;
  /** Transcribes the session's chosen audio; the result arrives as events. */
  transcribe(request: TranscribeRequest): Promise<IpcResult<TranscribeAccepted>>;
  /** Permission state; never prompts. */
  microphoneStatus(envelope: Envelope): Promise<IpcResult<MicrophoneStatus>>;
  /** Call only from a deliberate Record action, after showing the explanation. */
  startCapture(envelope: Envelope): Promise<IpcResult<StartCaptureResult>>;
  stopCapture(request: Envelope & { readonly captureHandle: string }): Promise<IpcResult<ChooseAudioResult>>;
  discardCapture(request: Envelope & { readonly captureHandle: string }): Promise<IpcResult<DiscardCaptureResult>>;
  /** Call only from the deliberate Acknowledge in Inspect, with the job ID main reported and a fresh request ID. */
  acknowledgeOutcome(request: AcknowledgeOutcomeRequest): Promise<IpcResult<AcknowledgeResult>>;
  onEvent(listener: (event: MainEvent) => void): () => void;
}

/** Returns the event as a fresh frozen copy if it matches a v1 schema. */
export function filterEvent(payload: unknown): MainEvent | null {
  if (!isPlainRecord(payload) || typeof payload.type !== 'string' || !Object.hasOwn(EVENT_SCHEMAS, payload.type)) {
    return null;
  }
  const schema = EVENT_SCHEMAS[payload.type as MainEvent['type']];
  if (checkSchema(payload, schema) !== 'ok') return null;
  return Object.freeze(pickSchemaFields(payload, schema)) as unknown as MainEvent;
}

function isIpcResult(value: unknown): value is IpcResult<unknown> {
  if (!isPlainRecord(value)) return false;
  if (value.ok === true) return Object.hasOwn(value, 'value');
  return value.ok === false && typeof value.code === 'string';
}

export function createDesktopApi(transport: PreloadTransport): DesktopApi {
  async function call<T>(intent: Intent, fields: object): Promise<IpcResult<T>> {
    const payload = pickSchemaFields({ ...fields, v: CONTRACT_VERSION }, REQUEST_SCHEMAS[intent]);
    let reply: unknown;
    try {
      reply = await transport.invoke(CHANNELS[intent], payload);
    } catch {
      // The call may or may not have reached main.
      return { ok: false, code: 'unknown_outcome' };
    }
    return isIpcResult(reply) ? (reply as IpcResult<T>) : { ok: false, code: 'invalid_response' };
  }

  return Object.freeze({
    createSession: () => call<SessionOpened>('createSession', {}),
    closeSession: (envelope: Envelope) => call<CloseResult>('closeSession', envelope),
    getCapabilities: (envelope: Envelope) => call<Capabilities>('getCapabilities', envelope),
    rewrite: (request: RewriteRequest) => call<RewriteAccepted>('rewrite', request),
    cancel: (request: CancelRequest) => call<CancelResult>('cancel', request),
    copyDraft: (request: CopyDraftRequest) => call<CopyResult>('copyDraft', request),
    chooseAudio: (envelope: Envelope) => call<ChooseAudioResult>('chooseAudio', envelope),
    transcribe: (request: TranscribeRequest) => call<TranscribeAccepted>('transcribe', request),
    microphoneStatus: (envelope: Envelope) => call<MicrophoneStatus>('microphoneStatus', envelope),
    startCapture: (envelope: Envelope) => call<StartCaptureResult>('startCapture', envelope),
    stopCapture: (request: Envelope & { readonly captureHandle: string }) => call<ChooseAudioResult>('stopCapture', request),
    discardCapture: (request: Envelope & { readonly captureHandle: string }) => call<DiscardCaptureResult>('discardCapture', request),
    acknowledgeOutcome: (request: AcknowledgeOutcomeRequest) => call<AcknowledgeResult>('acknowledgeOutcome', request),
    onEvent(listener: (event: MainEvent) => void) {
      return transport.subscribe(CHANNELS.event, (payload) => {
        const event = filterEvent(payload);
        if (event !== null) listener(event);
      });
    },
  });
}
