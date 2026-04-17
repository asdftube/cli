import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { basename, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export type ReplayProvider = 'codex' | 'claude' | 'opencode';
type ReplayRole = 'user' | 'assistant' | 'tool';

interface ReplayEvent {
  role: ReplayRole;
  text: string;
  timestampMs: number;
  modelLabel: string;
}

interface ReplayBlock {
  event: ReplayEvent;
  lines: string[];
  rowCount: number;
  absoluteRowStart: number;
  turnIndex: number;
  typingSeconds: number;
  startSeconds: number;
  endSeconds: number;
  infoUntilSeconds: number;
  sourceGapSeconds: number;
}

interface ReplayVisibleLine {
  block: ReplayBlock;
  line: string;
  lineIndex: number;
  absoluteRow: number;
}

interface ReplayStage {
  block: ReplayBlock;
  visibleLines: ReplayVisibleLine[];
  viewportStartRowFrom: number;
  viewportStartRowTo: number;
  startSeconds: number;
  endSeconds: number;
}

interface ReplayParseResult {
  events: ReplayEvent[];
  sessionStartMs: number;
  warnings: string[];
}

interface ReplayRenderStats {
  durationSeconds: number;
  totalRows: number;
}

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

interface GitleaksFinding {
  Secret?: string;
  Match?: string;
}

export interface ReplayRenderOptions {
  provider: ReplayProvider;
  cwd?: string;
  inputPath?: string;
  query?: string;
  project?: string;
  outputPath: string;
  title: string;
  watermark?: string;
  publicId?: string;
  width?: number;
  height?: number;
  fps?: number;
  maxEvents?: number;
  maxPages?: number;
  maxStagesPerSegment?: number;
  speedMultiplier?: number;
  includeToolCalls?: boolean;
  includeToolArgs?: boolean;
  includeToolOutput?: boolean;
  fontFile?: string;
  gitleaksBin?: string;
  gitleaksMode?: 'auto' | 'off';
  gitleaksConfigPath?: string;
  customRedactions?: string;
}

export interface ReplayRenderResult {
  provider: ReplayProvider;
  inputPath: string;
  outputPath: string;
  metadataPath: string;
  transcriptPath: string;
  reviewPath: string;
  events: number;
  pages: number;
  segments: number;
  durationSeconds: number;
  warnings: string[];
  redactionRulesTriggered: Array<{ name: string; hits: number }>;
  secretScanner: 'regex-only' | 'regex+gitleaks';
}

export interface ReplaySelectionOptions {
  provider: ReplayProvider;
  cwd?: string;
  inputPath?: string;
  selector?: string;
  query?: string;
}

export interface ReplaySelectionResult {
  inputPath: string;
  outputPath: string;
  title: string;
  warnings: string[];
}

const DEFAULT_FONT = '/System/Library/Fonts/Menlo.ttc';
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;
const DEFAULT_MAX_EVENTS = 64;
const DEFAULT_MAX_PAGES = 999;
const DEFAULT_MAX_STAGES_PER_SEGMENT = 24;
const DEFAULT_SPEED_MULTIPLIER = 0.3;
const DEFAULT_WATERMARK = 'asdf.tube';
const DEFAULT_GITLEAKS_CONFIG_PATH = resolve(__dirname, '..', 'gitleaks.toml');

const outerX = 28;
const outerY = 28;
const barHeight = 28;
const scrollTrackWidth = 7;
const leadFontSize = 13;
const bodyFontSize = 13;
const timestampFontSize = 12;
const lineHeight = 21;
const barTextFontSize = 11;

function normalizeFont(path: string | undefined): string {
  return path || DEFAULT_FONT;
}

function escapeDrawtext(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '`')
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ');
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

function compact(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatModelLabel(model: string | null, effort: string | null): string {
  if (!model) {
    return 'unknown';
  }

  if (!effort) {
    return model;
  }

  const shortEffort =
    effort === 'medium' ? 'med' : effort === 'high' ? 'high' : effort === 'low' ? 'low' : effort === 'xhigh' ? 'xhi' : effort;

  return `${model}-${shortEffort}`;
}

function formatClockFromMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function speakerLabel(event: ReplayEvent): string {
  if (event.role === 'assistant') {
    return event.modelLabel;
  }

  return event.role === 'user' ? 'you' : 'tool';
}

function speakerColor(role: ReplayRole): string {
  return role === 'user' ? '0xa7f3d0' : role === 'tool' ? '0xfacc15' : '0xbfdbfe';
}

function speakerPrefixColor(role: ReplayRole): string {
  return role === 'user' ? '0x7fb5a0' : role === 'tool' ? '0xbda84b' : '0x7f92a8';
}

function bodyColor(role: ReplayRole): string {
  return speakerColor(role);
}

function estimateMonospaceWidth(text: string, fontSize: number): number {
  return Math.round(text.length * fontSize * 0.61);
}

function createBuiltInRedactions(): RedactionRule[] {
  return [
    {
      name: 'cloudflare-url',
      pattern: /https?:\/\/[^\s"'<>)]*cloudflare[^\s"'<>)]*/gi,
      replacement: '[REDACTED_CLOUDFLARE_URL]'
    },
    {
      name: 'npm-token',
      pattern: /\bnpm_[A-Za-z0-9]{16,}\b/g,
      replacement: '[REDACTED_NPM_TOKEN]'
    },
    {
      name: 'api-token',
      pattern: /\b(?:sk|rk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/gi,
      replacement: '[REDACTED_API_TOKEN]'
    },
    {
      name: 'email',
      pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      replacement: '[REDACTED_EMAIL]'
    },
    {
      name: 'ipv4',
      pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
      replacement: '[REDACTED_IP]'
    },
    {
      name: 'url',
      pattern: /https?:\/\/[^\s"'<>)]*/gi,
      replacement: '[REDACTED_URL]'
    },
    {
      name: 'domain',
      pattern: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,5}[a-z]{2,24}\b/gi,
      replacement: '[REDACTED_DOMAIN]'
    },
    {
      name: 'uuid',
      pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      replacement: '[REDACTED_UUID]'
    },
    {
      name: 'hash',
      pattern: /\b[a-f0-9]{20,64}\b/gi,
      replacement: '[REDACTED_HASH]'
    },
    {
      name: 'street-address',
      pattern:
        /\b\d{1,6}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,5}\s+(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Way|Court|Ct)\b/gi,
      replacement: '[REDACTED_ADDRESS]'
    }
  ];
}

function createCustomRedactions(raw: string | undefined): RedactionRule[] {
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Array<{ name?: string; pattern: string; replacement?: string; flags?: string }>;
    return parsed.map((rule, index) => ({
      name: rule.name || `custom-${index + 1}`,
      pattern: new RegExp(rule.pattern, rule.flags || 'gi'),
      replacement: rule.replacement || '[REDACTED]'
    }));
  } catch {
    return raw
      .split('||')
      .map((entry, index) => {
        const [pattern, replacement] = entry.split('=>');
        return pattern?.trim()
          ? {
              name: `custom-${index + 1}`,
              pattern: new RegExp(pattern.trim(), 'gi'),
              replacement: replacement?.trim() || '[REDACTED]'
            }
          : null;
      })
      .filter((rule): rule is RedactionRule => rule != null);
  }
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function applyLiteralMask(value: string, secrets: string[]): string {
  let current = value;

  for (const secret of uniqStrings(secrets).sort((left, right) => right.length - left.length)) {
    current = current.split(secret).join('[REDACTED_SECRET]');
  }

  return current;
}

async function runCommand(command: string, args: string[], cwd = process.cwd()): Promise<string> {
  const { stdout, stderr } = await execFile(command, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024
  });

  return [stdout, stderr].filter(Boolean).join('\n');
}

function resolveCodexSessionsRoot(): string {
  return join(process.env.HOME || '', '.codex', 'sessions');
}

function resolveClaudeHistoryPath(): string {
  return join(process.env.HOME || '', '.claude', 'history.jsonl');
}

function resolveOpencodeHistoryPath(): string {
  return join(process.env.HOME || '', '.opencode', 'history.jsonl');
}

function sanitizeOutputSegment(value: string): string {
  const collapsed = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return collapsed || 'session';
}

function codexSessionIdFromPath(path: string): string {
  const base = basename(path, extname(path));
  const prefix = 'rollout-';

  if (!base.startsWith(prefix)) {
    return base;
  }

  const parts = base.slice(prefix.length).split('-');
  if (parts.length >= 5) {
    return parts.slice(-5).join('-');
  }

  return base.slice(prefix.length) || base;
}

function buildReplayTitle(provider: ReplayProvider, label: string): string {
  const providerTitle = provider[0]!.toUpperCase() + provider.slice(1);
  return `${providerTitle} replay: ${label}`;
}

async function hasGitleaks(bin: string, mode: 'auto' | 'off'): Promise<boolean> {
  if (mode === 'off') {
    return false;
  }

  return execFile('sh', ['-lc', `command -v ${bin}`], {
    maxBuffer: 1024 * 1024
  })
    .then(() => true)
    .catch(() => false);
}

async function findGitleaksSecrets(value: string, bin: string, configPath: string, enabled: boolean): Promise<string[]> {
  if (!enabled || !value.trim()) {
    return [];
  }

  const workDir = await mkdtemp(join(tmpdir(), 'asdftube-gitleaks-'));
  const reportPath = join(workDir, 'report.json');
  const inputPath = join(workDir, 'input.txt');

  try {
    await writeFile(inputPath, value, 'utf8');
    await execFile(
      bin,
      [
        'dir',
        workDir,
        '--config',
        configPath,
        '--no-banner',
        '--no-git',
        '--report-format',
        'json',
        '--report-path',
        reportPath,
        '--redact',
        '--exit-code',
        '0'
      ],
      {
        maxBuffer: 8 * 1024 * 1024,
        timeout: 5000
      }
    );

    const report = await readFile(reportPath, 'utf8').catch(() => '[]');
    const findings = JSON.parse(report) as GitleaksFinding[];
    return uniqStrings(findings.flatMap((finding) => [finding.Secret, finding.Match]).filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    return [];
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function applyRedactionsWithStats(value: string, rules: RedactionRule[]): { text: string; hits: Map<string, number> } {
  let current = value;
  const hits = new Map<string, number>();

  for (const rule of rules) {
    const matches = current.match(rule.pattern);
    if (matches && matches.length > 0) {
      hits.set(rule.name, (hits.get(rule.name) || 0) + matches.length);
      current = current.replace(rule.pattern, rule.replacement);
    }
  }

  return {
    text: compact(current),
    hits
  };
}

function mergeHitMaps(target: Map<string, number>, source: Map<string, number>): void {
  for (const [key, value] of source.entries()) {
    target.set(key, (target.get(key) || 0) + value);
  }
}

function extractTextParts(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return '';
        }

        const item = entry as Record<string, unknown>;
        if (typeof item.text === 'string') {
          return item.text;
        }

        if (typeof item.input_text === 'string') {
          return item.input_text;
        }

        if (typeof item.output_text === 'string') {
          return item.output_text;
        }

        if (typeof item.content === 'string') {
          return item.content;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object') {
    const item = content as Record<string, unknown>;
    return [item.text, item.content, item.message].filter((part): part is string => typeof part === 'string').join('\n');
  }

  return '';
}

function extractGenericRole(record: Record<string, unknown>): ReplayRole | null {
  const candidates = [record.role, record.sender, record.author, record.type];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.toLowerCase();
    if (normalized.includes('user') || normalized === 'human') {
      return 'user';
    }
    if (normalized.includes('assistant') || normalized.includes('claude') || normalized.includes('codex') || normalized.includes('opencode')) {
      return 'assistant';
    }
    if (normalized.includes('tool')) {
      return 'tool';
    }
  }

  if (typeof record.display === 'string') {
    return 'user';
  }

  return null;
}

function extractGenericText(record: Record<string, unknown>): string {
  const directCandidates = [
    record.text,
    record.message,
    record.display,
    record.output,
    record.input,
    record.content
  ];

  for (const candidate of directCandidates) {
    const extracted = extractTextParts(candidate);
    if (extracted.trim()) {
      return extracted;
    }
  }

  for (const key of ['payload', 'data', 'delta']) {
    const candidate = record[key];
    if (candidate && typeof candidate === 'object') {
      const extracted = extractTextParts(candidate);
      if (extracted.trim()) {
        return extracted;
      }
    }
  }

  return '';
}

function extractTimestampMs(record: Record<string, unknown>, fallbackMs: number): number {
  const candidates = [record.timestamp, record.createdAt, record.time, record.created_at];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate > 10_000_000_000 ? candidate : candidate * 1000;
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) {
        return numeric > 10_000_000_000 ? numeric : numeric * 1000;
      }
    }
  }

  return fallbackMs;
}

function extractModelLabel(record: Record<string, unknown>, provider: ReplayProvider, fallback = 'unknown'): string {
  const candidates = [record.model, record.modelName, record.model_name, record.agent];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return fallback === 'unknown' ? provider : fallback;
}

async function parseCodexEventsFromFile(
  path: string,
  rules: RedactionRule[],
  maxEvents: number,
  includeToolCalls: boolean,
  includeToolArgs: boolean,
  includeToolOutput: boolean,
  gitleaksBin: string,
  gitleaksEnabled: boolean,
  gitleaksConfigPath: string,
  hitMap: Map<string, number>
): Promise<ReplayParseResult> {
  const events: ReplayEvent[] = [];
  const warnings: string[] = [];
  let sessionStartMs = 0;
  let currentModelLabel = 'unknown';
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const parsedTimestampMs = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;

    if (parsed.type === 'session_meta') {
      sessionStartMs = Number.isFinite(parsedTimestampMs) ? parsedTimestampMs : sessionStartMs;
      continue;
    }

    if (parsed.type === 'turn_context') {
      const payload = parsed.payload as Record<string, unknown> | undefined;
      const model = typeof payload?.model === 'string' ? payload.model : null;
      const effort = typeof payload?.effort === 'string' ? payload.effort : null;
      currentModelLabel = formatModelLabel(model, effort);
      continue;
    }

    const timestampMs = Number.isFinite(parsedTimestampMs) ? parsedTimestampMs : sessionStartMs || Date.now();
    let event: ReplayEvent | null = null;

    if (parsed.type === 'response_item') {
      const payload = parsed.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload.type === 'string') {
        if (payload.type === 'message') {
          const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null;
          const { text, hits } = applyRedactionsWithStats(extractTextParts(payload.content), rules);
          mergeHitMaps(hitMap, hits);
          if (role && text) {
            event = { role, text, timestampMs, modelLabel: currentModelLabel };
          }
        } else if (payload.type === 'function_call' && typeof payload.name === 'string' && includeToolCalls) {
          const raw = `tool call: ${payload.name}${includeToolArgs && typeof payload.arguments === 'string' ? ` ${payload.arguments}` : ''}`;
          const { text, hits } = applyRedactionsWithStats(raw, rules);
          mergeHitMaps(hitMap, hits);
          event = { role: 'tool', text, timestampMs, modelLabel: currentModelLabel };
        } else if (payload.type === 'function_call_output' && typeof payload.output === 'string' && includeToolOutput) {
          const { text, hits } = applyRedactionsWithStats(`tool output: ${payload.output}`, rules);
          mergeHitMaps(hitMap, hits);
          event = { role: 'tool', text, timestampMs, modelLabel: currentModelLabel };
        }
      }
    }

    if (!event) {
      continue;
    }

    if (!sessionStartMs) {
      sessionStartMs = event.timestampMs;
    }

    events.push(event);
    if (events.length > maxEvents) {
      events.shift();
    }
  }

  const transcript = events.map((event) => event.text).join('\n\n');
  const secrets = await findGitleaksSecrets(transcript, gitleaksBin, gitleaksConfigPath, gitleaksEnabled);
  if (secrets.length > 0) {
    hitMap.set('gitleaks', secrets.length);
  }

  return {
    events: secrets.length === 0 ? events : events.map((event) => ({ ...event, text: compact(applyLiteralMask(event.text, secrets)) })),
    sessionStartMs: sessionStartMs || events[0]?.timestampMs || Date.now(),
    warnings
  };
}

async function parseGenericEventsFromFile(
  provider: ReplayProvider,
  path: string,
  rules: RedactionRule[],
  maxEvents: number,
  projectFilter: string | undefined,
  gitleaksBin: string,
  gitleaksEnabled: boolean,
  gitleaksConfigPath: string,
  hitMap: Map<string, number>
): Promise<ReplayParseResult> {
  const events: ReplayEvent[] = [];
  const warnings: string[] = [];
  let sessionStartMs = 0;
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (projectFilter && typeof parsed.project === 'string' && !parsed.project.includes(projectFilter)) {
      continue;
    }

    const role = extractGenericRole(parsed);
    const rawText = extractGenericText(parsed);
    if (!role || !rawText.trim()) {
      continue;
    }

    const timestampMs = extractTimestampMs(parsed, sessionStartMs || Date.now());
    const { text, hits } = applyRedactionsWithStats(rawText, rules);
    mergeHitMaps(hitMap, hits);
    const event: ReplayEvent = {
      role,
      text,
      timestampMs,
      modelLabel: extractModelLabel(parsed, provider, provider === 'claude' ? 'claude' : provider)
    };

    if (!sessionStartMs) {
      sessionStartMs = timestampMs;
    }

    events.push(event);
    if (events.length > maxEvents) {
      events.shift();
    }
  }

  const assistantCount = events.filter((event) => event.role === 'assistant').length;
  if (assistantCount === 0) {
    warnings.push(`No assistant turns were detected in ${basename(path)}. This provider may require an exported full transcript instead of prompt history.`);
  }

  const transcript = events.map((event) => event.text).join('\n\n');
  const secrets = await findGitleaksSecrets(transcript, gitleaksBin, gitleaksConfigPath, gitleaksEnabled);
  if (secrets.length > 0) {
    hitMap.set('gitleaks', secrets.length);
  }

  return {
    events: secrets.length === 0 ? events : events.map((event) => ({ ...event, text: compact(applyLiteralMask(event.text, secrets)) })),
    sessionStartMs: sessionStartMs || events[0]?.timestampMs || Date.now(),
    warnings
  };
}

async function findCodexSessionPath(query: string, inputPath?: string): Promise<string> {
  if (inputPath) {
    return resolve(inputPath);
  }

  const sessionsRoot = resolveCodexSessionsRoot();
  const matches = (await runCommand('rg', ['-l', query, sessionsRoot]))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.jsonl'));

  if (matches.length === 0) {
    throw new Error(`No Codex session found for query: ${query}`);
  }

  const ranked = await Promise.all(
    matches.map(async (path) => ({
      path,
      size: (await stat(path)).size
    }))
  );
  ranked.sort((left, right) => right.size - left.size);
  return ranked[0]!.path;
}

async function findLatestCodexSessionPath(): Promise<string> {
  const sessionsRoot = resolveCodexSessionsRoot();
  const matches = (await runCommand('find', [sessionsRoot, '-type', 'f', '-name', '*.jsonl']))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.jsonl'));

  if (matches.length === 0) {
    throw new Error('No Codex sessions were found under ~/.codex/sessions');
  }

  const ranked = await Promise.all(
    matches.map(async (path) => ({
      path,
      modifiedMs: (await stat(path)).mtimeMs
    }))
  );
  ranked.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return ranked[0]!.path;
}

async function findCodexSessionBySelector(selector: string): Promise<string | null> {
  const sessionsRoot = resolveCodexSessionsRoot();
  const normalizedSelector = selector.trim();

  if (!normalizedSelector) {
    return null;
  }

  const matches = (await runCommand('find', [sessionsRoot, '-type', 'f', '-name', `*${normalizedSelector}*.jsonl`]))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.jsonl'));

  if (matches.length === 0) {
    return null;
  }

  const ranked = await Promise.all(
    matches.map(async (path) => ({
      path,
      modifiedMs: (await stat(path)).mtimeMs
    }))
  );
  ranked.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return ranked[0]!.path;
}

async function resolveReplayInputPath(provider: ReplayProvider, options: ReplayRenderOptions): Promise<{ path: string; warnings: string[] }> {
  if (options.inputPath) {
    return { path: resolve(options.inputPath), warnings: [] };
  }

  if (provider === 'codex') {
    return { path: await findCodexSessionPath(options.query || 'cybercafe.party'), warnings: [] };
  }

  if (provider === 'claude') {
    const historyPath = resolveClaudeHistoryPath();
    return {
      path: historyPath,
      warnings: ['Using Claude prompt history fallback. Pass --input with an exported transcript for full assistant replay fidelity.']
    };
  }

  const historyPath = resolveOpencodeHistoryPath();
  return {
    path: historyPath,
    warnings: ['Using OpenCode fallback history path. Pass --input with an exported transcript if local history is unavailable or incomplete.']
  };
}

export async function resolveReplaySelection(options: ReplaySelectionOptions): Promise<ReplaySelectionResult> {
  const cwd = options.cwd || process.cwd();

  if (options.inputPath) {
    const resolvedInputPath = resolve(options.inputPath);
    const stem = basename(resolvedInputPath, extname(resolvedInputPath));
    const label = options.provider === 'codex' ? codexSessionIdFromPath(resolvedInputPath) : stem;

    return {
      inputPath: resolvedInputPath,
      outputPath: join(cwd, `asdf-tube-${options.provider}-${sanitizeOutputSegment(label)}.mp4`),
      title: buildReplayTitle(options.provider, label),
      warnings: []
    };
  }

  if (options.provider === 'codex') {
    const selector = options.selector?.trim() || options.query?.trim();
    const selectedPath =
      !selector || selector === 'latest'
        ? await findLatestCodexSessionPath()
        : (await findCodexSessionBySelector(selector)) ?? (await findCodexSessionPath(selector));
    const sessionId = codexSessionIdFromPath(selectedPath);
    return {
      inputPath: selectedPath,
      outputPath: join(cwd, `asdf-tube-codex-${sanitizeOutputSegment(sessionId)}.mp4`),
      title: buildReplayTitle('codex', sessionId),
      warnings: selector ? [] : ['No session selector provided. Defaulted to the latest Codex session.']
    };
  }

  if (options.provider === 'claude') {
    const inputPath = resolveClaudeHistoryPath();
    return {
      inputPath,
      outputPath: join(cwd, 'asdf-tube-claude-history.mp4'),
      title: buildReplayTitle('claude', 'history'),
      warnings: ['Using Claude prompt history fallback. Pass --input with an exported transcript for full assistant replay fidelity.']
    };
  }

  const inputPath = resolveOpencodeHistoryPath();
  return {
    inputPath,
    outputPath: join(cwd, 'asdf-tube-opencode-history.mp4'),
    title: buildReplayTitle('opencode', 'history'),
    warnings: ['Using OpenCode fallback history path. Pass --input with an exported transcript if local history is unavailable or incomplete.']
  };
}

function wrapText(value: string, firstLineChars: number, continuationChars: number): string[] {
  const lines: string[] = [];
  let lineLimit = firstLineChars;

  for (const paragraph of value.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = '';

    if (words.length === 0) {
      lineLimit = continuationChars;
      continue;
    }

    for (const word of words) {
      if (word.length > lineLimit && !current) {
        let remainder = word;
        while (remainder.length > lineLimit) {
          lines.push(remainder.slice(0, lineLimit));
          remainder = remainder.slice(lineLimit);
          lineLimit = continuationChars;
        }
        current = remainder;
        continue;
      }

      if (!current) {
        current = word;
        continue;
      }

      if (`${current} ${word}`.length > lineLimit) {
        lines.push(current);
        current = word;
        lineLimit = continuationChars;
        continue;
      }

      current = `${current} ${word}`;
    }

    if (current) {
      lines.push(current);
      lineLimit = continuationChars;
    }
  }

  return lines;
}

function blockTypingSeconds(lines: string[], speedMultiplier: number): number {
  const totalChars = lines.reduce((sum, line) => sum + line.length, 0);
  return Math.max(0.74, Math.min(2.59, (totalChars / 68) * 1.3225 * speedMultiplier));
}

function perLineDurations(lines: string[], totalSeconds: number, speedMultiplier: number): number[] {
  if (lines.length === 0) {
    return [];
  }

  const weightedLengths = lines.map((line) => Math.max(1, line.length));
  const totalChars = Math.max(1, weightedLengths.reduce((sum, value) => sum + value, 0));
  const rawDurations = weightedLengths.map((value) => totalSeconds * (value / totalChars));
  const minimum = 0.12 * speedMultiplier;
  const clamped = rawDurations.map((value) => Math.max(minimum, value));
  const clampedTotal = clamped.reduce((sum, value) => sum + value, 0);

  if (clampedTotal <= totalSeconds) {
    const remainder = totalSeconds - clampedTotal;
    clamped[clamped.length - 1] += remainder;
    return clamped;
  }

  const adjustableIndices = clamped.map((value, index) => ({ value, index })).filter((entry) => entry.value > minimum);
  if (adjustableIndices.length === 0) {
    const equalDuration = totalSeconds / lines.length;
    return lines.map((_, index) => (index === lines.length - 1 ? totalSeconds - equalDuration * (lines.length - 1) : equalDuration));
  }

  let overflow = clampedTotal - totalSeconds;
  for (const entry of adjustableIndices) {
    if (overflow <= 0) {
      break;
    }
    const available = clamped[entry.index]! - minimum;
    const reduction = Math.min(available, overflow);
    clamped[entry.index] -= reduction;
    overflow -= reduction;
  }

  const normalizedTotal = clamped.reduce((sum, value) => sum + value, 0);
  clamped[clamped.length - 1] += totalSeconds - normalizedTotal;
  return clamped;
}

function buildVisibleLines(blocks: ReplayBlock[], viewportStartRowFrom: number, viewportStartRowTo: number, maxLines: number): ReplayVisibleLine[] {
  const minViewportRow = Math.min(viewportStartRowFrom, viewportStartRowTo);
  const maxViewportRow = Math.max(viewportStartRowFrom, viewportStartRowTo);
  const viewportEndRow = maxViewportRow + maxLines;

  return blocks.flatMap((block) =>
    block.lines
      .map((line, lineIndex) => ({
        block,
        line,
        lineIndex,
        absoluteRow: block.absoluteRowStart + lineIndex
      }))
      .filter((entry) => entry.absoluteRow >= minViewportRow && entry.absoluteRow < viewportEndRow)
  );
}

function buildStages(
  events: ReplayEvent[],
  width: number,
  height: number,
  speedMultiplier: number
): ReplayStage[] {
  const outerWidth = width - 56;
  const outerHeight = height - 82;
  const contentX = outerX + 8;
  const contentTop = outerY + barHeight + 10;
  const scrollTrackX = outerX + outerWidth - 20;
  const contentRight = scrollTrackX - 40;
  const timestampColumnWidth = 72;
  const transcriptX = contentX + timestampColumnWidth;
  const contentWidth = contentRight - transcriptX;
  const contentBottom = outerY + outerHeight - 22;
  const continuationChars = Math.max(52, Math.floor((contentWidth - 12) / (bodyFontSize * 0.66)));
  const maxLines = Math.max(10, Math.floor((contentBottom - contentTop) / lineHeight));
  const blocks: ReplayBlock[] = [];
  const stages: ReplayStage[] = [];
  let totalRows = 0;

  for (const [index, event] of events.entries()) {
    const prefixChars = `${speakerLabel(event)}> `.length;
    const firstLineChars = Math.max(16, continuationChars - prefixChars);
    const renderedLines = wrapText(event.text, firstLineChars, continuationChars).slice(0, 8);
    const rowCount = renderedLines.length + 1;
    blocks.push({
      event,
      lines: renderedLines,
      rowCount,
      absoluteRowStart: totalRows,
      turnIndex: index + 1,
      typingSeconds: blockTypingSeconds(renderedLines, speedMultiplier),
      startSeconds: 0,
      endSeconds: 0,
      infoUntilSeconds: 0,
      sourceGapSeconds:
        index < events.length - 1 ? Math.max(0, (events[index + 1]!.timestampMs - event.timestampMs) / 1000) : 0
    });
    totalRows += rowCount;
  }

  let cursor = 0;
  let previousViewportStartRow = 0;
  for (const [index, block] of blocks.entries()) {
    const viewportStartRow = Math.max(0, block.absoluteRowStart + block.lines.length - maxLines);
    const stageHoldSeconds = Math.max(0.2, Math.min(0.95, (0.2 + block.sourceGapSeconds * 0.18) * speedMultiplier));
    const startSeconds = cursor;
    block.startSeconds = startSeconds;
    block.endSeconds = startSeconds + block.typingSeconds;
    block.infoUntilSeconds = block.endSeconds + stageHoldSeconds;

    stages.push({
      block,
      visibleLines: buildVisibleLines(blocks.slice(0, index + 1), previousViewportStartRow, viewportStartRow, maxLines),
      viewportStartRowFrom: previousViewportStartRow,
      viewportStartRowTo: viewportStartRow,
      startSeconds,
      endSeconds: block.infoUntilSeconds
    });

    previousViewportStartRow = viewportStartRow;
    cursor = block.infoUntilSeconds;
  }

  return stages;
}

function drawText(text: string, x: number | string, y: number | string, size: number, color: string, enable: string, font: string): string {
  return `drawtext=fontfile='${font}':text='${escapeDrawtext(text)}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:enable='${enable}'`;
}

function drawTextBaseline(
  text: string,
  x: number | string,
  y: number | string,
  size: number,
  color: string,
  enable: string,
  font: string
): string {
  return `drawtext=fontfile='${font}':text='${escapeDrawtext(text)}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y_align=font:y=${y}:enable='${enable}'`;
}

function pushTypedLineFilters(
  filters: string[],
  text: string,
  x: number | string,
  y: number | string,
  size: number,
  color: string,
  startSeconds: number,
  durationSeconds: number,
  persistUntil: number,
  fps: number,
  font: string
): void {
  const chunkCount = Math.max(1, Math.min(text.length, Math.max(1, Math.floor(durationSeconds * fps))));

  for (let index = 0; index < chunkCount; index += 1) {
    const chunkStart = startSeconds + (durationSeconds * index) / chunkCount;
    const chunkEnd = startSeconds + (durationSeconds * (index + 1)) / chunkCount;
    const visibleChars = Math.max(1, Math.ceil((text.length * (index + 1)) / chunkCount));
    filters.push(
      drawTextBaseline(`${text.slice(0, visibleChars)}|`, x, y, size, color, `gte(t\\,${chunkStart.toFixed(3)})*lt(t\\,${chunkEnd.toFixed(3)})`, font)
    );
  }

  filters.push(drawTextBaseline(text, x, y, size, color, `gte(t\\,${(startSeconds + durationSeconds).toFixed(3)})*lt(t\\,${persistUntil.toFixed(3)})`, font));
}

function stageScrollProgressExpr(stage: ReplayStage): string {
  const typingStart = stage.block.startSeconds;
  const rawDuration = Math.max(0.24, stage.endSeconds - stage.block.startSeconds);
  const start = typingStart.toFixed(3);
  const duration = rawDuration.toFixed(3);
  const raw = `min(max((t-${start})/${duration}\\,0)\\,1)`;
  return `((${raw})*(${raw})*(3-2*(${raw})))`;
}

function lineYExpression(stage: ReplayStage, absoluteRow: number, contentTop: number): string {
  const baseRow = absoluteRow - stage.viewportStartRowFrom;
  const scrollDeltaRows = stage.viewportStartRowTo - stage.viewportStartRowFrom;
  if (scrollDeltaRows === 0) {
    return `${Math.round(contentTop + baseRow * lineHeight)}`;
  }

  return `floor(${contentTop + baseRow * lineHeight}-(${scrollDeltaRows * lineHeight}*${stageScrollProgressExpr(stage)}))`;
}

function splitStagesIntoSegments(stages: ReplayStage[], maxStages: number): ReplayStage[][] {
  if (stages.length <= maxStages) {
    return [stages];
  }

  const segments: ReplayStage[][] = [];
  for (let index = 0; index < stages.length; index += maxStages) {
    segments.push(stages.slice(index, index + maxStages));
  }
  return segments;
}

function normalizeSegmentStages(segmentStages: ReplayStage[]): ReplayStage[] {
  const segmentStart = segmentStages[0]?.startSeconds || 0;
  return segmentStages.map((stage) => ({
    ...stage,
    block: {
      ...stage.block,
      startSeconds: stage.block.startSeconds - segmentStart,
      endSeconds: stage.block.endSeconds - segmentStart,
      infoUntilSeconds: stage.block.infoUntilSeconds - segmentStart
    },
    startSeconds: stage.startSeconds - segmentStart,
    endSeconds: stage.endSeconds - segmentStart
  }));
}

async function renderStagesToVideo(
  stages: ReplayStage[],
  events: ReplayEvent[],
  visibleStartMs: number,
  watermarkText: string,
  barTitle: string,
  outputFilePath: string,
  width: number,
  height: number,
  fps: number,
  font: string,
  speedMultiplier: number
): Promise<ReplayRenderStats> {
  const outerWidth = width - 56;
  const outerHeight = height - 82;
  const contentX = outerX + 8;
  const contentTop = outerY + barHeight + 10;
  const scrollTrackX = outerX + outerWidth - 20;
  const contentBottom = outerY + outerHeight - 22;
  const scrollTrackY = contentTop + 6;
  const scrollTrackHeight = contentBottom - scrollTrackY;
  const timestampColumnWidth = 72;
  const transcriptX = contentX + timestampColumnWidth;
  const durationSeconds = Math.max(12, (stages.at(-1)?.endSeconds || 0) + 1.2);
  const finalTurnIndex = stages.at(-1)?.block.turnIndex || 0;
  const totalRows = Math.max(1, (stages.at(-1)?.block.absoluteRowStart || 0) + (stages.at(-1)?.block.rowCount || 0));
  const maxVisibleLines = Math.max(10, Math.floor((contentBottom - contentTop) / lineHeight));
  const barTextY = outerY + 8;
  const filters: string[] = [
    `drawbox=x=0:y=0:w=${width}:h=${height}:color=0x061014:t=fill`,
    `drawbox=x=${outerX}:y=${outerY}:w=${outerWidth}:h=${outerHeight}:color=0x081525@0.92:t=fill`,
    `drawbox=x=${scrollTrackX}:y=${scrollTrackY}:w=${scrollTrackWidth}:h=${scrollTrackHeight}:color=0xf8fafc@0.10:t=fill`
  ];

  stages.forEach((stage) => {
    const stageVisibleUntil = stage.block.turnIndex === finalTurnIndex ? durationSeconds : stage.endSeconds;
    const stageEnable = `between(t\\,${stage.startSeconds.toFixed(3)}\\,${stageVisibleUntil.toFixed(3)})`;
    const thumbHeight = Math.max(44, Math.floor((scrollTrackHeight * Math.min(maxVisibleLines, totalRows)) / totalRows));
    const thumbTravel = Math.max(0, scrollTrackHeight - thumbHeight);
    const thumbStartY = scrollTrackY + Math.round((thumbTravel * stage.viewportStartRowFrom) / Math.max(1, totalRows - maxVisibleLines));
    const thumbEndY = scrollTrackY + Math.round((thumbTravel * stage.viewportStartRowTo) / Math.max(1, totalRows - maxVisibleLines));
    const thumbYExpr = thumbStartY === thumbEndY ? `${thumbStartY}` : `${thumbStartY}+(${thumbEndY - thumbStartY}*${stageScrollProgressExpr(stage)})`;

    filters.push(drawText(`turn ${stage.block.turnIndex}/${events.length}`, `w-text_w-${outerX + 18}`, barTextY, barTextFontSize, '0x8fa6b6', stageEnable, font));
    filters.push(`drawbox=x=${scrollTrackX}:y=${thumbYExpr}:w=${scrollTrackWidth}:h=${thumbHeight}:color=0xa7f3d0@0.82:t=fill:enable='${stageEnable}'`);

    stage.visibleLines.forEach((entry) => {
      const y = lineYExpression(stage, entry.absoluteRow, contentTop);
      const clock = entry.lineIndex === 0 ? formatClockFromMs(entry.block.event.timestampMs - visibleStartMs) : '';
      const size = entry.lineIndex === 0 ? leadFontSize : bodyFontSize;
      const color = bodyColor(entry.block.event.role);

      if (entry.block.turnIndex === stage.block.turnIndex) {
        return;
      }

      if (clock) {
        filters.push(drawTextBaseline(clock, contentX, y, timestampFontSize, '0x6e8092', stageEnable, font));
      }

      if (entry.lineIndex === 0) {
        const prefix = `${speakerLabel(entry.block.event)}> `;
        const prefixWidth = estimateMonospaceWidth(prefix, size);
        filters.push(drawTextBaseline(prefix, transcriptX, y, size, speakerPrefixColor(entry.block.event.role), stageEnable, font));
        filters.push(drawTextBaseline(entry.line, transcriptX + prefixWidth, y, size, color, stageEnable, font));
      } else {
        filters.push(drawTextBaseline(entry.line, transcriptX, y, size, color, stageEnable, font));
      }
    });

    const lineDurations = perLineDurations(stage.block.lines, stage.block.typingSeconds, speedMultiplier);
    let lineCursor = stage.block.startSeconds;
    const linePersistUntil = stage.block.turnIndex === finalTurnIndex ? durationSeconds : stage.endSeconds;

    stage.block.lines.forEach((line, lineIndex) => {
      const y = lineYExpression(stage, stage.block.absoluteRowStart + lineIndex, contentTop);
      const clock = lineIndex === 0 ? formatClockFromMs(stage.block.event.timestampMs - visibleStartMs) : '';
      const size = lineIndex === 0 ? leadFontSize : bodyFontSize;
      const color = bodyColor(stage.block.event.role);
      const duration = lineDurations[lineIndex] || 0.12;

      if (clock) {
        filters.push(drawTextBaseline(clock, contentX, y, timestampFontSize, '0x6e8092', stageEnable, font));
      }

      if (lineIndex === 0) {
        const prefix = `${speakerLabel(stage.block.event)}> `;
        const prefixWidth = estimateMonospaceWidth(prefix, size);
        filters.push(drawTextBaseline(prefix, transcriptX, y, size, speakerPrefixColor(stage.block.event.role), stageEnable, font));
        pushTypedLineFilters(filters, line, transcriptX + prefixWidth, y, size, color, lineCursor, duration, linePersistUntil, fps, font);
      } else {
        pushTypedLineFilters(filters, line, transcriptX, y, size, color, lineCursor, duration, linePersistUntil, fps, font);
      }

      lineCursor += duration;
    });
  });

  filters.push(`drawbox=x=0:y=0:w=${width}:h=${contentTop}:color=0x061014:t=fill`);
  filters.push(`drawbox=x=${outerX}:y=${outerY}:w=${outerWidth}:h=${contentTop - outerY}:color=0x081525@0.92:t=fill`);
  filters.push(`drawbox=x=0:y=${contentBottom}:w=${width}:h=${height - contentBottom}:color=0x061014:t=fill`);
  filters.push(`drawbox=x=${outerX}:y=${outerY}:w=${outerWidth}:h=${barHeight}:color=0x142235:t=fill`);
  filters.push(drawText(barTitle, outerX + 18, barTextY, barTextFontSize, '0x8fa6b6', 'gte(t\\,0)', font));

  stages.forEach((stage) => {
    const stageVisibleUntil = stage.block.turnIndex === finalTurnIndex ? durationSeconds : stage.endSeconds;
    const stageEnable = `between(t\\,${stage.startSeconds.toFixed(3)}\\,${stageVisibleUntil.toFixed(3)})`;
    filters.push(drawText(`turn ${stage.block.turnIndex}/${events.length}`, `w-text_w-${outerX + 18}`, barTextY, barTextFontSize, '0x8fa6b6', stageEnable, font));
  });

  filters.push(drawText(watermarkText, 'w-text_w-40', height - 48, 22, '0xf8fafc@0.24', 'gte(t\\,0)', font));

  const filterPath = `${outputFilePath}.fffilter`;
  await writeFile(filterPath, filters.join(',\n'), 'utf8');
  await runCommand('ffmpeg', [
    '-y',
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-filter_complex_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x061014:s=${width}x${height}:d=${durationSeconds.toFixed(3)}:r=${fps}`,
    '-f',
    'lavfi',
    '-i',
    `anullsrc=channel_layout=stereo:sample_rate=48000:d=${durationSeconds.toFixed(3)}`,
    '-filter_complex_script',
    filterPath,
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-pix_fmt',
    'yuv420p',
    outputFilePath
  ]);

  return { durationSeconds, totalRows };
}

export async function renderReplayVideo(options: ReplayRenderOptions): Promise<ReplayRenderResult> {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const fps = options.fps ?? DEFAULT_FPS;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxStagesPerSegment = options.maxStagesPerSegment ?? DEFAULT_MAX_STAGES_PER_SEGMENT;
  const speedMultiplier = options.speedMultiplier ?? DEFAULT_SPEED_MULTIPLIER;
  const gitleaksBin = options.gitleaksBin || 'gitleaks';
  const gitleaksMode = options.gitleaksMode || 'auto';
  const gitleaksConfigPath = options.gitleaksConfigPath || DEFAULT_GITLEAKS_CONFIG_PATH;
  const font = normalizeFont(options.fontFile);
  const hitMap = new Map<string, number>();
  const resolvedInput = await resolveReplayInputPath(options.provider, options);
  const rules = [...createBuiltInRedactions(), ...createCustomRedactions(options.customRedactions)];
  const gitleaksEnabled = await hasGitleaks(gitleaksBin, gitleaksMode);

  const parsed =
    options.provider === 'codex'
      ? await parseCodexEventsFromFile(
          resolvedInput.path,
          rules,
          maxEvents,
          options.includeToolCalls === true,
          options.includeToolArgs === true,
          options.includeToolOutput === true,
          gitleaksBin,
          gitleaksEnabled,
          gitleaksConfigPath,
          hitMap
        )
      : await parseGenericEventsFromFile(
          options.provider,
          resolvedInput.path,
          rules,
          maxEvents,
          options.project,
          gitleaksBin,
          gitleaksEnabled,
          gitleaksConfigPath,
          hitMap
        );

  const events = parsed.events.slice(-maxPages);
  if (events.length === 0) {
    throw new Error(`No renderable ${options.provider} messages found in ${resolvedInput.path}`);
  }

  const outputPath = resolve(options.cwd || process.cwd(), options.outputPath);
  const metadataPath = `${outputPath}.json`;
  const transcriptPath = `${outputPath}.txt`;
  const reviewPath = `${outputPath}.review.json`;
  const visibleStartMs = events[0]!.timestampMs;
  const watermarkText = options.publicId ? `https://asdf.tube/${options.publicId}` : options.watermark || DEFAULT_WATERMARK;
  const barTitle = `asdf.tube - ${options.title}`;
  const stages = buildStages(events, width, height, speedMultiplier).slice(-maxPages);
  const segmentGroups = splitStagesIntoSegments(stages, maxStagesPerSegment);
  const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-replay-segments-'));
  let durationSeconds = 0;

  try {
    const segmentFiles: string[] = [];
    for (const [index, group] of segmentGroups.entries()) {
      const segmentOutputPath = join(tempDir, `segment-${String(index + 1).padStart(3, '0')}.mp4`);
      const stats = await renderStagesToVideo(
        normalizeSegmentStages(group),
        events,
        visibleStartMs,
        watermarkText,
        barTitle,
        segmentOutputPath,
        width,
        height,
        fps,
        font,
        speedMultiplier
      );
      durationSeconds += stats.durationSeconds;
      segmentFiles.push(segmentOutputPath);
    }

    await writeFile(transcriptPath, events.map((event) => `${formatClockFromMs(event.timestampMs - visibleStartMs)} ${speakerLabel(event)}> ${event.text}`).join('\n\n'), 'utf8');
    if (segmentFiles.length === 1) {
      await writeFile(outputPath, await readFile(segmentFiles[0]!));
    } else {
      const concatListPath = join(tempDir, 'segments.txt');
      await writeFile(concatListPath, segmentFiles.map((file) => `file '${file.replace(/'/g, `'\\''`)}'`).join('\n'), 'utf8');
      await runCommand('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', outputPath]);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const redactionRulesTriggered = [...hitMap.entries()]
    .filter(([, hits]) => hits > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([name, hits]) => ({ name, hits }));
  const warnings = [...resolvedInput.warnings, ...parsed.warnings];

  const review = {
    provider: options.provider,
    inputPath: resolvedInput.path,
    outputPath,
    title: options.title,
    warnings,
    events: events.length,
    pages: stages.length,
    segments: segmentGroups.length,
    secretScanner: gitleaksEnabled ? 'regex+gitleaks' : 'regex-only',
    redactionRulesTriggered
  };

  await writeFile(metadataPath, JSON.stringify(review, null, 2), 'utf8');
  await writeFile(reviewPath, JSON.stringify(review, null, 2), 'utf8');

  return {
    provider: options.provider,
    inputPath: resolvedInput.path,
    outputPath,
    metadataPath,
    transcriptPath,
    reviewPath,
    events: events.length,
    pages: stages.length,
    segments: segmentGroups.length,
    durationSeconds,
    warnings,
    redactionRulesTriggered,
    secretScanner: gitleaksEnabled ? 'regex+gitleaks' : 'regex-only'
  };
}
