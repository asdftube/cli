import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export interface WindowRecord {
  id: number;
  app: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenCaptureOptions {
  cwd?: string;
  outputPath: string;
  seconds: number;
  display?: number;
  windowId?: number;
  app?: string;
  titleContains?: string;
  includeCursor?: boolean;
  showClicks?: boolean;
  withAudio?: boolean;
  audioDeviceId?: string;
}

async function runCommand(command: string, args: string[], cwd = process.cwd()): Promise<string> {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024
    });

    return [stdout, stderr].filter(Boolean).join('\n');
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const details = [failure.stderr, failure.stdout].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n').trim();

    if (command === 'screencapture') {
      throw new Error(
        details
          ? `Screen capture failed.\n${details}\nGrant Screen Recording permission to your terminal app in macOS Privacy & Security, then retry.`
          : 'Screen capture failed. Grant Screen Recording permission to your terminal app in macOS Privacy & Security, then retry.'
      );
    }

    throw new Error(details ? `${command} failed.\n${details}` : `${command} failed.`);
  }
}

async function writeSwiftWindowScript(): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-window-list-'));
  const scriptPath = join(tempDir, 'windows.swift');
  await writeFile(
    scriptPath,
    `import Cocoa
import CoreGraphics

let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows {
  guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
  guard let owner = window[kCGWindowOwnerName as String] as? String else { continue }
  let id = window[kCGWindowNumber as String] as? Int ?? 0
  let name = window[kCGWindowName as String] as? String ?? ""
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let x = Int((bounds["X"] as? Double) ?? 0)
  let y = Int((bounds["Y"] as? Double) ?? 0)
  let w = Int((bounds["Width"] as? Double) ?? 0)
  let h = Int((bounds["Height"] as? Double) ?? 0)
  print("\\(id)\\t\\(owner)\\t\\(name.replacingOccurrences(of: "\\t", with: " "))\\t\\(x)\\t\\(y)\\t\\(w)\\t\\(h)")
}
`,
    'utf8'
  );
  return scriptPath;
}

export async function listWindows(cwd = process.cwd()): Promise<WindowRecord[]> {
  const scriptPath = await writeSwiftWindowScript();

  try {
    const raw = await runCommand('swift', [scriptPath], cwd);
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, app, title, x, y, width, height] = line.split('\t');
        return {
          id: Number(id),
          app: app || '',
          title: title || '',
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height)
        } satisfies WindowRecord;
      })
      .filter((window) => Number.isFinite(window.id) && window.app.length > 0);
  } finally {
    await rm(dirname(scriptPath), { recursive: true, force: true }).catch(() => undefined);
  }
}

function selectWindow(windows: WindowRecord[], options: Pick<ScreenCaptureOptions, 'windowId' | 'app' | 'titleContains'>): WindowRecord {
  if (options.windowId != null) {
    const match = windows.find((window) => window.id === options.windowId);
    if (!match) {
      throw new Error(`Window ${options.windowId} was not found`);
    }
    return match;
  }

  let matches = windows;
  if (options.app) {
    matches = matches.filter((window) => window.app.toLowerCase() === options.app!.toLowerCase());
  }
  if (options.titleContains) {
    matches = matches.filter((window) => window.title.toLowerCase().includes(options.titleContains!.toLowerCase()));
  }

  if (matches.length === 0) {
    throw new Error('No matching window was found');
  }
  if (matches.length > 1) {
    const summary = matches.slice(0, 8).map((window) => `${window.id}: ${window.app}${window.title ? ` - ${window.title}` : ''}`).join('\n');
    throw new Error(`Multiple windows matched. Narrow with --window-id or --title-contains.\n${summary}`);
  }

  return matches[0]!;
}

async function normalizeCapturedVideo(tempPath: string, outputPath: string, cwd: string): Promise<string> {
  await runCommand(
    'ffmpeg',
    ['-y', '-i', tempPath, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', outputPath],
    cwd
  );
  return outputPath;
}

export function buildScreenCaptureVideoArgs(
  options: Pick<ScreenCaptureOptions, 'seconds' | 'includeCursor' | 'showClicks' | 'withAudio' | 'audioDeviceId' | 'display'>,
  rawPath: string,
  windowId?: number
): string[] {
  const args = ['-v', '-x', `-V${Math.max(1, Math.round(options.seconds))}`];
  if (options.includeCursor !== false) {
    args.push('-C');
  }
  if (options.showClicks !== false) {
    args.push('-k');
  }
  if (options.audioDeviceId) {
    args.push(`-G${options.audioDeviceId}`);
  } else if (options.withAudio) {
    args.push('-g');
  }
  if (windowId != null) {
    args.push(`-l${windowId}`);
  } else if (options.display != null) {
    args.push(`-D${options.display}`);
  }
  args.push(rawPath);
  return args;
}

export async function recordDesktopVideo(options: ScreenCaptureOptions): Promise<string> {
  const cwd = options.cwd || process.cwd();
  const outputPath = resolve(cwd, options.outputPath);
  const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-desktop-recording-'));
  const rawPath = join(tempDir, 'capture.mov');

  try {
    const args = buildScreenCaptureVideoArgs(options, rawPath);
    await runCommand('screencapture', args, cwd);
    return await normalizeCapturedVideo(rawPath, outputPath, cwd);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function recordWindowVideo(options: ScreenCaptureOptions): Promise<{ outputPath: string; window: WindowRecord }> {
  const cwd = options.cwd || process.cwd();
  const outputPath = resolve(cwd, options.outputPath);
  const windows = await listWindows(cwd);
  const window = selectWindow(windows, options);
  const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-window-recording-'));
  const rawPath = join(tempDir, 'capture.mov');

  try {
    const args = buildScreenCaptureVideoArgs(options, rawPath, window.id);
    await runCommand('screencapture', args, cwd);
    return {
      outputPath: await normalizeCapturedVideo(rawPath, outputPath, cwd),
      window
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function inspectVideoDuration(filePath: string, cwd = process.cwd()): Promise<number> {
  const output = await runCommand(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    cwd
  );
  const seconds = Number(output.trim());
  return Number.isFinite(seconds) ? seconds : 0;
}

export async function captureTerminalWindow(options: ScreenCaptureOptions): Promise<{ outputPath: string; window: WindowRecord }> {
  const windows = await listWindows(options.cwd || process.cwd());
  const preferredApps = options.app ? [options.app] : ['iTerm2', 'iTerm', 'Terminal', 'Warp', 'Ghostty', 'kitty', 'Alacritty'];
  let terminalWindow: WindowRecord | null = null;

  if (options.windowId != null) {
    terminalWindow = selectWindow(windows, {
      windowId: options.windowId,
      app: undefined,
      titleContains: options.titleContains
    });
  } else {
    for (const app of preferredApps) {
      try {
        terminalWindow = selectWindow(windows, {
          app,
          titleContains: options.titleContains,
          windowId: undefined
        });
        break;
      } catch {
        continue;
      }
    }
  }

  if (!terminalWindow) {
    throw new Error(
      `No terminal window matched. Run \`asdftube record windows\` and pass --window-id, or target one of: ${preferredApps.join(', ')}.`
    );
  }

  return await recordWindowVideo({
    ...options,
    windowId: terminalWindow.id,
    app: undefined,
    titleContains: undefined
  });
}
