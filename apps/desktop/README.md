# Xenon Writing desktop (proposed Electron client)

Status: **Packets A, B (parts 1–3), C, D and E (parts 1–4).** A pure TypeScript session reducer (A). The main-process IPC handlers, session registry, route policy and preload façade (C). The rewrite job runner, in-process synthetic fixture provider and offline composition (D). Audio intake: strict WAV inspection, the chooseAudio intent and session-bound asset tokens (E1). Synthetic transcription and the reducer's Replace/Keep transcript candidate (E2). Microphone permission states and the capture lifecycle behind injected OS ports (E3). An accessible Electron shell (B part 1) that wires D's offline synthetic composition into Electron and drives the reducer: one hardened window with transcript, steering and draft panes and explicit copy, where a typed fixture rewrite completes end to end. Part 2 adds audio to the shell: Import audio through a native chooser, Transcribe with the synthetic transcriber, and the Replace/Keep transcript candidate. Part 3 adds the recording UI (the explanation before the first microphone prompt, Record, a timer, Stop/Discard), tested against a stub bridge; Since the Stop confirm step, Stop keeps the audio and asks before transcribing it. E part 4 wires real macOS microphone permission and capture into `main.ts` (the only target: macOS on Apple silicon), so Record works in the real app on macOS; real-device evidence from a packaged install comes from a manual checklist run on a real Mac (kept outside this repository), which passed on macOS 27.2.1 arm64 except step 7 (access revoked while recording) and Check again clearing its message, both still to observe. The only live route is route card 07's local base rewrite, off unless main is launched with its switch; otherwise nothing leaves the process. An unknown outcome pauses new work app-wide until it clears: on that route, by the user's acknowledgment in an Inspect step; on any other, by a restart. Nothing here is evidence of transcription or rewrite quality.

Stack (owner decision, 2026-11-18): Electron 45, Electron Forge 8 with its Vite plugin (Vite 8), React 19, TypeScript 7 for typechecking only, Playwright with axe-core for end-to-end checks. All versions are pinned exactly in `package.json` with a lockfile. Only `src/main/main.ts`, `src/preload/preload.ts` and `src/main/platform/electronChooser.ts` import Electron, and `tests/contract/offline.test.ts` limits them to named, local-only bindings.

Design: the interaction rules, the IPC contract and the acceptance scenarios this client follows are summarized in this README and enforced by its tests; the design documents themselves stay outside this repository. A separate Swift app, also not in this repository, remains the behavioral reference. Packets A–F are the delivery slices the client was built in. Route card 07 is the compiled-in description of the one live route (destination, model, limits and the synthetic-text-only exception), in `src/main/providers/baseRewriteRoute.ts`.

## Layout

| Path | Owns |
|---|---|
| `src/contracts/session.ts` | Proposed IPC v1 envelope, main → renderer rewrite events, safe failure codes, route descriptor with per-route UTF-8 limits, fixture-only limits |
| `src/renderer/session.ts` | Pure reducer: transcript/steering revisions, frozen request snapshot, draft promotion rules, cancellation, unknown-outcome gate; selectors for rewrite availability, draft status, phase and copy eligibility |
| `src/contracts/ipc.ts` | IPC v1 channel names, exact request and event schemas, published route and capability shapes, result type (C) |
| `src/main/ipc.ts` | Main-process handlers: caller trust, schema, version and session checks, route policy and byte limits, request-ID dedupe, one-job and unknown-outcome gates, provider-result checks, ordered event delivery, cancel and copy (C) |
| `src/main/sessionRegistry.ts` | Trusted windows, one session per window, epochs, main-issued job IDs and draft handles bound to one session (C) |
| `src/main/routePolicy.ts` | Startup-validated route registry; only the synthetic fixture rewrite route by default (C) |
| `src/main/jobs.ts` | Rewrite job runner: route-exact adapter lookup, timeout on an injectable clock, cancel, and the dispatched/not-dispatched rule for unknown outcomes (D) |
| `src/main/providers/fixture.ts` | In-process synthetic rewrite (identity `fixture-v1`, D) and transcriber (fixed text, identity `fixture-asr-v1`, E2), each with an optional delay |
| `src/main/providers/chatRewrite.ts` | Chat-rewrite provider core for a future base or pipeline rewrite route: the exact OpenAI-compatible request with the route identity as the model and the job ID as the `Idempotency-Key`, strict reply checks (exact model echo, the pipeline's synthetic/personalized mark against the route mode, one stopped choice, draft and reply byte limits), a status mapping that reads only clear refusals as `route_unavailable` and everything else (409 included) as `unknown_outcome`, and a startup check that a fixture route fits the pipeline chat view's limits. It goes through an injected transport; route card 07's transport is `loopbackHttp.ts`, and `synthetic.ts` registers the core for route card 07 only when main's switch is on |
| `src/main/providers/loopbackHttp.ts` | The one loopback transport for an approved chat route (route card 07) and the only source file allowed `node:http`: the literal `127.0.0.1` and the card's port on a fresh connection with its own agent (a global proxy agent cannot reroute it), no redirects, reading stopped at the first chunk past the reply cap and at most cap + 1 bytes delivered, "not sent" only when the connection never opened, no logging. `main.ts` creates it only when route card 07's switch is on |
| `src/main/providers/baseRewriteRoute.ts` | Route card 07 compiled in: the base rewrite route (`local-base-rewrite`, identity `mlx-community/Qwen3-4B-Instruct-2507-4bit`, label "Local base model (test text only)", 4,096/2,048/8,192-byte limits), port 30113, `max_tokens` 1,024, 45 s timeout, a 100,000-byte reply cap, the "synthetic" guard, and the main-only switch `XENON_REWRITE_ROUTE=local-base-rewrite`. With the switch, `synthetic.ts` offers this route instead of the fixture rewrite route |
| `src/main/platform/media.ts` | WAV inspection against the fixture limits; the chooser port contract (E1) |
| `src/main/platform/capture.ts` | Microphone permission and capture port contracts (E3) |
| `src/main/platform/chooser.ts`, `electronChooser.ts` | The chooser's rules (one file, cancel on anything else, bounded read) and their Electron binding: a native open dialog parented to the caller's window and a read of at most the limit plus one byte (B part 2) |
| `src/main/platform/captureCore.ts`, `captureProtocol.ts`, `electronCapture.ts`, `src/preload/capturePreload.ts`, `src/capture/` | macOS microphone permission and capture (E part 4): the recording rules and WAV assembly, the macOS state mapping and capture-window messages, the Electron binding with its hidden capture window and permission gate, that window's preload and page |
| `src/main/synthetic.ts` | Offline composition: fixture-only policy + runner + fixture provider behind main's handlers (D) |
| `src/preload/desktop.ts` | The renderer's only API: named methods, exact payload fields, filtered frozen events (C) |
| `src/main/main.ts` | Electron main (B): one window with `sandbox`, `contextIsolation`, no Node integration or webviews; denies new windows, navigation and every permission request; registers C's handlers with `ipcMain.handle` and trusts only that window's top frame at the URL it loaded |
| `src/preload/preload.ts` | Preload entry (B): exposes C's façade as `window.xenon` through `contextBridge`, nothing else |
| `src/renderer/main.tsx`, `Composer.tsx` | Opens a session through `window.xenon`, then toolbar (session, route, A−/A+ text size) and reducer wiring; forwards frozen requests to the façade (B) |
| `src/renderer/TranscriptPane.tsx`, `DraftPane.tsx`, `styles.css` | Import audio and Transcribe with an audio status line, the Replace/Keep transcript candidate, labelled transcript and steering editors, Rewrite/Cancel, status line; separate read-only draft preview with identity line and Copy draft (B) |
| `src/renderer/recording.ts`, `Recorder.tsx` | The recorder's UI state machine (explain, start, record, ended, stop, discard) and its controls: Record or Stop/Keep and Discard, the explanation, the timer and the recorder status line (B part 3) |
| `src/renderer/statusKind.ts`, `tests/unit/statusKind.test.ts` | Which kind a status line is, from the icon it shows (⚠ warning, ✓ success, … progress, ● recording, otherwise information); the kind sets the line's color through `data-kind` |

| `src/renderer/sendConsent.ts`, `tests/unit/sendConsent.test.ts` | The first-send consent rule (route card 07): which routes ask (any mode but `fixture`, until the session consents), that a blocked Send records no consent, and how the destination is named |
| `src/renderer/inspectFacts.ts`, `Inspect.tsx`, `tests/unit/inspectFacts.test.ts` | The Inspect step (route card 07): what is and isn't known about an unknown outcome, and the panel with its one Acknowledge |
| `tests/contract/acknowledge.test.ts` | The `acknowledgeOutcome` intent: every refusal with no side effect, the gate reopening, outcome reports to every session (reload, later session, another window), the preload filter, and the journey through the real runner, chat provider and reducer with a throwaway in-memory transport |
| `src/renderer/noticeKind.ts` | Whether the shown notice is about a rewrite or a transcription, from the action that set it, so the status line words it right (B part 2) |
| `index.html` | Renderer entry with the packaged Content-Security-Policy, relaxed only on the dev server (`vite.renderer.config.ts`) (B) |
| `tests/unit/session.test.ts` | Synthetic reducer tests, run on deep-frozen state so any mutation fails |
| `tests/contract/jobs.test.ts` | Synthetic tests for Packet D on a fake clock, end to end through façade, main, runner, fixture and reducer, with network APIs trapped |
| `tests/contract/chatRewrite.test.ts`, `tests/fixtures/chat-rewrite-v1.json` | The chat-rewrite core against a fake transport: request bytes and idempotency key, dispatch order, limits at max and max+1 (multibyte), reply checks, status mapping, NotSent, unknown outcomes after cancel or timeout, the pipeline-fit startup check. The JSON holds the shared request and reply vectors and the pipeline's limits, which the writing pipeline's own contract test checks from its side |
| `tests/contract/loopbackHttp.test.ts` | The transport against a throwaway server on 127.0.0.1 in the test process (the only test that opens a socket): the request it sends, end to end through the runner and chat core, a stopped service, replies at, over and past the cap or never ending, the content type passed through, a redirect, a hang and a cancel, a cut-off reply, a pre-send abort, proxy variables and a global proxy agent, bad ports |
| `tests/contract/baseRewriteRoute.test.ts`, `tests/canary/baseRewrite.canary.ts` | Route card 07 wired in, against a fake transport: the card pins the Swift reference's model and port, only the exact switch turns it on, the guard stops unmarked text before dispatch, main offers the base route instead of the fixture and a rewrite goes through it once, a stopped service is `route_unavailable` with no fallback. The canary is manual and opt-in (`node tests/canary/baseRewrite.canary.ts --send`), never part of `npm test`: one synthetic sentence to the running service |
| `tests/unit/recording.test.ts` | Recorder transitions: explanation only when never asked, start outcomes, endings by handle, Stop/Discard races, stale results (B part 3) |
| `tests/unit/noticeKind.test.ts` | Notice wording follows the job that set it, including typing over a waiting candidate (B part 2) |
| `tests/contract/chooser.test.ts` | The chooser's rules with a fake platform: one file read to the limit plus one byte, cancels read nothing, a failed read rejects (B part 2) |
| `tests/contract/captureCore.test.ts`, `captureProtocol.test.ts` | Capture rules with a fake input and clock (limit, endings, flush, discard, refused start, WAV header); macOS state mapping, the re-read after the prompt, chunk bounds and failure reasons (E part 4) |
| `tests/unit/transcription.test.ts` | Reducer: transcription, the Replace/Keep candidate, kind-safe events, cancel and unknown outcomes (E2) |
| `tests/contract/transcribe.test.ts` | Main transcribe intent, transcription runner and fixture, and the offline choose → transcribe → Replace/Keep → rewrite journey (E2) |
| `tests/fixtures/clock.ts` | Shared deterministic fake clock |
| `tests/contract/capture.test.ts` | Permission states, no prompt at launch, no prompt loops, revoke, one capture per window, stop/discard, teardown on close/navigation, late starts (E3) |
| `tests/contract/media.test.ts` | WAV limit, format and corruption cases; chooseAudio cancel, refusal, concurrency, close-while-open and trust (E1) |
| `tests/fixtures/wav.ts` | Generated sine-tone WAV builder; the `noon` fixture is built at test time, not committed as a binary |
| `tests/contract/ipc.test.ts` | Synthetic contract tests for Packet C with in-memory ports, including façade → main → reducer round trips |
| `tests/e2e/composer.spec.ts` | Playwright acceptance for Packet B (rewrite, copy, layout, axe; part 2: import, transcribe, Replace/Keep, cancel, import refusals; part 3: explanation, record, stop, discard, endings, denied/recheck, timer) against the production renderer build and a synthetic `window.xenon`; files are served by request interception, so no sockets open and other requests are aborted; the axe journey runs in light and dark at 1100 and 760 wide, and the keyboard focus ring must measure at least 3:1 against the page in both schemes |
| `tests/e2e/offline.spec.ts`, `offline-trap.cjs`, `electron-build-check.ts`, `playwright.electron.config.ts` | Packet D's offline test against the built app in a real Electron window: a trap loaded into main before the app, the journeys and a self-check; refuses a missing or stale build |

## Run

Requires Node.js 22.18+. Unit tests still need no install, because Node strips the types:

```sh
cd apps/desktop
npm test                 # reducer and contract tests, no install needed
npm ci                   # everything below needs the pinned dependencies
npm run typecheck        # TypeScript 7 `tsc`, no emit
npm run test:e2e         # builds the renderer, then Playwright (needs `npx playwright install chromium`)
npm run test:electron    # packages the app, then Packet D's offline test in a real Electron window
npm start                # Electron dev window with hot reload
npm run package          # unsigned local package in out/, not a release
```

Use only erasable TypeScript syntax (no `enum`, `namespace` or parameter properties) so Node can keep running the unit tests without a build.

`test:electron` needs Electron's runtime binary, which Electron's install script downloads during `npm ci`. If `node_modules/electron/dist` is missing (for example after `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, or with install scripts skipped or denied), `node node_modules/electron/install.js` fetches the pinned version and checks it against the package's checksums. On Linux it needs a display (CI uses `xvfb-run`). Running Playwright with `playwright.electron.config.ts` directly refuses a missing, development or stale build; `npm run test:electron` packages first.

## Behavior decisions

The design docs leave these points open. Each is a proposal for review, not a settled product rule.

### Packet A: renderer reducer

- **Editing during a rewrite does not cancel it.** The editor stays live. When the reply arrives for older inputs it is discarded with `result_outdated`, and the previous draft and new text are kept. It is not shown as a new stale draft.
- **Precedence:** a malformed reply (`invalid_response`) or wrong identity (`provider_mismatch`) is reported before staleness. Output is promoted only when mode and identity exactly match the route that was requested.
- **Local cancel** returns to editing immediately, with edits and the previous draft kept, and does not claim the remote request was retracted. Its outcome is unknown until main reports it, so new rewrites stay blocked (`awaiting_cancellation`) until main sends the cancelled job's terminal event, normally `rewrite.failed` with `cancelled`. If that event is `unknown_outcome`, the job moves to the reconcile gate.
- **Unrecognized failure codes are treated as `unknown_outcome`** (fail closed) and block new rewrites until main sends `rewrite.reconciled`. A reconcile matches on request ID. If both sides carry a job ID, those must match too.
- **Request IDs are never reused within a session.** The reducer remembers every issued ID and refuses reuse, so a replayed reply for an old request cannot complete a new one.
- **A reply that fails integrity or identity checks is a known bad outcome, not an unknown one.** It ends the attempt with `invalid_response` or `provider_mismatch`, keeps the previous draft, and does not block retries. Disabling a route that misreports its identity is main's route-policy job.
- **Assumed ordering:** main delivers one job's events in order (accepted, then terminal, then any reconcile). A reconcile that arrives before its `unknown_outcome` failure would leave that gate in place.
- **Limits belong to each route** (`RouteDescriptor.limits`). `FIXTURE_LIMITS` holds the component design's fixture defaults (16 KiB transcript, 2 KiB steering, 24 KiB draft), counted in UTF-8 bytes.
- **Regenerating with unchanged inputs is allowed.** While a regeneration is in flight the existing draft is "previous". If that request fails, the draft becomes current again.

### Packet B: shell decisions

Proposals for review, like the reducer decisions above.

- **Every button uses `aria-disabled`, not `disabled`** (Rewrite, Cancel, Copy, Import audio, Transcribe, Record, Stop, Discard and, since the UI fixes, A−/A+), so keyboard focus stays on the button while the state changes under it, for example A−/A+ at either end of the size range. Activating one while unavailable does nothing.
- **The status line is one polite live region.** It announces rewriting, completion and failures in words with an icon, and never reads draft or transcript text aloud. Copy has its own status line under the button.
- **Copying a stale draft:** the button reads "Copy previous draft" while the shown draft is outdated. Pressing that named button is the confirmation `copyEligibility` asks for; there is no extra dialog.
- **Text size has seven fixed steps (87.5% to 200%)** and is not persisted, since no storage design is approved.
- **No route until Packet D.** Main publishes an empty route registry and a job port that fails every job, because C's default fixture route has no runner yet. D supplies the fixture route and its runner together.
- **Session start:** the renderer calls `createSession` once at load and uses the first ready `rewrite`-stage route (and, since part 2, the first ready `transcribe`-stage route and the offered actions). If the façade is missing or the call fails, the shell runs offline with no route.
- **Left out until a later packet needs it:** Settings (no settings exist yet). Inspect for an unknown outcome has since been added (see "Inspect step" below).

Part 2, audio in the shell:

- **Import audio and Transcribe appear only when main offers `chooseAudio` and `transcribe`** with a ready transcribe route. Without a bridge neither is shown. They sit above the transcript, so the tab order is A−, A+, Import audio, Transcribe, Transcript, Steering, Rewrite, Cancel, preview, Copy.
- **Transcribe uses `aria-disabled`** like Rewrite. It is available only with audio chosen and no blocker: no job running, no cancel or unknown outcome pending, and no candidate waiting. The audio status line, which describes the button, names the blocker ("Replace or keep the waiting transcript before transcribing again.").
- **The audio status line is its own polite live region.** It says "No audio chosen.", "Audio ready: 2.5 seconds of WAV." or why an import failed and what to do next. A failed import leaves the earlier audio chosen in main and the reducer, so the line says both: the refusal and "The earlier audio (2.5 seconds) is still chosen." It never names the file; main never sends a name or path.
- **One dialog per click.** A second Import while the dialog is open does nothing in the renderer (main also refuses a second dialog per window with `already_open`). Closing the dialog clears any earlier refusal.
- **Import refusals in words:** `invalid_input` and `unsupported` ask for a mono, 16 kHz, 16-bit WAV of at most 30 seconds; `route_unavailable` (the dialog or the read failed) says to try again or choose another file; `denied` (the session ended while the dialog was open) says to choose again. Closing the dialog changes nothing; a second Import while one is open says a chooser is already open.
- **An empty transcript is filled directly; any other text gets a candidate.** A direct fill is announced ("Transcript added from the audio. Review it before you rewrite.") until the next change. The candidate is a labelled region ("Transcript from audio") showing the text as text, its mode and identity, and Replace transcript / Keep existing. Nothing in the editor changes until Replace. Replace and Keep move focus to the transcript, because their buttons disappear with the region.
- **Cancel cancels whichever job is running,** rewrite or transcription, with the same local-then-confirmed rules.
- **Notice wording follows the job that set it** (`noticeKind.ts`): the job that just ended (settled, cancelled or abandoned) owns the notice it left, so "Transcription cancelled. Your text is kept." versus "Rewrite cancelled…". Typing over a waiting candidate reads "Transcript not applied because your text or the chosen audio changed. Your text is kept." An unrelated action does not reword a notice that is still shown.
- **The chooser binding** parents the native dialog to the caller's window, filters for `.wav` only as a convenience (intake inspects bytes), treats a closed dialog, a vanished window or anything but one file as a cancel, and reads at most the limit plus one byte so intake can tell "too large" from "exactly at the limit". The path stays in main.
  - It opens the file non-blocking and requires a regular file before reading, so a FIFO or serial device fails at once instead of blocking until a writer appears (which would hold the window's chooser slot for good).
  - A read that takes over 10 s fails (`route_unavailable`), so a hung mount releases the slot too.
- **Known gap, shared with rewrite:** the renderer settles jobs from events and ignores the invoke reply. Main announces refusals of well-formed requests as events, but not those for a closed session or stale epoch, which would leave the job pending until the session is replaced.

Part 3, recording:

- **Before the first rewrite to a route that leaves the app, the app asks where the text goes** (owner-approved route card 07's consent step). An inline region, "Send to {route label}?", names the exact model, where it runs ("a separate service on this Mac" for a local route) and that it may keep a copy; it takes focus on its heading. Send sends and records consent for the session; Not now or Escape closes it. After either, focus goes to the status line, so a repeated Enter cannot send again or reopen it. While the rewrite is blocked (an empty or oversized transcript, a running job), Send is unavailable and the region says why. The fixture route never asks.
- **Record appears only when main offers `capture`,** which main does on macOS since E part 4; elsewhere (the Linux CI app) it stays hidden. The Playwright renderer tests drive it against a stub bridge, and the offline Electron test drives the real capture with Chromium's fake input device. The tab order becomes A−, A+, Import audio, Record, Transcribe, Transcript, and so on.
- **Nothing prompts or records at launch.** The shell reads `microphoneStatus` at session start, which never prompts, only to explain a denied, restricted, unsupported or unreadable microphone up front.
- **An explanation comes before the first OS prompt.** Record first re-reads `microphoneStatus` (never prompting; "Checking the microphone…"), because a remembered state can be unread or stale. Unless the fresh answer is a decided state (`granted`, `denied`, `restricted`, `unsupported`), Record shows "Before you record": the microphone is used, the computer asks once, it can be changed in privacy settings, and a recording is kept only for this session. A failed or `unknown` read also explains first, since main re-reads the state itself and prompts when it is `not_requested`. Continue sends `startCapture`; Not now or Escape sends nothing and returns focus to Record.
  - Focus moves to the explanation's heading, not to Continue, so a repeated or held Enter on Record cannot consent before the text is shown. Continue is described by the explanation text.
- **Recording** shows "Recording. Stop keeps it; Discard keeps nothing.", a `role="timer"` clock ("0:03 of 0:30", not announced every second) and Stop and Discard. Import and Transcribe wait (`aria-disabled`, described by the recorder's status).
  - **Focus follows the recorder only while it is with the recorder** (on its controls, or lost to the page): Stop once recording, Record afterwards. A user who moved to the editor while the microphone started keeps typing there.
  - **A start still waiting for the OS does not block** Import or Transcribe, so an unanswered prompt cannot trap the user. Main has no cancel for a starting capture (see Packet E part 3); Record waits for the answer.
  - **An ending that arrives before the start's reply** (a port that ends at once) is held and applied once the handle is known.
- **Stop keeps the audio and asks before transcribing it** (owner decision, 2026-11-18: a recording is never sent to a transcription service without a second click). The recording becomes the session's audio, like a chosen file. When transcription is offered, a "Transcribe this recording?" prompt names where it would go ("Transcribing sends it to Synthetic fixture · fixture-asr-v1. Nothing is sent until you choose Transcribe recording.").
  - **Transcribe recording** transcribes exactly that recording, under the usual rules (a blocker makes the button wait and say why; existing text gets a Replace/Keep candidate). **Not now** or Escape keeps it without sending anything ("Recording kept. Nothing was sent; choose Transcribe when you want a transcript.").
  - Focus goes to the prompt's heading, not its button, so a repeated or held Enter on Stop cannot become the second click. The heading is described by the prompt text, and the recorder's status line also announces "Recording kept and not sent…" for anyone whose focus is elsewhere.
  - After Transcribe recording or Not now, focus goes to the recorder's status line, not to Record, so a repeated Enter cannot start a new recording.
  - When transcribing has to wait, the prompt says why for each blocker (a running job, a waiting transcript, a cancel still settling, an unknown outcome).
  - The prompt applies only to the kept recording: importing or recording other audio, or starting a transcription with the Transcribe button, ends it. It does not block Import, Record or Transcribe. "Nothing was sent" is cleared once that recording is sent or replaced.
  - This replaces part 3's first behavior, where Stop started the transcription at once.
- **Discard keeps nothing**, also when it wins a race with a settling stop (main answers that stop with `cancelled`).
- **A recording that ends by itself** (`capture.ended`: time limit, device lost, permission revoked) freezes the timer and says why; its audio is held until **Keep audio** or Discard. Events for another capture handle are ignored, and an ending after Stop changes nothing.
- **Refusals in words:** denied (settings, then **Check again**, which re-reads the status without prompting), restricted (system policy, no recheck), unsupported, unknown (Check again), a dismissed prompt (`not_requested` again: Record asks again), no input, in use, a failed start, a recording already in progress, a session that ended, a stop that could not be saved, and a lost reply (`unknown_outcome`: main may hold a recording this window never heard about; reopening the window releases it). Each says Type and Import stay available or what to do next. Check again keeps focus on the recorder when its button goes away.
- **Fixed from part 1:** `main.ts` registered `desktop.handle`, the synchronous core, which answers async intents (`chooseAudio`, and capture later) with `unsupported`. It now registers `desktop.invoke`, the entry point for every intent.

### Packet C: main process and preload

- **Who may call.** Only the top frame of a window main registered, at exactly the URL main loaded (a `#fragment` is ignored). Anything else gets `denied` with no side effect.
- **Rejection codes.**
  - `denied`: untrusted caller, unknown/closed session, stale epoch or another window's session; a route not in the registry; a request while another job runs or an unknown outcome is unresolved; a handle or request ID the session does not own.
  - `unsupported`: another contract version, an unknown channel, or a route registered for a different stage.
  - `route_unavailable`: a registered route that is disabled.
  - `invalid_input`: wrong shape, an extra or missing field, a mistyped value, a blank transcript, input over the route's UTF-8 byte limits, or a reused request ID with a different body.
- **Refusals reach the reducer.** A well-formed rewrite refused before acceptance is announced as `rewrite.failed` with `jobId: null` on the event channel, as well as in the invoke reply. The reducer settles requests from events, so without this a refused request would stay pending. Malformed payloads and ID/body conflicts are not announced, because a conflict announcement would settle the original request.
- **Dedupe.** A request ID's first result, including a refusal, is stored with a SHA-256 fingerprint of its exact fields. An identical retry returns that result and never dispatches or announces again.
  - A session keeps 256 request records, evicting the oldest settled ones. A running job's record is never evicted.
  - Bodies over 1 Mi characters are refused before hashing.
- **Ordering.** `rewrite.accepted` goes out on the ordered event channel before the job is handed to the runner, then is also returned as the invoke reply. The renderer therefore sees accepted before any terminal, even a synchronous one, and the reducer ignores the duplicate accepted.
- **Provider results are checked in main before the renderer sees them.**
  - Wrong mode or identity → `provider_mismatch`.
  - Blank, oversize or non-string text → `invalid_response`.
  - An unrecognized failure code becomes `unknown_outcome`.
  - A runner that throws on submit is also `unknown_outcome`, because dispatch may have happened.
  - Only the first report per job counts.
- **Gates are app-wide, not per session.** At most one rewrite job runs at a time, and none starts while any outcome is unknown. Both survive a reload, a new session and a closed window, so neither a reload nor a renderer calling `createSession` again can dispatch a second time. With one window per app (interaction design), this equals the per-session fixture limit.
  - Two things clear an unknown outcome: main-side `reconcile(jobId)`, which the renderer cannot call and nothing calls yet (it is for a future route with receipts), and the user's acknowledgment in Inspect, only for a route whose card allows it (see "Inspect step" below).
  - Every open session is told about each unknown outcome (`outcome.unresolved`), and every session opened later finds it in `SessionOpened.unresolved`, so the gate is never invisible.
  - A refused renderer sees `denied` and can retry later.
- **Copy.** Main checks that the handle belongs to the caller's open session and has not expired. Cancelled jobs never get a copyable handle: a success that arrives after cancel is reported, so the renderer can retire the job, but its handle is not stored.
- **Session lifecycle.** Opening a session in a window that already has one closes the old one. So do `windowNavigated` (top-frame navigation, reload or renderer loss) and `windowClosed`. Closing revokes the session's handles, bumps the epoch, asks its job to stop and drops every later event for it.
- **Electron wiring** lives in Packet B's `src/main/main.ts` and `src/preload/preload.ts`: `ipcMain.handle` per channel through `callerFromElectronEvent`, `webContents.send` for events, `windowNavigated` on main-frame `did-start-navigation` and `render-process-gone`, `windowClosed` on `destroyed`, and `createDesktopApi` through `contextBridge`.

**Contract deviations from the component design, for review.**
1. `cancel` takes the renderer's `clientRequestId`, not a job ID, because the user can cancel before the accepted event arrives.
2. Only `rewrite` carries and dedupes a `clientRequestId`. `cancel` and `copyDraft` are idempotent in effect, `getCapabilities` only reads, and `createSession`/`closeSession` are replace/close operations. A retried copy writes the same text to the clipboard twice.
3. The component design says main accepts copy only for the *current reviewable* draft. Main cannot see edits, so it cannot tell a current draft from a discarded outdated one. It keeps the last 8 handles per session, so the draft still on screen stays copyable after later results are discarded. "Current or previous, with confirmation" is enforced by the reducer's `copyEligibility`. There is no user-gesture flag, because main could not verify one; the UI must call copy only from a deliberate action.
4. `acknowledgeOutcome` (Inspect step) is a renderer intent that clears an unknown-outcome gate. The component design lists no such intent, and the delivery plan's unknown-outcome scenario asks for independent reconciliation. Route card 07 records the deviation: its service keeps no receipts to reconcile against, so the user acknowledges instead, for synthetic text only; the threat model weighs what it lets a compromised renderer do. Its request ID is single-use: any reuse in the session, even with an identical body, is `denied`, never replayed, because the acknowledgment's effect is reported as events. Like a user gesture for copy, main cannot verify that the user pressed Acknowledge; the UI calls it only from that button. `SessionOpened` gains `unresolved`, and there are two new events, `outcome.unresolved` and `outcome.cleared`.

### Packet D: jobs and the fixture provider

- **Whether a request may have left the process decides the outcome.** An adapter calls `dispatched()` immediately before it sends.
  - That call throws once the job was cancelled, timed out or finished. The adapter must then not send, so a cancel before dispatch is certain.
  - Before dispatch, cancel is certain and immediate (`cancelled`), and a timeout is `timed_out`.
  - After dispatch, an abort or timeout is `unknown_outcome`, which closes main's gate until reconciliation. So is an adapter's own claim of `cancelled` or `timed_out`, because only the remote side could confirm it. A late success is still reported as a success.
  - The runner never retries and never falls back to another adapter.
- **Timeouts belong to each route.** Every adapter declares its own `timeoutMs`, and the runner refuses to start without it, so a future live route cannot inherit the fixture's value. The fixture uses the 10 s default from the component design, a test value, not a live SLA. A job must finish strictly before its deadline; one that would finish exactly at it times out.
- **Adapter failures.** A `ProviderFailure` with a known code passes through, except as above. Any other error, or a non-promise return, is handled once: `route_unavailable` before dispatch and `unknown_outcome` after it.
- **Adapters are route-exact.** Each adapter must match one published rewrite route's key, mode and identity at startup, or the app fails to start. A route without its adapter is `route_unavailable` at submit.
- **The fixture** returns the transcript with runs of whitespace collapsed and the ends trimmed, so `"Meet  at\nnoon. "` becomes `"Meet at noon."`. It identifies as `fixture`/`fixture-v1`. It never calls `dispatched()`, opens no socket and reads no file. Markup passes through as text; rendering it as text is the UI's job (B).
- **Mapping from the delivery plan's Packet D row.**
  - `noon.wav`, the fixture transcriber and the transcribe intent move to Packet E. Audio asset tokens come from the chooser and capture flow there.
  - `tests/e2e/offline.spec.ts` now exists: it runs the built app in a real Electron window (`npm run test:electron`, CI job `desktop-electron`).
  - Offline evidence comes in three layers:
    - **Contract:** every end-to-end contract test runs with the network entry points in `net`, `tls`, `http(s)`, `dgram`, `dns` (including resolvers and promises) and `fetch` trapped, and fails if any is touched.
    - **Static:** a scan fails if any source file imports a Node built-in other than those allowed, or calls `fetch`, `WebSocket`, `XMLHttpRequest`, `EventSource` or a worker. That also covers workers, child processes and modules added later.
    - **Runtime, in Electron:** `offline.spec.ts` launches the Forge Vite production build (`.vite/`, from `node_modules/electron`, not the packaged `out/` app) with `tests/e2e/offline-trap.cjs` loaded into main before the app's code. The trap records and refuses Node's TCP, TLS, HTTP(S), HTTP/2, UDP and every DNS call; global `fetch`, `WebSocket` and `EventSource`; `child_process`, `worker_threads`, `utilityProcess` and `shell`; Electron's `net` and each session's `preconnect`, `resolveHost`, `resolveProxy` and `fetch`; and it cancels and records any non-local request in every session, plus any spellchecker dictionary download. A self-check proves each of these is caught before the app's own journeys run, hits during shutdown are read after the app closes, and each run gets a throwaway profile (`app.setPath('userData')`), so it never uses the developer's `npm start` profile. The journeys: the façade surface, typed rewrite → explicit copy (clipboard captured), import → synthetic transcription → Replace with the native dialog stubbed in main, and chooser refusals.
  - **What the runtime layer cannot claim.** It does not see background loads made by Chromium's browser process itself (component updates, safe browsing, field trials, breakpad), renderer-side WebRTC or UDP, or other processes. Playwright's launch adds `--disable-background-networking` and `--disable-component-update`, so those paths are off during the test but not necessarily in a user's launch. The evidence is "the exercised paths touched no trapped entry point", not "the shipped app opens no sockets"; a packaged-app network capture belongs to the per-OS acceptance (Packet F).
  - **Spellchecker (decision for review):** Chromium's Hunspell spellchecker downloads dictionaries from the network on Windows and Linux. The widened trap caught exactly that in Linux CI, even with the session's spellchecker disabled at ready and spellchecking off per window. Each new session starts loading dictionaries for the app locale before any window exists, so `main.ts` clears every session's spellchecker languages and disables it in `session-created`, and turns `webPreferences.spellcheck` off; macOS spellchecks locally with the OS. Re-enabling it needs a bundled dictionary or a confirmed OS-local spellchecker.
  - Node 25+'s `--permission` network block would be stronger, but CI runs Node 22.

### Packet E part 1: audio intake

- **Packet E is split in three.**
  - **E1 (this part):** intake.
  - **E2:** the transcribe intent, the fixture transcriber and the reducer's Replace/Keep transcript candidate.
  - **E3:** the permission state model and capture lifecycle.
  - Real-OS and packaged evidence for E is next: the target is macOS on Apple silicon (owner decision, 2026-11-18), minimum macOS 15.
- **Media is inspected, never trusted.** `inspectWav` reads the actual RIFF/WAVE structure and accepts only the component design's fixture format: PCM, mono, 16 kHz, 16-bit, at most 30 s and 1 MiB. The file name, extension and claimed type are ignored.
  - **`invalid_input`:** malformed, truncated or padded files; data before `fmt`; duplicate `fmt`; empty audio; a partial sample frame; anything over a limit.
  - **`unsupported`:** a well-formed WAV in another sample format.
  - A missing pad byte after an odd-sized final chunk is tolerated, since many writers omit it.
  - **Only samples are kept.** On success the inspector returns a freshly allocated canonical WAV holding only `fmt` and `data`. Metadata chunks (LIST/INFO, bext, iXML), which can carry names, paths or originators, never reach a later transcriber, and the stored asset never shares memory with the file read (a Node `Buffer.slice` would). Any non-empty audio reports at least 1 ms.
- **The chooser is a port.**
  - Electron wiring implements `pickAudio` with a native dialog that is modal to the calling window, plus a read capped at `maxBytes + 1`. It never returns a path.
  - Closing the chooser returns `cancelled` and changes nothing.
  - **One chooser per window at a time.** This is per window, not per session, so a renderer that opens new sessions cannot stack dialogs. A second request gets the non-error status `already_open`.
  - A session closed while the dialog is open gets `denied`, and the bytes are dropped.
  - **Failure codes, so the UI can choose what to offer:**
    - `invalid_input` or `unsupported` with the capability present: offer "Choose another".
    - `route_unavailable`: the dialog itself failed, so retry.
    - `denied`: the session ended.
    - `unsupported` with no `chooseAudio` capability: no chooser on this platform.
  - Nothing opens the chooser at launch or on capability queries. As with copy, main cannot verify a user gesture; the UI must call it only from a deliberate action.
- **Assets.** A chosen file becomes a main-held asset named by an opaque token bound to the session, with a summary of format, duration and byte count. Sample data never crosses the bridge.
  - A session holds at most one asset: a new choice revokes the old token, and closing the session drops it.
  - The token is not usable for anything until E2.
- **Async intents.** `invoke(channel, caller, payload)` is now the single wiring entry point and always resolves to a result. The synchronous `handle` remains the core for immediate intents, and answers `unsupported` for chooseAudio. Both go through one `resolveCall`, which does caller trust, schema, version and session binding, so a check added there covers every intent.

### Packet E part 2: synthetic transcription

- **Main.** A `transcribe` intent takes the session's asset token, a transcribe-stage route, a fresh request ID and the source revision.
  - It follows the same rules as rewrite: dedupe by request ID; refusals announced as `transcribe.failed` with `jobId: null`; one processing job app-wide, shared with rewrites; and the unknown-outcome gate.
  - An expired, replaced or foreign asset token is `denied`.
  - The transcriber gets its own copy of the canonical samples, never the stored asset.
  - Results are checked against the route's identity and the transcript byte limit, not the draft limit, because a transcript lands in the editor.
  - `reconcile(jobId)` sends `transcribe.reconciled` for transcriptions.
- **Runner.** Rewrite and transcription share one runner core: route-exact adapters, a timeout per route, and the dispatched/unknown rule. D's `createJobRunner` API is unchanged; `createTranscribeRunner` is the transcription runner.
- **Fixture transcriber.** It re-checks the audio is the fixture format, then returns the fixed text "Meet at noon." as `fixture-asr-v1`. It recognizes nothing, so it is not evidence of transcription quality.
- **Reducer (interaction design).** One transcription at a time, and it blocks rewrites and vice versa.
  - **Selected audio.** The reducer tracks the audio currently chosen or recorded (`audio.chosen`), and only that audio can be transcribed.
    - Choosing other audio abandons a transcription of the old audio, like a cancel: its terminal still has to arrive, and its text can never land.
    - It also drops a candidate from the old audio.
    - Main cancels a running transcription whose asset was replaced.
  - **Empty editor:** the transcript fills it directly and bumps the revision.
  - **Existing text, even whitespace:** the transcript becomes a **candidate**, and nothing changes until the user chooses **Replace** (bumps the revision, so a rewrite in flight becomes outdated) or **Keep**.
  - **Typing:** typing while a candidate waits keeps the typing and drops the candidate (`result_outdated`).
  - **Editing mid-flight:** editing during a transcription outdates its result.
  - **Integrity before staleness:** identity, echo, blank and oversize problems are reported before staleness, and never change the text.
- **Job references carry a kind** (`rewrite` or `transcribe`), and events of the other kind never settle, retire or reconcile them, even with the same request ID.
- **Decision for review:** one asset can be transcribed more than once while it is the session's audio. That is harmless for the fixture, but with a live ASR route it would mean sending the same audio again, so it needs a product decision before any live route.
- **Asset rules E1 could not show** are now tested end to end: one asset per session (a new choice revokes the old token), and the transcriber receives only `fmt` + `data`.

### Packet E part 3: microphone permission and capture

- **Permission states (platform design).** `not_requested`, `granted`, `denied`, `restricted`, `unsupported` and `unknown`.
  - Any value the OS reports outside these (Electron's own spellings included) is `unknown`, and so is a failing OS query or prompt; neither is ever treated as granted.
  - `microphoneStatus` and `startCapture` report the same safe state, and `microphoneStatus` never prompts.
  - Nothing prompts or records at launch, on capability queries or on status checks.
- **The prompt only follows a deliberate Record.** `startCapture` shows the OS prompt only when the state is `not_requested`.
  - Every other state comes back as the non-error status `blocked`, so the UI explains it and keeps Type and Import.
  - Later attempts never prompt again, and a permission revoked in the OS blocks the next capture without prompting.
- **One capture in the whole app** (component design: "one capture… deny concurrent capture"), like the processing-job gate. A second request from any window gets `already_recording`.
  - The capture stays reserved while the OS prompt or device is starting, and while a stop is settling. A replaced session can't open a second prompt, and no second capture can start before the first is fully released.
- **Start failures say why.** Permission is granted but recording can't start → the non-error status `unavailable` with a reason: `no_input`, `in_use` (temporarily) or `failed`. The app is released so the user can retry. Device selection belongs to the port and UI (Packet B).
- **Stop and discard.**
  - `stopCapture` takes the single-use handle and inspects the audio like a chosen file (canonical samples only). The recording becomes the session's one asset, revoking the previous token and stopping any transcription of the previous audio.
  - A stop that fails or doesn't settle within 5 s is discarded at the device and reported as `route_unavailable`, so the device never keeps recording.
  - `discardCapture` keeps nothing, and during a settling stop it wins: the stop answers `cancelled` and no asset is made.
  - Closing, navigating, replacing or destroying the session stops the recording.
- **Recordings that end by themselves.** The stream reports the end through `onEnded` (time limit, device lost or permission revoked). Main then holds what was captured and sends `capture.ended` with the handle and reason, so the UI stops showing "Recording". The audio is kept until the user chooses Stop (keep) or Discard (platform design: "clearly stop… preserve completed material").
- **Time limit.** If the port doesn't stop itself at 30 s, main ends the recording 1 s later. A recording that overshoots the limit keeps its first 30 s instead of losing the take (an inspected trim; chosen files are still refused over the limit).
- **Deviation for review:** there is no way to cancel while the OS prompt or the device is still starting, because there is no handle yet. Closing or navigating cancels, and the slot stays reserved until the start resolves.
- **Port contracts** in `src/main/platform/capture.ts` record what the Electron wiring must guarantee: no prompt from `status()`, a persistent recording indicator, no silent device switch, and reporting how a recording ended.
- **Not done here:**
  - The recording UI (timer, Stop/Discard, the explanation before the first prompt) is Packet B.
  - The macOS ports are E part 4, below.

### Packet E part 4: macOS microphone permission and capture

The only target is macOS on Apple silicon (owner decision, 2026-11-18), minimum macOS 15. On other platforms main offers no capture.

- **Permission** (`captureProtocol.ts`, `electronCapture.ts`): Electron's `systemPreferences.getMediaAccessStatus('microphone')` gives macOS's state, mapped to the contract's (`not-determined` → `not_requested`; anything unrecognized → `unknown`, never granted). `request()` calls `askForMediaAccess('microphone')`, the OS prompt, then re-reads the state rather than trusting the call's answer. Main still prompts only from a deliberate Record when the state is `not_requested`.
- **Capture runs in a hidden capture window**, a second `BrowserWindow` (`show: false`, sandboxed, context isolation, no Node, no spellcheck, background throttling off) with its own page (`src/capture/`, strict CSP, no network) and its own preload (`capturePreload.ts`). The page opens the default input with `getUserMedia` (no echo cancellation, noise suppression or gain control), resamples it to 16 kHz in an `AudioContext` (and refuses to record if the context does not run at 16 kHz), and streams 16-bit samples to main in chunks of about 128 ms. Main assembles the WAV (`captureCore.ts`), so the same intake check as a chosen file applies.
  - **Only that window may use the microphone, and only while a recording is opening or open.** The session's permission handlers allow `media` for audio alone, for that window's `webContents`, its top frame, and a requesting URL equal to the capture page main opened; everything else, including the app window, is denied as before. Once the page has loaded, a reload or any other top-frame navigation of the capture window ends the recording and destroys the window.
  - **Messages count only from the capture window's top frame**, on private channels the app window's preload never exposes. Chunks are bounded (at most a few seconds each), even-length `ArrayBuffer`s, copied out.
  - The window exists only during a recording and is destroyed on Stop, Discard, an ending or a failed start.
  - macOS shows its own orange microphone indicator in the menu bar while the input is in use, which meets the port contract's persistent indicator.
- **Rules** (`captureCore.ts`, unit-tested with a fake input): at most the time limit's worth of samples is kept, and the port ends the recording itself at the limit even if samples stop (a timer that starts once the input is open, with 500 ms for the audio pipeline's delay, so a full recording keeps exactly 30 s and the sample count normally ends it first); the first ending wins; Stop asks the page to hand over what it holds (up to 500 ms) and loses at most about 128 ms the audio processor still buffers; Discard keeps nothing and is safe to repeat; a refused start releases the input.
- **Failures:** `NotFoundError`/`OverconstrainedError` → `no_input`; `NotReadableError`/`AbortError` → `in_use`; anything else, a crashed capture page or an input that does not open within 10 s → `failed`. A track that ends by itself is `revoked` when macOS no longer reports access as granted, otherwise `device_lost`.
- **Packaging** (`forge.config.ts`): the app's `Info.plist` declares `LSMinimumSystemVersion` 15.0 and an `NSMicrophoneUsageDescription` ("Xenon Writing uses the microphone only when you choose Record, to make a transcript you review before it changes your text."), which macOS shows in its prompt. The bundle identifier is still the packager's default, `com.electron.xenon-writing-desktop`.
- **Decisions for review:**
  - `ScriptProcessorNode` is deprecated in the Web Audio spec but still supported by Chromium; it avoids loading an AudioWorklet module from a `file://` page. Moving to an AudioWorklet is a later change if Chromium drops it.
  - Input device selection is the macOS default input; there is no in-app device picker.
  - **Security of the unsigned build:** it has Electron's default fuses (Run as Node, `NODE_OPTIONS`, `--inspect` on) and no hardened runtime, so a microphone grant to it could be borrowed by another local process starting the bundle in those modes. The acceptance checklist keeps the grant short-lived and resets it. Before any longer-lived grant: turn those fuses off and sign with the hardened runtime and the `com.apple.security.device.audio-input` entitlement (a packaging packet, with its own dependency review).
  - Closing the window while the device is still opening cannot abort the open: the device opens and is discarded as soon as the start resolves (normally well under a second), so macOS's indicator can flash briefly (see Packet E part 3's deviation on starting captures).
- **Evidence so far:** unit tests for the rules and protocol; the offline Electron test records from Chromium's fake input device with macOS's permission state stubbed in main (granted, never asked → explanation → one prompt, denied), checks the capture window comes and goes, that the app window is refused the microphone even while recording, and that a recording goes through Stop → the confirmation → the synthetic transcriber. It runs in Linux CI (the capture tests skip there: no macOS ports) and in a new macOS arm64 CI job. **Not yet run:** the real permission prompt, a real microphone, deny/revoke in System Settings and a packaged install, which is the manual checklist run on a real Mac, kept outside this repository.

### Inspect step (route card 07: the user acknowledges)

- **What it is.** An unknown outcome (a reply that may or may not have been produced after the text left the app) pauses every new rewrite and transcription in the app. The status line says so, and an **Inspect unknown outcome** button follows Rewrite and Cancel. It opens an inline region, like the first-send confirmation, not a modal. It says what is known (at what time the app began sending the transcript and steering, or the audio, to which route and model; that the reply, if one came, was not applied), what is not (whether it arrived and whether the service replied; that it may keep a copy), and that nothing will be sent again automatically. "Began sending", not "sent": main knows it accepted the job and handed it to the route, and a timeout can fire after that and before the request is out. Wording lives in `src/renderer/inspectFacts.ts`. While paused, the status line says so even over an older notice such as "You can try again".
- **Acknowledge.** One explicit **Acknowledge** button, only on a route whose card allows it. It sends `acknowledgeOutcome` with the exact job ID main reported and a fresh request ID. It resends nothing; a new rewrite is still a deliberate Rewrite.
  - Main accepts it only from a trusted window's current session and epoch, for a job ID that is a current unknown outcome, on a route in `acknowledgeRoutes`, with no job running and an unused request ID (`acknowledgmentRefusal` in `src/main/ipc.ts`). Anything else is refused with no side effect: a wrong, cleared or running job is `denied`, a route without acknowledgment `unsupported`, a reused request ID `denied`. A refused acknowledgment records nothing, so its request ID stays unused.
  - On success main sends `rewrite.reconciled` (or `transcribe.reconciled`) to the job's own session if it is still open, then `outcome.cleared` to every open session. The reconciled event is the same one an independent reconciliation sends; nothing records which it was (there is no audit log, by design).
  - The unknown outcome's own request record is kept past the session's record cap until it clears, so after acknowledging, an identical retry of that request replays its first result instead of dispatching again. The reducer reopens the gate once both its own request and main's report have cleared, and the status line says "Unknown outcome cleared. Nothing was sent again."
  - "No job running" cannot coincide with an unknown outcome today (one job runs at a time and none starts while an outcome is unknown); the check keeps the rule if that changes, and is tested on the pure rule.
- **Which routes.** Only route card 07's `local-base-rewrite` is in `acknowledgeRoutes` (`src/main/synthetic.ts`), and only while it requires the "synthetic" marker (`baseRewriteAcknowledgeable`): without the marker, acknowledgment turns off. Main refuses a fixture or unregistered key at startup. Fixture routes never allow it: a fixture never leaves the process, so an unknown outcome there means main's own bookkeeping failed. Inspect then says the route "can't be cleared here" and that quitting and reopening resumes, and offers only Close. Main-side `reconcile` stays for future routes with receipts.
- **After a reload, or in a session opened later** (decision for review). The gate is app-wide and in memory, so a reload or new session starts paused if any outcome is unknown. Main lists each one in `SessionOpened.unresolved` (kind, job ID, route key, the time main accepted the job, and whether it can be acknowledged), so the new session shows the paused status and Inspect at once, and may acknowledge it. An outcome that turns unknown after the reload, while its job was still running, reaches the open session as an `outcome.unresolved` event. `main.tsx` listens from before `createSession`, so an event main sends between its reply and the Composer's first subscription is buffered and applied, in order, not lost. Any trusted window's current session may acknowledge, since every one was told. A session holding an unknown outcome main sent no report for (a contract fault) shows Inspect without Acknowledge, saying only a restart clears it.
- **Focus and keyboard.** Opening Inspect moves focus to its heading; Escape, Close or the Inspect button again closes it and returns focus to the Inspect button (`aria-expanded`, `aria-controls`). After an acknowledgment focus goes to the status line, which says the gate cleared, but only from Inspect itself: if the user went back to the editor while it was pending, focus stays there. The panel's own status line is always mounted, so "Acknowledging." and a refusal are announced. A refused acknowledgment keeps the panel and focus on Acknowledge, and adds a warning that new work stays paused. A second press while one is in flight does nothing. Its two lists are labelled "What is known" and "What isn’t known" for VoiceOver. If the gate clears some other way, the panel closes; if focus was on Inspect's button or panel, or fell to the page when the button went away, it goes to the status line.
- **The time** is main's acceptance time, shown as the local time, with the date when it was not today. Main hands the job to its route at once, so it is the send time to within the runner's dispatch.

## Not covered yet

- A network capture of the packaged macOS app (the runtime offline test cannot see Chromium's own background loads), with the per-OS acceptance.
- A run of the manual checklist on a packaged install with a real microphone, and evidence on macOS 15 and 26.
- Any live provider adapter (separately approved, one route per change).
- The Inspect step against the real service: an unknown outcome from the running model and its acknowledgment (tested with a throwaway in-memory transport, the real runner, chat provider and reducer, and in the renderer against a stub bridge), and a manual VoiceOver pass (axe and Playwright's accessibility tree only).
- Packaging makers, Electron fuses, signing and notarization, which wait for the release decisions in the platform design.
- Session close/new-session confirmation.
- A route-change intent: the reducer already rejects completions after a route change, but nothing can trigger one yet.
- Persistence.

## Evidence

2026-11-17, macOS arm64, Node 26.7.0, development source (not packaged): `npm test` → 29 tests, 29 passed, 0 skipped. Six deliberate reducer mutations each failed at least one test. An independent review against the design docs found two bugs and one spec conflict: a reconcile without a job ID never cleared its gate, a finished request ID could be reused, and a new rewrite was allowed right after a local cancel. All three are fixed, each with a regression that failed before the fix. Node 22 runs only in CI.

2026-11-18, Packet C, macOS arm64, Node 26.7.0, development source: `npm test` → 74 tests (29 reducer, 45 contract), 74 passed, 0 skipped.
- Every deliberate mutation of a main/preload guard (caller trust, schema, dedupe, gates, provider checks, delivery after close, preload field filtering, route-card rules) now fails at least one test. Two mutations that survived were redundant checks and were removed. One was a missing test, now added.
- An independent review against the component design, trust model and delivery plan found two bugs and two spec gaps. All are fixed, and each regression fails when its fix is reverted:
  - A new session (a reload, or a renderer calling `createSession`) dropped the unknown-outcome gate and the one-job limit, so the same body could be dispatched again.
  - A rewrite refused before acceptance never reached the reducer, so the renderer stayed pending.
  - A late success after cancel was copyable.
  - Events could still reach a page the window had navigated to.
- The review also flagged three points that are recorded as contract deviations above instead of changed: cancel by request ID, the copy retention window, and dedupe on rewrite only. It also flagged unbounded request records, which are now capped.

2026-11-18, Packet D, macOS arm64, Node 26.7.0, development source: `npm test` → 96 tests (29 reducer, 45 IPC contract, 21 jobs contract, 1 offline scan), 96 passed, 0 skipped.
- 14 deliberate mutations of runner and fixture guards were tried. 12 failed a test.
- Of the two that survived:
  - One was a redundant check, now removed.
  - The other exposed a missing assertion: the fixture's own timer must stop on cancel. It is now asserted.
- An independent review found that the fixture path was sound but the runner contract was not ready for future dispatching adapters. Four latent issues, all fixed, each with a regression that fails when its fix is reverted:
  - An adapter could downgrade a post-dispatch abort to a known `cancelled`.
  - `dispatched()` was accepted after a cancel, which would allow a send main believed never happened.
  - A non-promise return could double-report.
  - A single runner-wide timeout defaulted to the fixture's value.
- The review also found test gaps, now closed:
  - The network trap covered one test and missed resolver, UDP-send and listen paths.
  - No test joined a dispatching adapter to main's unknown-outcome gate and reconcile. Acceptance scenario 3 is now tested end to end.

2026-11-18, Packet E part 1, macOS arm64, Node 26.7.0, development source: `npm test` → 118 tests (29 reducer, 45 IPC contract, 21 jobs contract, 22 media contract, 1 offline scan), 118 passed, 0 skipped. The chooser tests are time-limited, so a removed concurrency guard fails instead of hanging.

**Independent review.** It fuzzed the inspector with 200k inputs: none threw, oversized chunk sizes and offset views were handled, and the worst case took about 1.7 ms. It found five issues, all fixed, each with a regression that fails when its fix is reverted:
- The chooser guard was per session, so new sessions could stack dialogs.
- `Buffer.slice` would have shared memory with the file read.
- Metadata chunks were kept in the asset.
- Busy, failed and expired choosers shared codes.
- `invoke` duplicated the session binding.

It also showed my earlier mutation claim was wrong. Six more guard mutations survived:
- the copy;
- the fmt-size check, which stops a final zero-size `fmt` from reading past the end;
- the block-align check;
- the byte-rate check;
- the asset clear on close;
- the session binding.

All are now covered, except two rules that cannot be observed until E2 gives assets a consumer, and E2 must test them: one asset per session, and assets cleared on session close.

The size cases now use exactly max−1, max and max+1 as the component design asks. Odd sizes are reached through a final chunk without its pad byte.

2026-11-18, Packet E part 2, macOS arm64, Node 26.7.0, development source: `npm test` → 153 tests (29 reducer, 19 transcription reducer, 45 IPC contract, 21 jobs contract, 22 media contract, 16 transcribe contract, 1 offline scan), 153 passed, 0 skipped.

**Own mutation pass.** 14 of 17 mutations failed a test. The three survivors:
- A missing kind test, now added.
- A missing check that a transcription copy cannot change the stored asset, now added.
- An unreachable guard, now removed.

**Independent review.** It found one spec gap: choosing other audio mid-transcription still let the old audio's text land (interaction design: "starts another import… cannot overwrite anything"). It is now fixed, as above. The review's 9 surviving mutations are now each caught, with a test that fails when the fix is reverted:
- the transcription unknown-outcome gate in main;
- cancel, close, navigation and new audio reaching the transcription runner;
- the accepted-revision echo;
- an abandoned transcription's unknown outcome;
- a throwing transcriber;
- capability readiness;
- refusal replay;
- Replace clearing the notice;
- the fixture transcriber stopping on cancel.

**From the same review:**
- Whitespace in the editor now needs Replace.
- A dead route check was removed.
- Asset reuse is recorded as a decision for review.

**Rules E1 left open:**
- "One asset per session" is now tested.
- "Assets cleared on close" stays memory hygiene only: a closed session is unreachable.

2026-11-18, Packet E part 3, macOS arm64, Node 26.7.0, development source: `npm test` → 178 tests, 178 passed, 0 skipped. No real microphone, prompt or device was used.

**Independent review.** It found three lifecycle bugs, all now fixed:
- A failed stop left the device recording.
- Freeing the slot before a stop settled allowed two captures in one window and silently ignored a Discard.
- The one-capture limit applied per window, so two windows, or a replaced session during the prompt, could capture or prompt concurrently.

**Spec gaps it raised, also fixed:**
- no signal for device loss or revocation;
- no main-side time-limit backstop;
- an overshoot losing the whole take;
- start failures collapsed into one code;
- `microphoneStatus` passing unrecognized OS values through.

**Tests.** Reviewing the fixes caught one more: teardown released a capture while its OS prompt was still open, which allowed a second prompt. Now 18 targeted mutations of the reworked capture guards each fail a test. They cover the review's 12 survivors: prompting on `unknown`, release after a failing prompt, keeping audio from a closed session, a failing query reported as granted, a throwing discard aborting close, and preload channel routing, which is now checked for every façade method. One survivor in that run, Discard during a settling stop freeing the app early, led to a tightened test.

2026-11-18, Packet B, Linux x64 cloud container, Node 22.23.5, development source and an unsigned `electron-forge package` build (Electron 45.3.4):
- `npm run typecheck` (TypeScript 7) is clean. It is the first typecheck of Packet C's code. Two type errors were fixed without changing behavior: `CONTRACT_VERSION` is now `1 as const` so envelopes keep the literal version type, and a mistyped filter predicate in `src/main/ipc.ts` was replaced.
- `npm test` → 74 passed, 0 skipped.
- Hosted Chromium for Playwright could not be downloaded in that container, so `tests/e2e/composer.spec.ts` was run there inside an Electron 45 window with no preload (headless, `--no-sandbox` because the container runs as root): 13 passed, 0 skipped. An earlier run caught two real axe issues (low-contrast empty-preview text, A−/A+ names not containing their visible text), both fixed. CI runs the same spec in Playwright's Chromium.
- A launch probe of the packaged app with its real preload: `window.xenon` exposes exactly the seven façade methods; no `require` or `process` in the renderer; `createSession` succeeds from the trusted `file://` page with no routes; a copy with a foreign session is `denied`; the same holds after a reload; no console errors.
- Not checked: `electron-forge start` (dev server, needs a display), macOS, Windows, a screen reader, or a signed install.

2026-11-18, Packet B part 1 rebased on D and E1–E3, same Linux container: `main.ts` now builds `createSyntheticMain`, so the fixture rewrite route is published. Two type errors in E's code were fixed without behavior change (a capture event in the reducer's settle path, now pinned by a regression test; a tuple literal in a test). The offline scan now covers `.tsx` and allows Electron only in the two entry files. `npm run typecheck` clean; `npm test` → 179 passed, 0 skipped.

2026-11-18, Packet B part 2, macOS arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 195 passed, 0 skipped (16 new: 7 notice-wording and fill, 8 chooser, 1 static check that `main.ts` registers `desktop.invoke`); `npm run test:e2e` → 19 passed, 0 skipped (6 new audio tests; the keyboard, narrow-layout, axe and no-bridge tests extended for the audio row and candidate). Time-limited mutations each failed tests: notice wording frozen (2 unit, 2 e2e), Cancel limited to rewrites (1 e2e), Transcribe ignoring its blocker (2 e2e), no focus move after Keep/Replace (1 e2e), no repeat-Import guard (1 e2e); the reviewer's `windowId: 0` mutation now fails the media contract tests. A probe of the binding's open/stat/read logic on macOS: a FIFO fails at once with "not a regular file"; a regular file reads normally.

Independent review findings, fixed: a FIFO or serial device picked in the chooser blocked forever and held the window's chooser slot; a stale rewrite after typing over a candidate was worded as a transcript notice; the chooser's window ID and `main.ts`'s use of `invoke` were untested; focus fell to the page after Replace/Keep; a stale "already open" note and a refusal hiding the still-chosen audio; no text for Transcribe's blockers or for a direct fill; `denied` wording; per-file Electron binding limits in the offline scan. Not checked: the Electron chooser binding in a real window (needs the Electron binary; covered by the planned offline Electron test), macOS/Windows packaging, a screen reader.

2026-11-18, Packet B part 3, macOS arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 207 passed, 0 skipped (12 new recorder tests); `npm run test:e2e` → 34 passed, 0 skipped (15 new recording tests; the keyboard, narrow-layout, axe and no-bridge tests extended for Record, the explanation and a recording). Time-limited mutations each failed tests: no explanation before the first prompt (1 unit, 2 e2e), endings accepted for any handle (1 unit, 1 e2e), no transcription after Stop (2 e2e), Import allowed during a recording (1 e2e), focus on Continue instead of the heading (2 e2e), an unread state treated as decided (1 unit, 1 e2e), focus moved away from the editor (1 e2e), early endings dropped (1 e2e).

Independent review findings, fixed: a double or held Enter on Record reached the OS prompt without the explanation being read; Record skipped the explanation while the state was unread, stale or unreadable; focus was pulled from the editor into Stop, and fell to the page after Continue → refusal and after Check again; a start that never answered blocked Import and Transcribe with no way out; the explanation was not read to screen readers and Escape did not close it; Check again with no text at launch; `unknown_outcome` worded as "nothing kept"; the transcription after Stop could target another selected asset; an ending before the start reply was lost; redundant announcements in the audio status. Not checked: any real microphone, OS prompt or capture (no ports; target OS not chosen), a screen reader.

2026-11-18, Packet D offline test in Electron 45.3.4, the Forge Vite production build: `npm run test:electron` → 6 passed, 0 skipped on macOS arm64 (Node 26.7.0), and in CI's `desktop-electron` job on Linux x64 under `xvfb-run` with Chromium's OS sandbox on. A mutation that put back the earlier `desktop.handle` registration in `main.ts` failed both import tests. The independent review's findings are fixed: the trap now covers raw sockets, every DNS resolver, preconnect and host resolution, other sessions and partitions, child processes, workers, `utilityProcess`, `shell` and spellchecker downloads (all proven by the self-check); runs use a throwaway profile; shutdown hits are read after close; a missing or stale build is refused; the docs say what the runtime layer cannot see; and spellchecking is off where it would download dictionaries (the first Linux CI run of the widened trap caught those downloads). `npm run typecheck` clean; `npm test` → 207 passed; `npm run test:e2e` → 34 passed.

2026-11-18, Stop confirm step (owner decision), macOS arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 208 passed, 0 skipped (1 new); `npm run test:e2e` → 40 passed, 0 skipped (6 new; four recording tests and the axe test updated). Time-limited mutations each failed tests: Stop transcribing at once again (6 e2e), focus on the confirm button instead of the heading (2 e2e), a confirmation that is never dropped (1 e2e), no confirming phase (1 unit, 8 e2e), Record ignored while the prompt is shown (1 e2e), focus on Record after the prompt (3 e2e). Independent review findings, fixed: Record did nothing while the prompt was shown; a double Enter on Transcribe recording or Not now started a new recording; "nothing was sent" outlived the send; one blocker sentence for four blockers; the prompt was not announced to screen readers. Not checked: a real microphone, a screen reader.

2026-11-18, Packet E part 4 (macOS capture), macOS 27.2.1 arm64, Node 26.7.0: `npm run typecheck` clean; `npm test` → 221 passed, 0 skipped (13 new); `npm run test:e2e` → 40 passed; `npm run test:electron` → 10 passed, 0 skipped (4 new capture tests, with Chromium's fake input device, asserted in force before every test; the packaged `Info.plist` checked for `LSMinimumSystemVersion` 15.0 and the microphone text). CI: the new macOS arm64 job ran all 10; Linux ran 6 and skipped the 4 macOS capture tests. Time-limited mutations each failed tests: any window allowed the microphone (1 Electron test), the capture window left open after Stop or Discard (2), audio at the device rate instead of 16 kHz (1 with the guard removed, caught by the wall-clock bound; 3 with it kept). Independent review findings, fixed: the time limit counted the device's start-up, so a full recording kept less than 30 s; nothing checked the 16 kHz rate or that tests used the fake device; the unsigned build's microphone grant risk was undocumented and the signing claim wrong; permission was not tied to the capture page's own URL and top frame, and a reload could re-grant it; smaller ordering and lifecycle points. Not checked: the real permission prompt, a real microphone, revoke or device loss on real hardware, a packaged install, macOS 15 or 26, a screen reader.

2026-11-21, chat-rewrite provider core (desktop-to-pipeline route, slice 2), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 241 passed, 0 skipped (20 new, and the job runner now passes the job ID to rewrite adapters). The pipeline's own contract test, outside this repository, sends the same vectors through its chat view. Time-limited mutations each failed tests (30 in two rounds): no `dispatched()`, a send outside it, the model echo removed, made case-insensitive or a prefix match, each pipeline-mark check removed or weakened, the old "every 4xx is a refusal" mapping, truncation allowed, NotSent ignored, each byte limit removed or counted in UTF-16 units, the abort signal not passed, a fixed idempotency key, an unsafe job ID allowed, and each pipeline-fit check removed.

Independent review findings, fixed: the pipeline answers 409 for `rewrite_outcome_unknown`, which the core reported as `route_unavailable`, so the app would have offered a retry, which is the replay the design forbids (2xx other than 200 and 3xx had the same problem); no idempotency key was sent, so the pipeline's replay protection never applied and nothing could reconcile by key; a fixture route could carry limits the pipeline refuses after dispatch; the reported identity was not tied to the model on the wire (now the route identity is the model); nine weak-test mutations survived; the README claimed a pipeline-side check that did not exist yet.

2026-11-21, UI fix: a visible keyboard focus ring (UI review), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm test` → 241 passed; `npm run test:e2e` → 45 passed, 0 skipped (5 new: the focus ring in light and dark, and the axe journey now in light and dark at 1100 and 760 wide instead of light only). The ring used the system `Highlight` color, a translucent selection color that measured 1.49:1 against the light background (WCAG 1.4.11 needs 3:1); it is now Chromium's own default ring colors, `#005fcc` in light (5.98:1) and `#99c8ff` in dark (10.76:1). Unavailable buttons were faded with `opacity: 0.6`, which also faded their focus ring to 2.79:1 in light mode (Rewrite keeps focus while unavailable); they now mix their colors toward the page instead, which looks the same and leaves the ring alone. The transcript candidate's border, which shared the old ring color, is now `CanvasText`, like the explanation's, so it never reads as focus. The ring test covers available and unavailable buttons and both editors, scales the ring by any opacity on the control or its ancestors, and fails on a color syntax it cannot read. The light-mode test failed before the fix. Time-limited mutations each failed tests after a rebuild: a low-contrast dark ring, no offset, a 1px ring, `Highlight` again, the old opacity on unavailable buttons, opacity on the focused button, and opacity on an ancestor.

Independent review findings, fixed: the opacity on unavailable buttons faded their ring below 3:1, and the test could not see opacity and checked only available controls; the color parser would have misread `color(srgb …)` instead of failing; a forced-colors fallback did nothing in Chromium and was removed.

2026-11-21, UI fix: A−/A+ keep keyboard focus (UI review), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 241 passed; `npm run test:e2e` → 46 passed, 0 skipped (1 new). A− and A+ used native `disabled`, so pressing A+ to the largest size (or A− to the smallest) blurred the button and dropped keyboard focus to the page; they now use `aria-disabled` with a guard, like Rewrite. The new test failed before the change (focus "inactive"). Independent review: no regressions; the onClick guards are belt and braces (the size already clamps, so removing them changes nothing observable), and the README's list of `aria-disabled` buttons was incomplete, now fixed.

2026-11-21, UI fix: error copy says what to do next (UI review, in part), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 241 passed; `npm run test:e2e` → 47 passed, 0 skipped (1 new, 1 extended). A refused rewrite said "denied" where transcription says "refused", and neither said why; both now say "refused because another job is running or an earlier outcome is still unknown" (main refuses while any job runs or any outcome is unknown, app-wide) and "If a job is running, try again when it finishes." A rejected input now says to shorten the transcript or steering, the only way it can happen (the renderer blocks a blank transcript first). A failed copy now tells two cases apart: when main no longer holds the draft (its handle was closed or evicted), "This draft can no longer be copied. Rewrite to get a new one."; when the clipboard write failed, "Couldn’t copy the draft. It is still shown here. Try copying again." The new and extended assertions failed before the change, and mutations that mapped every copy failure to one message each failed them. Left as they are: `unknown_outcome` (its next step is the Inspect/reconcile work, not built), `unsupported` and `provider_mismatch`, which the user cannot fix from here.

Independent review findings, fixed: "Wait for any running job to finish" was false when the cause was an unknown outcome the user cannot see (for example from a closed session), and "Try copying again" was false for a draft whose handle main had evicted.

2026-11-21, base rewrite route, part 1 (route card 07 and the loopback transport), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 257 passed, 0 skipped (16 new in `tests/contract/loopbackHttp.test.ts`, which uses a throwaway server on 127.0.0.1 inside the test process; `offline.test.ts` now allows `node:http` in `loopbackHttp.ts` only). No composition uses the transport yet, so the app is still offline. Time-limited mutations each failed tests: always or never "not sent", the abort ignored, no cap on the delivered body, reading a reply to its end, `localhost` instead of `127.0.0.1`, no pre-send abort check, no port check. One survived and is harmless: dropping the explicit `Connection: close` header, which Node already sends with `agent: false`.

Independent review findings, fixed: `agent: false` is load-bearing (with `NODE_USE_ENV_PROXY`, Node 24+ and Electron 45's Node 24.22 route the global agent through `HTTP_PROXY`) but no test caught its removal, now tested with a global proxy agent where the runtime supports one (skipped on a Node without that support, where there is nothing to reroute); the card's limits did not fit together (`max_tokens` 1,024 cannot hold a rewrite of a 16,000-byte transcript), now 4,096-byte transcripts and 8,192-byte drafts; the card overstated what the UI shows; the exception did not cover unknown retention, deletion and logging downstream or carry a date; the reconciliation choice (the user acknowledges, as there are no receipts to check) is now labelled a deviation from independent reconciliation; four weak-test mutations survived (no close after delivery, no reply error handlers, a hard-coded content type, `>=` at the cap), now each caught.

2026-11-21, UI: the design-token layer and primary actions (owner decision: a hand-written CSS layer, no component library; UI review), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm test` → 257 passed; `npm run test:e2e` → 49 passed, 0 skipped (2 new). `styles.css` now opens with tokens: surfaces and text keep the system colors so they follow macOS; semantic colors are explicit per scheme with measured contrast (accent and its label, danger, warning, success, muted, the focus ring); spacing and type sizes are rem tokens, so gaps now grow with A+ instead of staying fixed in pixels; the page and editor gutters stop growing at 5% and 2.5% of the window width, so on a narrow window the largest text keeps its column (at 320px they stay 16px and 8px). Rewrite and Copy draft are the primary actions (`.primary`): an accent fill with a 600-weight label (5.98:1 in light, 12.06:1 in dark), and when unavailable they take the colors of any other unavailable button (they keep their weight, so nothing shifts when availability flips). The new test failed before the change. axe found no violations in 42 screenshots of the main states, light and dark, at 1280 and 760 wide. Also fixed: a flaky layout assertion in the 320px largest-text test (about one failure in 300 runs of the full parallel suite), which measured the two panes in two reads right after a rewrite completed, while the status line could still re-wrap; it now waits for the rendered result and measures both panes in one pass (no failure in 1,470 repeated runs).

Independent review findings, fixed: at 320px and the largest text the doubled gutters took 64px of the window and squeezed the editors' text column from about 270px to 222px (now clamped to the window width, and asserted); the test did not check the primary's weight or Copy draft's unavailable look; the README said unavailable primaries look like any other unavailable button, but they keep their weight on purpose.

2026-11-21, UI: Discard and the recording state (UI review), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm test` → 264 passed; `npm run test:e2e` → 53 passed, 0 skipped (3 new). Discard, which drops the recording, looked exactly like Stop and sat 8px from it; it is now outlined in the danger color on the page fill (label 5.91:1 in light, 7.32:1 in dark) and 16px from Stop (a trailing gap on Stop, so Discard does not indent when it wraps). While the microphone is live, a 4px bar in the recording color marks the recorder, the status dot turns that color and the timer is bolder; all of it goes when recording ends. The label stays "Discard"; a confirm step or undo is a product decision not taken here. The new test failed before the change. axe found no violations in 40 screenshots of the main states.

Independent review findings, fixed: the gap was a leading margin on Discard, which indented it when it wrapped at 320px; nothing tested that the bar and red dot clear on an ending the user did not choose (the time limit, a lost device) or that Discard looks unavailable while a stop settles (both now tested).

2026-11-21, base rewrite route, part 2 (the wiring, route card 07), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 264 passed, 0 skipped (7 new; the chat core's "no composition registers it" test became "only route card 07 reaches it, behind main's switch"); `npm run test:e2e` → 50 passed (1 new: the header shows the route label). The guard, the switch, the composition and the header label are each covered; time-limited mutations each failed tests: no guard, a case-sensitive guard, the fixture route kept beside the base route, a switch that accepts any value, the marker dropped from the settings, and main turning the route on without the switch. The synthetic canary passed outside Electron and in the packaged app with the switch on, and an egress watch saw only the one loopback connection to the service.

Independent review findings, fixed: the guard checked the transcript but not the steering, which also goes to the service (now a non-empty steering must contain the marker too, and AGENTS and the route card say so); the offline Electron test inherited the route switch from the shell (it now removes it, so it always runs the fixture routes); the packaged-app canary had run on a build from before the rebase (re-run on a fresh build of the final code); stale wording in the README and `main.ts`. The reviewer confirmed that Vite does not inline the switch (main reads `process.env` at launch), that the switch cannot be bypassed or redirected, that there is no fallback route, and that `test:electron` passes (10 of 10) with the switch unset.

2026-11-21, UI: status colors (UI review), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm test` → 268 passed (1 new, `tests/unit/statusKind.test.ts`); `npm run test:e2e` → 60 passed, 0 skipped (4 new; counts after the first-send confirmation merged). Warnings and successes looked the same apart from a small glyph, and the `.status` class used in the markup had no rule. Each status line (audio, source, recorder, copy) now carries `data-kind` from the icon it shows (`src/renderer/statusKind.ts`), and warnings and successes take the warning and success colors (6.86 and 6.34:1 in light, 11.94 and 10.46:1 in dark); warnings are also bolder, since with red-green color blindness the two colors look alike. Information stays the body text color. Some icons now match their meaning: a cancel the user chose is information, not a warning; being over a size limit or waiting on an unknown outcome is a warning; audio that is ready but waiting is information, not a success; a recording ended by revoked access or a lost device is a warning and one stopped at the time limit is information. The words are unchanged. The new tests failed before the change, and time-limited mutations each failed them: no warning color or weight, an uncolored or miscolored copy status, an uncolored audio status, an ended recording shown as progress, and swapped kinds.

Independent review findings, fixed: a recording ended by revoked access or a lost device showed as progress, and ready-but-waiting audio as a success; three of the four status lines were effectively untested; warnings and successes were indistinguishable with red-green color blindness (now also bolder); a few icons did not match their meaning; the copy status mapped its kind inline rather than through `statusKind()`.

2026-11-21, first-send confirmation (route card 07's consent step), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 267 passed (3 new in `tests/unit/sendConsent.test.ts`); `npm run test:e2e` → 56 passed, 0 skipped (3 new). Behavior decision for review: see the rule above. The new tests failed before the change; time-limited mutations each failed them: never asking, asking every time, focus not moved after Send or after Not now, Send sending nothing, and a blocked Send going through.

Independent review findings, fixed: Send ignored a blocker that appeared while the region was open (an emptied transcript, a transcription started), so it recorded consent, sent nothing and dropped focus; focus fell to the page after Send; a double Enter on Not now reopened the region; the wording left out where the model runs and that it may keep a copy; the rule lived only in component state (now `sendConsent.ts`, unit-tested); the test helper's "completed" rewrite used the fixture identity on a base route.


2026-11-21, UI: grouping, a line-length cap and Check again (UI review), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 268 passed; `npm run test:e2e` → 64 passed, 0 skipped (4 new). Each label in both panes ("Transcript", "Steering (optional)", "Draft preview") now has more room above it than between it and its own field (16px against 8px at default size). Lines stay readable at every width: the content stops at 84rem on a very wide window and centers, and each pane stops at 41rem, which also covers the one-column layout below 920px (a preview line measured about 104 characters at 1920 wide and 99 at 919 wide; about 72 now). Both caps are in rem, so they grow with A+. Check again is sized to its label and aligned with the recorder's start edge. The new tests failed before the change; time-limited mutations each failed them: a fixed-pixel cap, no pane cap, Check again centered, and only one label grouped.

Independent review findings, fixed: below the 920px breakpoint the cap never applied, so a half-screen window still got about 92 characters a line (now each pane is capped); the Draft pane's label was not grouped; three weak-test mutations survived (the cap not growing with A+, Check again's position, the Transcript label), and the centering check assumed a 1920px viewport rather than the page's client width.

2026-11-26, the Inspect step (route card 07: the user acknowledges an unknown outcome), macOS 27.2.1 arm64, Node 26.7.0, development source: `npm run typecheck` clean; `npm test` → 306 passed, 0 skipped (38 new); `npm run test:e2e` → 83 passed, 0 skipped (19 new, among them axe with Inspect open, after a refusal and at the largest text size, in light and dark at 1280 and 760 wide); `npm run test:electron` → 10 passed (the façade test now lists `acknowledgeOutcome` and sends one through Electron to main, which answers `denied` for a job it never reported). No live model was called: the unknown outcome in the end-to-end contract test comes from a throwaway in-memory transport answering 500 after dispatch. 61 time-limited mutations, one guard or behavior removed each: 59 failed a test. Two survive by construction: counting no running jobs at the acknowledgment's call site (no intent can reach it today: one job runs at a time and none starts while an outcome is unknown; the rule itself is tested), and the composition skipping the synthetic-marker check (the marker is a compiled constant; the check itself is tested). Earlier runs found two gaps, now tested: focus after Acknowledge when main's reply arrives before its events, and Inspect reopening by itself on a later outcome.

Independent review findings, fixed: events main sent between its reply to `createSession` and the Composer's first subscription were lost (now buffered from before the call); "your transcript and steering were sent" claimed more than main knows (a timeout can fire after the job is handed over and before the request is out), and a time stamped 0 would show 1970; the panel's refusal line was mounted already filled, so a screen reader might not announce it; focus fell to the page when the gate cleared with it on the Inspect button, and was pulled out of the editor when an acknowledgment settled late; an older "You can try again" notice stayed on the status line while paused; an unknown outcome's request record could be evicted, so after acknowledging an identical retry would dispatch again; acknowledgment was not tied in code to the route being synthetic-only. Answered in the docs instead of changed: any window may acknowledge another window's outcome (restricting it to the job's window would strand an outcome after the window is closed and reopened from the Dock), and an acknowledgment reaches the job's own session as the same `reconciled` event as an independent reconciliation (nothing logs it).
