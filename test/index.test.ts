import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../src/index';

function createRuntime(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch, output: { out: string[]; err: string[] }) {
  return {
    env,
    fetchImpl,
    stdout: (line: string) => {
      output.out.push(line);
    },
    stderr: (line: string) => {
      output.err.push(line);
    },
    cwd: process.cwd()
  };
}

describe('@asdftube/cli', () => {
  it('does not default auth to a GitHub noreply email address', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-cli-auth-email-'));
    const configPath = join(tempDir, 'config.json');
    const output = { out: [] as string[], err: [] as string[] };

    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetch should not run when the guessed email is unusable');
    };

    const exitCode = await runCli(
      ['auth'],
      createRuntime(
        {
          ASDF_TUBE_CLI_CONFIG: configPath,
          GIT_AUTHOR_EMAIL: '14224835+waml@users.noreply.github.com'
        },
        fetchImpl,
        output
      )
    );

    expect(exitCode).toBe(1);
    expect(output.err.join('\n')).toContain('Email is required');
  });

  it('uploads a file through hosted multipart URLs and waits for the asset', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-cli-upload-'));
    const configPath = join(tempDir, 'config.json');
    const filePath = join(tempDir, 'input.mp4');
    const output = { out: [] as string[], err: [] as string[] };

    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        baseUrl: 'https://asdf.tube',
        apiKey: 'token',
        orgId: 'org_dev',
        userId: 'user_dev',
        username: 'demo',
        email: 'demo@example.com',
        orgSlug: 'dev-org',
        orgName: 'Dev Org'
      })
    );
    await writeFile(filePath, Buffer.from('abcdefghij'));

    const putBodies: number[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === 'https://asdf.tube/v1/uploads/initiate' && method === 'POST') {
        return new Response(
          JSON.stringify({
            uploadId: 'upload_1',
            assetId: 'asset_1',
            parts: [
              { partNumber: 1, uploadUrl: 'https://upload.local/part1' },
              { partNumber: 2, uploadUrl: 'https://upload.local/part2' }
            ]
          }),
          { status: 200 }
        );
      }

      if (url.startsWith('https://upload.local/') && method === 'PUT') {
        const size = Buffer.from(await (init?.body as Uint8Array).slice(0)).byteLength;
        putBodies.push(size);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (url === 'https://asdf.tube/v1/uploads/complete' && method === 'POST') {
        return new Response(JSON.stringify({ assetId: 'asset_1', duplicate: false, jobs: ['job_1'] }), { status: 200 });
      }

      if (url === 'https://asdf.tube/v1/assets/asset_1' && method === 'GET') {
        return new Response(
          JSON.stringify({
            asset: {
              id: 'asset_1',
              status: 'ready',
              mimeType: 'video/mp4',
              durationMs: 1_000,
              width: 1920,
              height: 1080
            }
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const exitCode = await runCli(['upload', filePath, '--wait', '--part-size-mb', '0.000005'], createRuntime(
      {
        ASDF_TUBE_CLI_CONFIG: configPath
      },
      fetchImpl,
      output
    ));

    expect(exitCode).toBe(0);
    expect(putBodies).toEqual([5, 5]);
    expect(JSON.parse(output.out.join('\n'))).toMatchObject({
      assetId: 'asset_1',
      status: 'ready'
    });
  });

  it('publishes a file, creates a default render, and prints the share URL', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-cli-publish-'));
    const configPath = join(tempDir, 'config.json');
    const filePath = join(tempDir, 'input.mp4');
    const output = { out: [] as string[], err: [] as string[] };
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];

    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        baseUrl: 'https://asdf.tube',
        apiKey: 'token',
        orgId: 'org_dev',
        userId: 'user_dev',
        username: 'demo',
        email: 'demo@example.com',
        orgSlug: 'dev-org',
        orgName: 'Dev Org'
      })
    );
    await writeFile(filePath, Buffer.from('abcdefghij'));

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let parsedBody: unknown;

      if (typeof init?.body === 'string') {
        parsedBody = JSON.parse(init.body);
      }

      requests.push({ url, method, body: parsedBody });

      if (url === 'https://asdf.tube/v1/uploads/initiate' && method === 'POST') {
        return new Response(
          JSON.stringify({
            uploadId: 'upload_1',
            assetId: 'asset_1',
            parts: [{ partNumber: 1, uploadUrl: 'https://upload.local/full' }]
          }),
          { status: 200 }
        );
      }

      if (url === 'https://upload.local/full' && method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (url === 'https://asdf.tube/v1/uploads/complete' && method === 'POST') {
        return new Response(JSON.stringify({ assetId: 'asset_1', duplicate: false, jobs: ['job_1'] }), { status: 200 });
      }

      if (url === 'https://asdf.tube/v1/assets/asset_1' && method === 'GET') {
        return new Response(
          JSON.stringify({
            asset: {
              id: 'asset_1',
              status: 'ready',
              mimeType: 'video/mp4',
              durationMs: 2_000,
              width: 1080,
              height: 1920
            }
          }),
          { status: 200 }
        );
      }

      if (url === 'https://asdf.tube/v1/renders' && method === 'POST') {
        return new Response(JSON.stringify({ renderId: 'render_1', jobId: 'job_render_1' }), { status: 200 });
      }

      if (url === 'https://asdf.tube/v1/renders/render_1' && method === 'GET') {
        return new Response(JSON.stringify({ id: 'render_1', status: 'ready', outputUrl: 'https://cdn/render.mp4' }), {
          status: 200
        });
      }

      if (url === 'https://asdf.tube/v1/renders/render_1/share' && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'share_1',
            renderId: 'render_1',
            username: 'demo',
            title: 'Demo video',
            url: 'https://asdf.tube/AbCdEfGhIj1',
            createdAt: '2026-01-01T00:00:00.000Z',
            revokeToken: 'sharetok_test',
            revokeUrl: 'https://api.asdf.tube/v1/public-shares/share_1/revoke-by-token'
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const exitCode = await runCli(['publish', filePath, '--title', 'Demo video'], createRuntime(
      {
        ASDF_TUBE_CLI_CONFIG: configPath
      },
      fetchImpl,
      output
    ));

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.out.join('\n'))).toMatchObject({
      assetId: 'asset_1',
      renderId: 'render_1',
      shareUrl: 'https://asdf.tube/AbCdEfGhIj1',
      revokeToken: 'sharetok_test'
    });

    const renderRequest = requests.find((request) => request.url === 'https://asdf.tube/v1/renders');
    expect(renderRequest?.body).toMatchObject({
      orgId: 'org_dev',
      spec: {
        canvas: {
          width: 1080,
          height: 1920
        },
        nodes: [
          { id: 'video_main', type: 'video', fit: 'contain' },
          { id: 'audio_main', type: 'audio' }
        ]
      }
    });
  });

  it('revokes a public share via scoped delete token', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-cli-share-delete-'));
    const configPath = join(tempDir, 'config.json');
    const output = { out: [] as string[], err: [] as string[] };

    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        baseUrl: 'https://asdf.tube',
        apiKey: 'token',
        orgId: 'org_dev',
        userId: 'user_dev',
        username: 'demo',
        email: 'demo@example.com',
        orgSlug: 'dev-org',
        orgName: 'Dev Org'
      })
    );

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === 'https://asdf.tube/v1/public-shares/share_1/revoke-by-token' && method === 'POST') {
        expect(init?.body).toBe(JSON.stringify({ token: 'sharetok_test' }));
        return new Response(
          JSON.stringify({
            id: 'share_1',
            renderId: 'render_1',
            username: 'demo',
            title: 'Demo video',
            url: 'https://asdf.tube/AbCdEfGhIj1',
            createdAt: '2026-01-01T00:00:00.000Z'
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const exitCode = await runCli(
      ['share', 'delete', 'share_1', '--token', 'sharetok_test'],
      createRuntime(
        {
          ASDF_TUBE_CLI_CONFIG: configPath
        },
        fetchImpl,
        output
      )
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.out.join('\n'))).toMatchObject({
      id: 'share_1'
    });
  });
});
