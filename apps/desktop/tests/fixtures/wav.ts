/**
 * Generated, non-personal audio fixtures. The `noon.wav` fixture is built here
 * at test time instead of being committed as a binary. It is a plain sine tone with no speech or recording.
 */
export interface WavOptions {
  readonly durationMs?: number;
  /** Exact number of sample frames; overrides durationMs. */
  readonly frames?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly bitsPerSample?: number;
  /** 1 = PCM, 3 = IEEE float, 0xFFFE = extensible. */
  readonly audioFormat?: number;
  /** Extra chunks before "data", e.g. a LIST chunk. Odd sizes get a pad byte. */
  readonly extraChunks?: readonly { readonly id: string; readonly size: number; readonly afterData?: boolean }[];
  /** Put the data chunk before fmt (malformed). */
  readonly dataFirst?: boolean;
  /** Bytes appended to the sample data, e.g. 1 for a partial frame. */
  readonly extraDataBytes?: number;
  /** Override single fmt fields only (inconsistent headers). */
  readonly channelsField?: number;
  readonly blockAlignField?: number;
  readonly byteRateField?: number;
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  const pad = body.byteLength % 2;
  const out = new Uint8Array(8 + body.byteLength + pad);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.byteLength, true);
  out.set(body, 8);
  return out;
}

export function synthWav(options: WavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;
  const bits = options.bitsPerSample ?? 16;
  const bytesPerFrame = (channels * bits) / 8;
  const frames = options.frames ?? Math.round(((options.durationMs ?? 1_000) * sampleRate) / 1000);

  const fmt = new Uint8Array(16);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, options.audioFormat ?? 1, true);
  f.setUint16(2, options.channelsField ?? channels, true);
  f.setUint32(4, sampleRate, true);
  f.setUint32(8, options.byteRateField ?? sampleRate * bytesPerFrame, true);
  f.setUint16(12, options.blockAlignField ?? bytesPerFrame, true);
  f.setUint16(14, bits, true);

  // A quiet 440 Hz tone: synthetic, deterministic, no speech.
  const data = new Uint8Array(frames * bytesPerFrame + (options.extraDataBytes ?? 0));
  if (bits === 16) {
    const d = new DataView(data.buffer);
    for (let i = 0; i < frames; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 3000);
      for (let c = 0; c < channels; c++) d.setInt16((i * channels + c) * 2, sample, true);
    }
  }

  const extras = (after: boolean) =>
    (options.extraChunks ?? []).filter((c) => (c.afterData ?? false) === after).map(({ id, size }) => chunk(id, new Uint8Array(size)));
  const parts = options.dataFirst
    ? [chunk('data', data), chunk('fmt ', fmt)]
    : [chunk('fmt ', fmt), ...extras(false), chunk('data', data), ...extras(true)];
  const bodyLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(12 + bodyLength);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  new DataView(out.buffer).setUint32(4, 4 + bodyLength, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  let offset = 12;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** The "noon" fixture: one second of tone standing in for "Meet at noon.". */
export const noonWav = (): Uint8Array => synthWav({ durationMs: 1_000 });
