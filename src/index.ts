import { spawn } from 'node:child_process';
import { access, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

import { captureTerminalWindow, inspectVideoDuration, listWindows, recordDesktopVideo, recordWindowVideo } from './capture';
import { editVideoFromPrompt, parseAssetList } from './edit';
import { renderReplayVideo, resolveReplaySelection, type ReplayProvider } from './replay';
import {
  describeVideoTextSizePresets,
  parseVideoTextSizePreset,
  resolveTerminalTextMetrics,
  type VideoTextSizePreset
} from './text-size';

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
  deleteCommand?: string;
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
  audioCodec?: string | null;
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

interface ShareListItem extends PublicShareResponse {
  revokedAt?: string | null;
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

export function normalizeBaseUrl(value: string): string {
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

function shouldOutputJson(parsed: ParsedArgs): boolean {
  return getOptionBoolean(parsed, 'json');
}

function outputBlankLine(runtime: Required<CliRuntime>): void {
  runtime.stdout('');
}

function outputHeading(runtime: Required<CliRuntime>, heading: string): void {
  runtime.stdout(heading);
}

function outputField(runtime: Required<CliRuntime>, label: string, value: string | number | boolean | null | undefined): void {
  if (value === undefined || value === null || value === '') {
    return;
  }

  runtime.stdout(`${label}: ${String(value)}`);
}

function formatDurationSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return 'unknown';
  }

  if (value < 60) {
    return `${value.toFixed(1)}s`;
  }

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function outputPublishSummary(
  runtime: Required<CliRuntime>,
  result: PublishResult,
  extras?: {
    heading?: string;
    recordedPath?: string;
    durationSeconds?: number;
    windowLabel?: string;
    title?: string;
  }
): void {
  outputHeading(runtime, extras?.heading ?? 'Published');
  outputField(runtime, 'Share URL', result.shareUrl);
  outputField(runtime, 'Delete', result.deleteCommand);
  outputField(runtime, 'Saved file', extras?.recordedPath);
  outputField(
    runtime,
    'Duration',
    extras?.durationSeconds !== undefined ? formatDurationSeconds(extras.durationSeconds) : undefined
  );
  outputField(runtime, 'Window', extras?.windowLabel);
  outputField(runtime, 'Title', extras?.title);
}

function outputRecordedSummary(
  runtime: Required<CliRuntime>,
  recordedPath: string,
  durationSeconds: number,
  extras?: {
    heading?: string;
    windowLabel?: string;
  }
): void {
  outputHeading(runtime, extras?.heading ?? 'Recording saved');
  outputField(runtime, 'Saved file', recordedPath);
  outputField(runtime, 'Duration', formatDurationSeconds(durationSeconds));
  outputField(runtime, 'Window', extras?.windowLabel);
}

function outputReplaySummary(
  runtime: Required<CliRuntime>,
  result: {
    outputPath: string;
    transcriptPath: string;
    reviewPath: string;
  },
  extras?: {
    heading?: string;
    shareUrl?: string;
    deleteCommand?: string;
    published?: boolean;
  }
): void {
  outputHeading(runtime, extras?.heading ?? (extras?.published ? 'Replay published' : 'Replay ready for review'));
  outputField(runtime, 'Video', result.outputPath);
  outputField(runtime, 'Transcript', result.transcriptPath);
  outputField(runtime, 'Review notes', result.reviewPath);
  outputField(runtime, 'Share URL', extras?.shareUrl);
  outputField(runtime, 'Delete', extras?.deleteCommand);
}

function outputEditSummary(
  runtime: Required<CliRuntime>,
  result: {
    outputPath?: string;
    outputPaths: string[];
    durationSeconds?: number;
    operations: Array<{ summary: string }>;
    warnings: string[];
  },
  extras?: {
    heading?: string;
    shareUrl?: string;
    deleteCommand?: string;
    published?: boolean;
  }
): void {
  outputHeading(runtime, extras?.heading ?? (extras?.published ? 'Edited video published' : 'Edited video ready'));
  if (result.outputPath) {
    outputField(runtime, 'Video', result.outputPath);
  } else {
    outputField(runtime, 'Outputs', result.outputPaths.length);
    result.outputPaths.forEach((path, index) => outputField(runtime, `Part ${index + 1}`, path));
  }
  outputField(
    runtime,
    'Duration',
    result.durationSeconds !== undefined ? formatDurationSeconds(result.durationSeconds) : undefined
  );
  outputField(runtime, 'Applied edits', result.operations.map((operation) => operation.summary).join('; '));
  if (result.warnings.length > 0) {
    outputField(runtime, 'Warnings', result.warnings.join(' | '));
  }
  outputField(runtime, 'Share URL', extras?.shareUrl);
  outputField(runtime, 'Delete', extras?.deleteCommand);
}

function outputShareList(runtime: Required<CliRuntime>, shares: ShareListItem[]): void {
  if (shares.length === 0) {
    runtime.stdout('No shares found.');
    return;
  }

  outputHeading(runtime, `Shares (${shares.length})`);
  for (const share of shares) {
    outputBlankLine(runtime);
    runtime.stdout(`${share.id}  ${share.title}`);
    outputField(runtime, 'URL', share.url);
    outputField(runtime, 'Created', share.createdAt);
    outputField(runtime, 'State', share.revokedAt ? 'revoked' : 'active');
  }
}

function outputReportList(runtime: Required<CliRuntime>, reports: PublicShareReportResponse[]): void {
  if (reports.length === 0) {
    runtime.stdout('No reports found.');
    return;
  }

  outputHeading(runtime, `Reports (${reports.length})`);
  for (const report of reports) {
    outputBlankLine(runtime);
    runtime.stdout(`${report.id}  ${report.reason}`);
    outputField(runtime, 'Share', report.shareId);
    outputField(runtime, 'State', report.state);
    outputField(runtime, 'Resolution', report.resolution ?? 'pending');
    outputField(runtime, 'Created', report.createdAt);
  }
}

function buildShareDeleteCommand(shareId: string, revokeToken?: string): string | undefined {
  if (!revokeToken) {
    return undefined;
  }

  return `npx -y @asdftube/cli@latest share delete ${shareId} --token ${revokeToken}`;
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

export function getConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.ASDF_TUBE_CLI_CONFIG) {
    return resolve(env.ASDF_TUBE_CLI_CONFIG);
  }

  return join(homedir(), '.config', 'asdftube', 'config.json');
}

export async function saveConfig(configPath: string, config: StoredConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function loadConfig(configPath: string): Promise<StoredConfig | null> {
  try {
    const raw = await readFile(configPath, 'utf8');
    return JSON.parse(raw) as StoredConfig;
  } catch {
    return null;
  }
}

export async function clearConfig(configPath: string): Promise<void> {
  try {
    await unlink(configPath);
  } catch {
    // Ignore missing config files.
  }
}

async function accessFile(path: string): Promise<void> {
  await access(path, fsConstants.F_OK | fsConstants.R_OK);
}

export async function requestJson<TResponse>(
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
  const contentType = response.headers.get('content-type') ?? '';

  if (!response.ok) {
    const preview = text.slice(0, 240).replace(/\s+/g, ' ').trim();
    throw new Error(`Request failed with ${response.status} ${response.statusText}: ${preview || 'empty response body'}`);
  }

  if (text.length === 0) {
    return null as TResponse;
  }

  if (!/application\/json|application\/problem\+json/i.test(contentType)) {
    const preview = text.slice(0, 240).replace(/\s+/g, ' ').trim();
    throw new Error(
      `Expected JSON from ${url} but received ${contentType || 'unknown content type'}: ${preview || 'empty response body'}`
    );
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown parse error';
    const preview = text.slice(0, 240).replace(/\s+/g, ' ').trim();
    throw new Error(`Invalid JSON from ${url}: ${message}. Response preview: ${preview || 'empty response body'}`);
  }
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

export function buildDefaultRenderSpec(
  asset: AssetResponse,
  preset: 'landscape_hd' | 'square_social' | 'story_portrait'
): CompositionSpec {
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
      ...(asset.asset.audioCodec
        ? [
            {
              id: 'audio_main',
              type: 'audio' as const,
              assetId: asset.asset.id,
              startFrame: 0,
              endFrame: durationFrames
            }
          ]
        : [])
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
    ...(share.revokeUrl ? { revokeUrl: share.revokeUrl } : {}),
    ...(share.revokeToken ? { deleteCommand: buildShareDeleteCommand(share.id, share.revokeToken) } : {})
  };
}

async function attachReplayPayload(
  runtime: Required<CliRuntime>,
  config: StoredConfig,
  shareId: string,
  replay: {
    provider: ReplayProvider;
    title: string;
    payloadPath: string;
    transcriptPath: string;
    reviewPath: string;
  }
): Promise<void> {
  const payloadRaw = await readFile(replay.payloadPath, 'utf8');
  const transcriptRaw = await readFile(replay.transcriptPath, 'utf8');
  const reviewRaw = await readFile(replay.reviewPath, 'utf8');

  await requestJson(
    runtime,
    'POST',
    `${config.baseUrl}/v1/public-shares/${shareId}/replay`,
    config.apiKey,
    {
      provider: replay.provider,
      title: replay.title,
      payload: JSON.parse(payloadRaw) as unknown,
      transcript: transcriptRaw,
      review: JSON.parse(reviewRaw) as unknown
    }
  );
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

export async function guessDefaultEmail(cwd: string, fallback?: string): Promise<string | undefined> {
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
    '  asdftube mcp-server',
    '  asdftube auth [--email <email>] [--json]',
    '  asdftube auth whoami [--json]',
    '  asdftube auth logout [--json]',
    '  asdftube upload <file> [--wait] [--json] [--part-size-mb <mb>] [--base-url <url>]',
    '  asdftube publish <file> [--title <title>] [--preset auto|landscape_hd|square_social|story_portrait] [--no-watermark] [--json]',
    `  asdftube record terminal [--cmd <shell>] [--output <file>] [--prompt <text>] [--text-size ${describeVideoTextSizePresets()}] [--publish] [--title <title>] [--json]`,
    '  asdftube record desktop [--seconds <n>] [--display <id>] [--output <file>] [--publish] [--title <title>] [--json]',
    '  asdftube record window [--window-id <id> | --app <name> [--title-contains <text>]] [--seconds <n>] [--output <file>] [--publish] [--title <title>] [--json]',
    '  asdftube record windows [--json]',
    '  asdftube edit video <file> --prompt "<natural language edit>" [--asset <path[,path...]>] [--output <file>] [--publish] [--title <title>] [--json]',
    `  asdftube replay codex|gemini [latest|<session-hash>|<query>] [--review-only] [--publish --yes] [--redactions <rules>] [--text-size ${describeVideoTextSizePresets()}] [--json]`,
    `  asdftube replay claude|opencode [--input <file>] [--output <file>] [--review-only] [--publish --yes] [--redactions <rules>] [--text-size ${describeVideoTextSizePresets()}] [--json]`,
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
    textSizePreset: VideoTextSizePreset;
    fontFile?: string;
  }
): Promise<string> {
  const cwd = runtime.cwd;
  const outputPath = resolve(cwd, options.outputPath);
  const font = resolveTerminalFont(options.fontFile);
  const width = 1920;
  const height = 1080;
  const fps = 30;
  const textMetrics = resolveTerminalTextMetrics(options.textSizePreset);
  const fontSize = textMetrics.fontSize;
  const lineHeight = textMetrics.lineHeight;
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
    `drawbox=x=${x}:y=${y + 4}:w=${textMetrics.cursorWidth}:h=${Math.max(textMetrics.cursorMinHeight, fontSize)}:color=0xf8fafc:t=fill:enable='${enable}*gt(mod(t\\,1)\\,0.5)'`;

  filters.push(drawText(options.prompt, marginX, marginY, `lt(t\\,${commandStartSeconds.toFixed(3)})`));
  filters.push(drawCursor(marginX + Math.round(options.prompt.length * fontSize * 0.61) + 12, marginY, `lt(t\\,${commandStartSeconds.toFixed(3)})`));

  for (let index = 1; index <= displayCommand.length; index += 1) {
    const startSeconds = commandStartSeconds + (index - 1) * typingDelaySeconds;
    const endSeconds = index === displayCommand.length ? durationSeconds : commandStartSeconds + index * typingDelaySeconds;
    const cursorEndSeconds =
      index === displayCommand.length
        ? Math.max(commandStartSeconds + index * typingDelaySeconds, outputOffsetSeconds)
        : endSeconds;
    const line = `${options.prompt} ${displayCommand.slice(0, index)}`;
    filters.push(drawText(line, marginX, marginY, `between(t\\,${startSeconds.toFixed(3)}\\,${endSeconds.toFixed(3)})`));
    filters.push(
      drawCursor(
        marginX + Math.round(line.length * fontSize * 0.61) + 12,
        marginY,
        `between(t\\,${startSeconds.toFixed(3)}\\,${cursorEndSeconds.toFixed(3)})`
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
  const json = shouldOutputJson(parsed);

  if (action === 'whoami') {
    const config = await loadConfig(configPath);

    if (!config) {
      throw new Error('No stored auth config found');
    }

    const payload = {
      configPath,
      baseUrl: config.baseUrl,
      orgId: config.orgId,
      orgSlug: config.orgSlug,
      orgName: config.orgName,
      userId: config.userId,
      username: config.username,
      email: config.email,
      apiKeyExpiresAt: config.apiKeyExpiresAt ?? null
    };

    if (json) {
      outputJson(runtime, payload);
      return;
    }

    outputHeading(runtime, 'Signed in');
    outputField(runtime, 'Username', config.username);
    outputField(runtime, 'Email', config.email);
    outputField(runtime, 'Org', `${config.orgName} (${config.orgSlug})`);
    outputField(runtime, 'Config', configPath);
    return;
  }

  if (action === 'logout') {
    await clearConfig(configPath);
    const payload = {
      cleared: true,
      configPath
    };

    if (json) {
      outputJson(runtime, payload);
      return;
    }

    outputHeading(runtime, 'Signed out');
    outputField(runtime, 'Config removed', configPath);
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
  const payload = {
    saved: true,
    configPath,
    org: response.org,
    user: response.user,
    apiKeyExpiresAt: response.apiKey.expiresAt
  };

  if (json) {
    outputJson(runtime, payload);
    return;
  }

  outputBlankLine(runtime);
  outputHeading(runtime, 'Signed in');
  outputField(runtime, 'Username', response.user.username);
  outputField(runtime, 'Org', `${response.org.name} (${response.org.slug})`);
  outputField(runtime, 'Config', configPath);
}

async function handleUploadCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const filePath = parsed.positionals[1];
  const json = shouldOutputJson(parsed);

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
    const payload = {
      assetId: completed.assetId,
      status: asset.asset.status,
      playbackUrl: (asset as { playbackUrl?: string | null }).playbackUrl ?? null
    };

    if (json) {
      outputJson(runtime, payload);
      return;
    }

    outputHeading(runtime, 'Upload complete');
    outputField(runtime, 'Asset ID', completed.assetId);
    outputField(runtime, 'Status', asset.asset.status);
    return;
  }

  if (json) {
    outputJson(runtime, completed);
    return;
  }

  outputHeading(runtime, 'Upload queued');
  outputField(runtime, 'Asset ID', completed.assetId);
  outputField(runtime, 'Jobs', completed.jobs.join(', '));
}

async function handlePublishCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const filePath = parsed.positionals[1];
  const json = shouldOutputJson(parsed);

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

  if (json) {
    outputJson(runtime, result);
    return;
  }

  outputPublishSummary(runtime, result, {
    title: getOptionString(parsed, 'title') ?? basename(filePath, extname(filePath))
  });
}

async function handleRecordCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const subcommand = parsed.positionals[1];
  const json = shouldOutputJson(parsed);

  if (subcommand === 'windows') {
    const windows = await listWindows(runtime.cwd);

    if (json) {
      outputJson(runtime, windows);
      return;
    }

    if (windows.length === 0) {
      runtime.stdout('No recordable windows found.');
      return;
    }

    outputHeading(runtime, `Windows (${windows.length})`);
    for (const window of windows) {
      outputBlankLine(runtime);
      runtime.stdout(`${window.id}  ${window.app}`);
      outputField(runtime, 'Title', window.title);
      outputField(runtime, 'Bounds', `${window.width}x${window.height} @ ${window.x},${window.y}`);
    }
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

      const payload = {
        recordedPath,
        durationSeconds: await inspectVideoDuration(recordedPath, runtime.cwd),
        ...result
      };

      if (json) {
        outputJson(runtime, payload);
        return;
      }

      outputPublishSummary(runtime, result, {
        heading: 'Desktop recording published',
        recordedPath,
        durationSeconds: payload.durationSeconds,
        title: getOptionString(parsed, 'title') ?? basename(recordedPath, extname(recordedPath))
      });
      return;
    }

    const durationSeconds = await inspectVideoDuration(recordedPath, runtime.cwd);
    if (json) {
      outputJson(runtime, { recordedPath, durationSeconds });
      return;
    }

    outputRecordedSummary(runtime, recordedPath, durationSeconds, {
      heading: 'Desktop recording saved'
    });
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

      const payload = {
        recordedPath: capture.outputPath,
        window: capture.window,
        durationSeconds: await inspectVideoDuration(capture.outputPath, runtime.cwd),
        ...result
      };

      if (json) {
        outputJson(runtime, payload);
        return;
      }

      outputPublishSummary(runtime, result, {
        heading: 'Window recording published',
        recordedPath: capture.outputPath,
        durationSeconds: payload.durationSeconds,
        windowLabel: `${capture.window.app}${capture.window.title ? ` - ${capture.window.title}` : ''}`,
        title: getOptionString(parsed, 'title') ?? `${capture.window.app}${capture.window.title ? ` - ${capture.window.title}` : ''}`
      });
      return;
    }

    const payload = {
      recordedPath: capture.outputPath,
      window: capture.window,
      durationSeconds: await inspectVideoDuration(capture.outputPath, runtime.cwd)
    };

    if (json) {
      outputJson(runtime, payload);
      return;
    }

    outputRecordedSummary(runtime, capture.outputPath, payload.durationSeconds, {
      heading: 'Window recording saved',
      windowLabel: `${capture.window.app}${capture.window.title ? ` - ${capture.window.title}` : ''}`
    });
    return;
  }

  if (subcommand !== 'terminal') {
    throw new Error('Supported record commands: terminal, desktop, window, windows');
  }

  const cmd = getOptionString(parsed, 'cmd');
  const outputPath = getOptionString(parsed, 'output') ?? join(runtime.cwd, 'asdftube-terminal-demo.mp4');
  const textSizePreset = parseVideoTextSizePreset(getOptionString(parsed, 'text-size'));
  const recordedPath =
    cmd || (!getOptionString(parsed, 'app') && !getOptionString(parsed, 'window-id') && !getOptionString(parsed, 'title-contains'))
      ? await recordTerminalActivity(runtime, {
          command: cmd ?? 'seq 1 10',
          outputPath,
          prompt: getOptionString(parsed, 'prompt') ?? `user@${basename(runtime.cwd)}>`,
          textSizePreset,
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

    const payload = {
      recordedPath,
      durationSeconds: await inspectVideoDuration(recordedPath, runtime.cwd),
      ...result
    };

    if (json) {
      outputJson(runtime, payload);
      return;
    }

    outputPublishSummary(runtime, result, {
      heading: 'Terminal recording published',
      recordedPath,
      durationSeconds: payload.durationSeconds,
      title: getOptionString(parsed, 'title') ?? basename(recordedPath, extname(recordedPath))
    });
    return;
  }

  const durationSeconds = await inspectVideoDuration(recordedPath, runtime.cwd);
  if (json) {
    outputJson(runtime, { recordedPath, durationSeconds });
    return;
  }

  outputRecordedSummary(runtime, recordedPath, durationSeconds, {
    heading: 'Terminal recording saved'
  });
}

async function handleReplayCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const provider = parsed.positionals[1] as ReplayProvider | undefined;
  const json = shouldOutputJson(parsed);

  if (!provider || !['codex', 'claude', 'opencode', 'gemini'].includes(provider)) {
    throw new Error('Replay provider must be one of codex, claude, opencode, or gemini');
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
    textSizePreset: parseVideoTextSizePreset(getOptionString(parsed, 'text-size')),
    inputPath: selection.inputPath,
    ...(getOptionString(parsed, 'project') ? { project: getOptionString(parsed, 'project') } : {}),
    ...(getOptionString(parsed, 'redactions') ? { customRedactions: getOptionString(parsed, 'redactions') } : {}),
    includeToolCalls: getOptionBoolean(parsed, 'include-tool-calls'),
    includeToolArgs: getOptionBoolean(parsed, 'include-tool-args'),
    includeToolOutput: getOptionBoolean(parsed, 'include-tool-output')
  });

  if (getOptionBoolean(parsed, 'review-only') || !getOptionBoolean(parsed, 'publish')) {
    if (json) {
      outputJson(runtime, result);
      return;
    }

    outputReplaySummary(runtime, result);
    return;
  }

  const confirmed = getOptionBoolean(parsed, 'yes')
    ? true
    : await confirmProceed(
        `Replay rendered locally at ${result.outputPath}. Review ${result.reviewPath} and ${result.transcriptPath} before publish.`
      );

  if (!confirmed) {
    const payload = {
      ...result,
      published: false
    };

    if (json) {
      outputJson(runtime, payload);
      return;
    }

    outputReplaySummary(runtime, result, {
      heading: 'Replay ready for review'
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
  await attachReplayPayload(runtime, config, published.shareId, {
    provider,
    title: replayTitle,
    payloadPath: result.payloadPath,
    transcriptPath: result.transcriptPath,
    reviewPath: result.reviewPath
  });

  const payload = {
    ...result,
    ...published,
    published: true
  };

  if (json) {
    outputJson(runtime, payload);
    return;
  }

  outputReplaySummary(runtime, result, {
    heading: 'Replay published',
    shareUrl: published.shareUrl,
    deleteCommand: published.deleteCommand,
    published: true
  });
}

async function handleEditCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const subject = parsed.positionals[1];

  if (subject !== 'video') {
    throw new Error(`Unknown edit subject: ${subject ?? '(missing)'}`);
  }

  const sourcePath = parsed.positionals[2];

  if (!sourcePath) {
    throw new Error('Missing input file for edit video');
  }

  const prompt = requireOptionString(parsed, 'prompt');
  const outputPath =
    getOptionString(parsed, 'output') ??
    join(runtime.cwd, `${basename(sourcePath, extname(sourcePath))}-edited.mp4`);
  const result = await editVideoFromPrompt({
    cwd: runtime.cwd,
    sourcePath,
    prompt,
    outputPath,
    assetPaths: parseAssetList(runtime.cwd, getOptionString(parsed, 'asset'))
  });
  const json = shouldOutputJson(parsed);

  if (result.outputPaths.length > 1) {
    if (getOptionBoolean(parsed, 'publish')) {
      throw new Error('Split edits produce multiple outputs. Publish one file explicitly after review.');
    }

    if (json) {
      outputJson(runtime, result);
      return;
    }

    outputEditSummary(runtime, result);
    return;
  }

  if (!getOptionBoolean(parsed, 'publish')) {
    if (json) {
      outputJson(runtime, result);
      return;
    }

    outputEditSummary(runtime, result);
    return;
  }

  const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));
  const published = await publishFile(runtime, config, result.outputPath!, {
    title: getOptionString(parsed, 'title') ?? basename(result.outputPath!, extname(result.outputPath!)),
    preset: (getOptionString(parsed, 'preset') ?? 'auto') as 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait',
    watermark: parsed.options.get('watermark') !== false,
    partSizeBytes: parsePositiveNumber(getOptionString(parsed, 'part-size-mb'), DEFAULT_PART_SIZE_BYTES / (1024 * 1024)) * 1024 * 1024
  });
  const payload = {
    ...result,
    ...published,
    published: true
  };

  if (json) {
    outputJson(runtime, payload);
    return;
  }

  outputEditSummary(runtime, result, {
    heading: 'Edited video published',
    shareUrl: published.shareUrl,
    deleteCommand: published.deleteCommand,
    published: true
  });
}

async function handleShareCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const action = parsed.positionals[1];
  const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));
  const json = shouldOutputJson(parsed);

  if (action === 'list') {
    const state = getOptionString(parsed, 'state');
    const shares = await requestJson<ShareListItem[]>(
      runtime,
      'GET',
      `${config.baseUrl}/v1/public-shares${state ? `?state=${encodeURIComponent(state)}` : ''}`,
      config.apiKey
    );

    if (json) {
      outputJson(runtime, shares);
      return;
    }

    outputShareList(runtime, shares);
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
    if (json) {
      outputJson(runtime, share);
      return;
    }

    outputHeading(runtime, 'Share revoked');
    outputField(runtime, 'Share URL', share.url);
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
    if (json) {
      outputJson(runtime, share);
      return;
    }

    outputHeading(runtime, 'Share deleted');
    outputField(runtime, 'Share URL', share.url);
    return;
  }

  throw new Error(`Unknown share command: ${action ?? '(missing)'}`);
}

async function handleReportCommand(runtime: Required<CliRuntime>, parsed: ParsedArgs): Promise<void> {
  const action = parsed.positionals[1];
  const config = resolveStoredConfig(runtime, parsed, await loadConfig(getConfigPath(runtime.env)));
  const json = shouldOutputJson(parsed);

  if (action === 'list') {
    const state = getOptionString(parsed, 'state');
    const reports = await requestJson<PublicShareReportResponse[]>(
      runtime,
      'GET',
      `${config.baseUrl}/v1/public-share-reports${state ? `?state=${encodeURIComponent(state)}` : ''}`,
      config.apiKey
    );
    if (json) {
      outputJson(runtime, reports);
      return;
    }

    outputReportList(runtime, reports);
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
    if (json) {
      outputJson(runtime, resolved);
      return;
    }

    outputHeading(runtime, 'Report resolved');
    outputField(runtime, 'Report ID', resolved.report.id);
    outputField(runtime, 'Resolution', resolved.report.resolution ?? resolution);
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
      case 'mcp-server': {
        const { startMcpServer } = await import('./mcp');
        await startMcpServer(runtime);
        return 0;
      }
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
      case 'edit':
        await handleEditCommand(runtime, parsed);
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

export interface CapturedCliExecution<TValue = unknown> {
  exitCode: number;
  stdout: string[];
  stderr: string[];
  text: string;
  json: TValue | null;
}

export async function executeCliCommand<TValue = unknown>(
  argv: string[],
  runtimeOverrides?: CliRuntime
): Promise<CapturedCliExecution<TValue>> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const supportsJson =
    argv.length > 0 && argv[0] !== 'help' && argv[0] !== 'mcp-server' && !argv.includes('--json');
  const exitCode = await runCli(supportsJson ? [...argv, '--json'] : argv, {
    ...runtimeOverrides,
    stdout: (line: string) => {
      stdout.push(line);
    },
    stderr: (line: string) => {
      stderr.push(line);
    }
  });

  const text = stdout.join('\n').trim();
  let json: TValue | null = null;

  if (text) {
    try {
      json = JSON.parse(text) as TValue;
    } catch {
      json = null;
    }
  }

  return {
    exitCode,
    stdout,
    stderr,
    text,
    json
  };
}
