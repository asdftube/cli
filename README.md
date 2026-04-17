# @asdftube/cli

Local-first CLI for `asdf.tube`.

Install:

```bash
npm install -g @asdftube/cli
```

Or run directly:

```bash
npx @asdftube/cli@latest help
```

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
asdftube record terminal --cmd "seq 1 10" --publish --title "Terminal demo"
asdftube record desktop --seconds 10 --publish --title "Desktop capture"
asdftube record windows
asdftube record window --window-id 184 --seconds 10 --publish --title "Window capture"
asdftube replay codex latest --review-only
asdftube replay codex 019d97eb-3dbc-70c2-ac2b-dfad275f98c6 --publish --yes
asdftube replay codex "cybercafe.party" --publish --yes
asdftube replay claude --input ./claude-export.jsonl --publish --yes --title "Claude replay"
asdftube replay opencode --input ./opencode-export.jsonl --publish --yes --title "OpenCode replay"
asdftube share list
asdftube share delete SHARE_ID --token sharetok_xxx
asdftube report list
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

- Apache-2.0
