# @asdftube/cli

CLI for recording, reviewing, and publishing `asdf.tube` shares.

Boundary:

- This workspace is the public CLI only.
- Do not add proprietary API, worker, admin, auth, or backend source code to this workspace or any future public CLI repository.

Install:

```bash
npm install -g @asdftube/cli
```

Or run directly:

```bash
npx @asdftube/cli@latest help
```

## MCP install

Codex:

```bash
codex mcp add asdftube -- npx -y @asdftube/cli@latest mcp-server
```

Claude Code:

```bash
claude mcp add asdftube -- npx -y @asdftube/cli@latest mcp-server
```

OpenCode (`opencode.json` or `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "asdftube": {
      "type": "local",
      "command": ["npx", "-y", "@asdftube/cli@latest", "mcp-server"],
      "enabled": true
    }
  }
}
```

Gemini CLI (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "asdftube": {
      "command": "npx",
      "args": ["-y", "@asdftube/cli@latest", "mcp-server"]
    }
  }
}
```

Once installed, ask your agent to use the `asdftube` MCP tools to authenticate with your email, render locally for review, and only publish after you approve it.

The MCP surface now also exposes local prompt-driven editing through `asdftube_edit_video`, so the same agent can trim, blur, speed up, stitch, split, or add intro/audio layers without leaving the local machine.

Fastest replay flow from an agent CLI:

```bash
npx @asdftube/cli@latest auth
npx @asdftube/cli@latest replay codex latest --publish --yes
```

`asdftube auth` sends a magic link and PIN to your email, then stores an expiring local session. No password or separate signup/login command is required.

Core commands:

```bash
asdftube auth
asdftube upload ./recording.mp4 --wait
asdftube publish ./recording.mp4 --title "Demo walkthrough"
asdftube record terminal --cmd "seq 1 10" --text-size standard --publish --title "Terminal demo"
asdftube record desktop --seconds 10 --publish --title "Desktop capture"
asdftube record windows
asdftube record window --window-id 184 --seconds 10 --publish --title "Window capture"
asdftube edit video ./demo.mp4 --prompt "crop out the first 15 seconds of the video"
asdftube edit video ./demo.mp4 --prompt "speed up video 3x from 0:30 to 0:50"
asdftube edit video ./demo.mp4 --prompt "blur out 0:55 to 1:10 while I type something sensitive"
asdftube edit video ./demo.mp4 --asset ./intro.mp3 --prompt "add this mp3 to the clip, fade out intro showing a centered text \"Hello World\""
asdftube edit video ./demo.mp4 --asset ./clip-2.mp4,./clip-3.mp4 --prompt "stitch together different clips together"
asdftube edit video ./demo.mp4 --prompt "split 0:00-0:15 and 0:30-0:45 into separate files"
asdftube replay codex latest --review-only --text-size standard
asdftube replay codex latest --review-only --redactions 'acme|internal-only|staging-secret=>[REDACTED_TERM]'
asdftube replay codex 019d97eb-3dbc-70c2-ac2b-dfad275f98c6 --publish --yes
asdftube replay codex "cybercafe.party" --publish --yes
asdftube replay claude --input ./claude-export.jsonl --publish --yes --title "Claude replay"
asdftube replay gemini latest --review-only
asdftube replay gemini --input ./gemini-session.json --publish --yes --title "Gemini replay"
asdftube replay opencode --input ./opencode-export.jsonl --publish --yes --title "OpenCode replay"
asdftube share list
asdftube share delete SHARE_ID --token sharetok_xxx
asdftube report list
```

Default command output is human-readable. Add `--json` when you need structured output for scripts or automation.

Video text sizing uses fixed presets instead of arbitrary numbers:

- `compact`
- `standard` (default)
- `large`

MCP entrypoint:

```bash
asdftube mcp-server
```

Prompt editing notes:

- `edit video` is local-first and ffmpeg-backed.
- The parser currently supports:
  - remove the first N seconds
  - remove a range
  - speed up a range
  - blur a range
  - add centered intro text with fade-out
  - mix or replace audio with an extra track
  - stitch in extra clips passed via `--asset`
  - split explicit ranges into separate output files
- Automatic large-cursor and click-ring effects are not implemented yet because the current capture path does not record pointer telemetry.

Custom replay redactions:

```bash
# Case-insensitive word list. The fallback syntax defaults to /gi/.
asdftube replay codex latest --review-only --redactions 'acme|internal-only|staging-secret=>[REDACTED_TERM]'

# Multiple rules in one flag.
asdftube replay codex latest --review-only --redactions 'acme|internal-only=>[REDACTED_TERM]||CF-[0-9]{4,}=>[REDACTED_TICKET]'

# JSON form when you need explicit flags.
asdftube replay gemini latest --review-only --redactions '[{"name":"terms","pattern":"acme|internal-only|staging-secret","replacement":"[REDACTED_TERM]","flags":"gi"}]'
```

Environment fallbacks:

- `ASDF_TUBE_BASE_URL`
- `ASDF_TUBE_API_KEY`
- `ASDF_TUBE_ORG_ID`
- `ASDF_TUBE_CLI_CONFIG`

Local build:

```bash
pnpm --filter @asdftube/cli build
cd packages/cli && npm pack
```

Smoke the installed binary from the packed tarball:

```bash
tmpdir=$(mktemp -d)
npm install -g --prefix "$tmpdir" packages/cli/asdftube-cli-*.tgz
"$tmpdir/bin/asdftube" help
```

Notes:

- Replay rendering and redaction happen locally before publish.
- Review `*.review.json` and `*.txt` replay artifacts before uploading the final MP4.
- Desktop/window capture on macOS requires Screen Recording permission for the terminal app running `asdftube`.
- `ffmpeg` and `ffprobe` must be available on your PATH for replay rendering and capture packaging.
- `gitleaks` is optional but recommended for stronger local secret scanning during replay redaction.

License:

- AGPL-3.0-only
