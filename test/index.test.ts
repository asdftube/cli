import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildDefaultRenderSpec, runCli } from '../src/index';
import { resolveReplayTextMetrics, resolveTerminalTextMetrics } from '../src/text-size';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

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
  it('does not emit a default audio node for silent assets', () => {
    const spec = buildDefaultRenderSpec(
      {
        asset: {
          id: 'asset_silent',
          status: 'ready',
          mimeType: 'video/mp4',
          durationMs: 3_000,
          width: 1706,
          height: 1162,
          audioCodec: null
        }
      },
      'landscape_hd'
    );

    expect(spec.nodes).toHaveLength(1);
    expect(spec.nodes[0]).toMatchObject({
      id: 'video_main',
      type: 'video',
      assetId: 'asset_silent'
    });
  });

  it('documents replay custom redactions in the CLI usage output', async () => {
    const output = { out: [] as string[], err: [] as string[] };

    const exitCode = await runCli(
      ['help'],
      createRuntime(process.env, async () => {
        throw new Error('fetch should not run for help');
      }, output)
    );

    expect(exitCode).toBe(0);
    expect(output.out.join('\n')).toContain('--redactions <rules>');
    expect(output.out.join('\n')).toContain('--text-size compact|standard|large');
    expect(output.out.join('\n')).toContain('asdftube edit video <file>');
  });

  it('uses a larger default standard text size preset for rendered videos', () => {
    expect(resolveReplayTextMetrics('standard')).toMatchObject({
      bodyFontSize: 15,
      leadFontSize: 15
    });
    expect(resolveTerminalTextMetrics('standard')).toMatchObject({
      fontSize: 38,
      lineHeight: 47
    });
  });

  it('exposes MCP auth tools over stdio and persists auth state', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-cli-mcp-'));
    const configPath = join(tempDir, 'config.json');
    const server = createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/v1/auth/email/start') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            challengeId: 'challenge_1',
            exchangeToken: 'exchange_1',
            email: 'demo@example.com',
            maskedEmail: 'de**@example.com',
            expiresAt: '2099-01-01T00:00:00.000Z',
            pollAfterSeconds: 1
          })
        );
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/auth/email/complete') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            org: {
              id: 'org_dev',
              slug: 'dev-org',
              name: 'Dev Org'
            },
            user: {
              id: 'user_dev',
              username: 'demo',
              email: 'demo@example.com',
              name: 'Demo User'
            },
            apiKey: {
              id: 'key_dev',
              token: 'token',
              expiresAt: null
            }
          })
        );
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.listen(0, '127.0.0.1', () => resolvePromise());
      server.once('error', rejectPromise);
    });

    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral TCP address for the auth test server');
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js')
      ]);
      const tsxCli = require.resolve('tsx').replace(/loader\.mjs$/, 'cli.mjs');
      const client = new Client({
        name: 'asdftube-cli-test-client',
        version: '0.1.0'
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [tsxCli, join(process.cwd(), 'src/cli.ts'), 'mcp-server'],
        env: {
          ...process.env,
          ASDF_TUBE_CLI_CONFIG: configPath,
          ASDF_TUBE_BASE_URL: baseUrl
        }
      });

      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'asdftube_auth_start')).toBe(true);
      expect(tools.tools.some((tool) => tool.name === 'asdftube_replay_session')).toBe(true);
      expect(tools.tools.some((tool) => tool.name === 'asdftube_edit_video')).toBe(true);

      const startResult = await client.callTool({
        name: 'asdftube_auth_start',
        arguments: {
          email: 'demo@example.com'
        }
      });
      const startPayload = JSON.parse((startResult.content?.[0] as { text: string }).text) as {
        challengeId: string;
        exchangeToken: string;
      };

      expect(startPayload.challengeId).toBe('challenge_1');

      await client.callTool({
        name: 'asdftube_auth_complete',
        arguments: {
          challengeId: startPayload.challengeId,
          exchangeToken: startPayload.exchangeToken
        }
      });

      const whoamiResult = await client.callTool({
        name: 'asdftube_auth_whoami',
        arguments: {}
      });
      const whoamiPayload = JSON.parse((whoamiResult.content?.[0] as { text: string }).text) as {
        username: string;
        email: string;
      };

      expect(whoamiPayload).toMatchObject({
        username: 'demo',
        email: 'demo@example.com'
      });

      await client.close();
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }

          resolvePromise();
        });
      });
    }
  });

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
        return jsonResponse({
          uploadId: 'upload_1',
          assetId: 'asset_1',
          parts: [
            { partNumber: 1, uploadUrl: 'https://upload.local/part1' },
            { partNumber: 2, uploadUrl: 'https://upload.local/part2' }
          ]
        });
      }

      if (url.startsWith('https://upload.local/') && method === 'PUT') {
        const size = Buffer.from(await (init?.body as Uint8Array).slice(0)).byteLength;
        putBodies.push(size);
        return jsonResponse({ ok: true });
      }

      if (url === 'https://asdf.tube/v1/uploads/complete' && method === 'POST') {
        return jsonResponse({ assetId: 'asset_1', duplicate: false, jobs: ['job_1'] });
      }

      if (url === 'https://asdf.tube/v1/assets/asset_1' && method === 'GET') {
        return jsonResponse({
          asset: {
            id: 'asset_1',
            status: 'ready',
            mimeType: 'video/mp4',
            durationMs: 1_000,
            width: 1920,
            height: 1080
          }
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const exitCode = await runCli(['upload', filePath, '--wait', '--part-size-mb', '0.000005', '--json'], createRuntime(
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
        return jsonResponse({
          uploadId: 'upload_1',
          assetId: 'asset_1',
          parts: [{ partNumber: 1, uploadUrl: 'https://upload.local/full' }]
        });
      }

      if (url === 'https://upload.local/full' && method === 'PUT') {
        return jsonResponse({ ok: true });
      }

      if (url === 'https://asdf.tube/v1/uploads/complete' && method === 'POST') {
        return jsonResponse({ assetId: 'asset_1', duplicate: false, jobs: ['job_1'] });
      }

      if (url === 'https://asdf.tube/v1/assets/asset_1' && method === 'GET') {
        return jsonResponse({
          asset: {
            id: 'asset_1',
            status: 'ready',
            mimeType: 'video/mp4',
            durationMs: 2_000,
            width: 1080,
            height: 1920
          }
        });
      }

      if (url === 'https://asdf.tube/v1/renders' && method === 'POST') {
        return jsonResponse({ renderId: 'render_1', jobId: 'job_render_1' });
      }

      if (url === 'https://asdf.tube/v1/renders/render_1' && method === 'GET') {
        return jsonResponse({ id: 'render_1', status: 'ready', outputUrl: 'https://cdn/render.mp4' });
      }

      if (url === 'https://asdf.tube/v1/renders/render_1/share' && method === 'POST') {
        return jsonResponse({
          id: 'share_1',
          renderId: 'render_1',
          username: 'demo',
          title: 'Demo video',
          url: 'https://asdf.tube/AbCdEfGhIj1',
          createdAt: '2026-01-01T00:00:00.000Z',
          revokeToken: 'sharetok_test',
          revokeUrl: 'https://api.asdf.tube/v1/public-shares/share_1/revoke-by-token'
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const exitCode = await runCli(['publish', filePath, '--title', 'Demo video', '--json'], createRuntime(
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
      revokeToken: 'sharetok_test',
      deleteCommand: 'npx -y @asdftube/cli@latest share delete share_1 --token sharetok_test'
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
          { id: 'video_main', type: 'video', fit: 'contain' }
        ]
      }
    });
    expect(renderRequest?.body.spec.nodes).toHaveLength(1);
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
        return jsonResponse({
          id: 'share_1',
          renderId: 'render_1',
          username: 'demo',
          title: 'Demo video',
          url: 'https://asdf.tube/AbCdEfGhIj1',
          createdAt: '2026-01-01T00:00:00.000Z'
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const exitCode = await runCli(
      ['share', 'delete', 'share_1', '--token', 'sharetok_test', '--json'],
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

  it('prints a friendly publish summary by default', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'asdftube-cli-publish-human-'));
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

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === 'https://asdf.tube/v1/uploads/initiate' && method === 'POST') {
        return jsonResponse({
          uploadId: 'upload_1',
          assetId: 'asset_1',
          parts: [{ partNumber: 1, uploadUrl: 'https://upload.local/full' }]
        });
      }

      if (url === 'https://upload.local/full' && method === 'PUT') {
        return jsonResponse({ ok: true });
      }

      if (url === 'https://asdf.tube/v1/uploads/complete' && method === 'POST') {
        return jsonResponse({ assetId: 'asset_1', duplicate: false, jobs: ['job_1'] });
      }

      if (url === 'https://asdf.tube/v1/assets/asset_1' && method === 'GET') {
        return jsonResponse({
          asset: {
            id: 'asset_1',
            status: 'ready',
            mimeType: 'video/mp4',
            durationMs: 2_000,
            width: 1080,
            height: 1920
          }
        });
      }

      if (url === 'https://asdf.tube/v1/renders' && method === 'POST') {
        return jsonResponse({ renderId: 'render_1', jobId: 'job_render_1' });
      }

      if (url === 'https://asdf.tube/v1/renders/render_1' && method === 'GET') {
        return jsonResponse({ id: 'render_1', status: 'ready', outputUrl: 'https://cdn/render.mp4' });
      }

      if (url === 'https://asdf.tube/v1/renders/render_1/share' && method === 'POST') {
        return jsonResponse({
          id: 'share_1',
          renderId: 'render_1',
          username: 'demo',
          title: 'Demo video',
          url: 'https://asdf.tube/AbCdEfGhIj1',
          createdAt: '2026-01-01T00:00:00.000Z',
          revokeToken: 'sharetok_test'
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const exitCode = await runCli(
      ['publish', filePath, '--title', 'Demo video'],
      createRuntime(
        {
          ASDF_TUBE_CLI_CONFIG: configPath
        },
        fetchImpl,
        output
      )
    );

    expect(exitCode).toBe(0);
    expect(output.out.join('\n')).toContain('Published');
    expect(output.out.join('\n')).toContain('Share URL: https://asdf.tube/AbCdEfGhIj1');
    expect(output.out.join('\n')).toContain(
      'Delete: npx -y @asdftube/cli@latest share delete share_1 --token sharetok_test'
    );
  });
});
