export interface AudioFeatures {
  bass: number;
  mids: number;
  treble: number;
  energy: number;
  flux: number;
  beatPulse: number;
  kickPulse: number;
  beatCount: number;
  bpm: number | null;
}

export interface AudioFeatureFrame {
  readonly active: boolean;
  readonly timestamp: number;
  readonly bands: Float32Array;
  readonly features: AudioFeatures;
}

export interface AudioFeatureExtractorOptions {
  bandCount?: number;
}

export class AudioFeatureExtractor {
  constructor(options?: AudioFeatureExtractorOptions);
  readonly bandCount: number;
  readonly bands: Float32Array;
  readonly features: AudioFeatures;
  readonly frame: AudioFeatureFrame;
  reset(): AudioFeatureFrame;
  update(
    bands: ArrayLike<number>,
    timestamp: number,
    options?: { active?: boolean },
  ): AudioFeatureFrame;
}

export interface AudioStreamAnalyzerOptions extends AudioFeatureExtractorOptions {
  fftSize?: number;
  minDecibels?: number;
  maxDecibels?: number;
  smoothingTimeConstant?: number;
  minimumFrequency?: number;
  maximumFrequency?: number;
  latencyHint?: AudioContextLatencyCategory | number;
  audioContext?: AudioContext | null;
}

export interface AudioStreamDiagnostics {
  causal: true;
  connected: boolean;
  captureLatencyMilliseconds: number | null;
  contextBaseLatencyMilliseconds: number | null;
  sampleRate: number | null;
  fftSize: number;
  fftWindowMilliseconds: number | null;
  analyserSmoothing: number;
  bandCount: number;
}

export class AudioStreamAnalyzer {
  constructor(options?: AudioStreamAnalyzerOptions);
  readonly connected: boolean;
  readonly diagnostics: AudioStreamDiagnostics;
  connect(input: MediaStream | MediaStreamTrack): Promise<this>;
  resume(): Promise<void>;
  sample(timestamp?: number): AudioFeatureFrame;
  reset(): AudioFeatureFrame;
  disconnect(): Promise<void>;
}
