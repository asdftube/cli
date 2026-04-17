import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

import { captureTerminalWindow, inspectVideoDuration, listWindows, recordDesktopVideo, recordWindowVideo } from './capture';
import { renderReplayVideo, resolveReplaySelection, type ReplayProvider } from './replay';

const execFile = promisify(execFileCallback);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface StoredConfig {
  version: 1;
  baseUrl: string;
  apiKey: string;
  apiKeyExpiresAt?: string | null;
  orgId: string;
  userId: string;
  username: string;
  email: string;
  orgSlug: string;
  orgName: string;
}

export interface CliRuntime {
  fetchImpl?: typeof fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PublishResult {
  assetId: string;
  renderId: string;
  shareId: string;
  shareUrl: string;
  revokeToken?: string;
  revokeUrl?: string;
}

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | boolean>;
}

interface AssetRecordResponse {
  id: string;
  status: 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed';
  mimeType: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

interface AssetResponse {
  asset: AssetRecordResponse;
}

interface RenderResponse {
  id: string;
  status: 'queued' | 'ready' | 'failed';
  outputUrl: string | null;
  error?: { message?: string } | null;
}

interface AuthResponse {
  org: {
    id: string;
    slug: string;
    name: string;
  };
  user: {
    id: string;
    username: string;
    email: string;
    name: string;
  };
  apiKey: {
    id: string;
    token: string;
    expiresAt: string | null;
  };
}

interface StartEmailAuthResponse {
  challengeId: string;
  exchangeToken: string;
  email: string;
  maskedEmail: string;
  expiresAt: string;
  pollAfterSeconds: number;
}

interface EmailAuthChallengeStatusResponse {
  challengeId: string;
  status: 'pending' | 'verified' | 'completed' | 'expired';
  expiresAt: string;
  email: string;
  maskedEmail: string;
}

interface InitiateUploadResponse {
  uploadId: string;
  assetId: string;
  uploadUrl?: string;
  parts: Array<{
    partNumber: number;
    uploadUrl?: string;
  }>;
}

interface CompleteUploadResponse {
  assetId: string;
  duplicate: boolean;
  jobs: string[];
}

interface CreateRenderResponse {
  renderId: string;
  jobId: string;
}

interface PublicShareResponse {
  id: string;
  renderId: string;
  username: string;
  title: string;
  url: string;
  createdAt: string;
  revokeToken?: string;
  revokeUrl?: string;
}

interface PublicShareReportResponse {
  id: string;
  shareId: string;
  renderId: string;
  reason: string;
  state: 'open' | 'resolved';
  resolution: 'dismissed' | 'removed' | null;
  createdAt: string;
  updatedAt: string;
}

interface CompositionSpec {
  version: 1;
  canvas: {
    width: number;
    height: number;
    fps: number;
    durationFrames: number;
    background: string;
  };
  nodes: Array<Record<string, JsonValue>>;
}

const DEFAULT_BASE_URL = 'https://api.asdftube.com';
const DEFAULT_PART_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function createRuntime(runtime?: CliRuntime): Required<CliRuntime> {
  return {
    fetchImpl: runtime?.fetchImpl ?? fetch,
    stdout: runtime?.stdout ?? ((line: string) => process.stdout.write(`${line}\n`)),
    stderr: runtime?.stderr ?? ((line: string) => process.stderr.write(`${line}\n`)),
    cwd: runtime?.cwd ?? process.cwd(),
    env: runtime?.env ?? process.env
  };
}

function outputJson(runtime: Required<CliRuntime>, value: unknown): void {
  runtime.stdout(JSON.stringify(value, null, 2));
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith('--no-')) {
      options.set(token.slice(5), false);
      continue;
    }

    const inlineIndex = token.indexOf('=');
    if (inlineIndex >= 0) {
      options.set(token.slice(2, inlineIndex), token.slice(inlineIndex + 1));
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      options.set(key, true);
      continue;
    }

    options.set(key, next);
    index += 1;
  }

  return { positionals, options };
}

function getOptionString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function getOptionBoolean(parsed: ParsedArgs, name: string): boolean {
  const value = parsed.options.get(name);
  return value === true;
}

function requireOptionString(parsed: ParsedArgs, name: string): string {
  const value = getOptionString(parsed, name);

  if (!value) {
    throw new Error(`Missing required option --${name}`);
  }

  return value;
}

function inferMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.mkv':
      return 'video/x-matroska';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.aac':
      return 'audio/aac';
    case '.srt':
      return 'application/x-subrip';
    case '.vtt':
      return 'text/vtt';
    case '.ass':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

function getConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.ASDF_TUBE_CLI_CONFIG) {
    return resolve(env.ASDF_TUBE_CLI_CONFIG);
  }

  return join(homedir(), '.config', 'asdftube', 'config.json');
}

async function saveConfig(configPath: string, config: StoredConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

async function loadConfig(configPath: string): Promise<StoredConfig | null> {
  try {
    const raw = await readFile(configPath, 'utf8');
    return JSON.parse(raw) as StoredConfig;
  } catch {
    return null;
  }
}

async function clearConfig(configPath: string): Promise<void> {
  try {
    await unlink(configPath);
  } catch {
    // Ignore missing config files.
  }
}

async function accessFile(path: string): Promise<void> {
  await access(path, fsConstants.F_OK | fsConstants.R_OK);
}

async function requestJson<TResponse>(
  runtime: Required<CliRuntime>,
  method: string,
  url: string,
  apiKey?: string,
  body?: unknown
): Promise<TResponse> {
  const headers = new Headers();

  if (apiKey) {
    headers.set('x-api-key', apiKey);
  }

  if (body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  const response = await runtime.fetchImpl(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  const text = await response.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}: ${text || response.statusText}`);
  }

  return parsed as TResponse;
}

async function uploadBinary(runtime: Required<CliRuntime>, uploadUrl: string, apiKey: string, payload: Uint8Array): Promise<void> {
  const response = await runtime.fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/octet-stream'
    },
    body: Buffer.from(payload)
  });

  if (!response.ok) {
    throw new Error(`Binary upload failed with ${response.status}: ${await response.text()}`);
  }
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, received ${value}`);
  }

  return parsed;
}

function resolveStoredConfig(
  runtime: Required<CliRuntime>,
  parsed: ParsedArgs,
  config: StoredConfig | null
): StoredConfig {
  const env = runtime.env;
  const baseUrl = normalizeBaseUrl(
    getOptionString(parsed, 'base-url') ?? env.ASDF_TUBE_BASE_URL ?? config?.baseUrl ?? DEFAULT_BASE_URL
  );
  const apiKey = getOptionString(parsed, 'api-key') ?? env.ASDF_TUBE_API_KEY ?? config?.apiKey;
  const orgId = getOptionString(parsed, 'org-id') ?? env.ASDF_TUBE_ORG_ID ?? config?.orgId;

  if (!apiKey || !orgId) {
    throw new Error('Missing auth context. Run `asdftube auth` or set ASDF_TUBE_API_KEY and ASDF_TUBE_ORG_ID.');
  }

  if (config?.apiKeyExpiresAt && config.apiKeyExpiresAt <= new Date().toISOString()) {
    throw new Error('Stored auth session has expired. Run `asdftube auth` again.');
  }

  return {
    version: 1,
    baseUrl,
    apiKey,
    apiKeyExpiresAt: config?.apiKeyExpiresAt ?? null,
    orgId,
    userId: config?.userId ?? 'unknown',
    username: config?.username ?? 'unknown',
    email: config?.email ?? 'unknown',
    orgSlug: config?.orgSlug ?? 'unknown',
    orgName: config?.orgName ?? 'unknown'
  };
}

async function waitForAssetReady(
  runtime: Required<CliRuntime>,
  config: StoredConfig,
  assetId: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS
): Promise<AssetResponse> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const asset = await requestJson<AssetResponse>(runtime, 'GET', `${config.baseUrl}/v1/assets/${assetId}`, config.apiKey);

    if (asset.asset.status === 'ready') {
      return asset;
    }

    if (asset.asset.status === 'failed') {
      throw new Error(`Asset ${assetId} failed during processing`);
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for asset ${assetId}`);
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, DEFAULT_POLL_INTERVAL_MS);
    });
  }
}

async function waitForRenderReady(
  runtime: Required<CliRuntime>,
  config: StoredConfig,
  renderId: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS
): Promise<RenderResponse> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const render = await requestJson<RenderResponse>(runtime, 'GET', `${config.baseUrl}/v1/renders/${renderId}`, config.apiKey);

    if (render.status === 'ready') {
      return render;
    }

    if (render.status === 'failed') {
      throw new Error(render.error?.message ? `Render failed: ${render.error.message}` : `Render ${renderId} failed`);
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for render ${renderId}`);
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, DEFAULT_POLL_INTERVAL_MS);
    });
  }
}

function resolvePublishPreset(asset: AssetResponse): 'landscape_hd' | 'square_social' | 'story_portrait' {
  const width = asset.asset.width ?? 0;
  const height = asset.asset.height ?? 0;

  if (width > 0 && height > 0) {
    const ratio = width / height;

    if (ratio >= 0.9 && ratio <= 1.1) {
      return 'square_social';
    }

    if (height > width) {
      return 'story_portrait';
    }
  }

  return 'landscape_hd';
}

function createCanvasForPreset(preset: 'landscape_hd' | 'square_social' | 'story_portrait'): CompositionSpec['canvas'] {
  if (preset === 'story_portrait') {
    return {
      width: 1080,
      height: 1920,
      fps: 30,
      durationFrames: 30,
      background: '#071014'
    };
  }

  if (preset === 'square_social') {
    return {
      width: 1080,
      height: 1080,
      fps: 30,
      durationFrames: 30,
      background: '#071014'
    };
  }

  return {
    width: 1920,
    height: 1080,
    fps: 30,
    durationFrames: 30,
    background: '#071014'
  };
}

function buildDefaultRenderSpec(asset: AssetResponse, preset: 'landscape_hd' | 'square_social' | 'story_portrait'): CompositionSpec {
  const canvas = createCanvasForPreset(preset);
  const durationFrames = Math.max(30, Math.round(((asset.asset.durationMs ?? 1_000) / 1_000) * canvas.fps));

  return {
    version: 1,
    canvas: {
      ...canvas,
      durationFrames
    },
    nodes: [
      {
        id: 'video_main',
        type: 'video',
        assetId: asset.asset.id,
        startFrame: 0,
        endFrame: durationFrames,
        fit: 'contain'
      },
      {
        id: 'audio_main',
        type: 'audio',
        assetId: asset.asset.id,
        startFrame: 0,
        endFrame: durationFrames
      }
    ]
  };
}

async function uploadHostedFile(
  runtime: Required<CliRuntime>,
  config: StoredConfig,
  filePath: string,
  partSizeBytes: number
): Promise<CompleteUploadResponse> {
  await accessFile(filePath);
  const resolvedPath = resolve(runtime.cwd, filePath);
  const fileStats = await stat(resolvedPath);
  const normalizedPartSizeBytes = Math.max(1, Math.round(partSizeBytes));
  const initiate = await requestJson<InitiateUploadResponse>(
    runtime,
    'POST',
    `${config.baseUrl}/v1/uploads/initiate`,
    config.apiKey,
    {
      orgId: config.orgId,
      filename: basename(resolvedPath),
      mimeType: inferMimeType(resolvedPath),
      sizeBytes: fileStats.size,
      partSizeBytes: normalizedPartSizeBytes
    }
  );

  const handle = await open(resolvedPath, 'r');

  try {
    for (const part of initiate.parts) {
      const uploadUrl = part.uploadUrl ?? initiate.uploadUrl;

      if (!uploadUrl) {
        throw new Error(`Upload session ${initiate.uploadId} did not provide an upload URL`);
      }

      const offset = (part.partNumber - 1) * normalizedPartSizeBytes;
      const bytesToRead = Math.max(0, Math.min(normalizedPartSizeBytes, fileStats.size - offset));
      const chunk = Buffer.alloc(bytesToRead);
      await handle.read(chunk, 0, bytesToRead, offset);
      await uploadBinary(runtime, uploadUrl, config.apiKey, chunk);
    }
  } finally {
    await handle.close();
  }

  return await requestJson<CompleteUploadResponse>(
    runtime,
    'POST',
    `${config.baseUrl}/v1/uploads/complete`,
    config.apiKey,
    { uploadId: initiate.uploadId }
  );
}

async function publishFile(
  runtime: Required<CliRuntime>,
  config: StoredConfig,
  filePath: string,
  options: {
    title?: string;
    preset?: 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait';
    watermark?: boolean;
    partSizeBytes: number;
  }
): Promise<PublishResult> {
  const completed = await uploadHostedFile(runtime, config, filePath, options.partSizeBytes);
  const asset = await waitForAssetReady(runtime, config, completed.assetId);
  const resolvedPreset = options.preset && options.preset !== 'auto' ? options.preset : resolvePublishPreset(asset);
  const render = await requestJson<CreateRenderResponse>(
    runtime,
    'POST',
    `${config.baseUrl}/v1/renders`,
    config.apiKey,
    {
      orgId: config.orgId,
      spec: buildDefaultRenderSpec(asset, resolvedPreset),
      watermark: options.watermark === false ? false : { text: 'asdf.tube', opacity: 0.22 }
    }
  );
  await waitForRenderReady(runtime, config, render.renderId);
  const share = await requestJson<PublicShareResponse>(
    runtime,
    'POST',
    `${config.baseUrl}/v1/renders/${render.renderId}/share`,
    config.apiKey,
    {
      title: options.title ?? basename(filePath, extname(filePath))
    }
  );

  return {
    assetId: completed.assetId,
    renderId: render.renderId,
    shareId: share.id,
    shareUrl: share.url,
    ...(share.revokeToken ? { revokeToken: share.revokeToken } : {}),
    ...(share.revokeUrl ? { revokeUrl: share.revokeUrl } : {})
  };
}

async function confirmProceed(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question(`${message} Type "yes" to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function promptForInput(question: string, initialValue?: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive input is required');
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const suffix = initialValue ? ` [${initialValue}]` : '';
    const answer = await rl.question(`${question}${suffix}: `);
    return (answer.trim() || initialValue || '').trim();
  } finally {
    rl.close();
  }
}

async function guessDefaultEmail(cwd: string, fallback?: string): Promise<string | undefined> {
  const normalizeCandidate = (value: string | undefined): string | undefined => {
    const email = value?.trim();

    if (!email) {
      return undefined;
    }

    if (/@users\.noreply\.github\.com$/i.test(email)) {
      return undefined;
    }

    return email;
  };

  if (fallback?.trim()) {
    return normalizeCandidate(fallback);
  }

  const environmentEmail = process.env.ASDF_TUBE_AUTH_EMAIL ?? process.env.GIT_AUTHOR_EMAIL ?? process.env.GIT_COMMITTER_EMAIL;
  const normalizedEnvironmentEmail = normalizeCandidate(environmentEmail);

  if (normalizedEnvironmentEmail) {
    return normalizedEnvironmentEmail;
  }

  try {
    const guessed = await runCommand('git', ['config', '--get', 'user.email'], cwd);
    return normalizeCandidate(guessed);
  } catch {
    return undefined;
  }
}

function createUsage(): string {
  return [
    'Usage:',
    '  asdftube auth [--email <email>]',
    '  asdftube auth whoami',
    '  asdftube auth logout',
    '  asdftube upload <file> [--wait] [--json] [--part-size-mb <mb>] [--base-url <url>]',
    '  asdftube publish <file> [--title <title>] [--preset auto|landscape_hd|square_social|story_portrait] [--no-watermark] [--json]',
    '  asdftube record terminal [--cmd <shell>] [--output <file>] [--prompt <text>] [--publish] [--title <title>]',
    '  asdftube record desktop [--seconds <n>] [--display <id>] [--output <file>] [--publish] [--title <title>]',
    '  asdftube record window [--window-id <id> | --app <name> [--title-contains <text>]] [--seconds <n>] [--output <file>] [--publish] [--title <title>]',
    '  asdftube record windows',
    '  asdftube replay codex [latest|<session-hash>|<query>] [--review-only] [--publish --yes]',
    '  asdftube replay claude|opencode [--input <file>] [--output <file>] [--review-only] [--publish --yes]',
    '  asdftube share list [--state active|revoked|all] [--json]',
    '  asdftube share revoke <shareId> [--json]',
    '  asdftube share delete <shareId> --token <revokeToken> [--json]',
    '  asdftube report list [--state open|resolved|all] [--json]',
    '  asdftube report resolve <reportId> --resolution removed|dismissed [--note <text>] [--json]',
    '',
    'Environment fallbacks:',
    '  ASDF_TUBE_BASE_URL, ASDF_TUBE_API_KEY, ASDF_TUBE_ORG_ID, ASDF_TUBE_CLI_CONFIG'
  ].join('\n');
}

function resolveTerminalFont(explicitPath: string | undefined): string {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        '/System/Library/Fonts/Menlo.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
        '/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf'
      ];

  return candidates[0]!;
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

function normalizeTerminalText(value: string): string {
  return stripAnsi(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function wrapLine(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) {
    return [value];
  }

  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += maxChars) {
    chunks.push(value.slice(index, index + maxChars));
  }

  return chunks;
}

function escapeDrawtext(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '`')
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,');
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFile(command, args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024
  });

  return [stdout, stderr].filter(Boolean).join('\n');
}

async function recordTerminalActivity(
  runtime: Required<CliRuntime>,
  options: {
    command: string;
    outputPath: string;
    prompt: string;
    fontFile?: string;
  }
): Promise<string> {
  const cwd = runtime.cwd;
  const outputPath = resolve(cwd, options.outputPath);
  const font = resolveTerminalFont(options.fontFile);
  const width = 1920;
  const height = 1080;
  const fps = 30;
  const fontSize = 34;
  const lineHeight = 42;
  const marginX = 8;
  const marginY = 8;
  const typingDelaySeconds = 0.03;
  const commandStartSeconds = 0.35;
  const outputStartPaddingSeconds = 0.25;
  const endingHoldSeconds = 1.0;
  const maxVisibleLines = Math.max(1, Math.floor((height - marginY * 2) / lineHeight) - 2);

  const lines: Array<{ text: string; timeSeconds: number }> = [];
  const start = process.hrtime.bigint();
  let carry = '';

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('/bin/sh', ['-c', options.command], {
      cwd,
      env: {
        ...runtime.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        TERM: 'xterm-256color'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const handleChunk = (chunk: Buffer): void => {
      const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      carry += normalizeTerminalText(chunk.toString('utf8'));
      const parts = carry.split('\n');
      carry = parts.pop() ?? '';

      for (const part of parts) {
        lines.push({ text: part, timeSeconds: elapsedSeconds });
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (carry.length > 0) {
        lines.push({ text: carry, timeSeconds: Number(process.hrtime.bigint() - start) / 1_000_000_000 });
      }

      if (code && code !== 0) {
        rejectPromise(new Error(`Recording command exited with status ${code}`));
        return;
      }

      resolvePromise();
    });
  });

  const displayCommand = options.command;
  const typedEndSeconds = commandStartSeconds + displayCommand.length * typingDelaySeconds;
  const outputOffsetSeconds = typedEndSeconds + outputStartPaddingSeconds;
  const maxChars = Math.max(30, Math.floor((width - marginX * 2) / (fontSize * 0.58)));
  const renderedLines = lines
    .flatMap((line) => wrapLine(line.text, maxChars).map((chunk) => ({ text: chunk, timeSeconds: outputOffsetSeconds + line.timeSeconds })))
    .slice(-maxVisibleLines);
  const finalLineTime = renderedLines.at(-1)?.timeSeconds ?? outputOffsetSeconds;
  const durationSeconds = Math.max(3, finalLineTime + endingHoldSeconds);
  const filters: string[] = [];

  const drawText = (text: string, x: number, y: number, enable: string): string =>
    `drawtext=fontfile='${font}':text='${escapeDrawtext(text)}':expansion=none:fontsize=${fontSize}:fontcolor=0xf8fafc:x=${x}:y=${y}:enable='${enable}'`;
  const drawCursor = (x: number, y: number, enable: string): string =>
    `drawbox=x=${x}:y=${y + 4}:w=18:h=${Math.max(24, fontSize)}:color=0xf8fafc:t=fill:enable='${enable}*gt(mod(t\\,1)\\,0.5)'`;

  filters.push(drawText(options.prompt, marginX, marginY, `lt(t\\,${commandStartSeconds.toFixed(3)})`));
  filters.push(drawCursor(marginX + Math.round(options.prompt.length * fontSize * 0.61) + 12, marginY, `lt(t\\,${commandStartSeconds.toFixed(3)})`));

  for (let index = 1; index <= displayCommand.length; index += 1) {
    const startSeconds = commandStartSeconds + (index - 1) * typingDelaySeconds;
    const endSeconds = index === displayCommand.length ? durationSeconds : commandStartSeconds + index * typingDelaySeconds;
    const line = `${options.prompt} ${displayCommand.slice(0, index)}`;
    filters.push(drawText(line, marginX, marginY, `between(t\\,${startSeconds.toFixed(3)}\\,${endSeconds.toFixed(3)})`));
    filters.push(
      drawCursor(
        marginX + Math.round(line.length * fontSize * 0.61) + 12,
        marginY,
        `between(t\\,${startSeconds.toFixed(3)}\\,${endSeconds.toFixed(3)})`
      )
    );
  }

  renderedLines.forEach((line, index) => {
    filters.push(drawText(line.text, marginX, marginY + lineHeight * (index + 1), `gte(t\\,${line.timeSeconds.toFixed(3)})`));
  });

  filters.push(drawText(options.prompt, marginX, marginY + lineHeight * (renderedLines.length + 1), `gte(t\\,${finalLineTime.toFixed(3)})`));
  filters.push(
    drawCursor(
      marginX + Math.round(options.prompt.length * fontSize * 0.61) + 12,
      marginY + lineHeight * (renderedLines.length + 1),
      `gte(t\\,${finalLineTime.toFixed(3)})`
    )
  );

  await mkdir(dirname(outputPath), { recursive: true });
  const filterPath = `${outputPath}.fffilter`;
  await writeFile(filterPath, filters.join(',\n'), 'utf8');
  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x011014:s=${width}x${height}:d=${durationSeconds.toFixed(3)}:r=${fps}`,
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=48000:d=${durationSeconds.toFixed(3)}`,
      '-filter_complex_script',
      filterPath,
      '-shortest',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      outputPath
    ],
    cwd
  );

  return outputPath;
}

async function handleAuthCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const action = parsed.positionals[1];
  const configPath = getConfigPath(runtime.env);

  if (action === 'whoami') {
    const config = await loadConfig(configPath);

    if (!config) {
      throw new Error('No stored auth config found');
    }

    outputJson(runtime, {
      configPath,
      baseUrl: config.baseUrl,
      orgId: config.orgId,
      orgSlug: config.orgSlug,
      orgName: config.orgName,
      userId: config.userId,
      username: config.username,
      email: config.email,
      apiKeyExpiresAt: config.apiKeyExpiresAt ?? null
    });
    return;
  }

  if (action === 'logout') {
    await clearConfig(configPath);
    outputJson(runtime, {
      cleared: true,
      configPath
    });
    return;
  }

  if (action && !['login', 'signup'].includes(action)) {
    throw new Error(`Unknown auth command: ${action}`);
  }

  const existingConfig = await loadConfig(configPath);
  const baseUrl = normalizeBaseUrl(getOptionString(parsed, 'base-url') ?? runtime.env.ASDF_TUBE_BASE_URL ?? existingConfig?.baseUrl ?? DEFAULT_BASE_URL);
  const defaultEmail = await guessDefaultEmail(runtime.cwd, getOptionString(parsed, 'email') ?? existingConfig?.email);
  const email =
    getOptionString(parsed, 'email') ??
    (process.stdin.isTTY && process.stdout.isTTY ? await promptForInput('Email', defaultEmail) : defaultEmail);

  if (!email) {
    throw new Error('Email is required. Pass --email or run the command in an interactive terminal.');
  }

  const challenge = await requestJson<StartEmailAuthResponse>(runtime, 'POST', `${baseUrl}/v1/auth/email/start`, undefined, {
    email
  });

  runtime.stdout(`Sent a sign-in email to ${challenge.maskedEmail}.`);
  runtime.stdout('Click the link in the email, or enter the PIN from the email here.');

  const deadline = new Date(challenge.expiresAt).getTime();
  let response: AuthResponse | null = null;

  while (!response) {
    if (Number.isFinite(deadline) && Date.now() > deadline) {
      throw new Error('Sign-in challenge expired. Run `asdftube auth` again.');
    }

    let pin = '';

    if (process.stdin.isTTY && process.stdout.isTTY) {
      pin = await promptForInput('PIN (or press Enter to keep waiting)');
    }

    if (pin) {
      response = await requestJson<AuthResponse>(runtime, 'POST', `${baseUrl}/v1/auth/email/complete`, undefined, {
        challengeId: challenge.challengeId,
        exchangeToken: challenge.exchangeToken,
        pin
      });
      break;
    }

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, challenge.pollAfterSeconds * 1000);
    });

    const status = await requestJson<EmailAuthChallengeStatusResponse>(
      runtime,
      'GET',
      `${baseUrl}/v1/auth/email/challenges/${challenge.challengeId}`
    );

    if (status.status === 'verified') {
      response = await requestJson<AuthResponse>(runtime, 'POST', `${baseUrl}/v1/auth/email/complete`, undefined, {
        challengeId: challenge.challengeId,
        exchangeToken: challenge.exchangeToken
      });
      break;
    }

    if (status.status === 'expired') {
      throw new Error('Sign-in challenge expired. Run `asdftube auth` again.');
    }
  }

  const stored: StoredConfig = {
    version: 1,
    baseUrl,
    apiKey: response.apiKey.token,
    apiKeyExpiresAt: response.apiKey.expiresAt,
    orgId: response.org.id,
    userId: response.user.id,
    username: response.user.username,
    email: response.user.email,
    orgSlug: response.org.slug,
    orgName: response.org.name
  };
  await saveConfig(configPath, stored);
  outputJson(runtime, {
    saved: true,
    configPath,
    org: response.org,
    user: response.user,
    apiKeyExpiresAt: response.apiKey.expiresAt
  });
}

async function handleUploadCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const filePath = parsed.positionals[1];

  if (!filePath) {
    throw new Error('Missing file path for upload command');
  }

  const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));
  const completed = await uploadHostedFile(
    runtime,
    config,
    filePath,
    parsePositiveNumber(getOptionString(parsed, 'part-size-mb'), DEFAULT_PART_SIZE_BYTES / (1024 * 1024)) * 1024 * 1024
  );

  if (getOptionBoolean(parsed, 'wait')) {
    const asset = await waitForAssetReady(runtime, config, completed.assetId);
    outputJson(runtime, {
      assetId: completed.assetId,
      status: asset.asset.status,
      playbackUrl: (asset as { playbackUrl?: string | null }).playbackUrl ?? null
    });
    return;
  }

  outputJson(runtime, completed);
}

async function handlePublishCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const filePath = parsed.positionals[1];

  if (!filePath) {
    throw new Error('Missing file path for publish command');
  }

  const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));
  const preset = (getOptionString(parsed, 'preset') ?? 'auto') as 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait';
  const result = await publishFile(runtime, config, filePath, {
    title: getOptionString(parsed, 'title'),
    preset,
    watermark: parsed.options.get('watermark') !== false,
    partSizeBytes: parsePositiveNumber(getOptionString(parsed, 'part-size-mb'), DEFAULT_PART_SIZE_BYTES / (1024 * 1024)) * 1024 * 1024
  });

  outputJson(runtime, result);
}

async function handleRecordCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const subcommand = parsed.positionals[1];

  if (subcommand === 'windows') {
    outputJson(runtime, await listWindows(runtime.cwd));
    return;
  }

  if (subcommand === 'desktop') {
    const recordedPath = await recordDesktopVideo({
      cwd: runtime.cwd,
      outputPath: getOptionString(parsed, 'output') ?? join(runtime.cwd, 'asdftube-desktop-capture.mp4'),
      seconds: parsePositiveNumber(getOptionString(parsed, 'seconds'), 8),
      ...(getOptionString(parsed, 'display') ? { display: Number(getOptionString(parsed, 'display')) } : {})
    });

    if (getOptionBoolean(parsed, 'publish')) {
      const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));
      const result = await publishFile(runtime, config, recordedPath, {
        title: getOptionString(parsed, 'title') ?? basename(recordedPath, extname(recordedPath)),
        preset: (getOptionString(parsed, 'preset') ?? 'auto') as 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait',
        watermark: parsed.options.get('watermark') !== false,
        partSizeBytes: parsePositiveNumber(getOptionString(parsed, 'part-size-mb'), DEFAULT_PART_SIZE_BYTES / (1024 * 1024)) * 1024 * 1024
      });

      outputJson(runtime, {
        recordedPath,
        durationSeconds: await inspectVideoDuration(recordedPath, runtime.cwd),
        ...result
      });
      return;
    }

    outputJson(runtime, { recordedPath, durationSeconds: await inspectVideoDuration(recordedPath, runtime.cwd) });
    return;
  }

  if (subcommand === 'window') {
    const capture = await recordWindowVideo({
      cwd: runtime.cwd,
      outputPath: getOptionString(parsed, 'output') ?? join(runtime.cwd, 'asdftube-window-capture.mp4'),
      seconds: parsePositiveNumber(getOptionString(parsed, 'seconds'), 8),
      ...(getOptionString(parsed, 'window-id') ? { windowId: Number(getOptionString(parsed, 'window-id')) } : {}),
      ...(getOptionString(parsed, 'app') ? { app: getOptionString(parsed, 'app') } : {}),
      ...(getOptionString(parsed, 'title-contains') ? { titleContains: getOptionString(parsed, 'title-contains') } : {})
    });

    if (getOptionBoolean(parsed, 'publish')) {
      const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));
      const result = await publishFile(runtime, config, capture.outputPath, {
        title: getOptionString(parsed, 'title') ?? `${capture.window.app}${capture.window.title ? ` - ${capture.window.title}` : ''}`,
        preset: (getOptionString(parsed, 'preset') ?? 'auto') as 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait',
        watermark: parsed.options.get('watermark') !== false,
        partSizeBytes: parsePositiveNumber(getOptionString(parsed, 'part-size-mb'), DEFAULT_PART_SIZE_BYTES / (1024 * 1024)) * 1024 * 1024
      });

      outputJson(runtime, {
        recordedPath: capture.outputPath,
        window: capture.window,
        durationSeconds: await inspectVideoDuration(capture.outputPath, runtime.cwd),
        ...result
      });
      return;
    }

    outputJson(runtime, {
      recordedPath: capture.outputPath,
      window: capture.window,
      durationSeconds: await inspectVideoDuration(capture.outputPath, runtime.cwd)
    });
    return;
  }

  if (subcommand !== 'terminal') {
    throw new Error('Supported record commands: terminal, desktop, window, windows');
  }

  const cmd = getOptionString(parsed, 'cmd');
  const outputPath = getOptionString(parsed, 'output') ?? join(runtime.cwd, 'asdftube-terminal-demo.mp4');
  const recordedPath =
    cmd || (!getOptionString(parsed, 'app') && !getOptionString(parsed, 'window-id') && !getOptionString(parsed, 'title-contains'))
      ? await recordTerminalActivity(runtime, {
          command: cmd ?? 'seq 1 10',
          outputPath,
          prompt: getOptionString(parsed, 'prompt') ?? `user@${basename(runtime.cwd)}>`,
          fontFile: getOptionString(parsed, 'font-file')
        })
      : (
          await captureTerminalWindow({
            cwd: runtime.cwd,
            outputPath,
            seconds: parsePositiveNumber(getOptionString(parsed, 'seconds'), 8),
            ...(getOptionString(parsed, 'window-id') ? { windowId: Number(getOptionString(parsed, 'window-id')) } : {}),
            ...(getOptionString(parsed, 'app') ? { app: getOptionString(parsed, 'app') } : {}),
            ...(getOptionString(parsed, 'title-contains') ? { titleContains: getOptionString(parsed, 'title-contains') } : {})
          })
        ).outputPath;

  if (getOptionBoolean(parsed, 'publish')) {
    const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));
    const result = await publishFile(runtime, config, recordedPath, {
      title: getOptionString(parsed, 'title') ?? basename(recordedPath, extname(recordedPath)),
      preset: (getOptionString(parsed, 'preset') ?? 'auto') as 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait',
      watermark: parsed.options.get('watermark') !== false,
      partSizeBytes: parsePositiveNumber(getOptionString(parsed, 'part-size-mb'), DEFAULT_PART_SIZE_BYTES / (1024 * 1024)) * 1024 * 1024
    });

    outputJson(runtime, {
      recordedPath,
      durationSeconds: await inspectVideoDuration(recordedPath, runtime.cwd),
      ...result
    });
    return;
  }

  outputJson(runtime, { recordedPath, durationSeconds: await inspectVideoDuration(recordedPath, runtime.cwd) });
}

async function handleReplayCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const provider = parsed.positionals[1] as ReplayProvider | undefined;

  if (!provider || !['codex', 'claude', 'opencode'].includes(provider)) {
    throw new Error('Replay provider must be one of codex, claude, or opencode');
  }

  const selector = parsed.positionals[2];
  const selection = await resolveReplaySelection({
    provider,
    cwd: runtime.cwd,
    ...(getOptionString(parsed, 'input') ? { inputPath: getOptionString(parsed, 'input') } : {}),
    ...(selector ? { selector } : {}),
    ...(getOptionString(parsed, 'query') ? { query: getOptionString(parsed, 'query') } : {})
  });
  const outputPath = getOptionString(parsed, 'output') ?? selection.outputPath;
  const replayTitle = getOptionString(parsed, 'title') ?? selection.title;
  const result = await renderReplayVideo({
    provider,
    cwd: runtime.cwd,
    outputPath,
    title: replayTitle,
    inputPath: selection.inputPath,
    ...(getOptionString(parsed, 'project') ? { project: getOptionString(parsed, 'project') } : {}),
    ...(getOptionString(parsed, 'redactions') ? { customRedactions: getOptionString(parsed, 'redactions') } : {}),
    includeToolCalls: getOptionBoolean(parsed, 'include-tool-calls'),
    includeToolArgs: getOptionBoolean(parsed, 'include-tool-args'),
    includeToolOutput: getOptionBoolean(parsed, 'include-tool-output')
  });

  if (getOptionBoolean(parsed, 'review-only') || !getOptionBoolean(parsed, 'publish')) {
    outputJson(runtime, result);
    return;
  }

  const confirmed = getOptionBoolean(parsed, 'yes')
    ? true
    : await confirmProceed(
        `Replay rendered locally at ${result.outputPath}. Review ${result.reviewPath} and ${result.transcriptPath} before publish.`
      );

  if (!confirmed) {
    outputJson(runtime, {
      ...result,
      published: false
    });
    return;
  }

  const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));
  const published = await publishFile(runtime, config, result.outputPath, {
    title: replayTitle,
    preset: (getOptionString(parsed, 'preset') ?? 'auto') as 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait',
    watermark: parsed.options.get('watermark') !== false,
    partSizeBytes: parsePositiveNumber(getOptionString(parsed, 'part-size-mb'), DEFAULT_PART_SIZE_BYTES / (1024 * 1024)) * 1024 * 1024
  });

  outputJson(runtime, {
    ...result,
    ...published,
    published: true
  });
}

async function handleShareCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const action = parsed.positionals[1];
  const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));

  if (action === 'list') {
    const state = getOptionString(parsed, 'state');
    const shares = await requestJson<PublicShareResponse[]>(
      runtime,
      'GET',
      `${config.baseUrl}/v1/public-shares${state ? `?state=${encodeURIComponent(state)}` : ''}`,
      config.apiKey
    );
    outputJson(runtime, shares);
    return;
  }

  if (action === 'revoke') {
    const shareId = parsed.positionals[2];

    if (!shareId) {
      throw new Error('Missing shareId for share revoke');
    }

    const share = await requestJson<PublicShareResponse>(
      runtime,
      'POST',
      `${config.baseUrl}/v1/public-shares/${shareId}/revoke`,
      config.apiKey
    );
    outputJson(runtime, share);
    return;
  }

  if (action === 'delete') {
    const shareId = parsed.positionals[2];

    if (!shareId) {
      throw new Error('Missing shareId for share delete');
    }

    const share = await requestJson<PublicShareResponse>(
      runtime,
      'POST',
      `${config.baseUrl}/v1/public-shares/${shareId}/revoke-by-token`,
      undefined,
      { token: requireOptionString(parsed, 'token') }
    );
    outputJson(runtime, share);
    return;
  }

  throw new Error(`Unknown share command: ${action ?? '(missing)'}`);
}

async function handleReportCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const action = parsed.positionals[1];
  const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));

  if (action === 'list') {
    const state = getOptionString(parsed, 'state');
    const reports = await requestJson<PublicShareReportResponse[]>(
      runtime,
      'GET',
      `${config.baseUrl}/v1/public-share-reports${state ? `?state=${encodeURIComponent(state)}` : ''}`,
      config.apiKey
    );
    outputJson(runtime, reports);
    return;
  }

  if (action === 'resolve') {
    const reportId = parsed.positionals[2];

    if (!reportId) {
      throw new Error('Missing reportId for report resolve');
    }

    const resolution = requireOptionString(parsed, 'resolution');
    const resolved = await requestJson<{ resolved: boolean; report: PublicShareReportResponse }>(
      runtime,
      'POST',
      `${config.baseUrl}/v1/public-share-reports/${reportId}/resolve`,
      config.apiKey,
      {
        resolution,
        ...(getOptionString(parsed, 'note') ? { resolutionNote: getOptionString(parsed, 'note') } : {})
      }
    );
    outputJson(runtime, resolved);
    return;
  }

  throw new Error(`Unknown report command: ${action ?? '(missing)'}`);
}

export async function runCli(argv: string[], runtimeOverrides?: CliRuntime): Promise<number> {
  const runtime = createRuntime(runtimeOverrides);
  const parsed = parseArgs(argv);

  if (argv.length === 0 || getOptionBoolean(parsed, 'help') || parsed.positionals[0] === 'help') {
    runtime.stdout(createUsage());
    return 0;
  }

  try {
    const command = parsed.positionals[0];

    switch (command) {
      case 'auth':
        await handleAuthCommand(runtime, parsed);
        return 0;
      case 'upload':
        await handleUploadCommand(runtime, parsed);
        return 0;
      case 'publish':
        await handlePublishCommand(runtime, parsed);
        return 0;
      case 'record':
        await handleRecordCommand(runtime, parsed);
        return 0;
      case 'replay':
        await handleReplayCommand(runtime, parsed);
        return 0;
      case 'share':
        await handleShareCommand(runtime, parsed);
        return 0;
      case 'report':
        await handleReportCommand(runtime, parsed);
        return 0;
      default:
        runtime.stderr(`Unknown command: ${command}`);
        runtime.stderr(createUsage());
        return 1;
    }
  } catch (error) {
    runtime.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
