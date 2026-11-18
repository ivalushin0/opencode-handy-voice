import { SAMPLE_RATE, encodeWav } from "./wav.ts";

export interface Recording {
  // Mic loudness right now, as RMS from 0 to 1.
  level(): number;
  stop(): Promise<Uint8Array>;
  cancel(): void;
}

// Records the default microphone, then decodes and resamples to 16 kHz mono WAV.
export async function record(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  recorder.start();
  const meter = new AudioContext();
  const analyser = meter.createAnalyser();
  meter.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const release = () => {
    stream.getTracks().forEach((track) => track.stop());
    void meter.close();
  };

  return {
    level: () => {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    },
    stop: async () => {
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.stop();
      await stopped;
      release();
      const encoded = await new Blob(chunks).arrayBuffer();
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      try {
        const audio = await context.decodeAudioData(encoded);
        return encodeWav(audio.getChannelData(0));
      } finally {
        await context.close();
      }
    },
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}
