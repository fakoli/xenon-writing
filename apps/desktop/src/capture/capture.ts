/**
 * The hidden capture window's page (Packet E, macOS). Main opens it only for
 * a recording it has already been granted. It opens the default input,
 * converts it to 16 kHz mono 16-bit samples and hands them to main, and stops
 * when main asks or the track ends. It shows nothing and keeps nothing.
 */
interface CaptureHost {
  started(): void;
  failed(name: string): void;
  chunk(buffer: ArrayBuffer): void;
  ended(): void;
  flushed(): void;
  onFlush(listener: () => void): void;
}

const host = (window as unknown as { captureHost: CaptureHost }).captureHost;
// Small buffers, so Stop loses at most about 128 ms that the processor still holds.
const BUFFER = 2048;

async function capture(): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
  } catch (error) {
    host.failed(error instanceof DOMException ? error.name : 'Error');
    return;
  }
  const track = stream.getAudioTracks()[0];
  if (track === undefined) {
    host.failed('NotFoundError');
    return;
  }
  // The audio graph resamples the input to the fixture rate. Anything else would distort the recording
  // and its length, so refuse it rather than send it.
  const context = new AudioContext({ sampleRate: 16_000 });
  if (context.sampleRate !== 16_000) {
    track.stop();
    void context.close();
    host.failed('NotSupportedError');
    return;
  }
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(BUFFER, 1, 1);
  let open = true;
  processor.onaudioprocess = (event) => {
    if (!open) return;
    const input = event.inputBuffer.getChannelData(0);
    const samples = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const value = Math.max(-1, Math.min(1, input[i] as number));
      samples[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
    host.chunk(samples.buffer);
  };
  source.connect(processor);
  processor.connect(context.destination); // the processor only runs when connected; its output is silent
  const stop = () => {
    open = false;
    track.stop();
    void context.close();
  };
  track.addEventListener('ended', () => {
    if (!open) return;
    stop();
    host.ended();
  });
  host.onFlush(() => {
    stop();
    host.flushed();
  });
  host.started();
}

void capture();
