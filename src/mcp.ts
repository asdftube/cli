import type {
  CapturedCliExecution,
  CliRuntime,
  StoredConfig
} from './index';
import {
  clearConfig,
  executeCliCommand,
  getConfigPath,
  guessDefaultEmail,
  loadConfig,
  normalizeBaseUrl,
  requestJson,
  saveConfig
} from './index';

const DEFAULT_BASE_URL = 'https://api.asdftube.com';

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

type RequiredRuntime = Required<CliRuntime>;

function createJsonResult(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
} {
  const structuredContent =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ],
    ...(structuredContent ? { structuredContent } : {})
  };
}

function summarizeCliFailure(execution: CapturedCliExecution): string {
  return [...execution.stderr, ...execution.stdout].join('\n').trim() || `CLI exited with status ${execution.exitCode}`;
}

function appendStringOption(args: string[], key: string, value: string | undefined): void {
  if (!value) {
    return;
  }

  args.push(`--${key}`, value);
}

function appendBooleanOption(args: string[], key: string, value: boolean | undefined): void {
  if (value === true) {
    args.push(`--${key}`);
  }

  if (value === false) {
    args.push(`--no-${key}`);
  }
}

async function resolveStoredConfig(
  runtime: RequiredRuntime,
  overrides?: { baseUrl?: string; apiKey?: string; orgId?: string }
): Promise<StoredConfig> {
  const stored = await loadConfig(getConfigPath(runtime.env));
  const baseUrl = normalizeBaseUrl(
    overrides?.baseUrl ?? runtime.env.ASDF_TUBE_BASE_URL ?? stored?.baseUrl ?? DEFAULT_BASE_URL
  );
  const apiKey = overrides?.apiKey ?? runtime.env.ASDF_TUBE_API_KEY ?? stored?.apiKey;
  const orgId = overrides?.orgId ?? runtime.env.ASDF_TUBE_ORG_ID ?? stored?.orgId;

  if (!apiKey || !orgId) {
    throw new Error('Missing auth context. Authenticate with asdftube_auth_start/asdftube_auth_complete first.');
  }

  if (stored?.apiKeyExpiresAt && stored.apiKeyExpiresAt <= new Date().toISOString()) {
    throw new Error('Stored auth session has expired. Authenticate again.');
  }

  return {
    version: 1,
    baseUrl,
    apiKey,
    apiKeyExpiresAt: stored?.apiKeyExpiresAt ?? null,
    orgId,
    userId: stored?.userId ?? 'unknown',
    username: stored?.username ?? 'unknown',
    email: stored?.email ?? 'unknown',
    orgSlug: stored?.orgSlug ?? 'unknown',
    orgName: stored?.orgName ?? 'unknown'
  };
}

async function runJsonCli<TValue>(
  runtime: RequiredRuntime,
  args: string[]
): Promise<TValue> {
  const execution = await executeCliCommand<TValue>(args, runtime);

  if (execution.exitCode !== 0) {
    throw new Error(summarizeCliFailure(execution));
  }

  if (execution.json == null) {
    throw new Error(`Command did not return JSON: ${args.join(' ')}`);
  }

  return execution.json;
}

export async function startMcpServer(runtime: RequiredRuntime): Promise<void> {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('zod')
  ]);

  const server = new McpServer({
    name: 'asdf.tube',
    version: '0.3.0'
  });

  server.tool(
    'asdftube_auth_start',
    'Use this when you need to start asdf.tube email authentication and send the magic link or PIN challenge to the user.',
    {
      email: z.string().email().optional(),
      baseUrl: z.string().url().optional()
    },
    async ({ email, baseUrl }: { email?: string; baseUrl?: string }) => {
      const configPath = getConfigPath(runtime.env);
      const existing = await loadConfig(configPath);
      const resolvedBaseUrl = normalizeBaseUrl(baseUrl ?? runtime.env.ASDF_TUBE_BASE_URL ?? existing?.baseUrl ?? DEFAULT_BASE_URL);
      const resolvedEmail = email ?? (await guessDefaultEmail(runtime.cwd, existing?.email));

      if (!resolvedEmail) {
        throw new Error('Email is required. Pass it to asdftube_auth_start.');
      }

      const challenge = await requestJson<StartEmailAuthResponse>(
        runtime,
        'POST',
        `${resolvedBaseUrl}/v1/auth/email/start`,
        undefined,
        { email: resolvedEmail }
      );

      return createJsonResult({
        baseUrl: resolvedBaseUrl,
        challengeId: challenge.challengeId,
        exchangeToken: challenge.exchangeToken,
        email: challenge.email,
        maskedEmail: challenge.maskedEmail,
        expiresAt: challenge.expiresAt,
        pollAfterSeconds: challenge.pollAfterSeconds,
        nextStep:
          'Ask the user to click the magic link or provide the PIN, then call asdftube_auth_complete with challengeId, exchangeToken, and optionally pin.'
      });
    }
  );

  server.tool(
    'asdftube_auth_status',
    'Use this when you need to poll the current state of an asdf.tube email authentication challenge.',
    {
      challengeId: z.string().min(1),
      baseUrl: z.string().url().optional()
    },
    async ({ challengeId, baseUrl }: { challengeId: string; baseUrl?: string }) => {
      const existing = await loadConfig(getConfigPath(runtime.env));
      const resolvedBaseUrl = normalizeBaseUrl(baseUrl ?? runtime.env.ASDF_TUBE_BASE_URL ?? existing?.baseUrl ?? DEFAULT_BASE_URL);
      const status = await requestJson<EmailAuthChallengeStatusResponse>(
        runtime,
        'GET',
        `${resolvedBaseUrl}/v1/auth/email/challenges/${encodeURIComponent(challengeId)}`
      );

      return createJsonResult(status);
    }
  );

  server.tool(
    'asdftube_auth_complete',
    'Use this when the user has clicked the magic link or given you the PIN and you need to finish authentication.',
    {
      challengeId: z.string().min(1),
      exchangeToken: z.string().min(1),
      pin: z.string().min(1).optional(),
      baseUrl: z.string().url().optional()
    },
    async ({
      challengeId,
      exchangeToken,
      pin,
      baseUrl
    }: {
      challengeId: string;
      exchangeToken: string;
      pin?: string;
      baseUrl?: string;
    }) => {
      const configPath = getConfigPath(runtime.env);
      const existing = await loadConfig(configPath);
      const resolvedBaseUrl = normalizeBaseUrl(baseUrl ?? runtime.env.ASDF_TUBE_BASE_URL ?? existing?.baseUrl ?? DEFAULT_BASE_URL);
      const response = await requestJson<AuthResponse>(
        runtime,
        'POST',
        `${resolvedBaseUrl}/v1/auth/email/complete`,
        undefined,
        {
          challengeId,
          exchangeToken,
          ...(pin ? { pin } : {})
        }
      );

      const stored: StoredConfig = {
        version: 1,
        baseUrl: resolvedBaseUrl,
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

      return createJsonResult({
        saved: true,
        configPath,
        org: response.org,
        user: response.user,
        apiKeyExpiresAt: response.apiKey.expiresAt
      });
    }
  );

  server.tool('asdftube_auth_whoami', 'Use this when you need the current stored asdf.tube auth identity.', {}, async () => {
    const configPath = getConfigPath(runtime.env);
    const config = await loadConfig(configPath);

    if (!config) {
      throw new Error('No stored auth config found.');
    }

    return createJsonResult({
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
  });

  server.tool('asdftube_auth_logout', 'Use this when you need to clear the locally stored asdf.tube auth session.', {}, async () => {
    const configPath = getConfigPath(runtime.env);
    await clearConfig(configPath);

    return createJsonResult({
      cleared: true,
      configPath
    });
  });

  server.tool(
    'asdftube_publish_file',
    'Use this when you already have a local media file and want to upload and publish it as an asdf.tube share.',
    {
      path: z.string().min(1),
      title: z.string().min(1).optional(),
      preset: z.enum(['auto', 'landscape_hd', 'square_social', 'story_portrait']).optional(),
      watermark: z.boolean().optional()
    },
    async ({
      path,
      title,
      preset,
      watermark
    }: {
      path: string;
      title?: string;
      preset?: 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait';
      watermark?: boolean;
    }) => {
      await resolveStoredConfig(runtime);
      const args = ['publish', path];
      appendStringOption(args, 'title', title);
      appendStringOption(args, 'preset', preset);
      appendBooleanOption(args, 'watermark', watermark);

      return createJsonResult(await runJsonCli(runtime, args));
    }
  );

  server.tool(
    'asdftube_record_terminal',
    'Use this when you want to record a terminal command or synthetic terminal session and optionally publish it.',
    {
      cmd: z.string().optional(),
      output: z.string().optional(),
      prompt: z.string().optional(),
      publish: z.boolean().optional(),
      title: z.string().optional(),
      preset: z.enum(['auto', 'landscape_hd', 'square_social', 'story_portrait']).optional(),
      watermark: z.boolean().optional()
    },
    async (input: {
      cmd?: string;
      output?: string;
      prompt?: string;
      publish?: boolean;
      title?: string;
      preset?: 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait';
      watermark?: boolean;
    }) => {
      if (input.publish) {
        await resolveStoredConfig(runtime);
      }

      const args = ['record', 'terminal'];
      appendStringOption(args, 'cmd', input.cmd);
      appendStringOption(args, 'output', input.output);
      appendStringOption(args, 'prompt', input.prompt);
      appendBooleanOption(args, 'publish', input.publish);
      appendStringOption(args, 'title', input.title);
      appendStringOption(args, 'preset', input.preset);
      appendBooleanOption(args, 'watermark', input.watermark);

      return createJsonResult(await runJsonCli(runtime, args));
    }
  );

  server.tool(
    'asdftube_record_desktop',
    'Use this when you want to capture the full desktop for a short duration and optionally publish it.',
    {
      seconds: z.number().positive().optional(),
      display: z.number().int().positive().optional(),
      output: z.string().optional(),
      publish: z.boolean().optional(),
      title: z.string().optional(),
      preset: z.enum(['auto', 'landscape_hd', 'square_social', 'story_portrait']).optional(),
      watermark: z.boolean().optional()
    },
    async (input: {
      seconds?: number;
      display?: number;
      output?: string;
      publish?: boolean;
      title?: string;
      preset?: 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait';
      watermark?: boolean;
    }) => {
      if (input.publish) {
        await resolveStoredConfig(runtime);
      }

      const args = ['record', 'desktop'];
      appendStringOption(args, 'seconds', input.seconds?.toString());
      appendStringOption(args, 'display', input.display?.toString());
      appendStringOption(args, 'output', input.output);
      appendBooleanOption(args, 'publish', input.publish);
      appendStringOption(args, 'title', input.title);
      appendStringOption(args, 'preset', input.preset);
      appendBooleanOption(args, 'watermark', input.watermark);

      return createJsonResult(await runJsonCli(runtime, args));
    }
  );

  server.tool(
    'asdftube_list_windows',
    'Use this when you need to inspect capturable windows before recording a specific app window.',
    {},
    async () => createJsonResult(await runJsonCli(runtime, ['record', 'windows']))
  );

  server.tool(
    'asdftube_record_window',
    'Use this when you want to capture one specific app window and optionally publish it.',
    {
      windowId: z.number().int().positive().optional(),
      app: z.string().optional(),
      titleContains: z.string().optional(),
      seconds: z.number().positive().optional(),
      output: z.string().optional(),
      publish: z.boolean().optional(),
      title: z.string().optional(),
      preset: z.enum(['auto', 'landscape_hd', 'square_social', 'story_portrait']).optional(),
      watermark: z.boolean().optional()
    },
    async (input: {
      windowId?: number;
      app?: string;
      titleContains?: string;
      seconds?: number;
      output?: string;
      publish?: boolean;
      title?: string;
      preset?: 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait';
      watermark?: boolean;
    }) => {
      if (input.publish) {
        await resolveStoredConfig(runtime);
      }

      const args = ['record', 'window'];
      appendStringOption(args, 'window-id', input.windowId?.toString());
      appendStringOption(args, 'app', input.app);
      appendStringOption(args, 'title-contains', input.titleContains);
      appendStringOption(args, 'seconds', input.seconds?.toString());
      appendStringOption(args, 'output', input.output);
      appendBooleanOption(args, 'publish', input.publish);
      appendStringOption(args, 'title', input.title);
      appendStringOption(args, 'preset', input.preset);
      appendBooleanOption(args, 'watermark', input.watermark);

      return createJsonResult(await runJsonCli(runtime, args));
    }
  );

  server.tool(
    'asdftube_edit_video',
    'Use this when you want to apply natural-language local video edits such as trim, speed changes, blur windows, intro text, audio overlays, stitches, or splits, and optionally publish the result.',
    {
      source: z.string().min(1),
      prompt: z.string().min(1),
      assets: z.array(z.string().min(1)).optional(),
      output: z.string().optional(),
      publish: z.boolean().optional(),
      title: z.string().optional(),
      preset: z.enum(['auto', 'landscape_hd', 'square_social', 'story_portrait']).optional(),
      watermark: z.boolean().optional()
    },
    async (input: {
      source: string;
      prompt: string;
      assets?: string[];
      output?: string;
      publish?: boolean;
      title?: string;
      preset?: 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait';
      watermark?: boolean;
    }) => {
      if (input.publish) {
        await resolveStoredConfig(runtime);
      }

      const args = ['edit', 'video', input.source, '--prompt', input.prompt];
      appendStringOption(args, 'output', input.output);
      appendBooleanOption(args, 'publish', input.publish);
      appendStringOption(args, 'title', input.title);
      appendStringOption(args, 'preset', input.preset);
      appendBooleanOption(args, 'watermark', input.watermark);

      if (input.assets && input.assets.length > 0) {
        appendStringOption(args, 'asset', input.assets.join(','));
      }

      return createJsonResult(await runJsonCli(runtime, args));
    }
  );

  server.tool(
    'asdftube_replay_session',
    'Use this when you want to render a Codex, Claude, OpenCode, or Gemini session locally for review and optionally publish it after approval.',
    {
      provider: z.enum(['codex', 'claude', 'opencode', 'gemini']),
      selector: z.string().optional(),
      input: z.string().optional(),
      output: z.string().optional(),
      title: z.string().optional(),
      reviewOnly: z.boolean().optional(),
      publish: z.boolean().optional(),
      yes: z.boolean().optional(),
      query: z.string().optional(),
      redactions: z.string().optional(),
      includeToolCalls: z.boolean().optional(),
      includeToolArgs: z.boolean().optional(),
      includeToolOutput: z.boolean().optional(),
      preset: z.enum(['auto', 'landscape_hd', 'square_social', 'story_portrait']).optional(),
      watermark: z.boolean().optional()
    },
    async (input: {
      provider: 'codex' | 'claude' | 'opencode' | 'gemini';
      selector?: string;
      input?: string;
      output?: string;
      title?: string;
      reviewOnly?: boolean;
      publish?: boolean;
      yes?: boolean;
      query?: string;
      redactions?: string;
      includeToolCalls?: boolean;
      includeToolArgs?: boolean;
      includeToolOutput?: boolean;
      preset?: 'auto' | 'landscape_hd' | 'square_social' | 'story_portrait';
      watermark?: boolean;
    }) => {
      if (input.publish && input.yes !== true) {
        throw new Error('Publishing a replay through MCP requires yes=true. Render locally first, then publish only after explicit approval.');
      }

      if (input.publish) {
        await resolveStoredConfig(runtime);
      }

      const args = ['replay', input.provider];

      if (input.selector) {
        args.push(input.selector);
      }

      appendStringOption(args, 'input', input.input);
      appendStringOption(args, 'output', input.output);
      appendStringOption(args, 'title', input.title);
      appendBooleanOption(args, 'review-only', input.reviewOnly);
      appendBooleanOption(args, 'publish', input.publish);
      appendBooleanOption(args, 'yes', input.yes);
      appendStringOption(args, 'query', input.query);
      appendStringOption(args, 'redactions', input.redactions);
      appendBooleanOption(args, 'include-tool-calls', input.includeToolCalls);
      appendBooleanOption(args, 'include-tool-args', input.includeToolArgs);
      appendBooleanOption(args, 'include-tool-output', input.includeToolOutput);
      appendStringOption(args, 'preset', input.preset);
      appendBooleanOption(args, 'watermark', input.watermark);

      const result = await runJsonCli<Record<string, unknown>>(runtime, args);

      return createJsonResult({
        ...result,
        localReviewHint:
          input.publish === true
            ? 'Replay published.'
            : 'Review reviewPath, transcriptPath, and outputPath before calling this tool again with publish=true and yes=true.'
      });
    }
  );

  server.tool(
    'asdftube_share_delete',
    'Use this when you need to revoke and delete a public asdf.tube share using its scoped revoke token.',
    {
      shareId: z.string().min(1),
      token: z.string().min(1)
    },
    async ({ shareId, token }: { shareId: string; token: string }) => {
      return createJsonResult(await runJsonCli(runtime, ['share', 'delete', shareId, '--token', token]));
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
