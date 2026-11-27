# Xenon Writing desktop

An Electron desktop client for Xenon Writing, a voice-to-writing assistant. You type or record a transcript, add optional steering, and get a rewritten draft that you review and copy yourself. It targets macOS on Apple silicon, macOS 15 or later.

**Status: early and unreleased.** By default the app is fully offline: rewrites and transcription use synthetic fixture routes inside the app. One optional route sends rewrites to a model server on `127.0.0.1:30113`. It is off unless the app is launched with `XENON_REWRITE_ROUTE=local-base-rewrite`, it only sends text containing the word "synthetic", only to a server that first proves its identity (a protocol whose server half is not in this repository), and only until the end of 2026-12-31, Pacific time, by this machine's clock: from then on it sends nothing until a reviewed change extends that date, and a rewrite there reports that the route is unavailable. Nothing here is evidence of transcription or rewrite quality.

## Checks

```sh
cd apps/desktop
npm test               # unit and contract tests, no install needed (Node 22.18+)
npm ci
npm run typecheck
npm run test:e2e       # the renderer end to end, with Playwright and axe
npm run test:electron  # the offline test in a real Electron window
```

Repository checks, from the root. The boundary check needs the private denied-term list described in [CONTRIBUTING.md](CONTRIBUTING.md), and refuses to run without it:

```sh
python3 tools/check_public_boundary.py
python3 tools/check_repository.py
python3 -m unittest discover -s tests
```

## Layout

| Path | What it is |
|---|---|
| `apps/desktop/` | The Electron client. Its README describes the design and the behavior decisions |
| `tools/` | The public boundary check, the repository guard and the hook installer |
| `tests/` | Tests for the tools |
| `.githooks/` | Hooks that run the boundary check before each commit and merge, on each message, and before each push |

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [PUBLIC_BOUNDARY.md](PUBLIC_BOUNDARY.md) before changing anything.

## License

All rights reserved. See [LICENSE](LICENSE). Being able to read this source does not grant a license to use, copy or redistribute it.
