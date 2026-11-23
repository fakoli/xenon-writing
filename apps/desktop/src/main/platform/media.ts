/**
 * Audio intake for the fixture route (Packet E, part 1).
 *
 * Untrusted media is checked before anything else sees it (trust model). The
 * actual container and sample format are read and compared against the
 * fixture limits from the component design: WAV, PCM, mono, 16 kHz, 16-bit, at most
 * 30 s and 1 MiB. The file name, extension and claimed MIME type are never
 * trusted, and no path ever reaches the renderer.
 *
 * Choosing a file goes through an injected port. Electron wiring implements
 * it with a native open dialog plus a size-capped read. Tests use fakes. The
 * chooser never opens at launch, only from an explicit intent.
 */
import type { FailureCode } from '../../contracts/session.ts';
import type { AudioSummary } from '../../contracts/ipc.ts';

export const FIXTURE_AUDIO = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDurationMs: 30_000,
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
});

/** 16-bit mono at 16 kHz: 2 bytes per frame, 32 bytes per millisecond. */
const BYTES_PER_FRAME = 2;
const BYTES_PER_MS = (FIXTURE_AUDIO.sampleRate * BYTES_PER_FRAME) / 1000;
const MAX_DATA_BYTES = FIXTURE_AUDIO.maxDurationMs * BYTES_PER_MS;
const PCM = 1;

/**
 * On success, `canonical` is a freshly allocated WAV holding only the fmt and
 * data chunks. Metadata chunks (LIST/INFO, bext, iXML and the like, which can
 * carry names, paths or originators) are dropped, so nothing but samples
 * reaches a later transcriber. It never shares memory with the input.
 */
export type WavVerdict =
  | { readonly ok: true; readonly summary: AudioSummary; readonly canonical: Uint8Array }
  | { readonly ok: false; readonly code: FailureCode };

/** A minimal 44-byte-header WAV around a copy of the given PCM samples. */
function canonicalWav(samples: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 36 + samples.byteLength, true);
  out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8); // WAVEfmt
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM, true);
  view.setUint16(22, FIXTURE_AUDIO.channels, true);
  view.setUint32(24, FIXTURE_AUDIO.sampleRate, true);
  view.setUint32(28, FIXTURE_AUDIO.sampleRate * BYTES_PER_FRAME, true);
  view.setUint16(32, BYTES_PER_FRAME, true);
  view.setUint16(34, FIXTURE_AUDIO.bitsPerSample, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36); // data
  view.setUint32(40, samples.byteLength, true);
  out.set(samples, 44);
  return out;
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}

/**
 * Inspects WAV bytes against the fixture limits.
 * - `invalid_input`: not a well-formed RIFF/WAVE file, an empty or partial
 *   sample frame, or over the size or duration limit.
 * - `unsupported`: a well-formed WAV in another sample format.
 */
export function inspectWav(bytes: Uint8Array, options: { readonly trimToLimit?: boolean } = {}): WavVerdict {
  const bad = { ok: false, code: 'invalid_input' } as const;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > FIXTURE_AUDIO.maxBytes || bytes.byteLength < 12) return bad;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') return bad;
  if (view.getUint32(4, true) !== bytes.byteLength - 8) return bad; // truncated or padded

  let format: { audioFormat: number; channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number } | null = null;
  let dataBytes: number | null = null;
  let dataOffset = 0;
  let offset = 12;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) return bad;
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) return bad;
    if (id === 'fmt ') {
      if (format !== null || dataBytes !== null || size < 16) return bad; // one fmt, before data
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (format === null || dataBytes !== null) return bad; // data needs a preceding fmt, once
      dataBytes = size;
      dataOffset = body;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  // A missing pad byte after an odd-sized final chunk is tolerated; many writers omit it.
  if (format === null || dataBytes === null) return bad;

  const matches =
    format.audioFormat === PCM &&
    format.channels === FIXTURE_AUDIO.channels &&
    format.sampleRate === FIXTURE_AUDIO.sampleRate &&
    format.bits === FIXTURE_AUDIO.bitsPerSample &&
    format.blockAlign === BYTES_PER_FRAME &&
    format.byteRate === FIXTURE_AUDIO.sampleRate * BYTES_PER_FRAME;
  if (!matches) return { ok: false, code: 'unsupported' };
  if (dataBytes === 0 || dataBytes % BYTES_PER_FRAME !== 0) return bad;
  // A recording that overshoots the limit keeps its first 30 s instead of losing the take.
  if (dataBytes > MAX_DATA_BYTES) {
    if (!options.trimToLimit) return bad;
    dataBytes = MAX_DATA_BYTES;
  }

  const canonical = canonicalWav(bytes.subarray(dataOffset, dataOffset + dataBytes));
  return {
    ok: true,
    // Rounded up, so any non-empty audio reports at least 1 ms.
    summary: { format: 'wav-pcm16-mono-16k', durationMs: Math.ceil(dataBytes / BYTES_PER_MS), bytes: canonical.byteLength },
    canonical,
  };
}

/** What the platform chooser returns. Never a path, name or handle to the file. */
export type ChooserResult = { readonly status: 'cancelled' } | { readonly status: 'picked'; readonly bytes: Uint8Array };

/**
 * Native file chooser, implemented by the Electron wiring. It must:
 * - open only when called, and always modal to the calling window;
 * - read at most `maxBytes + 1` bytes, so an oversized file fails validation
 *   instead of being loaded whole;
 * - never return the path.
 */
export interface AudioChooserPort {
  /** windowId is the asking window's webContents ID; the dialog is modal to it. */
  pickAudio(options: { readonly maxBytes: number; readonly windowId: number }): Promise<ChooserResult>;
}
