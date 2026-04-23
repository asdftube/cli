import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { editVideoFromPrompt, parseEditPrompt } from '../src/edit';

const execFile = promisify(execFileCallback);

async function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  await execFile(command, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024
  });
}

async function makeVideo(path: string, color: string, seconds: number, withAudio = true): Promise<void> {
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=640x360:d=${seconds.toFixed(3)}:r=30`
  ];

  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${seconds.toFixed(3)}`);
  }

  args.push(
    '-map',
    '0:v:0',
    '-map',
    withAudio ? '1:a:0' : '0:a:0?',
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
    path
  );

  await runCommand('ffmpeg', args, process.cwd());
}

async function makeAudio(path: string, seconds: number): Promise<void> {
  await runCommand(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds.toFixed(3)}`,
      '-c:a',
      'libmp3lame',
      path
    ],
    process.cwd()
  );
}

async function probeDuration(path: string): Promise<number> {
  const { stdout } = await execFile('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path
  ]);

  return Number(stdout.trim());
}

async function probeAudioCodec(path: string): Promise<string | null> {
  const { stdout } = await execFile('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path
  ]);

  const value = stdout.trim();
  return value ? value : null;
}

describe('prompt video editor', () => {
  it('parses the core natural-language editing intents', () => {
    const parsed = parseEditPrompt(
      process.cwd(),
      'crop out the first 15 seconds of the video, speed up video 3x from 0:30 to 0:50, blur out 0:55 to 1:10, fade out intro showing a centered text "Hello World", add this mp3 to the clip, stitch together different clips together, split 0:00-0:15 and 0:30-0:45',
      ['/tmp/music.mp3', '/tmp/clip-2.mp4']
    );

    expect(parsed.operations.map((operation) => operation.kind)).toEqual([
      'trim_start',
      'speed_range',
      'blur_range',
      'intro_title',
      'audio_track',
      'stitch',
      'split'
    ]);
  });

  it(
    'can execute trim, speed, blur, intro text, and audio mix locally',
    async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-edit-smoke-'));
    const inputPath = join(tempDir, 'input.mp4');
    const audioPath = join(tempDir, 'music.mp3');
    const outputPath = join(tempDir, 'edited.mp4');

    await makeVideo(inputPath, 'navy', 4, true);
    await makeAudio(audioPath, 4);

    const result = await editVideoFromPrompt({
      cwd: tempDir,
      sourcePath: inputPath,
      prompt:
        'crop out the first 1 second of the video, speed up video 2x from 0:01 to 0:02, blur out 0:00 to 0:00.5, fade out intro showing a centered text "Hello World", add this mp3 to the clip',
      outputPath,
      assetPaths: [audioPath]
    });

    expect(result.outputPath).toBe(outputPath);
    expect(result.outputPaths).toEqual([outputPath]);
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
    expect(await probeDuration(outputPath)).toBeGreaterThan(1.2);
    expect(await probeDuration(outputPath)).toBeLessThan(3.5);
    expect(await probeAudioCodec(outputPath)).toBeTruthy();
    },
    20_000
  );

  it(
    'can stitch clips and split a final file into separate outputs',
    async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-edit-stitch-'));
    const firstPath = join(tempDir, 'first.mp4');
    const secondPath = join(tempDir, 'second.mp4');
    const stitchedPath = join(tempDir, 'stitched.mp4');
    const splitBasePath = join(tempDir, 'split.mp4');

    await makeVideo(firstPath, 'red', 1.2, true);
    await makeVideo(secondPath, 'blue', 1.2, false);

    const stitched = await editVideoFromPrompt({
      cwd: tempDir,
      sourcePath: firstPath,
      prompt: 'stitch together different clips together',
      outputPath: stitchedPath,
      assetPaths: [secondPath]
    });

    expect(stitched.outputPath).toBe(stitchedPath);
    expect(await probeDuration(stitchedPath)).toBeGreaterThan(2);

    const split = await editVideoFromPrompt({
      cwd: tempDir,
      sourcePath: stitchedPath,
      prompt: 'split 0:00 to 0:00.8 and 0:01 to 0:01.6 into separate files',
      outputPath: splitBasePath
    });

    expect(split.outputPaths).toHaveLength(2);
    expect((await stat(split.outputPaths[0]!)).size).toBeGreaterThan(0);
    expect((await stat(split.outputPaths[1]!)).size).toBeGreaterThan(0);
    },
    20_000
  );
});
