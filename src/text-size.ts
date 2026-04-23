export type VideoTextSizePreset = 'compact' | 'standard' | 'large';

export interface TerminalTextMetrics {
  fontSize: number;
  lineHeight: number;
  cursorWidth: number;
  cursorMinHeight: number;
}

export interface ReplayTextMetrics {
  leadFontSize: number;
  bodyFontSize: number;
  timestampFontSize: number;
  lineHeight: number;
  barTextFontSize: number;
}

const DEFAULT_PRESET: VideoTextSizePreset = 'standard';
const VALID_PRESETS: VideoTextSizePreset[] = ['compact', 'standard', 'large'];

export function describeVideoTextSizePresets(): string {
  return VALID_PRESETS.join('|');
}

export function parseVideoTextSizePreset(raw: string | undefined): VideoTextSizePreset {
  if (!raw?.trim()) {
    return DEFAULT_PRESET;
  }

  const normalized = raw.trim().toLowerCase();
  if (VALID_PRESETS.includes(normalized as VideoTextSizePreset)) {
    return normalized as VideoTextSizePreset;
  }

  throw new Error(`Invalid --text-size preset "${raw}". Use one of: ${describeVideoTextSizePresets()}`);
}

export function resolveTerminalTextMetrics(preset: VideoTextSizePreset): TerminalTextMetrics {
  switch (preset) {
    case 'compact':
      return {
        fontSize: 34,
        lineHeight: 42,
        cursorWidth: 18,
        cursorMinHeight: 24
      };
    case 'large':
      return {
        fontSize: 44,
        lineHeight: 54,
        cursorWidth: 22,
        cursorMinHeight: 32
      };
    case 'standard':
    default:
      return {
        fontSize: 38,
        lineHeight: 47,
        cursorWidth: 20,
        cursorMinHeight: 28
      };
  }
}

export function resolveReplayTextMetrics(preset: VideoTextSizePreset): ReplayTextMetrics {
  switch (preset) {
    case 'compact':
      return {
        leadFontSize: 13,
        bodyFontSize: 13,
        timestampFontSize: 12,
        lineHeight: 21,
        barTextFontSize: 11
      };
    case 'large':
      return {
        leadFontSize: 17,
        bodyFontSize: 17,
        timestampFontSize: 14,
        lineHeight: 27,
        barTextFontSize: 12
      };
    case 'standard':
    default:
      return {
        leadFontSize: 15,
        bodyFontSize: 15,
        timestampFontSize: 13,
        lineHeight: 24,
        barTextFontSize: 12
      };
  }
}
