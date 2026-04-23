import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveReplaySelection } from '../src/replay';

const originalHome = process.env.HOME;

async function writeCodexSessionFile(homeDir: string, relativePath: string, contents: string): Promise<string> {
  const fullPath = join(homeDir, '.codex', 'sessions', relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, 'utf8');
  return fullPath;
}

async function writeGeminiSessionFile(homeDir: string, relativePath: string, contents: string): Promise<string> {
  const fullPath = join(homeDir, '.gemini', 'tmp', relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents, 'utf8');
  return fullPath;
}

describe('@asdftube/cli replay selection', () => {
  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it('defaults codex replay selection to the latest session', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'asdftube-replay-home-'));
    process.env.HOME = homeDir;

    const olderPath = await writeCodexSessionFile(
      homeDir,
      '2026/04/15/rollout-2026-04-15T10-26-49-019d922e-6e0b-7ca0-86eb-612f25a25eb6.jsonl',
      '{"type":"message","role":"user","content":"older"}\n'
    );
    const latestPath = await writeCodexSessionFile(
      homeDir,
      '2026/04/16/rollout-2026-04-16T13-11-09-019d97eb-3dbc-70c2-ac2b-dfad275f98c6.jsonl',
      '{"type":"message","role":"user","content":"latest"}\n'
    );

    const selection = await resolveReplaySelection({
      provider: 'codex',
      cwd: homeDir
    });

    expect(selection.inputPath).toBe(latestPath);
    expect(selection.outputPath).toContain('asdf-tube-codex-019d97eb-3dbc-70c2-ac2b-dfad275f98c6.mp4');
    expect(selection.title).toBe('Codex replay: 019d97eb-3dbc-70c2-ac2b-dfad275f98c6');
    expect(selection.warnings).toEqual(['No session selector provided. Defaulted to the latest Codex session.']);
    expect(olderPath).not.toBe(selection.inputPath);
  });

  it('resolves a codex session by the exit hash selector', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'asdftube-replay-hash-'));
    process.env.HOME = homeDir;

    const targetPath = await writeCodexSessionFile(
      homeDir,
      '2026/04/16/rollout-2026-04-16T13-11-09-019d97eb-3dbc-70c2-ac2b-dfad275f98c6.jsonl',
      '{"type":"message","role":"user","content":"target"}\n'
    );

    const selection = await resolveReplaySelection({
      provider: 'codex',
      cwd: homeDir,
      selector: '019d97eb-3dbc-70c2-ac2b-dfad275f98c6'
    });

    expect(selection.inputPath).toBe(targetPath);
    expect(selection.outputPath).toContain('asdf-tube-codex-019d97eb-3dbc-70c2-ac2b-dfad275f98c6.mp4');
    expect(selection.title).toBe('Codex replay: 019d97eb-3dbc-70c2-ac2b-dfad275f98c6');
    expect(selection.warnings).toEqual([]);
  });

  it('defaults gemini replay selection to the latest chat session file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'asdftube-replay-gemini-'));
    process.env.HOME = homeDir;

    await writeGeminiSessionFile(
      homeDir,
      'older-project/chats/session-2026-04-15T10-26-older.json',
      JSON.stringify({
        sessionId: 'older',
        startTime: '2026-04-15T10:26:49.000Z',
        messages: [{ type: 'user', content: [{ text: 'older' }], timestamp: '2026-04-15T10:26:49.000Z' }]
      })
    );
    const latestPath = await writeGeminiSessionFile(
      homeDir,
      'latest-project/chats/session-2026-04-16T13-11-latest.json',
      JSON.stringify({
        sessionId: 'latest',
        startTime: '2026-04-16T13:11:09.000Z',
        messages: [
          { type: 'user', content: [{ text: 'hello' }], timestamp: '2026-04-16T13:11:09.000Z' },
          { type: 'gemini', content: 'world', timestamp: '2026-04-16T13:11:12.000Z', model: 'gemini-2.5-pro' }
        ]
      })
    );

    const selection = await resolveReplaySelection({
      provider: 'gemini',
      cwd: homeDir
    });

    expect(selection.inputPath).toBe(latestPath);
    expect(selection.outputPath).toContain('asdf-tube-gemini-2026-04-16t13-11-latest.mp4');
    expect(selection.title).toBe('Gemini replay: 2026-04-16T13-11-latest');
    expect(selection.warnings).toEqual(['No session selector provided. Defaulted to the latest Gemini session.']);
  });
});
