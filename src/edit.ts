import { copyFile, rm, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

const execFile = promisify(execFileCallback);

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const DEFAULT_FPS = 30;
const DEFAULT_INTRO_SECONDS = 3;
const DEFAULT_INTRO_FADE_SECONDS = 0.8;
const DEFAULT_BACKGROUND_AUDIO_VOLUME = 0.45;

export interface MediaMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  audioCodec: string | null;
  videoCodec: string | null;
}

export interface EditPromptParseResult {
  operations: EditOperation[];
  warnings: string[];
}

export type EditOperation =
  | { kind: 'trim_start'; seconds: number; summary: string }
  | { kind: 'remove_range'; startSeconds: number; endSeconds: number; summary: string }
  | { kind: 'speed_range'; startSeconds: number; endSeconds: number; factor: number; summary: string }
  | { kind: 'blur_range'; startSeconds: number; endSeconds: number; summary: string }
  | {
      kind: 'intro_title';
      text: string;
      durationSeconds: number;
      fadeSeconds: number;
      summary: string;
    }
  | {
      kind: 'audio_track';
      mode: 'mix' | 'replace';
      audioPath: string;
      volume: number;
      summary: string;
    }
  | {
      kind: 'stitch';
      clipPaths: string[];
      summary: string;
    }
  | {
      kind: 'split';
      ranges: Array<{ startSeconds: number; endSeconds: number }>;
      summary: string;
    };

export interface EditVideoOptions {
  cwd: string;
  sourcePath: string;
  prompt: string;
  outputPath: string;
  assetPaths?: string[];
}

export interface EditVideoResult {
  sourcePath: string;
  prompt: string;
  outputPath?: string;
  outputPaths: string[];
  operations: EditOperation[];
  warnings: string[];
  durationSeconds?: number;
}

function isAudioPath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isVideoPath(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function normalizePath(cwd: string, value: string): string {
  if (isAbsolute(value)) {
    return value;
  }

  if (value.startsWith('~/')) {
    return resolve(process.env.HOME || '', value.slice(2));
  }

  return resolve(cwd, value);
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFile(command, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024
  });

  return [stdout, stderr].filter(Boolean).join('\n');
}

function escapeDrawtext(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%');
}

function scalePadFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${DEFAULT_FPS}`;
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseAssetList(cwd: string, value: string | undefined): string[] {
  return splitList(value).map((item) => normalizePath(cwd, item));
}

function parseClock(value: string): number | null {
  const trimmed = value.trim().toLowerCase();

  if (!trimmed) {
    return null;
  }

  if (/^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(trimmed)) {
    const parts = trimmed.split(':').map(Number);

    if (parts.length === 2) {
      return parts[0]! * 60 + parts[1]!;
    }

    if (parts.length === 3) {
      return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    }
  }

  const unitPattern = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b/g;
  let matched = false;
  let totalSeconds = 0;
  let unitMatch: RegExpExecArray | null = null;

  while ((unitMatch = unitPattern.exec(trimmed)) != null) {
    matched = true;
    const amount = Number(unitMatch[1]!);
    const unit = unitMatch[2]!;

    if (unit.startsWith('h')) {
      totalSeconds += amount * 3600;
    } else if (unit.startsWith('m')) {
      totalSeconds += amount * 60;
    } else {
      totalSeconds += amount;
    }
  }

  if (matched) {
    return totalSeconds;
  }

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  return null;
}

function parseRequiredClock(value: string, label: string): number {
  const parsed = parseClock(value);

  if (parsed == null) {
    throw new Error(`Could not parse ${label}: ${value}`);
  }

  return parsed;
}

function parseAllRanges(value: string): Array<{ startSeconds: number; endSeconds: number }> {
  const ranges: Array<{ startSeconds: number; endSeconds: number }> = [];
  const rangePattern =
    /(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s))\s*(?:-|to)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s))/gi;
  let match: RegExpExecArray | null = null;

  while ((match = rangePattern.exec(value)) != null) {
    const startSeconds = parseRequiredClock(match[1]!, 'range start');
    const endSeconds = parseRequiredClock(match[2]!, 'range end');

    if (endSeconds > startSeconds) {
      ranges.push({ startSeconds, endSeconds });
    }
  }

  return ranges;
}

function resolveAudioAsset(cwd: string, prompt: string, assetPaths: string[]): string | null {
  const explicitMatch = prompt.match(/([~./A-Za-z0-9_-]+\.(?:mp3|wav|m4a|aac))/i);

  if (explicitMatch?.[1]) {
    return normalizePath(cwd, explicitMatch[1]);
  }

  return assetPaths.find((assetPath) => isAudioPath(assetPath)) ?? null;
}

function resolveVideoAssets(assetPaths: string[]): string[] {
  return assetPaths.filter((assetPath) => isVideoPath(assetPath));
}

export function parseEditPrompt(cwd: string, prompt: string, assetPaths: string[] = []): EditPromptParseResult {
  const normalizedPrompt = prompt.trim();
  const warnings: string[] = [];
  const operations: EditOperation[] = [];

  if (!normalizedPrompt) {
    throw new Error('Edit prompt is required.');
  }

  const trimStartMatch = normalizedPrompt.match(
    /\b(?:crop out|cut|remove|trim)(?: the)? first ([0-9:.\s]+(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)?)/i
  );

  if (trimStartMatch?.[1]) {
    const seconds = parseRequiredClock(trimStartMatch[1], 'trim duration');
    operations.push({
      kind: 'trim_start',
      seconds,
      summary: `Trim the first ${seconds.toFixed(2)} seconds`
    });
  }

  const removeRangePattern =
    /\b(?:crop out|cut out|cut|remove|trim)(?:[^.,"\n]*?)\bfrom\b\s*([^,.;]+?)\s*\bto\b\s*([^,.;]+)/gi;
  let removeRangeMatch: RegExpExecArray | null = null;

  while ((removeRangeMatch = removeRangePattern.exec(normalizedPrompt)) != null) {
    const startSeconds = parseRequiredClock(removeRangeMatch[1]!, 'cut start');
    const endSeconds = parseRequiredClock(removeRangeMatch[2]!, 'cut end');

    if (endSeconds <= startSeconds) {
      throw new Error('Cut range end must be after the start.');
    }

    operations.push({
      kind: 'remove_range',
      startSeconds,
      endSeconds,
      summary: `Remove ${startSeconds.toFixed(2)}s to ${endSeconds.toFixed(2)}s`
    });
  }

  const speedMatch = normalizedPrompt.match(
    /\bspeed up(?: the video| the clip| video| clip)?(?: by)?\s*([0-9]+(?:\.[0-9]+)?)x(?: speed)?(?:[^.,"\n]*?\bfrom\b\s*([^,.;]+?)\s*\bto\b\s*([^,.;]+))?/i
  );

  if (speedMatch?.[1]) {
    const factor = Number(speedMatch[1]);

    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error('Speed factor must be a positive number.');
    }

    const startSeconds = speedMatch[2] ? parseRequiredClock(speedMatch[2], 'speed start') : 0;
    const endSeconds = speedMatch[3] ? parseRequiredClock(speedMatch[3], 'speed end') : Number.POSITIVE_INFINITY;
    operations.push({
      kind: 'speed_range',
      startSeconds,
      endSeconds,
      factor,
      summary:
        endSeconds === Number.POSITIVE_INFINITY
          ? `Speed the whole clip by ${factor}x`
          : `Speed ${startSeconds.toFixed(2)}s to ${endSeconds.toFixed(2)}s by ${factor}x`
    });
  }

  const blurPattern =
    /\bblur(?: out)?(?:[^.,"\n]*?)(?:\bfrom\b\s*)?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s))\s*\bto\b\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s))/gi;
  let blurMatch: RegExpExecArray | null = null;

  while ((blurMatch = blurPattern.exec(normalizedPrompt)) != null) {
    const startSeconds = parseRequiredClock(blurMatch[1]!, 'blur start');
    const endSeconds = parseRequiredClock(blurMatch[2]!, 'blur end');

    if (endSeconds <= startSeconds) {
      throw new Error('Blur range end must be after the start.');
    }

    operations.push({
      kind: 'blur_range',
      startSeconds,
      endSeconds,
      summary: `Blur ${startSeconds.toFixed(2)}s to ${endSeconds.toFixed(2)}s`
    });
  }

  if (/\bcenter(?:ed)? text\b/i.test(normalizedPrompt)) {
    const titleMatch = normalizedPrompt.match(/["“]([^"”]+)["”]/);

    if (!titleMatch?.[1]) {
      throw new Error('Centered intro text requires a quoted string.');
    }

    operations.push({
      kind: 'intro_title',
      text: titleMatch[1],
      durationSeconds: DEFAULT_INTRO_SECONDS,
      fadeSeconds: DEFAULT_INTRO_FADE_SECONDS,
      summary: `Add centered intro text "${titleMatch[1]}"`
    });
  }

  if (/\b(?:add|mix|replace)(?:[^.,"\n]*?)\b(?:mp3|audio|soundtrack|music)\b/i.test(normalizedPrompt)) {
    const audioPath = resolveAudioAsset(cwd, normalizedPrompt, assetPaths);

    if (!audioPath) {
      throw new Error('This edit needs an audio file. Pass one with --asset <file.mp3>.');
    }

    operations.push({
      kind: 'audio_track',
      mode: /\breplace(?:[^.,"\n]*?)\baudio\b/i.test(normalizedPrompt) ? 'replace' : 'mix',
      audioPath,
      volume: DEFAULT_BACKGROUND_AUDIO_VOLUME,
      summary: `${/\breplace(?:[^.,"\n]*?)\baudio\b/i.test(normalizedPrompt) ? 'Replace' : 'Mix in'} audio track ${basename(audioPath)}`
    });
  }

  if (/\b(?:stitch|combine|concat(?:enate)?|join)\b/i.test(normalizedPrompt)) {
    const clipPaths = resolveVideoAssets(assetPaths);

    if (clipPaths.length === 0) {
      throw new Error('Stitching needs one or more extra video clips. Pass them with --asset.');
    }

    operations.push({
      kind: 'stitch',
      clipPaths,
      summary: `Stitch ${clipPaths.length + 1} clips together`
    });
  }

  if (/\bsplit\b/i.test(normalizedPrompt)) {
    const ranges = parseAllRanges(normalizedPrompt);

    if (ranges.length === 0) {
      throw new Error('Split prompts need explicit ranges like "split 0:00-0:15 and 0:30-0:45".');
    }

    operations.push({
      kind: 'split',
      ranges,
      summary: `Split into ${ranges.length} segments`
    });
  }

  if (/\b(?:mouse|cursor|click effect|click ring|pointer)\b/i.test(normalizedPrompt)) {
    warnings.push(
      'Automatic large cursor and click effects are not implemented yet because current capture flows do not record pointer telemetry.'
    );
  }

  if (operations.length === 0) {
    throw new Error('No supported edit actions were found in the prompt.');
  }

  return { operations, warnings };
}

async function probeMediaFile(sourcePath: string, cwd: string): Promise<MediaMetadata> {
  const output = await runCommand(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', sourcePath],
    cwd
  );
  const parsed = JSON.parse(output) as {
    streams: Array<Record<string, string | number>>;
    format: Record<string, string>;
  };
  const video = parsed.streams.find((stream) => stream.codec_type === 'video');
  const audio = parsed.streams.find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(parsed.format.duration ?? 0);

  if (!video?.width || !video?.height || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Could not determine media dimensions or duration for ${sourcePath}`);
  }

  return {
    durationSeconds,
    width: Number(video.width),
    height: Number(video.height),
    hasAudio: audio != null,
    audioCodec: audio?.codec_name ? String(audio.codec_name) : null,
    videoCodec: video?.codec_name ? String(video.codec_name) : null
  };
}

function normalizeRange(
  metadata: MediaMetadata,
  startSeconds: number,
  endSeconds: number
): { startSeconds: number; endSeconds: number } {
  const normalizedStart = Math.max(0, Math.min(startSeconds, metadata.durationSeconds));
  const normalizedEnd = Math.max(0, Math.min(endSeconds, metadata.durationSeconds));

  if (normalizedEnd <= normalizedStart) {
    throw new Error('Range end must be after the start.');
  }

  return {
    startSeconds: normalizedStart,
    endSeconds: normalizedEnd
  };
}

async function transcodeSegment(
  cwd: string,
  inputPath: string,
  outputPath: string,
  metadata: MediaMetadata,
  startSeconds: number,
  endSeconds: number
): Promise<void> {
  const normalized = normalizeRange(metadata, startSeconds, endSeconds);

  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-ss',
      normalized.startSeconds.toFixed(3),
      '-to',
      normalized.endSeconds.toFixed(3),
      '-i',
      inputPath,
      '-vf',
      scalePadFilter(metadata.width, metadata.height),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath
    ],
    cwd
  );
}

async function normalizeClipForConcat(
  cwd: string,
  inputPath: string,
  outputPath: string,
  metadata: MediaMetadata
): Promise<void> {
  const args = ['-y', '-i', inputPath];

  if (!metadata.hasAudio) {
    args.push(
      '-f',
      'lavfi',
      '-t',
      metadata.durationSeconds.toFixed(3),
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000'
    );
  }

  args.push(
    '-vf',
    scalePadFilter(metadata.width, metadata.height),
    '-map',
    '0:v:0',
    '-map',
    metadata.hasAudio ? '0:a:0' : '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath
  );

  await runCommand('ffmpeg', args, cwd);
}

async function concatFiles(cwd: string, inputPaths: string[], outputPath: string): Promise<void> {
  const listPath = join(dirname(outputPath), `${basename(outputPath, extname(outputPath))}.concat.txt`);
  await writeFile(listPath, inputPaths.map((filePath) => `file '${filePath.replace(/'/g, `'\\''`)}'`).join('\n'), 'utf8');
  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath
    ],
    cwd
  );
}

async function removeRangeFromVideo(
  cwd: string,
  inputPath: string,
  outputPath: string,
  metadata: MediaMetadata,
  startSeconds: number,
  endSeconds: number
): Promise<void> {
  const normalized = normalizeRange(metadata, startSeconds, endSeconds);
  const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-edit-remove-'));

  try {
    const segmentPaths: string[] = [];

    if (normalized.startSeconds > 0.03) {
      const beforePath = join(tempDir, 'before.mp4');
      await transcodeSegment(cwd, inputPath, beforePath, metadata, 0, normalized.startSeconds);
      segmentPaths.push(beforePath);
    }

    if (normalized.endSeconds < metadata.durationSeconds - 0.03) {
      const afterPath = join(tempDir, 'after.mp4');
      await transcodeSegment(cwd, inputPath, afterPath, metadata, normalized.endSeconds, metadata.durationSeconds);
      segmentPaths.push(afterPath);
    }

    if (segmentPaths.length === 0) {
      throw new Error('The requested cut would remove the entire video.');
    }

    const normalizedSegments: string[] = [];

    for (const [index, segmentPath] of segmentPaths.entries()) {
      const normalizedPath = join(tempDir, `normalized-${index + 1}.mp4`);
      await normalizeClipForConcat(cwd, segmentPath, normalizedPath, await probeMediaFile(segmentPath, cwd));
      normalizedSegments.push(normalizedPath);
    }

    await concatFiles(cwd, normalizedSegments, outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildAtempoFilter(factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error('Audio speed factor must be a positive number.');
  }

  const filters: string[] = [];
  let remaining = factor;

  while (remaining > 2) {
    filters.push('atempo=2.0');
    remaining /= 2;
  }

  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }

  filters.push(`atempo=${remaining.toFixed(3)}`);
  return filters.join(',');
}

async function speedRangeInVideo(
  cwd: string,
  inputPath: string,
  outputPath: string,
  metadata: MediaMetadata,
  startSeconds: number,
  endSeconds: number,
  factor: number
): Promise<void> {
  const boundedEnd = endSeconds === Number.POSITIVE_INFINITY ? metadata.durationSeconds : endSeconds;
  const normalized = normalizeRange(metadata, startSeconds, boundedEnd);
  const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-edit-speed-'));

  try {
    const segmentPaths: string[] = [];

    if (normalized.startSeconds > 0.03) {
      const beforePath = join(tempDir, 'before.mp4');
      await transcodeSegment(cwd, inputPath, beforePath, metadata, 0, normalized.startSeconds);
      segmentPaths.push(beforePath);
    }

    const targetPath = join(tempDir, 'target.mp4');
    await transcodeSegment(cwd, inputPath, targetPath, metadata, normalized.startSeconds, normalized.endSeconds);
    const spedPath = join(tempDir, 'target-sped.mp4');
    const targetMetadata = await probeMediaFile(targetPath, cwd);
    const speedArgs = [
      '-y',
      '-i',
      targetPath,
      '-filter:v',
      `setpts=PTS/${factor}`,
      '-map',
      '0:v:0'
    ];

    if (targetMetadata.hasAudio) {
      speedArgs.push('-filter:a', buildAtempoFilter(factor), '-map', '0:a:0');
    }

    speedArgs.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      spedPath
    );
    await runCommand('ffmpeg', speedArgs, cwd);
    segmentPaths.push(spedPath);

    if (normalized.endSeconds < metadata.durationSeconds - 0.03) {
      const afterPath = join(tempDir, 'after.mp4');
      await transcodeSegment(cwd, inputPath, afterPath, metadata, normalized.endSeconds, metadata.durationSeconds);
      segmentPaths.push(afterPath);
    }

    const normalizedSegments: string[] = [];

    for (const [index, segmentPath] of segmentPaths.entries()) {
      const normalizedPath = join(tempDir, `normalized-${index + 1}.mp4`);
      await normalizeClipForConcat(cwd, segmentPath, normalizedPath, await probeMediaFile(segmentPath, cwd));
      normalizedSegments.push(normalizedPath);
    }

    await concatFiles(cwd, normalizedSegments, outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function blurRangeInVideo(
  cwd: string,
  inputPath: string,
  outputPath: string,
  metadata: MediaMetadata,
  startSeconds: number,
  endSeconds: number
): Promise<void> {
  const normalized = normalizeRange(metadata, startSeconds, endSeconds);

  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-filter_complex',
      `[0:v]split=2[base][blur];[blur]boxblur=luma_radius=18:luma_power=2:chroma_radius=10:chroma_power=1[fx];[base][fx]overlay=enable='between(t,${normalized.startSeconds.toFixed(3)},${normalized.endSeconds.toFixed(3)})'[v]`,
      '-map',
      '[v]',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath
    ],
    cwd
  );
}

function resolveTitleFont(): string | null {
  const candidates = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Menlo.ttc'];
  return candidates[0] ?? null;
}

async function addIntroTitle(
  cwd: string,
  inputPath: string,
  outputPath: string,
  metadata: MediaMetadata,
  text: string,
  durationSeconds: number,
  fadeSeconds: number
): Promise<void> {
  const holdSeconds = Math.max(0.2, durationSeconds - fadeSeconds);
  const font = resolveTitleFont();
  const drawtext =
    `drawtext=text='${escapeDrawtext(text)}':x=(w-text_w)/2:y=(h-text_h)/2:` +
    `${font ? `fontfile='${font}':` : ''}` +
    `fontsize=${Math.round(Math.min(metadata.width, metadata.height) * 0.08)}:fontcolor=white:` +
    `alpha='if(lt(t,${holdSeconds.toFixed(3)}),1,max(0,1-(t-${holdSeconds.toFixed(3)})/${fadeSeconds.toFixed(3)}))':` +
    `enable='lt(t,${durationSeconds.toFixed(3)})'`;

  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-i',
      inputPath,
      '-vf',
      drawtext,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath
    ],
    cwd
  );
}

async function addAudioTrack(
  cwd: string,
  inputPath: string,
  outputPath: string,
  metadata: MediaMetadata,
  audioPath: string,
  mode: 'mix' | 'replace',
  volume: number
): Promise<void> {
  const args = ['-y', '-i', inputPath, '-stream_loop', '-1', '-i', audioPath];

  if (mode === 'replace' || !metadata.hasAudio) {
    args.push(
      '-filter_complex',
      `[1:a]atrim=start=0:end=${metadata.durationSeconds.toFixed(3)},asetpts=PTS-STARTPTS[aout]`,
      '-map',
      '0:v:0',
      '-map',
      '[aout]'
    );
  } else {
    args.push(
      '-filter_complex',
      `[0:a]volume=1[a0];[1:a]atrim=start=0:end=${metadata.durationSeconds.toFixed(3)},asetpts=PTS-STARTPTS,volume=${volume.toFixed(2)}[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[aout]`,
      '-map',
      '0:v:0',
      '-map',
      '[aout]'
    );
  }

  args.push(
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath
  );

  await runCommand('ffmpeg', args, cwd);
}

async function stitchVideos(
  cwd: string,
  inputPath: string,
  outputPath: string,
  metadata: MediaMetadata,
  extraClipPaths: string[]
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-edit-stitch-'));

  try {
    const clipPaths = [inputPath, ...extraClipPaths];
    const normalizedClipPaths: string[] = [];

    for (const [index, clipPath] of clipPaths.entries()) {
      const clipMetadata = await probeMediaFile(clipPath, cwd);
      const normalizedPath = join(tempDir, `clip-${String(index + 1).padStart(2, '0')}.mp4`);
      await normalizeClipForConcat(cwd, clipPath, normalizedPath, {
        ...clipMetadata,
        width: metadata.width,
        height: metadata.height
      });
      normalizedClipPaths.push(normalizedPath);
    }

    await concatFiles(cwd, normalizedClipPaths, outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function splitVideo(
  cwd: string,
  inputPath: string,
  outputPath: string,
  metadata: MediaMetadata,
  ranges: Array<{ startSeconds: number; endSeconds: number }>
): Promise<string[]> {
  const outputBase = extname(outputPath)
    ? join(dirname(outputPath), basename(outputPath, extname(outputPath)))
    : outputPath;
  const outputs: string[] = [];

  for (const [index, range] of ranges.entries()) {
    const normalized = normalizeRange(metadata, range.startSeconds, range.endSeconds);
    const segmentPath = `${outputBase}-part-${String(index + 1).padStart(2, '0')}.mp4`;
    await transcodeSegment(cwd, inputPath, segmentPath, metadata, normalized.startSeconds, normalized.endSeconds);
    outputs.push(segmentPath);
  }

  return outputs;
}

export async function editVideoFromPrompt(options: EditVideoOptions): Promise<EditVideoResult> {
  const sourcePath = normalizePath(options.cwd, options.sourcePath);
  const assetPaths = (options.assetPaths ?? []).map((assetPath) => normalizePath(options.cwd, assetPath));
  const parseResult = parseEditPrompt(options.cwd, options.prompt, assetPaths);

  let currentPath = sourcePath;
  let currentMetadata = await probeMediaFile(currentPath, options.cwd);
  const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-edit-'));

  try {
    let currentIndex = 0;

    for (const [operationIndex, operation] of parseResult.operations.entries()) {
      if (operation.kind === 'split') {
        if (operationIndex !== parseResult.operations.length - 1) {
          throw new Error('Split must be the last edit in the prompt.');
        }

        const outputPaths = await splitVideo(options.cwd, currentPath, options.outputPath, currentMetadata, operation.ranges);
        return {
          sourcePath,
          prompt: options.prompt,
          outputPaths,
          operations: parseResult.operations,
          warnings: parseResult.warnings
        };
      }

      const nextPath = join(tempDir, `edit-${String(++currentIndex).padStart(2, '0')}.mp4`);

      switch (operation.kind) {
        case 'trim_start':
          await removeRangeFromVideo(options.cwd, currentPath, nextPath, currentMetadata, 0, operation.seconds);
          break;
        case 'remove_range':
          await removeRangeFromVideo(
            options.cwd,
            currentPath,
            nextPath,
            currentMetadata,
            operation.startSeconds,
            operation.endSeconds
          );
          break;
        case 'speed_range':
          await speedRangeInVideo(
            options.cwd,
            currentPath,
            nextPath,
            currentMetadata,
            operation.startSeconds,
            operation.endSeconds,
            operation.factor
          );
          break;
        case 'blur_range':
          await blurRangeInVideo(
            options.cwd,
            currentPath,
            nextPath,
            currentMetadata,
            operation.startSeconds,
            operation.endSeconds
          );
          break;
        case 'intro_title':
          await addIntroTitle(
            options.cwd,
            currentPath,
            nextPath,
            currentMetadata,
            operation.text,
            operation.durationSeconds,
            operation.fadeSeconds
          );
          break;
        case 'audio_track':
          await addAudioTrack(
            options.cwd,
            currentPath,
            nextPath,
            currentMetadata,
            operation.audioPath,
            operation.mode,
            operation.volume
          );
          break;
        case 'stitch':
          await stitchVideos(options.cwd, currentPath, nextPath, currentMetadata, operation.clipPaths);
          break;
      }

      currentPath = nextPath;
      currentMetadata = await probeMediaFile(currentPath, options.cwd);
    }

    await stat(currentPath);
    const finalOutputPath = normalizePath(options.cwd, options.outputPath);
    await copyFile(currentPath, finalOutputPath);

    return {
      sourcePath,
      prompt: options.prompt,
      outputPath: finalOutputPath,
      outputPaths: [finalOutputPath],
      operations: parseResult.operations,
      warnings: parseResult.warnings,
      durationSeconds: currentMetadata.durationSeconds
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
