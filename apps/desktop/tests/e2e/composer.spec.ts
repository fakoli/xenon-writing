/**
 * Packet B acceptance (the delivery plan): keyboard journey,
 * whitespace gating, text size, narrow and long-line layout, screen-reader
 * labels, separate preview/source nodes, explicit copy and the stale-reply
 * rules, against a synthetic stand-in for Packet C's preload façade. Part 2
 * adds audio import, transcription and the Replace/Keep candidate (Packet E
 * in the shell); part 3 adds Record, the explanation before the first
 * microphone prompt, the timer and Stop/Discard. Fictional text only; no
 * provider, file, microphone or network.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ORIGIN = 'https://xenon.test';
const DIST = path.resolve('.e2e-dist');
const FIXTURE_ROUTE = {
  routeKey: 'fixture-base',
  mode: 'fixture',
  identity: 'fixture-v1',
  limits: { transcriptBytes: 16 * 1024, steeringBytes: 2 * 1024, draftBytes: 24 * 1024 },
  stage: 'rewrite',
  label: 'Synthetic fixture',
  locationClass: 'synthetic',
  readiness: 'ready',
};
const ASR_ROUTE = { ...FIXTURE_ROUTE, routeKey: 'fixture-transcribe', identity: 'fixture-asr-v1', stage: 'transcribe' };
const CHOSEN = { status: 'chosen', assetToken: 'a1', summary: { format: 'wav-pcm16-mono-16k', durationMs: 2500, bytes: 80044 } };

type Win = Window & Record<string, any>;

/** Synthetic stand-in for Packet C's preload façade (`window.xenon`). */
function installBridge({ routes, chosen, mic, unresolved, early }: { routes: unknown[]; chosen: unknown; mic: string; unresolved: any[]; early: any[] }) {
  const w = window as Win;
  const listeners = new Set<(event: unknown) => void>();
  const ok = (value: unknown) => Promise.resolve({ ok: true, value });
  w.__sent = [];
  w.__cancelled = [];
  w.__copied = [];
  w.__copyOk = true;
  w.__transcribed = [];
  w.__chooseResult = { ok: true, value: chosen };
  w.__chooseCalls = 0;
  w.__chooseHold = false;
  w.__mic = mic;
  w.__micCalls = 0;
  w.__micHold = false;
  w.__micFail = false;
  w.__startCalls = 0;
  w.__startHold = false;
  w.__startResult = { ok: true, value: { status: 'recording', captureHandle: 'c1', maxDurationMs: 30_000 } };
  w.__stopped = [];
  w.__stopResult = { ok: true, value: { status: 'chosen', assetToken: 'a2', summary: { format: 'wav-pcm16-mono-16k', durationMs: 4000, bytes: 128044 } } };
  w.__discarded = [];
  w.__acked = [];
  w.__ackResult = { ok: true, value: { status: 'acknowledged' } };
  w.__ackHold = false;
  w.__ackEventsLate = false;
  // Unknown outcomes main would know of: { kind, jobId, clientRequestId (null for another session's) }.
  w.__outcomes = unresolved.map((o) => ({ kind: o.kind, jobId: o.jobId, clientRequestId: null }));
  w.__emit = (event: unknown) => listeners.forEach((listener) => listener(event));
  w.xenon = {
    createSession: () => {
      // Events main sends right after its reply, before the renderer has subscribed to anything of its own.
      if (early.length > 0) queueMicrotask(() => early.forEach((e) => w.__emit({ v: 1, sessionId: 's1', epoch: 1, ...e })));
      return ok({ v: 1, sessionId: 's1', epoch: 1, capabilities: { actions: ['rewrite', 'cancel', 'copyDraft', 'chooseAudio', 'transcribe', 'capture'], routes }, unresolved });
    },
    acknowledgeOutcome: (request: any) => {
      w.__acked.push(request);
      // Like main: on success the events (reconciled for this session's own request, then cleared) go out before the reply.
      // With __ackEventsLate the reply arrives first and the test sends the events with __flushAck.
      const answer = () => {
        const result = w.__ackResult;
        const known = (w.__outcomes as any[]).find((o) => o.jobId === request.jobId);
        if (result.ok && known !== undefined) {
          w.__outcomes = (w.__outcomes as any[]).filter((o) => o !== known);
          const envelope = { v: 1, sessionId: 's1', epoch: 1 };
          const events = () => {
            if (known.clientRequestId !== null) w.__emit({ ...envelope, type: `${known.kind}.reconciled`, clientRequestId: known.clientRequestId, jobId: known.jobId });
            w.__emit({ ...envelope, type: 'outcome.cleared', kind: known.kind, jobId: known.jobId });
          };
          if (w.__ackEventsLate) w.__flushAck = events;
          else events();
        }
        return result;
      };
      return w.__ackHold ? new Promise((resolve) => (w.__answerAck = () => resolve(answer()))) : Promise.resolve(answer());
    },
    rewrite: (request: unknown) => (w.__sent.push(request), ok({})),
    chooseAudio: () => {
      w.__chooseCalls += 1;
      // When held, the dialog stays open until the test answers it.
      return w.__chooseHold ? new Promise((resolve) => (w.__answerChooser = resolve)) : Promise.resolve(w.__chooseResult);
    },
    transcribe: (request: unknown) => (w.__transcribed.push(request), ok({})),
    microphoneStatus: () => {
      w.__micCalls++;
      if (w.__micFail) return Promise.resolve({ ok: false, code: 'unknown_outcome' });
      return w.__micHold ? new Promise((resolve) => (w.__answerMic = () => resolve({ ok: true, value: { microphone: w.__mic } }))) : ok({ microphone: w.__mic });
    },
    startCapture: () => {
      w.__startCalls++;
      // When held, the OS prompt or device is still starting until the test answers.
      return w.__startHold ? new Promise((resolve) => (w.__answerStart = () => resolve(w.__startResult))) : Promise.resolve(w.__startResult);
    },
    stopCapture: (request: unknown) => (w.__stopped.push(request), Promise.resolve(w.__stopResult)),
    discardCapture: (request: unknown) => (w.__discarded.push(request), ok({ status: 'discarded' })),
    cancel: (request: unknown) => (w.__cancelled.push(request), ok({ disposition: 'cancel_requested' })),
    copyDraft: (request: unknown) => {
      w.__copied.push(request);
      return w.__copyOk ? ok({ status: 'copied' }) : Promise.resolve({ ok: false, code: w.__copyCode ?? 'denied' });
    },
    onEvent: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function open(page: Page, opts: { bridge?: boolean; mic?: string; routes?: unknown[]; unresolved?: unknown[]; early?: unknown[] } = {}) {
  const errors: string[] = [];
  const offsite: string[] = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', (err) => errors.push(err.message));
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      offsite.push(url.href);
      return route.abort();
    }
    const file = path.join(DIST, decodeURIComponent(url.pathname));
    if (!file.startsWith(DIST)) return route.abort();
    try {
      await readFile(file);
      return route.fulfill({ path: file });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
  if (opts.bridge !== false) {
    await page.addInitScript(installBridge, {
      routes: opts.routes ?? [FIXTURE_ROUTE, ASR_ROUTE],
      chosen: CHOSEN,
      mic: opts.mic ?? 'not_requested',
      unresolved: opts.unresolved ?? [],
      early: opts.early ?? [],
    });
  }
  await page.goto(`${ORIGIN}/index.html`);
  await expect(page.getByRole('heading', { name: 'Session' })).toBeVisible();
  return { errors, offsite };
}

const transcript = (page: Page) => page.getByRole('textbox', { name: 'Transcript' });
const steering = (page: Page) => page.getByRole('textbox', { name: 'Steering (optional)' });
const rewriteButton = (page: Page) => page.getByRole('button', { name: 'Rewrite' });
const cancelButton = (page: Page) => page.getByRole('button', { name: 'Cancel' });
const preview = (page: Page) => page.locator('.preview');
const status = (page: Page) => page.locator('#source-status');
const copyButton = (page: Page) => page.getByRole('button', { name: /^Copy (previous )?draft$/ });
const copyStatus = (page: Page) => page.locator('#copy-status');
const importButton = (page: Page) => page.getByRole('button', { name: 'Import audio' });
const transcribeButton = (page: Page) => page.getByRole('button', { name: 'Transcribe', exact: true });
const audioStatus = (page: Page) => page.locator('#audio-status');
const candidate = (page: Page) => page.getByRole('region', { name: 'Transcript from audio' });
const recordButton = (page: Page) => page.getByRole('button', { name: 'Record', exact: true });
const recordStatus = (page: Page) => page.locator('#record-status');
const explanation = (page: Page) => page.getByRole('region', { name: 'Before you record' });
const confirmation = (page: Page) => page.getByRole('region', { name: 'Transcribe this recording?' });
const confirmButton = (page: Page) => page.getByRole('button', { name: 'Transcribe recording' });
const win = <T,>(page: Page, key: string) => page.evaluate((k) => (window as Win)[k], key) as Promise<T>;

/** Record → (explanation) → Continue, ending in a recording on screen. */
async function startRecording(page: Page) {
  await recordButton(page).click();
  if (await explanation(page).isVisible()) await page.getByRole('button', { name: 'Continue' }).click();
  await expect(recordStatus(page)).toContainText('Recording. Stop keeps it; Discard keeps nothing.');
}

/** Last request the renderer sent through the bridge. */
async function lastSent(page: Page) {
  return page.evaluate(() => {
    const sent = (window as Win).__sent as any[];
    return sent[sent.length - 1];
  });
}

/** Imports the stubbed audio and starts transcribing it; returns the request sent. */
async function startTranscription(page: Page) {
  await importButton(page).click();
  await expect(audioStatus(page)).toHaveText('✓ Audio ready: 2.5 seconds of WAV.');
  await transcribeButton(page).click();
  return page.evaluate(() => {
    const sent = (window as Win).__transcribed as any[];
    return sent[sent.length - 1];
  });
}

/** Accepts and completes a transcription with synthetic text. */
async function transcribed(page: Page, req: any, text: string, jobId = 't-j1') {
  const ids = { clientRequestId: req.clientRequestId, jobId, sourceRevision: req.sourceRevision };
  await emit(page, { type: 'transcribe.accepted', ...ids });
  await emit(page, { type: 'transcribe.succeeded', ...ids, actualMode: 'fixture', actualIdentity: 'fixture-asr-v1', text });
}

async function emit(page: Page, event: Record<string, unknown>) {
  await page.evaluate((e) => (window as Win).__emit(e), { v: 1, sessionId: 's1', epoch: 1, ...event });
}

/** Accepts and completes the in-flight request with a synthetic draft. */
async function complete(page: Page, text: string, jobId = 'j1', route: { mode: string; identity: string } = { mode: 'fixture', identity: 'fixture-v1' }) {
  const req = await lastSent(page);
  const ids = {
    clientRequestId: req.clientRequestId,
    jobId,
    sourceRevision: req.sourceRevision,
    steeringRevision: req.steeringRevision,
  };
  await emit(page, { type: 'rewrite.accepted', ...ids });
  await emit(page, {
    type: 'rewrite.succeeded',
    ...ids,
    actualMode: route.mode,
    actualIdentity: route.identity,
    text,
    draftHandle: `d-${jobId}`,
  });
}

test('keyboard-only journey from empty session to a reviewable draft', async ({ page }) => {
  const { errors, offsite } = await open(page);
  await expect(preview(page)).toHaveText('Nothing generated yet');
  await expect(page.locator('.identity')).toHaveText('Model: fixture-v1 (synthetic)');

  // Logical order: text size, audio, transcript, steering, rewrite, cancel, preview, copy.
  const order = ['A− Decrease text size', 'A+ Increase text size', 'Import audio', 'Record', 'Transcribe', 'Transcript', 'Steering (optional)', 'Rewrite', 'Cancel'];
  for (const name of order) {
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAccessibleName(name);
  }
  await page.keyboard.press('Tab');
  await expect(preview(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveAccessibleName('Copy draft');
  await expect(copyButton(page)).toBeDisabled();

  await transcript(page).focus();
  await page.keyboard.type('Meet Thursday at noon.');
  await page.keyboard.press('Enter'); // Enter inserts a newline, it does not submit.
  await page.keyboard.type('Bring the agenda.');
  await expect(transcript(page)).toHaveValue('Meet Thursday at noon.\nBring the agenda.');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Use one sentence.');
  await page.keyboard.press('Tab');
  await expect(rewriteButton(page)).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(status(page)).toContainText('Rewriting');
  await expect(rewriteButton(page)).toBeFocused(); // focus survives the state change
  const req = await lastSent(page);
  expect(req).toMatchObject({ v: 1, sessionId: 's1', epoch: 1, routeKey: 'fixture-base', transcript: 'Meet Thursday at noon.\nBring the agenda.', steering: 'Use one sentence.' });

  await complete(page, 'Meet Thursday at noon and bring the agenda.');
  await expect(preview(page)).toHaveText('Meet Thursday at noon and bring the agenda.');
  await expect(page.getByText('Current draft', { exact: true })).toBeVisible();
  await expect(status(page)).toContainText('Draft ready for review.');
  // Preview and source are different nodes; the source is untouched.
  await expect(transcript(page)).toHaveValue('Meet Thursday at noon.\nBring the agenda.');
  expect(await preview(page).evaluate((el) => el.tagName)).not.toBe('TEXTAREA');
  expect(errors).toEqual([]);
  expect(offsite).toEqual([]);
});

test('rewrite is not enabled for empty or whitespace-only transcript', async ({ page }) => {
  await open(page);
  await expect(rewriteButton(page)).toBeDisabled();
  await expect(status(page)).toContainText('Type a transcript to rewrite.');
  await transcript(page).fill('   \n\t  ');
  await steering(page).fill('Use one sentence.');
  await expect(rewriteButton(page)).toBeDisabled();
  await rewriteButton(page).click({ force: true });
  expect(await page.evaluate(() => (window as Win).__sent.length)).toBe(0);
  await transcript(page).fill(' Hi. ');
  await expect(rewriteButton(page)).toBeEnabled();
});

test('a late reply never overwrites edits made during a rewrite', async ({ page }) => {
  await open(page);
  await transcript(page).fill('Meet Thursday at noon.');
  await rewriteButton(page).click();
  await transcript(page).fill('Meet Friday at noon.');
  await complete(page, 'Meet Thursday at twelve.');
  await expect(transcript(page)).toHaveValue('Meet Friday at noon.');
  await expect(preview(page)).toHaveText('Nothing generated yet');
  await expect(status(page)).toContainText('Draft not applied because the text changed');
});

test('cancel keeps edits and the previous draft, labelled as previous', async ({ page }) => {
  await open(page);
  await transcript(page).fill('Meet at noon.');
  await rewriteButton(page).click();
  await complete(page, 'Meet at noon, please.');
  await steering(page).fill('Make it formal.');
  await expect(page.getByText('Previous draft', { exact: true })).toBeVisible();
  await rewriteButton(page).click();
  await cancelButton(page).click();

  await expect(status(page)).toContainText('Rewrite cancelled. Your edits and the previous draft are kept.');
  await expect(preview(page)).toHaveText('Meet at noon, please.');
  await expect(page.getByText('Previous draft', { exact: true })).toBeVisible();
  await expect(steering(page)).toHaveValue('Make it formal.');
  const cancelled = await page.evaluate(() => (window as Win).__cancelled);
  expect(cancelled).toHaveLength(1);
  // Outcome of the cancelled job is unknown until main reports it.
  await expect(rewriteButton(page)).toBeDisabled();
});

test('copy is explicit, sends only the draft handle and reports the result', async ({ page }) => {
  await open(page);
  await copyButton(page).click({ force: true });
  expect(await page.evaluate(() => (window as Win).__copied.length)).toBe(0);
  await transcript(page).fill('Meet at noon.');
  await rewriteButton(page).click();
  await complete(page, 'Meet at noon, please.');
  await copyButton(page).click();
  await expect(copyStatus(page)).toHaveText('✓ Draft copied to the clipboard.');
  expect(await page.evaluate(() => (window as Win).__copied)).toEqual([{ v: 1, sessionId: 's1', epoch: 1, draftHandle: 'd-j1' }]);

  // An edit makes the shown draft stale: the button names it before copying it.
  await steering(page).fill('Shorter.');
  await expect(page.getByRole('button', { name: 'Copy previous draft' })).toBeVisible();
  await page.evaluate(() => ((window as Win).__copyOk = false));
  await copyButton(page).click();
  // Main no longer holds the draft (closed or evicted): retrying cannot work, so say what can.
  await expect(copyStatus(page)).toHaveText('⚠ This draft can no longer be copied. Rewrite to get a new one.');
  // A clipboard failure is an unknown outcome: retrying is honest.
  await page.evaluate(() => ((window as Win).__copyCode = 'unknown_outcome'));
  await copyButton(page).click();
  await expect(copyStatus(page)).toHaveText('⚠ Couldn’t copy the draft. It is still shown here. Try copying again.');
  await expect(preview(page)).toHaveText('Meet at noon, please.');
});

test('draft text containing markup is shown as text, not rendered', async ({ page }) => {
  await open(page);
  await transcript(page).fill('Fictional note.');
  await rewriteButton(page).click();
  const markup = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
  await complete(page, markup);
  await expect(preview(page)).toHaveText(markup);
  expect(await preview(page).locator('img, b').count()).toBe(0);
  expect(await page.evaluate(() => (window as Win).__pwned)).toBeUndefined();
});

test('A− and A+ scale text within bounds', async ({ page }) => {
  await open(page);
  const size = () => transcript(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(await size()).toBe(20);
  const bigger = page.getByRole('button', { name: 'Increase text size' });
  const smaller = page.getByRole('button', { name: 'Decrease text size' });
  await bigger.click();
  expect(await size()).toBeGreaterThan(20);
  for (let i = 0; i < 10; i++) if (await bigger.isEnabled()) await bigger.click();
  await expect(bigger).toBeDisabled();
  expect(await size()).toBe(40);
  for (let i = 0; i < 10; i++) if (await smaller.isEnabled()) await smaller.click();
  await expect(smaller).toBeDisabled();
  expect(await size()).toBe(17.5);
});

test('a refused or rejected rewrite says what to do next, with the same verb as transcription', async ({ page }) => {
  await open(page);
  for (const [code, next] of [
    ['denied', 'Rewrite was refused because another job is running or an earlier outcome is still unknown. Your edits and the previous draft are kept. If a job is running, try again when it finishes.'],
    ['invalid_input', 'The route rejected this input. Your edits and the previous draft are kept. Shorten the transcript or steering, then try again.'],
  ] as const) {
    await transcript(page).fill(`Meet at noon (${code}).`);
    await rewriteButton(page).click();
    const req = await lastSent(page);
    await emit(page, { type: 'rewrite.failed', v: 1, sessionId: 's1', epoch: 1, clientRequestId: req.clientRequestId, jobId: null, code });
    await expect(status(page)).toHaveText(`⚠ ${next}`);
  }
});

test('A− and A+ keep keyboard focus at the ends of the range, and do nothing there', async ({ page }) => {
  await open(page);
  const size = () => transcript(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const bigger = page.getByRole('button', { name: 'Increase text size' });
  const smaller = page.getByRole('button', { name: 'Decrease text size' });
  await bigger.focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Enter');
  // Two frames, so a blur from the state change would have happened.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(bigger).toBeFocused();
  await expect(bigger).toHaveAttribute('aria-disabled', 'true');
  expect(await size()).toBe(40);
  await page.keyboard.press('Space');
  expect(await size()).toBe(40);
  await page.keyboard.press('Shift+Tab');
  await expect(smaller).toBeFocused();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(smaller).toBeFocused();
  await expect(smaller).toHaveAttribute('aria-disabled', 'true');
  await expect(bigger).toHaveAttribute('aria-disabled', 'false');
  expect(await size()).toBe(17.5);
});

for (const scale of ['default', 'largest']) {
  test(`320px wide at ${scale} text: stacked, no horizontal scroll, actions reachable`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    if (scale === 'largest') {
      const bigger = page.getByRole('button', { name: 'Increase text size' });
      while (await bigger.isEnabled()) await bigger.click();
      // Gutters grow with the text but stay narrow here, so the large text keeps its column.
      expect(await page.locator('.app').evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))).toBeLessThanOrEqual(16);
      expect(await transcript(page).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))).toBeLessThanOrEqual(8);
    }
    await transcript(page).fill('x'.repeat(2000)); // one long unbroken line
    await rewriteButton(page).click();
    await complete(page, 'y'.repeat(3000));
    // Measure only once the result has rendered: the status line re-wraps as it settles.
    await expect(preview(page)).toHaveText('y'.repeat(3000));
    await expect(status(page)).toContainText('Draft ready for review.');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const el of [transcript(page), preview(page)]) {
      expect(await el.evaluate((n) => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(0);
    }
    // Both panes in one layout pass, so a reflow between two reads cannot skew them.
    const { sourceBottom, draftTop } = await page.evaluate(() => {
      const source = document.querySelector('.pane.source')!.getBoundingClientRect();
      const draft = document.querySelector('.pane.draft')!.getBoundingClientRect();
      return { sourceBottom: source.bottom, draftTop: draft.top };
    });
    expect(draftTop).toBeGreaterThanOrEqual(sourceBottom);
    for (const name of ['Decrease text size', 'Increase text size', 'Import audio', 'Record', 'Transcribe', 'Rewrite', 'Cancel']) {
      const button = page.getByRole('button', { name, exact: name === 'Record' }); // not "Recording…"
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
    }
  });
}

test('each label sits closer to its own field than to whatever is above it, in both panes', async ({ page }) => {
  await open(page);
  // Gaps around each label, from the element just before it to the field just after it, in one layout pass.
  const gaps = await page.evaluate(() =>
    ['label[for="transcript"]', 'label[for="steering"]', '.preview-label'].map((selector) => {
      const label = document.querySelector(selector)!;
      const above = label.previousElementSibling!.getBoundingClientRect();
      const below = label.nextElementSibling!.getBoundingClientRect();
      const own = label.getBoundingClientRect();
      return { selector, above: own.top - above.bottom, below: below.top - own.bottom };
    }),
  );
  for (const gap of gaps) expect(gap.above, gap.selector).toBeGreaterThan(gap.below);
});

test('on a very wide window the content keeps a readable line length, and the cap grows with A+', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page);
  const measure = () =>
    page.evaluate(() => {
      const app = document.querySelector('.app')!.getBoundingClientRect();
      return { rem: parseFloat(getComputedStyle(document.documentElement).fontSize), left: app.left, width: app.width, right: document.documentElement.clientWidth - app.right };
    });
  const normal = await measure();
  expect(normal.width).toBeLessThanOrEqual(84 * normal.rem + 1);
  expect(Math.abs(normal.left - normal.right), 'centered').toBeLessThanOrEqual(2);
  // At the largest text the cap is still 84rem, so it is wider in pixels.
  await page.setViewportSize({ width: 3840, height: 1080 });
  const bigger = page.getByRole('button', { name: 'Increase text size' });
  while (await bigger.isEnabled()) await bigger.click();
  const largest = await measure();
  expect(largest.rem).toBeGreaterThan(normal.rem);
  expect(Math.abs(largest.width - 84 * largest.rem)).toBeLessThanOrEqual(1);
});

test('in one column, the panes keep a readable line length too', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await open(page);
  const { rem, pane } = await page.evaluate(() => ({
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
    pane: document.querySelector('.pane.draft')!.getBoundingClientRect().width,
  }));
  expect(pane).toBeLessThanOrEqual(41 * rem + 1);
});

test('Check again is sized to its label, not stretched across the pane', async ({ page }) => {
  await open(page, { mic: 'denied' });
  const check = page.getByRole('button', { name: 'Check again' });
  await expect(check).toBeVisible();
  const [button, pane, recorder] = [await check.boundingBox(), await page.locator('.pane.source').boundingBox(), await page.locator('.recorder').boundingBox()];
  expect(button!.width).toBeLessThan(pane!.width / 2);
  expect(Math.abs(button!.x - recorder!.x), 'aligned with the recorder\'s start edge').toBeLessThanOrEqual(1);
});

test('two columns at 920px and wider', async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 700 });
  await open(page);
  const source = await page.locator('.pane.source').boundingBox();
  const draft = await page.locator('.pane.draft').boundingBox();
  expect(draft!.x).toBeGreaterThan(source!.x + source!.width - 1);
});

/** WCAG relative luminance of an sRGB channel triple. */
function luminance([r, g, b]: number[]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r! / 255) + 0.7152 * lin(g! / 255) + 0.0722 * lin(b! / 255);
}

/**
 * Parses a computed `rgb()`/`rgba()` color, scales its alpha by any element
 * opacity, and composites it over an opaque background. Any other color
 * syntax fails the test rather than being misread.
 */
function over(color: string, background: number[], opacity = 1): number[] {
  check(/^rgba?\(/.test(color), `unexpected color syntax ${color}`);
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
  check(parts.length >= 3, `unparsed color ${color}`);
  const alpha = (parts.length >= 4 ? parts[3]! : 1) * opacity;
  return [0, 1, 2].map((i) => parts[i]! * alpha + background[i]! * (1 - alpha));
}
function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the keyboard focus ring is visible on every control kind (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await open(page);
    await transcript(page).fill('Meet at noon.');
    const background = over(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), [255, 255, 255]);
    // Available and unavailable (aria-disabled) buttons, and both editors.
    await expect(cancelButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(transcribeButton(page)).toHaveAttribute('aria-disabled', 'true');
    const controls = [importButton(page), rewriteButton(page), cancelButton(page), transcribeButton(page), page.getByRole('button', { name: 'A+' }), transcript(page), steering(page)];
    for (const control of controls) {
      // Reach each control by keyboard so :focus-visible applies.
      await control.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(control).toBeFocused();
      const ring = await control.evaluate((el) => {
        const style = getComputedStyle(el);
        // Opacity on the control or an ancestor fades its outline too, and outlineColor does not show it.
        let opacity = 1;
        for (let node: Element | null = el; node !== null; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity);
        return { color: style.outlineColor, opacity, style: style.outlineStyle, width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset) };
      });
      const name = await control.evaluate((el) => el.getAttribute('aria-label') ?? el.textContent ?? el.id);
      expect(ring.style, name).not.toBe('none');
      expect(ring.width, name).toBeGreaterThanOrEqual(2);
      // The ring sits outside the control (offset), on the page background: WCAG 1.4.11 needs 3:1.
      expect(ring.offset, name).toBeGreaterThan(0);
      expect(contrast(over(ring.color, background, ring.opacity), background), name).toBeGreaterThanOrEqual(3);
    }
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Rewrite and Copy draft are the primary actions, readable, and look unavailable when they are (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await open(page);
    const look = (locator: ReturnType<typeof rewriteButton>) =>
      locator.evaluate((el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, color: style.color, weight: Number(style.fontWeight) };
      });
    const colors = async (locator: ReturnType<typeof rewriteButton>) => {
      const { background, color } = await look(locator);
      return { background, color };
    };
    // Unavailable: Rewrite and Copy draft take the colors of any other unavailable button
    // (they keep their weight, so nothing shifts when availability flips).
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(copyButton(page)).toHaveAttribute('aria-disabled', 'true');
    expect(await colors(rewriteButton(page))).toEqual(await colors(cancelButton(page)));
    expect(await colors(copyButton(page))).toEqual(await colors(cancelButton(page)));
    await transcript(page).fill('Meet at noon.');
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'false');
    await rewriteButton(page).click();
    await complete(page, 'Meet at noon, please.');
    // Available: Rewrite and Copy draft stand apart from a secondary button.
    const page_bg = over(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), [255, 255, 255]);
    const secondary = await look(importButton(page));
    for (const primary of [rewriteButton(page), copyButton(page)]) {
      await expect(primary).toHaveAttribute('aria-disabled', 'false');
      const { background, color, weight } = await look(primary);
      expect(background).not.toBe(secondary.background);
      expect(weight).toBeGreaterThanOrEqual(600);
      const fill = over(background, page_bg);
      expect(contrast(over(color, fill), fill), 'label on the primary fill').toBeGreaterThanOrEqual(4.5);
      expect(contrast(fill, page_bg), 'the fill against the page').toBeGreaterThanOrEqual(3);
    }
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`while recording, Discard stands apart from Stop and the recording state is visible (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await open(page);
    const page_bg = over(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), [255, 255, 255]);
    const recorder = page.locator('.recorder');
    const startBorder = () => recorder.evaluate((el) => ({ width: parseFloat(getComputedStyle(el).borderInlineStartWidth), color: getComputedStyle(el).borderInlineStartColor }));
    expect((await startBorder()).width, 'no recording bar while idle').toBe(0);
    await recordButton(page).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('timer')).toBeVisible();
    const stop = page.getByRole('button', { name: 'Stop' });
    const discard = page.getByRole('button', { name: 'Discard' });
    // Discard is drawn as a destructive action: danger-colored label and border, readable on its own fill.
    const d = await discard.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, background: style.backgroundColor, border: style.borderTopColor };
    });
    const s = await stop.evaluate((el) => getComputedStyle(el).color);
    expect(d.color).not.toBe(s);
    const fill = over(d.background, page_bg);
    expect(contrast(over(d.color, fill), fill), 'Discard label').toBeGreaterThanOrEqual(4.5);
    expect(contrast(over(d.border, page_bg), page_bg), 'Discard border').toBeGreaterThanOrEqual(3);
    // And it is not right next to Stop.
    const [stopBox, discardBox] = [await stop.boundingBox(), await discard.boundingBox()];
    expect(discardBox!.x - (stopBox!.x + stopBox!.width)).toBeGreaterThanOrEqual(16);
    // A bar in the recording color marks the recorder, and the status dot uses it too.
    const bar = await startBorder();
    expect(bar.width).toBeGreaterThanOrEqual(3);
    expect(contrast(over(bar.color, page_bg), page_bg), 'recording bar').toBeGreaterThanOrEqual(3);
    const dotColor = () => page.locator('#record-status [aria-hidden="true"]').evaluate((el) => getComputedStyle(el).color);
    expect(await dotColor()).toBe(bar.color);
    // An ending the user did not choose (the time limit): the microphone is off, so the bar and red dot go.
    await emit(page, { type: 'capture.ended', captureHandle: 'c1', reason: 'max_duration' });
    await expect(page.getByRole('button', { name: 'Keep audio' })).toBeVisible();
    expect((await startBorder()).width, 'no bar once recording ends').toBe(0);
    expect(await dotColor()).not.toBe(bar.color);
    await discard.click();
    await expect(page.getByRole('timer')).toHaveCount(0);
    expect((await startBorder()).width).toBe(0);
  });
}

test('while a stop is settling, Discard looks unavailable like any other button', async ({ page }) => {
  await open(page);
  await recordButton(page).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('timer')).toBeVisible();
  // The stop never answers, so the recorder stays settling.
  await page.evaluate(() => {
    (window as Win).__stopResult = new Promise(() => {});
  });
  await page.getByRole('button', { name: 'Stop' }).click();
  const discard = page.getByRole('button', { name: 'Discard' });
  await expect(discard).toHaveAttribute('aria-disabled', 'true');
  const colors = (locator: ReturnType<typeof rewriteButton>) =>
    locator.evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, border: getComputedStyle(el).borderTopColor }));
  expect(await colors(discard)).toEqual(await colors(cancelButton(page)));
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`warnings and successes are told apart by color as well as icon (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await open(page);
    const page_bg = over(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), [255, 255, 255]);
    const text = over(await page.evaluate(() => getComputedStyle(document.body).color), page_bg);
    const look = (id: string) =>
      page.locator(`#${id}`).evaluate((el) => ({ kind: el.getAttribute('data-kind'), color: getComputedStyle(el).color }));
    // Plain information stays the body text color.
    expect((await look('source-status')).kind).toBe('info');
    expect(over((await look('source-status')).color, page_bg)).toEqual(text);
    // A success: green, readable.
    await transcript(page).fill('Meet at noon.');
    await rewriteButton(page).click();
    await complete(page, 'Meet at noon, please.');
    await expect(status(page)).toContainText('Draft ready');
    const success = await look('source-status');
    expect(success.kind).toBe('success');
    expect(over(success.color, page_bg)).not.toEqual(text);
    expect(contrast(over(success.color, page_bg), page_bg)).toBeGreaterThanOrEqual(4.5);
    // A warning: a different color, readable, on the rewrite status and on a failed copy.
    await steering(page).fill('Shorter.');
    await rewriteButton(page).click();
    const req = await lastSent(page);
    await emit(page, { type: 'rewrite.failed', v: 1, sessionId: 's1', epoch: 1, clientRequestId: req.clientRequestId, jobId: null, code: 'timed_out' });
    await expect(status(page)).toContainText('timed out');
    const warning = await look('source-status');
    expect(warning.kind).toBe('warning');
    expect(over(warning.color, page_bg)).not.toEqual(text);
    expect(warning.color).not.toBe(success.color);
    expect(contrast(over(warning.color, page_bg), page_bg)).toBeGreaterThanOrEqual(4.5);
    await page.evaluate(() => ((window as Win).__copyOk = false));
    await copyButton(page).click();
    await expect(copyStatus(page)).toHaveAttribute('data-kind', 'warning');
    expect(await look('copy-status')).toEqual(warning);
    // Warnings are bolder too, a cue that does not depend on telling the colors apart.
    expect(await page.locator('#source-status').evaluate((el) => Number(getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600);
  });

  test(`every status line takes the kind its state means (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await open(page);
    const kind = (id: string) => page.locator(`#${id}`).getAttribute('data-kind');
    // A successful copy is a success.
    await transcript(page).fill('Meet at noon.');
    await rewriteButton(page).click();
    await complete(page, 'Meet at noon, please.');
    await copyButton(page).click();
    await expect(copyStatus(page)).toHaveAttribute('data-kind', 'success');
    // Audio: none chosen is information, chosen is a success, chosen but waiting is information again.
    expect(await kind('audio-status')).toBe('info');
    await importButton(page).click();
    await expect(audioStatus(page)).toHaveAttribute('data-kind', 'success');
    await transcribeButton(page).click();
    const req = await page.evaluate(() => {
      const sent = (window as Win).__transcribed as unknown[];
      return sent[sent.length - 1];
    });
    await transcribed(page, req, 'Meet at one.');
    // A transcript is waiting for Replace or Keep, so the audio is ready but waiting: information.
    await expect(audioStatus(page)).toContainText('Replace or keep');
    await expect(audioStatus(page)).toHaveAttribute('data-kind', 'info');
    await page.getByRole('button', { name: 'Keep existing' }).click();
    await expect(audioStatus(page)).toHaveAttribute('data-kind', 'success');
    // The recorder: empty has no kind; recording keeps its red dot; a lost microphone is a warning.
    expect(await kind('record-status')).toBeNull();
    await recordButton(page).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(recordStatus(page)).toHaveAttribute('data-kind', 'recording');
    await emit(page, { type: 'capture.ended', captureHandle: 'c1', reason: 'device_lost' });
    await expect(recordStatus(page)).toHaveAttribute('data-kind', 'warning');
  });
}


/** Rendered copy and accessible names use typographic apostrophes, quotes and ellipses (UI review). */
async function expectTypographicCopy(page: Page) {
  const copy = await page.evaluate(() =>
    [document.body.innerText, ...Array.from(document.querySelectorAll('[aria-label], [title]'), (el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`)].join('\n'),
  );
  expect(copy).not.toMatch(/['"]|\.\.\./);
}

/** Computed font sizes of each heading level, the body text and the editor, in px. */
function typeSizes(page: Page) {
  return page.evaluate(() => {
    const px = (selector: string) => parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize);
    return {
      rem: px('html'),
      h1: px('h1'),
      h2: px('#source-heading'),
      h2Draft: px('#draft-heading'),
      h3s: Array.from(document.querySelectorAll('h3'), (h) => parseFloat(getComputedStyle(h).fontSize)),
      body: px('#audio-status'),
      editor: px('#transcript'),
    };
  });
}

for (const width of [1280, 320]) {
  test(`headings are a type scale above the body text, at default and largest size, ${width}px wide (UI review)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await open(page);
    // The transcript candidate and the explanation bring two h3s on screen.
    await transcript(page).fill('Meet at noon.');
    await transcribed(page, await startTranscription(page), 'Meet at one.');
    await expect(candidate(page)).toBeVisible();
    await recordButton(page).click();
    await expect(explanation(page)).toBeVisible();
    const bigger = page.getByRole('button', { name: 'Increase text size' });
    for (const scale of ['default', 'largest']) {
      if (scale === 'largest') while ((await bigger.getAttribute('aria-disabled')) !== 'true') await bigger.click();
      const s = await typeSizes(page);
      expect(s.h3s, scale).toHaveLength(2);
      // Exact steps in rem, so they grow with A+ ...
      expect([s.h1 / s.rem, s.h2 / s.rem, s.h2Draft / s.rem, ...s.h3s.map((h3) => h3 / s.rem)], scale).toEqual([1.75, 1.5, 1.5, 1.25, 1.25]);
      // ... each level above the next, every heading above the body text, and a pane heading above its editors' text.
      expect(s.h1, scale).toBeGreaterThan(s.h2);
      for (const h3 of s.h3s) {
        expect(s.h2, scale).toBeGreaterThan(h3);
        expect(h3, scale).toBeGreaterThan(s.body);
      }
      expect(s.h2, scale).toBeGreaterThan(s.editor);
      // Nothing is pushed sideways: no page scroll, and no heading wider than its box.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), scale).toBeLessThanOrEqual(0);
      const overflowing = await page.evaluate(() =>
        Array.from(document.querySelectorAll('h1, h2, h3'))
          .filter((h) => h.scrollWidth > h.clientWidth || h.getBoundingClientRect().right > document.documentElement.clientWidth)
          .map((h) => h.textContent),
      );
      expect(overflowing, scale).toEqual([]);
    }
  });
}

test('at 320px with the largest text, a long model name wraps instead of widening the page', async ({ page }) => {
  const base = { ...FIXTURE_ROUTE, routeKey: 'local-base-rewrite', mode: 'base', identity: 'mlx-community/Qwen3-4B-Instruct-2507-4bit', label: 'Local base model (test text only)', locationClass: 'local' };
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page, { routes: [base, ASR_ROUTE] });
  const bigger = page.getByRole('button', { name: 'Increase text size' });
  while ((await bigger.getAttribute('aria-disabled')) !== 'true') await bigger.click();
  const sideways = () =>
    page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      past: Array.from(document.querySelectorAll('.app *'))
        .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
        .map((el) => `${el.tagName.toLowerCase()}#${el.id}.${el.getAttribute('class') ?? ''}`),
    }));
  // The Draft pane's model line, and the send confirmation that names the same model.
  await expect(page.locator('.identity')).toHaveText('Model: mlx-community/Qwen3-4B-Instruct-2507-4bit');
  expect(await sideways()).toEqual({ page: 0, past: [] });
  await transcript(page).fill('Synthetic note: meet at noon.');
  await rewriteButton(page).click();
  await expect(sendRegion(page)).toBeVisible();
  expect(await sideways()).toEqual({ page: 0, past: [] });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the empty preview is muted but readable, and a draft is not (${colorScheme}; UI review)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await open(page);
    // The preview has no fill of its own, so its text sits on the page background.
    expect(await preview(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    const page_bg = over(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), [255, 255, 255]);
    const text = over(await page.evaluate(() => getComputedStyle(document.body).color), page_bg);
    const empty = page.locator('.preview .empty');
    await expect(empty).toHaveText('Nothing generated yet');
    const look = await empty.evaluate((el) => ({ color: getComputedStyle(el).color, style: getComputedStyle(el).fontStyle }));
    const hint = over(look.color, page_bg);
    expect(look.style).toBe('italic');
    expect(hint).not.toEqual(text);
    // Muted: clearly lower contrast than the body text, but still 4.5:1 or more.
    expect(contrast(hint, page_bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hint, page_bg)).toBeLessThan(contrast(text, page_bg) * 0.75);
    // A real draft is in the full text color.
    await transcript(page).fill('Meet at noon.');
    await rewriteButton(page).click();
    await complete(page, 'Meet at noon, please.');
    await expect(preview(page)).toHaveText('Meet at noon, please.');
    expect(over(await preview(page).evaluate((el) => getComputedStyle(el).color), page_bg)).toEqual(text);
  });
}

/** Each corner radius in the page that is not zero, with the element it is on. */
function cornerRadii(page: Page) {
  return page.evaluate(() => {
    // The token as a computed length, so a token in rem would still compare.
    const probe = document.body.appendChild(document.createElement('div'));
    probe.style.borderTopLeftRadius = 'var(--radius)';
    const token = getComputedStyle(probe).borderTopLeftRadius;
    probe.remove();
    const corners = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'] as const;
    const rounded: { what: string; radius: string }[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const style = getComputedStyle(el);
      for (const corner of corners) {
        if (style[corner] !== '0px') rounded.push({ what: `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''}`, radius: style[corner] });
      }
    }
    return { token, rounded };
  });
}

test('every rounded corner uses the one radius token (UI review)', async ({ page }) => {
  await open(page);
  const seen = new Set<string>();
  const check = async (state: string) => {
    const { token, rounded } = await cornerRadii(page);
    expect(token, state).not.toBe('0px');
    expect(rounded.filter((r) => r.radius !== token), state).toEqual([]);
    for (const r of rounded) seen.add(r.what);
  };
  await check('empty');
  await transcript(page).fill('Meet at noon.');
  await rewriteButton(page).click();
  await complete(page, 'Meet at noon, please.');
  await transcribed(page, await startTranscription(page), 'Meet at one.');
  await expect(candidate(page)).toBeVisible();
  await check('candidate');
  await page.getByRole('button', { name: 'Keep existing' }).click();
  await recordButton(page).click();
  await expect(explanation(page)).toBeVisible();
  await check('explanation');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('timer')).toBeVisible();
  await check('recording');
  // Buttons (Discard too), both editors, the preview, the candidate and the explanation are all rounded.
  for (const kind of ['button.', 'button.primary', 'button.danger', 'textarea.editor', 'div.preview', 'section.candidate', 'section.explain']) {
    expect([...seen], kind).toContain(kind);
  }
});

/** The words on each rendered line of an element, top to bottom. */
function wrappedLines(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const words: { word: string; top: number }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      for (const match of node.textContent!.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        words.push({ word: match[0], top: Math.round(range.getBoundingClientRect().top) });
      }
    }
    const lines = new Map<number, string[]>();
    for (const { word, top } of words) lines.set(top, [...(lines.get(top) ?? []), word]);
    return [...lines.values()];
  });
}

test('wrapped notices leave no word alone on their last line, even at 320px with the largest text (UI review)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page);
  // Status lines are balanced; the explanations' longer paragraphs are wrapped "pretty".
  const wrapStyles = await page.evaluate(() => Array.from(document.querySelectorAll('.status'), (el) => getComputedStyle(el).textWrapStyle));
  expect(new Set(wrapStyles)).toEqual(new Set(['balance']));
  const bigger = page.getByRole('button', { name: 'Increase text size' });
  while ((await bigger.getAttribute('aria-disabled')) !== 'true') await bigger.click();
  // With plain wrapping these two left "chosen." and "rewrite." alone on the last line.
  for (const selector of ['#audio-status', '#source-status']) {
    const lines = await wrappedLines(page, selector);
    expect(lines.length, selector).toBeGreaterThan(1);
    expect(lines.at(-1)!.length, `${selector}: ${lines.map((l) => l.join(' ')).join(' / ')}`).toBeGreaterThan(1);
  }
  await recordButton(page).click();
  await expect(explanation(page)).toBeVisible();
  expect(await page.locator('#explain-text').evaluate((el) => getComputedStyle(el).textWrapStyle)).toBe('pretty');
});

for (const [label, colorScheme, width] of [
  ['light, 1280 wide', 'light', 1280],
  ['dark, 1280 wide', 'dark', 1280],
  ['light, 760 wide', 'light', 760],
  ['dark, 760 wide', 'dark', 760],
] as const) {
  test(`no accessibility violations, empty and with a draft (${label})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width, height: 760 });
    await accessibilityJourney(page);
  });
}

async function accessibilityJourney(page: Page) {
  await open(page);
  // Legacy mode scans in-page, so the same check also runs inside Electron windows.
  const axe = () => new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  // Each state also checks its copy for straight quotes (UI review).
  const scan = async () => {
    await expectTypographicCopy(page);
    return axe();
  };
  expect((await scan()).violations).toEqual([]);
  await transcript(page).fill('Meet at noon.');
  await rewriteButton(page).click();
  await complete(page, 'Meet at noon, please.');
  await steering(page).fill('Shorter.');
  expect((await scan()).violations).toEqual([]);
  await transcribed(page, await startTranscription(page), 'Meet at one.');
  await expect(candidate(page)).toBeVisible();
  expect((await scan()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Keep existing' }).click();
  await recordButton(page).click();
  await expect(explanation(page)).toBeVisible();
  expect((await scan()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('timer')).toBeVisible();
  expect((await scan()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(confirmation(page)).toBeVisible();
  expect((await scan()).violations).toEqual([]);
}

test('the header names the rewrite route by its label, so a base route says "test text only"', async ({ page }) => {
  const base = {
    ...FIXTURE_ROUTE,
    routeKey: 'local-base-rewrite',
    mode: 'base',
    identity: 'mlx-community/Qwen3-4B-Instruct-2507-4bit',
    label: 'Local base model (test text only)',
    locationClass: 'local',
  };
  await open(page, { routes: [base, ASR_ROUTE] });
  await expect(page.locator('.route-summary')).toHaveText('Local base model (test text only)');
  await expect(page.locator('.identity')).toHaveText('Model: mlx-community/Qwen3-4B-Instruct-2507-4bit');
  // The route is named once, in the header; the Draft pane gives only the exact model (UI review).
  expect(await occurrences(page, 'Local base model (test text only)')).toBe(1);
  expect(await occurrences(page, 'base model')).toBe(1); // inside the header's label, nowhere else
});

/** How many times a phrase appears in the page's rendered text, ignoring case. */
function occurrences(page: Page, phrase: string) {
  return page.evaluate((p) => document.body.innerText.toLowerCase().split(p.toLowerCase()).length - 1, phrase);
}

test('the rewrite route is named once, in the header, empty and with a draft (UI review)', async ({ page }) => {
  await open(page);
  const check = async () => {
    expect(await occurrences(page, 'Synthetic fixture')).toBe(1);
    await expect(page.locator('.route-summary')).toHaveText('Synthetic fixture');
    await expect(page.locator('.identity')).toHaveText('Model: fixture-v1 (synthetic)');
  };
  await check();
  await transcript(page).fill('Meet at noon.');
  await rewriteButton(page).click();
  await complete(page, 'Meet at noon, please.');
  await expect(preview(page)).toHaveText('Meet at noon, please.');
  await check();
});

const BASE_ROUTE = {
  ...FIXTURE_ROUTE,
  routeKey: 'local-base-rewrite',
  mode: 'base',
  identity: 'mlx-community/Qwen3-4B-Instruct-2507-4bit',
  label: 'Local base model (test text only)',
  locationClass: 'local',
};
const sendRegion = (page: Page) => page.getByRole('region', { name: /^Send to / });
const sentCount = (page: Page) => page.evaluate(() => (window as Win).__sent.length as number);

test('a route that leaves the app asks once per session before the first send', async ({ page }) => {
  await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
  await transcript(page).fill('Synthetic note: meet at noon.');
  await rewriteButton(page).click();
  // Nothing is sent yet: the confirmation names where the text goes, and takes focus.
  await expect(sendRegion(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Send to Local base model (test text only)?' })).toBeFocused();
  await expect(sendRegion(page)).toContainText('mlx-community/Qwen3-4B-Instruct-2507-4bit');
  await expect(sendRegion(page)).toContainText('a separate service on this Mac');
  await expect(sendRegion(page)).toContainText('may keep a copy');
  expect(await sentCount(page)).toBe(0);
  // Not now: nothing sent, focus on the status line (not Rewrite, so a repeated Enter cannot reopen it).
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(sendRegion(page)).toHaveCount(0);
  await expect(status(page)).toBeFocused();
  expect(await sentCount(page)).toBe(0);
  // Escape declines too.
  await rewriteButton(page).click();
  await expect(sendRegion(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sendRegion(page)).toHaveCount(0);
  expect(await sentCount(page)).toBe(0);
  // Send: one request, the confirmation goes, and focus lands on the status line.
  await rewriteButton(page).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(sendRegion(page)).toHaveCount(0);
  await expect(status(page)).toBeFocused();
  expect(await sentCount(page)).toBe(1);
  await complete(page, 'Synthetic note: meet at noon, please.', 'j1', BASE_ROUTE);
  await expect(preview(page)).toHaveText('Synthetic note: meet at noon, please.');
  // Later rewrites in the same session go straight through.
  await steering(page).fill('Synthetic test: shorter.');
  await rewriteButton(page).click();
  await expect(sendRegion(page)).toHaveCount(0);
  expect(await sentCount(page)).toBe(2);
});

test('a blocked send keeps the confirmation open, says why, and records no consent', async ({ page }) => {
  await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
  await transcript(page).fill('Synthetic note: meet at noon.');
  await rewriteButton(page).click();
  await expect(sendRegion(page)).toBeVisible();
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toHaveAttribute('aria-disabled', 'false');
  // The transcript is emptied while the confirmation is open.
  await transcript(page).fill('');
  await expect(send).toHaveAttribute('aria-disabled', 'true');
  await expect(sendRegion(page)).toContainText('Type a transcript to rewrite.');
  // Playwright will not click an aria-disabled button by itself; a user still can, and it must do nothing.
  await send.click({ force: true });
  await expect(sendRegion(page)).toBeVisible();
  expect(await sentCount(page)).toBe(0);
  // Fixed: Send works, and only now is consent recorded.
  await transcript(page).fill('Synthetic note: meet at noon.');
  await expect(send).toHaveAttribute('aria-disabled', 'false');
  await send.click();
  expect(await sentCount(page)).toBe(1);
});

test('the send confirmation has no accessibility violations, and the fixture route never asks', async ({ page }) => {
  await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
  await transcript(page).fill('Synthetic note: meet at noon.');
  await rewriteButton(page).click();
  await expect(sendRegion(page)).toBeVisible();
  const scan = () => new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect((await scan()).violations).toEqual([]);
  const fixture = await page.context().newPage();
  await open(fixture);
  await transcript(fixture).fill('Meet at noon.');
  await rewriteButton(fixture).click();
  await expect(sendRegion(fixture)).toHaveCount(0);
  expect(await sentCount(fixture)).toBe(1);
});

test('without a bridge the shell says no route and never offers rewrite', async ({ page }) => {
  const { errors } = await open(page, { bridge: false });
  // Said in the header (and why in the status line), not again in the Draft pane, which has no model to name.
  await expect(page.locator('.route-summary')).toHaveText('No processing route');
  await expect(page.locator('.pane.draft')).not.toContainText('processing route');
  await expect(page.locator('.identity')).toHaveCount(0);
  await transcript(page).fill('Meet at noon.');
  await expect(rewriteButton(page)).toBeDisabled();
  await expect(status(page)).toContainText('no processing route is set up yet');
  await expect(importButton(page)).toHaveCount(0);
  await expect(transcribeButton(page)).toHaveCount(0);
  await expect(recordButton(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('packaged page keeps a strict content security policy', async ({ page }) => {
  await open(page);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).not.toContain('unsafe');
});

test('imported audio transcribes straight into an empty transcript', async ({ page }) => {
  const { errors, offsite } = await open(page);
  await expect(audioStatus(page)).toHaveText('ⓘ No audio chosen.');
  await expect(transcribeButton(page)).toBeDisabled();
  await transcribeButton(page).click({ force: true });
  expect(await page.evaluate(() => (window as Win).__transcribed.length)).toBe(0);

  const req = await startTranscription(page);
  expect(req).toMatchObject({ v: 1, sessionId: 's1', epoch: 1, routeKey: 'fixture-transcribe', assetToken: 'a1', sourceRevision: 0 });
  await expect(status(page)).toContainText('Transcribing the audio. You can keep editing.');
  await expect(transcribeButton(page)).toBeDisabled();
  await expect(rewriteButton(page)).toBeDisabled();
  await transcribed(page, req, 'Meet at one.');
  await expect(transcript(page)).toHaveValue('Meet at one.');
  await expect(candidate(page)).toHaveCount(0);
  await expect(status(page)).toContainText('Transcript added from the audio.');
  await transcript(page).fill('Meet at one today.');
  await expect(status(page)).not.toContainText('Transcript added from the audio.');
  expect(errors).toEqual([]);
  expect(offsite).toEqual([]);
});

test('a transcript never replaces existing text without Replace', async ({ page }) => {
  await open(page);
  await transcript(page).fill('Meet at noon.');
  await transcribed(page, await startTranscription(page), 'Meet at one.');
  await expect(candidate(page)).toContainText('Meet at one.');
  await expect(candidate(page)).toContainText('Synthetic fixture · fixture-asr-v1');
  await expect(status(page)).toContainText('A transcript from the audio is ready.');
  await expect(transcript(page)).toHaveValue('Meet at noon.');
  await expect(transcribeButton(page)).toBeDisabled(); // one candidate at a time
  await expect(audioStatus(page)).toContainText('Replace or keep the waiting transcript before transcribing again.');

  await page.getByRole('button', { name: 'Keep existing' }).click();
  await expect(candidate(page)).toHaveCount(0);
  await expect(transcript(page)).toHaveValue('Meet at noon.');
  await expect(transcript(page)).toBeFocused(); // focus does not fall to the page when the region goes

  await transcribeButton(page).click();
  const again = await page.evaluate(() => (window as Win).__transcribed.at(-1));
  await transcribed(page, again, 'Meet at two.', 't-j2');
  await page.getByRole('button', { name: 'Replace transcript' }).click();
  await expect(transcript(page)).toHaveValue('Meet at two.');
  await expect(candidate(page)).toHaveCount(0);
  await expect(transcript(page)).toBeFocused();
});

test('typing over a waiting transcript keeps the typed text and says why', async ({ page }) => {
  await open(page);
  await transcript(page).fill('Meet at noon.');
  await transcribed(page, await startTranscription(page), 'Meet at one.');
  await expect(candidate(page)).toBeVisible();
  await transcript(page).fill('Meet at three.');
  await expect(candidate(page)).toHaveCount(0);
  await expect(transcript(page)).toHaveValue('Meet at three.');
  await expect(status(page)).toContainText('Transcript not applied because your text or the chosen audio changed. Your text is kept.');
});

test('cancel stops a transcription and keeps the text', async ({ page }) => {
  await open(page);
  await transcript(page).fill('Meet at noon.');
  const req = await startTranscription(page);
  await cancelButton(page).click();
  await expect(status(page)).toContainText('Transcription cancelled. Your text is kept.');
  expect(await page.evaluate(() => (window as Win).__cancelled)).toEqual([{ v: 1, sessionId: 's1', epoch: 1, clientRequestId: req.clientRequestId }]);
  await expect(transcript(page)).toHaveValue('Meet at noon.');
  // A late result of the cancelled job changes nothing.
  await transcribed(page, req, 'Meet at one.');
  await expect(transcript(page)).toHaveValue('Meet at noon.');
  await expect(candidate(page)).toHaveCount(0);
});

test('import refusals say what to do and closing the chooser changes nothing', async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as Win).__chooseResult = { ok: true, value: { status: 'cancelled' } }));
  await importButton(page).click();
  await expect(audioStatus(page)).toHaveText('ⓘ No audio chosen.');
  await page.evaluate(() => ((window as Win).__chooseResult = { ok: false, code: 'invalid_input' }));
  await importButton(page).click();
  await expect(audioStatus(page)).toContainText('Choose a WAV file that is mono, 16 kHz, 16-bit and at most 30 seconds.');
  await expect(transcribeButton(page)).toBeDisabled();
  // A good file afterwards clears the refusal.
  await page.evaluate((chosen) => ((window as Win).__chooseResult = { ok: true, value: chosen }), CHOSEN);
  await importButton(page).click();
  await expect(audioStatus(page)).toHaveText('✓ Audio ready: 2.5 seconds of WAV.');
  await expect(transcribeButton(page)).toBeEnabled();
  // A later refusal keeps the earlier audio chosen, and says so.
  await page.evaluate(() => ((window as Win).__chooseResult = { ok: false, code: 'unsupported' }));
  await importButton(page).click();
  await expect(audioStatus(page)).toContainText('The earlier audio (2.5 seconds) is still chosen.');
  await expect(transcribeButton(page)).toBeEnabled();
});

test('a second Import while the chooser is open does nothing', async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as Win).__chooseHold = true));
  await importButton(page).click();
  await importButton(page).click();
  expect(await page.evaluate(() => (window as Win).__chooseCalls)).toBe(1);
  await page.evaluate(() => (window as Win).__answerChooser({ ok: true, value: { status: 'cancelled' } }));
  await expect(audioStatus(page)).toHaveText('ⓘ No audio chosen.');
  // Once it closes, Import opens it again.
  await page.evaluate(() => ((window as Win).__chooseHold = false));
  await importButton(page).click();
  expect(await page.evaluate(() => (window as Win).__chooseCalls)).toBe(2);
  await expect(audioStatus(page)).toHaveText('✓ Audio ready: 2.5 seconds of WAV.');
});

test('the first Record explains before the microphone prompt; Not now sends nothing', async ({ page }) => {
  const { errors } = await open(page);
  expect(await win<number>(page, '__startCalls')).toBe(0); // nothing records or prompts at launch
  await recordButton(page).click();
  await expect(explanation(page)).toContainText('Your computer will ask once whether this app may use it');
  // Focus goes to the heading, so the text comes before any button.
  await expect(page.getByRole('heading', { name: 'Before you record' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Continue' })).toHaveAccessibleDescription(/Recording uses your microphone/);
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(explanation(page)).toHaveCount(0);
  await expect(recordButton(page)).toBeFocused();
  expect(await win<number>(page, '__startCalls')).toBe(0);

  await recordButton(page).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(recordStatus(page)).toContainText('Recording. Stop keeps it; Discard keeps nothing.');
  expect(await win<number>(page, '__startCalls')).toBe(1);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeFocused();
  await expect(page.getByRole('timer')).toContainText('of 0:30');
  // Other audio input waits for the recording, and says why through the recorder's status.
  await expect(importButton(page)).toBeDisabled();
  await expect(transcribeButton(page)).toBeDisabled();
  await expect(importButton(page)).toHaveAccessibleDescription(/Recording\. Stop keeps it/);
  await importButton(page).click({ force: true });
  expect(await win<number>(page, '__chooseCalls')).toBe(0);
  expect(errors).toEqual([]);
});

test('Stop keeps the recording and transcribes it only after a second click', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await recordButton(page).click();
  await expect(explanation(page)).toHaveCount(0); // permission already decided: no explanation
  await expect(recordStatus(page)).toContainText('Recording.');
  await page.getByRole('button', { name: 'Stop' }).click();
  expect(await win<unknown[]>(page, '__stopped')).toEqual([{ v: 1, sessionId: 's1', epoch: 1, captureHandle: 'c1' }]);
  await expect(audioStatus(page)).toContainText('4.0 seconds');
  // Stop alone sends nothing: it asks, naming where the recording would go.
  await expect(confirmation(page)).toContainText('Transcribing sends it to Synthetic fixture · fixture-asr-v1.');
  await expect(page.getByRole('heading', { name: 'Transcribe this recording?' })).toBeFocused();
  await expect(confirmButton(page)).toHaveAccessibleDescription(/Nothing is sent until you choose Transcribe recording/);
  await expect(recordStatus(page)).toContainText('Recording kept and not sent.'); // announced, not only shown
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
  await confirmButton(page).click();
  await expect(confirmation(page)).toHaveCount(0);
  await expect(recordStatus(page)).toHaveText('✓ Recording kept.');
  await expect(status(page)).toContainText('Transcribing the audio.');
  const req = await page.evaluate(() => (window as Win).__transcribed.at(-1));
  expect(req).toMatchObject({ routeKey: 'fixture-transcribe', assetToken: 'a2', sourceRevision: 0 });
  await expect(recordStatus(page)).toBeFocused(); // not Record: a repeated Enter must not start another recording
  await transcribed(page, req, 'Meet at noon.');
  await expect(transcript(page)).toHaveValue('Meet at noon.');
});

test('a recording kept over existing text still needs Replace', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await transcript(page).fill('Meet at ten.');
  await startRecording(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await confirmButton(page).click();
  const req = await page.evaluate(() => (window as Win).__transcribed.at(-1));
  await transcribed(page, req, 'Meet at noon.');
  await expect(candidate(page)).toContainText('Meet at noon.');
  await expect(transcript(page)).toHaveValue('Meet at ten.');
});

test('Discard keeps nothing', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await startRecording(page);
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(recordStatus(page)).toHaveText('ⓘ Recording discarded. Nothing was kept.');
  expect(await win<unknown[]>(page, '__discarded')).toEqual([{ v: 1, sessionId: 's1', epoch: 1, captureHandle: 'c1' }]);
  expect(await win<unknown[]>(page, '__stopped')).toEqual([]);
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
  await expect(audioStatus(page)).toHaveText('ⓘ No audio chosen.');
  await expect(recordButton(page)).toBeFocused();
  await expect(importButton(page)).toBeEnabled();
});

test('a recording that ends by itself waits for Keep audio or Discard', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await startRecording(page);
  await emit(page, { type: 'capture.ended', captureHandle: 'other', reason: 'revoked' });
  await expect(recordStatus(page)).toContainText('Recording. Stop keeps it');
  await emit(page, { type: 'capture.ended', captureHandle: 'c1', reason: 'max_duration' });
  await expect(recordStatus(page)).toContainText('Recording stopped at the 30-second limit. Keep the audio, or discard it.');
  await page.getByRole('button', { name: 'Keep audio' }).click();
  expect(await win<unknown[]>(page, '__stopped')).toHaveLength(1);
  await expect(confirmation(page)).toBeVisible();
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
});

test('denied access is explained up front, with a recheck that never prompts', async ({ page }) => {
  await open(page, { mic: 'denied' });
  await expect(recordStatus(page)).toContainText('Microphone access is off for this app.');
  const recheck = page.getByRole('button', { name: 'Check again' });
  await recheck.click();
  await expect(recordStatus(page)).toContainText('Microphone access is off for this app.');
  expect(await win<number>(page, '__startCalls')).toBe(0);
  await page.evaluate(() => ((window as Win).__mic = 'granted'));
  await recheck.click();
  await expect(recordStatus(page)).toBeEmpty();
  await expect(recheck).toHaveCount(0);
  await expect(recordButton(page)).toBeFocused(); // not lost with the button
  await recordButton(page).click();
  await expect(explanation(page)).toHaveCount(0);
  expect(await win<number>(page, '__startCalls')).toBe(1);
});

test('a refused or unavailable start says why and leaves Record available', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await page.evaluate(() => ((window as Win).__startResult = { ok: true, value: { status: 'unavailable', reason: 'in_use' } }));
  await recordButton(page).click();
  await expect(recordStatus(page)).toContainText('The microphone is in use by another app.');
  await expect(recordButton(page)).toBeEnabled();
  await expect(importButton(page)).toBeEnabled();
  await page.evaluate(() => ((window as Win).__startResult = { ok: true, value: { status: 'blocked', microphone: 'restricted' } }));
  await recordButton(page).click();
  await expect(recordStatus(page)).toContainText('controlled by a system policy');
  await expect(page.getByRole('button', { name: 'Check again' })).toHaveCount(0);
});

test('the timer counts recording time and stops with the recording', async ({ page }) => {
  await page.clock.install();
  await open(page, { mic: 'granted' });
  await startRecording(page);
  await expect(page.getByRole('timer')).toHaveText('Recording time 0:00 of 0:30');
  await page.clock.runFor(3_100);
  await expect(page.getByRole('timer')).toHaveText('Recording time 0:03 of 0:30');
  await emit(page, { type: 'capture.ended', captureHandle: 'c1', reason: 'device_lost' });
  await page.clock.runFor(5_000);
  await expect(page.getByRole('timer')).toHaveText('Recording time 0:03 of 0:30');
  await expect(recordStatus(page)).toContainText('The microphone was disconnected.');
});

test('a double or held Enter on Record never consents for the user', async ({ page }) => {
  await open(page);
  await recordButton(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.down('Enter'); // auto-repeat
  await page.keyboard.up('Enter');
  await expect(explanation(page)).toBeVisible();
  expect(await win<number>(page, '__startCalls')).toBe(0);
  await page.keyboard.press('Escape'); // closes like a non-destructive dialog
  await expect(explanation(page)).toHaveCount(0);
  await expect(recordButton(page)).toBeFocused();
  expect(await win<number>(page, '__startCalls')).toBe(0);
});

test('Record reads the permission afresh, and explains when it is unread, stale or unreadable', async ({ page }) => {
  // Load says "granted", but the OS state changed since: the fresh read decides.
  await open(page, { mic: 'granted' });
  await page.evaluate(() => {
    const w = window as Win;
    w.__mic = 'not_requested';
    w.__micHold = true;
  });
  await recordButton(page).click();
  await expect(recordStatus(page)).toContainText('Checking the microphone');
  expect(await win<number>(page, '__startCalls')).toBe(0);
  await page.evaluate(() => (window as Win).__answerMic());
  await expect(explanation(page)).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  // A failed read also explains first rather than risk an unexplained prompt.
  await page.evaluate(() => {
    const w = window as Win;
    w.__micHold = false;
    w.__micFail = true;
  });
  await recordButton(page).click();
  await expect(explanation(page)).toBeVisible();
  expect(await win<number>(page, '__startCalls')).toBe(0);
});

test('focus returns to Record after Continue when the start is refused', async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as Win).__startResult = { ok: true, value: { status: 'blocked', microphone: 'denied' } }));
  await recordButton(page).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(recordStatus(page)).toContainText('Microphone access is off for this app.');
  await expect(recordButton(page)).toBeFocused();
});

test('typing while the microphone starts is never interrupted, and Import still works', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await page.evaluate(() => ((window as Win).__startHold = true));
  await recordButton(page).click();
  await expect(recordStatus(page)).toContainText('Starting the microphone');
  await expect(importButton(page)).toBeEnabled(); // a start that never answers cannot trap the user
  await transcript(page).click();
  await page.keyboard.type('Meet');
  await page.evaluate(() => (window as Win).__answerStart());
  await expect(recordStatus(page)).toContainText('Recording.');
  await page.keyboard.type(' at noon');
  await expect(transcript(page)).toBeFocused();
  await expect(transcript(page)).toHaveValue('Meet at noon');
  expect(await win<unknown[]>(page, '__stopped')).toEqual([]);
});

test('an ending that arrives before the start reply is still shown', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await page.evaluate(() => ((window as Win).__startHold = true));
  await recordButton(page).click();
  await expect(recordStatus(page)).toContainText('Starting the microphone');
  await emit(page, { type: 'capture.ended', captureHandle: 'c1', reason: 'device_lost' });
  await page.evaluate(() => (window as Win).__answerStart());
  await expect(recordStatus(page)).toContainText('The microphone was disconnected.');
  await expect(page.getByRole('button', { name: 'Keep audio' })).toBeVisible();
});

test('a stop that fails keeps nothing; Discard after an ending keeps nothing', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await page.evaluate(() => ((window as Win).__stopResult = { ok: false, code: 'route_unavailable' }));
  await startRecording(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(recordStatus(page)).toContainText('The recording couldn’t be saved. Nothing was kept.');
  await expect(audioStatus(page)).toHaveText('ⓘ No audio chosen.');
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
  await startRecording(page);
  await emit(page, { type: 'capture.ended', captureHandle: 'c1', reason: 'revoked' });
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(recordStatus(page)).toHaveText('ⓘ Recording discarded. Nothing was kept.');
});

test('Stop during a rewrite keeps the recording chosen without transcribing over the rule', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await transcript(page).fill('Meet at ten.');
  await rewriteButton(page).click(); // a rewrite is running: one job at a time
  await startRecording(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(audioStatus(page)).toContainText('Audio ready: 4.0 seconds of WAV.');
  // The confirmation waits, and says why, while the rewrite runs.
  await expect(confirmButton(page)).toBeDisabled();
  await expect(confirmation(page)).toContainText('Transcribing waits until the current job ends.');
  await confirmButton(page).click({ force: true });
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
  // Once the rewrite ends, the confirmation can go ahead, but nothing fires by itself.
  await complete(page, 'Meet at ten, please.');
  await expect(confirmButton(page)).toBeEnabled();
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
  await confirmButton(page).click();
  expect(await page.evaluate(() => (window as Win).__transcribed.at(-1))).toMatchObject({ assetToken: 'a2' });
});

test('a double or held Enter on Stop never confirms the transcription', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await startRecording(page);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // a third press
  await expect(confirmation(page)).toBeVisible();
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
});

test('Not now or Escape keeps the recording without sending it; Transcribe works later', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await startRecording(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(confirmation(page)).toHaveCount(0);
  await expect(recordStatus(page)).toContainText('Recording kept. Nothing was sent');
  await expect(recordStatus(page)).toBeFocused();
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
  // A later, deliberate Transcribe sends the kept recording, and "nothing was sent" goes away.
  await transcribeButton(page).click();
  expect(await page.evaluate(() => (window as Win).__transcribed.at(-1))).toMatchObject({ assetToken: 'a2' });
  await expect(recordStatus(page)).not.toContainText('Nothing was sent');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Session' })).toBeVisible();
  await startRecording(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toHaveCount(0);
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
});

test('the confirmation applies only to the kept recording', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await startRecording(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(confirmation(page)).toBeVisible();
  // Importing other audio replaces the recording, so there is nothing left to confirm.
  await importButton(page).click();
  await expect(audioStatus(page)).toHaveText('✓ Audio ready: 2.5 seconds of WAV.');
  await expect(confirmation(page)).toHaveCount(0);
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
  // Starting a transcription another way also ends the prompt.
  await startRecording(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(confirmation(page)).toBeVisible();
  await transcribeButton(page).click();
  await expect(confirmation(page)).toHaveCount(0);
  expect(await win<unknown[]>(page, '__transcribed')).toHaveLength(1);
});

test('a double Enter on Transcribe recording or Not now never starts a new recording', async ({ page }) => {
  await open(page, { mic: 'granted' });
  for (const name of ['Transcribe recording', 'Not now']) {
    await startRecording(page);
    await page.getByRole('button', { name: 'Stop' }).click();
    const before = await win<number>(page, '__startCalls');
    await page.getByRole('button', { name }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(confirmation(page)).toHaveCount(0);
    await expect(recordStatus(page)).toBeFocused(); // a status line, which does nothing on Enter
    expect(await win<number>(page, '__startCalls')).toBe(before);
    if (name === 'Transcribe recording') {
      const req = await page.evaluate(() => (window as Win).__transcribed.at(-1));
      await transcribed(page, req, 'Meet at noon.', `t-${before}`);
    }
  }
});

test('Record while the prompt is shown starts a new recording and drops the prompt', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await startRecording(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(confirmation(page)).toBeVisible();
  await recordButton(page).click();
  await expect(recordStatus(page)).toContainText('Recording. Stop keeps it');
  await expect(confirmation(page)).toHaveCount(0);
  expect(await win<number>(page, '__startCalls')).toBe(2);
  expect(await win<unknown[]>(page, '__transcribed')).toEqual([]);
});

test('importing other audio after Not now clears "nothing was sent"', async ({ page }) => {
  await open(page, { mic: 'granted' });
  await startRecording(page);
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(recordStatus(page)).toContainText('Nothing was sent');
  await importButton(page).click();
  await expect(audioStatus(page)).toHaveText('✓ Audio ready: 2.5 seconds of WAV.');
  await expect(recordStatus(page)).not.toContainText('Nothing was sent');
});

// ---------------------------------------------------------------------------
// The Inspect step (route card 07): an unknown outcome shows what is
// known, and one explicit Acknowledge clears it where the route's card allows.

const SENT_AT = Date.UTC(2026, 10, 26, 22, 42); // 10:42 PM in UTC
const inspectButton = (page: Page) => page.getByRole('button', { name: 'Inspect unknown outcome' });
const inspectRegion = (page: Page) => page.getByRole('region', { name: 'Unknown outcome' });
const acknowledgeButton = (page: Page) => page.getByRole('button', { name: 'Acknowledge', exact: true });
const OLD_OUTCOME = { kind: 'rewrite', jobId: 'j-old', routeKey: 'local-base-rewrite', sentAt: SENT_AT, clearance: 'acknowledge' };

/** Types synthetic text and sends the first rewrite to the base route, through the first-send confirmation. */
async function sendToBase(page: Page) {
  await transcript(page).fill('Synthetic note: meet at noon.');
  await rewriteButton(page).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect(await sentCount(page)).toBe(1);
}

/** Main accepts the in-flight rewrite, then reports its outcome unknown, as main does: failed, then outcome.unresolved. */
async function unknownOutcome(page: Page, jobId = 'j1') {
  const req = await lastSent(page);
  const ids = { clientRequestId: req.clientRequestId, jobId };
  await emit(page, { type: 'rewrite.accepted', ...ids, sourceRevision: req.sourceRevision, steeringRevision: req.steeringRevision });
  await emit(page, { type: 'rewrite.failed', ...ids, code: 'unknown_outcome' });
  await page.evaluate((o) => (window as Win).__outcomes.push(o), { kind: 'rewrite', jobId, clientRequestId: req.clientRequestId });
  await emit(page, { type: 'outcome.unresolved', kind: 'rewrite', jobId, routeKey: 'local-base-rewrite', sentAt: SENT_AT, clearance: 'acknowledge' });
}

test.describe('Inspect', () => {
  test.use({ timezoneId: 'UTC', locale: 'en-US' });
  // Five minutes after the send, so the time shows alone (no date); timers keep running.
  test.beforeEach(async ({ page }) => page.clock.setFixedTime(SENT_AT + 5 * 60_000));

  test('unknown outcome → Inspect → Acknowledge → a new rewrite is sent', async ({ page }) => {
    const { errors, offsite } = await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    await unknownOutcome(page);
    await expect(status(page)).toHaveText(
      '⚠ Response not applied: its outcome is unknown. Your edits and the previous draft are kept. New rewrites are paused. Inspect says what is known.',
    );
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'true');
    await rewriteButton(page).click({ force: true });
    expect(await sentCount(page)).toBe(1); // never a retry that bypasses the gate

    // Keyboard: Inspect follows Cancel, and opening it moves focus to its heading.
    await cancelButton(page).focus();
    await page.keyboard.press('Tab');
    await expect(inspectButton(page)).toBeFocused();
    await expect(inspectButton(page)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Unknown outcome' })).toBeFocused();
    await expect(inspectButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(inspectButton(page)).toHaveAttribute('aria-controls', 'inspect-panel');
    const region = inspectRegion(page);
    await expect(page.getByRole('list', { name: 'What is known' })).toHaveText(
      'At 10:42 PM, Xenon Writing began sending your transcript and steering to Local base model (test text only): the model mlx-community/Qwen3-4B-Instruct-2507-4bit.' +
        'Its reply, if one came, was not applied.',
    );
    await expect(page.getByRole('list', { name: 'What isn’t known' })).toHaveText(
      'Whether they arrived, and whether Local base model (test text only) produced a reply. It may have, and it may keep a copy of what it received.',
    );
    await expect(region).toContainText('Nothing will be sent again automatically.');
    await expect(region).toContainText('Acknowledge to resume.');
    await expect(acknowledgeButton(page)).toHaveAccessibleDescription(/Acknowledge to resume/);
    // Its status line is already mounted, empty, so a screen reader announces it when it fills in.
    await expect(page.locator('#inspect-status')).toHaveAttribute('role', 'status');
    await expect(page.locator('#inspect-status')).toHaveText('');
    expect(await sentCount(page)).toBe(1); // opening Inspect sends nothing

    await page.keyboard.press('Tab'); // the heading → Acknowledge
    await expect(acknowledgeButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    const acked = await win<any[]>(page, '__acked');
    expect(acked).toEqual([{ v: 1, sessionId: 's1', epoch: 1, clientRequestId: expect.any(String), jobId: 'j1' }]);
    await expect(region).toHaveCount(0);
    await expect(inspectButton(page)).toHaveCount(0);
    await expect(status(page)).toBeFocused();
    await expect(status(page)).toHaveText('✓ Unknown outcome cleared. Nothing was sent again. You can rewrite when you’re ready.');
    await expect(status(page)).toHaveAttribute('data-kind', 'success');
    expect(await sentCount(page)).toBe(1); // acknowledging resent nothing

    // A new rewrite is a fresh, deliberate request; consent was already given this session.
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'false');
    const first = await lastSent(page);
    await rewriteButton(page).click();
    expect(await sentCount(page)).toBe(2);
    const second = await lastSent(page);
    expect(second.clientRequestId).not.toBe(first.clientRequestId);
    expect(second.clientRequestId).not.toBe(acked[0].clientRequestId);
    await complete(page, 'Synthetic note: meet at noon, please.', 'j2', BASE_ROUTE);
    await expect(preview(page)).toHaveText('Synthetic note: meet at noon, please.');
    expect(errors).toEqual([]);
    expect(offsite).toEqual([]);
  });

  test('Close, Escape and the Inspect button itself close it, keep work paused and return focus to Inspect', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    await unknownOutcome(page);
    await inspectButton(page).click();
    await expect(page.getByRole('heading', { name: 'Unknown outcome' })).toBeFocused();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(inspectRegion(page)).toHaveCount(0);
    await expect(inspectButton(page)).toBeFocused();
    await expect(inspectButton(page)).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('Enter');
    await expect(inspectRegion(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(inspectRegion(page)).toHaveCount(0);
    await expect(inspectButton(page)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(inspectRegion(page)).toBeVisible();
    await inspectButton(page).click(); // a disclosure: pressing it again closes
    await expect(inspectRegion(page)).toHaveCount(0);

    expect(await win<unknown[]>(page, '__acked')).toEqual([]);
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'true');
    expect(await sentCount(page)).toBe(1);
  });

  test('a reload learns that new work is paused, and acknowledges from its new session', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE], unresolved: [OLD_OUTCOME] });
    await transcript(page).fill('Synthetic note: meet at noon.');
    await expect(status(page)).toHaveText('⚠ New rewrites are paused because an earlier outcome is unknown. Inspect says what is known.');
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'true');
    await importButton(page).click();
    await expect(audioStatus(page)).toHaveText('ⓘ Audio ready: 2.5 seconds of WAV. Transcribing is paused because an earlier outcome is unknown.');
    await expect(transcribeButton(page)).toHaveAttribute('aria-disabled', 'true');

    await inspectButton(page).click();
    await expect(inspectRegion(page)).toContainText('At 10:42 PM, Xenon Writing began sending your transcript and steering to Local base model (test text only)');
    await acknowledgeButton(page).click();
    expect(await win<any[]>(page, '__acked')).toEqual([{ v: 1, sessionId: 's1', epoch: 1, clientRequestId: expect.any(String), jobId: 'j-old' }]);
    await expect(status(page)).toBeFocused();
    await expect(status(page)).toHaveText('✓ Unknown outcome cleared. Nothing was sent again. You can rewrite when you’re ready.');
    await expect(transcribeButton(page)).toHaveAttribute('aria-disabled', 'false');
    // A new session asks before its first send, as always.
    await rewriteButton(page).click();
    await expect(sendRegion(page)).toBeVisible();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    expect(await sentCount(page)).toBe(1);
  });

  test('an outcome only a restart clears says so and offers no Acknowledge', async ({ page }) => {
    const restartOnly = { kind: 'transcribe', jobId: 't-old', routeKey: 'fixture-transcribe', sentAt: SENT_AT, clearance: 'restart' };
    await open(page, { unresolved: [restartOnly] });
    await inspectButton(page).click();
    await expect(page.getByRole('list', { name: 'What is known' })).toContainText('At 10:42 PM, Xenon Writing began sending your audio to Synthetic fixture: the model fixture-asr-v1.');
    await expect(page.getByRole('list', { name: 'What isn’t known' })).toHaveText('What became of it. The fixture runs inside this app, so nothing left it.');
    await expect(inspectRegion(page)).toContainText('This route can’t be cleared here. Quit and reopen Xenon Writing to resume.');
    await expect(inspectRegion(page).getByRole('button')).toHaveText(['Close']);
  });

  test('a refused acknowledgment keeps work paused and says so; trying again uses a fresh request ID', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    await unknownOutcome(page);
    await page.evaluate(() => ((window as Win).__ackResult = { ok: false, code: 'denied' }));
    await inspectButton(page).click();
    await acknowledgeButton(page).click();
    await expect(page.locator('#inspect-status')).toHaveText('⚠ Couldn’t acknowledge it, so new work stays paused. Try again, or quit and reopen Xenon Writing.');
    await expect(acknowledgeButton(page)).toBeFocused();
    await expect(acknowledgeButton(page)).toHaveAccessibleDescription(/Couldn’t acknowledge it/);
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'true');

    // Closing and opening again starts afresh.
    await page.keyboard.press('Escape');
    await inspectButton(page).click();
    await expect(page.locator('#inspect-status')).toHaveText('');
    await page.evaluate(() => ((window as Win).__ackResult = { ok: true, value: { status: 'acknowledged' } }));
    await acknowledgeButton(page).click();
    await expect(status(page)).toHaveText('✓ Unknown outcome cleared. Nothing was sent again. You can rewrite when you’re ready.');
    const acked = await win<any[]>(page, '__acked');
    expect(acked).toHaveLength(2);
    expect(acked[0].clientRequestId).not.toBe(acked[1].clientRequestId);
  });

  test('a double press of Acknowledge sends one acknowledgment', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    await unknownOutcome(page);
    await page.evaluate(() => ((window as Win).__ackHold = true));
    await inspectButton(page).click();
    await acknowledgeButton(page).click();
    await expect(acknowledgeButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#inspect-status')).toHaveText('… Acknowledging.');
    await acknowledgeButton(page).click({ force: true });
    await page.keyboard.press('Enter');
    expect(await win<unknown[]>(page, '__acked')).toHaveLength(1);
    await page.evaluate(() => (window as Win).__answerAck());
    await expect(status(page)).toHaveText('✓ Unknown outcome cleared. Nothing was sent again. You can rewrite when you’re ready.');
    expect(await win<unknown[]>(page, '__acked')).toHaveLength(1);
  });

  test("when main's reply arrives before its events, focus still lands on the status line, which then says the gate cleared", async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    await unknownOutcome(page);
    await page.evaluate(() => ((window as Win).__ackEventsLate = true));
    await inspectButton(page).click();
    await acknowledgeButton(page).click();
    await expect(inspectRegion(page)).toHaveCount(0);
    await expect(status(page)).toBeFocused();
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'true'); // still paused until main's events arrive
    await page.evaluate(() => (window as Win).__flushAck());
    await expect(status(page)).toHaveText('✓ Unknown outcome cleared. Nothing was sent again. You can rewrite when you’re ready.');
    await expect(status(page)).toBeFocused();
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'false');
  });

  test('a gate cleared some other way while Inspect is open closes it and moves focus to the status line', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    const req = await lastSent(page);
    await unknownOutcome(page);
    await inspectButton(page).click();
    await emit(page, { type: 'rewrite.reconciled', clientRequestId: req.clientRequestId, jobId: 'j1' });
    await expect(inspectRegion(page)).toBeVisible(); // main's report still holds it
    await emit(page, { type: 'outcome.cleared', kind: 'rewrite', jobId: 'j1' });
    await expect(inspectRegion(page)).toHaveCount(0);
    await expect(status(page)).toBeFocused();
    await expect(status(page)).toHaveText('✓ Unknown outcome cleared. Nothing was sent again. You can rewrite when you’re ready.');
    // A later unknown outcome starts with Inspect closed: it never opens by itself or takes focus.
    await emit(page, { type: 'outcome.unresolved', ...OLD_OUTCOME });
    await expect(inspectButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(inspectRegion(page)).toHaveCount(0);
    await expect(status(page)).toBeFocused();
  });

  test('an unknown outcome without main\'s report still pauses work and offers only a restart', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    const req = await lastSent(page);
    const ids = { clientRequestId: req.clientRequestId, jobId: 'j1' };
    await emit(page, { type: 'rewrite.accepted', ...ids, sourceRevision: req.sourceRevision, steeringRevision: req.steeringRevision });
    await emit(page, { type: 'rewrite.failed', ...ids, code: 'unknown_outcome' }); // and no outcome.unresolved
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'true');
    await inspectButton(page).click();
    await expect(inspectRegion(page)).toContainText('An earlier outcome is unknown, but its details did not arrive. Nothing will be sent again automatically. Quit and reopen Xenon Writing to resume.');
    await expect(inspectRegion(page).getByRole('button')).toHaveText(['Close']);
  });

  test('an outcome reported before the page subscribed still pauses work', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE], early: [{ type: 'outcome.unresolved', ...OLD_OUTCOME }] });
    await transcript(page).fill('Synthetic note: meet at noon.');
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(inspectButton(page)).toBeVisible();
  });

  test('a clearing sent before the page subscribed still reopens work', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE], unresolved: [OLD_OUTCOME], early: [{ type: 'outcome.cleared', kind: 'rewrite', jobId: 'j-old' }] });
    await transcript(page).fill('Synthetic note: meet at noon.');
    await expect(rewriteButton(page)).toHaveAttribute('aria-disabled', 'false');
    await expect(inspectButton(page)).toHaveCount(0);
  });

  test('when the gate clears with focus on the Inspect button, focus goes to the status line, not the page', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    const req = await lastSent(page);
    await unknownOutcome(page);
    await inspectButton(page).focus();
    await emit(page, { type: 'rewrite.reconciled', clientRequestId: req.clientRequestId, jobId: 'j1' });
    await emit(page, { type: 'outcome.cleared', kind: 'rewrite', jobId: 'j1' });
    await expect(inspectButton(page)).toHaveCount(0);
    await expect(status(page)).toBeFocused();
  });

  test('an acknowledgment that settles after the user went back to the editor leaves focus there', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    await unknownOutcome(page);
    await page.evaluate(() => ((window as Win).__ackHold = true));
    await inspectButton(page).click();
    await acknowledgeButton(page).click();
    await page.keyboard.press('Escape');
    await steering(page).click();
    await page.keyboard.type('Synthetic');
    await page.evaluate(() => (window as Win).__answerAck());
    await expect(status(page)).toHaveText('✓ Unknown outcome cleared. Nothing was sent again. You can rewrite when you’re ready.');
    await expect(steering(page)).toBeFocused();
    await page.keyboard.type(' test.');
    await expect(steering(page)).toHaveValue('Synthetic test.');
  });

  test('while paused, an older notice that says "try again" gives way to the paused status', async ({ page }) => {
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE] });
    await sendToBase(page);
    const req = await lastSent(page);
    await emit(page, { type: 'rewrite.accepted', clientRequestId: req.clientRequestId, jobId: 'j1', sourceRevision: req.sourceRevision, steeringRevision: req.steeringRevision });
    await emit(page, { type: 'rewrite.failed', clientRequestId: req.clientRequestId, jobId: 'j1', code: 'timed_out' });
    await expect(status(page)).toContainText('You can try again.');
    // Another window's job turns unknown: main reports it here too.
    await emit(page, { type: 'outcome.unresolved', ...OLD_OUTCOME });
    await expect(status(page)).toHaveText('⚠ New rewrites are paused because an earlier outcome is unknown. Inspect says what is known.');
  });

  test('several unknown outcomes are each named on their own Acknowledge', async ({ page }) => {
    const later = { kind: 'transcribe', jobId: 't-two', routeKey: 'local-base-rewrite', sentAt: SENT_AT + 60_000, clearance: 'acknowledge' };
    await open(page, { routes: [BASE_ROUTE, ASR_ROUTE], unresolved: [OLD_OUTCOME, later] });
    await inspectButton(page).click();
    await expect(page.getByRole('heading', { name: 'Unknown outcomes' })).toBeFocused();
    await expect(page.getByRole('list', { name: 'What is known' })).toHaveCount(2);
    await page.getByRole('button', { name: 'Acknowledge the rewrite started at 10:42 PM' }).click();
    expect((await win<any[]>(page, '__acked')).map((a) => a.jobId)).toEqual(['j-old']);
    // One remains: work stays paused and Inspect still offers it.
    await expect(status(page)).toBeFocused();
    await expect(status(page)).toHaveText('⚠ New rewrites are paused because an earlier outcome is unknown. Inspect says what is known.');
    await inspectButton(page).click();
    await expect(page.getByRole('heading', { name: 'Unknown outcome', exact: true })).toBeVisible();
    await expect(inspectRegion(page)).toContainText('At 10:43 PM, Xenon Writing began sending your audio');
    await expect(acknowledgeButton(page)).toBeVisible();
  });

  for (const [label, colorScheme, width] of [
    ['light', 'light', 1280],
    ['dark', 'dark', 1280],
    ['light, 760 wide', 'light', 760],
    ['dark, 760 wide', 'dark', 760],
  ] as const) {
    test(`no accessibility violations with Inspect open, and after a refusal (${label})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 760 });
      await open(page, { routes: [BASE_ROUTE, ASR_ROUTE], unresolved: [OLD_OUTCOME] });
      const scan = () => new AxeBuilder({ page }).setLegacyMode().withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect((await scan()).violations).toEqual([]);
      await inspectButton(page).click();
      await expect(inspectRegion(page)).toBeVisible();
      expect((await scan()).violations).toEqual([]);
      await page.evaluate(() => ((window as Win).__ackResult = { ok: false, code: 'denied' }));
      await acknowledgeButton(page).click();
      await expect(page.locator('#inspect-status')).toBeVisible();
      expect((await scan()).violations).toEqual([]);
      // Nothing in the panel is clipped or scrolls sideways at this width, even at the largest text size.
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await overflow()).toBeLessThanOrEqual(0);
      const larger = page.getByRole('button', { name: 'A+ Increase text size' });
      while ((await larger.getAttribute('aria-disabled')) !== 'true') await larger.click();
      expect(await overflow()).toBeLessThanOrEqual(0);
      expect((await scan()).violations).toEqual([]);
    });
  }
});
