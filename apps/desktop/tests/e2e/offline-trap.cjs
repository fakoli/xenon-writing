// Packet D's offline evidence in a real Electron window. The offline test
// loads this into Electron's main process with `-r`, before the app's own code
// runs. It records and refuses every network, DNS and process entry point main
// could reach, cancels non-local requests in every session, and gives the app a
// throwaway profile and a captured clipboard so tests touch neither the
// developer's profile nor the real clipboard.
//
// What it cannot see: background loads Chromium's browser process makes on
// its own (component updates, safe browsing, field trials), renderer-side
// WebRTC or UDP, and anything outside this process. Playwright's launch
// switches turn the browser's background networking off, so the evidence is
// "the exercised paths touched no trapped entry point", not "the shipped app
// opens no sockets".
'use strict';

const fs = require('node:fs');
const hits = (globalThis.__offlineHits = []);
// Hits also go to a file, so shutdown-time hits are seen after the app closes.
const HITS_FILE = process.env.XENON_OFFLINE_HITS;

function record(name) {
  hits.push(name);
  if (HITS_FILE) fs.appendFileSync(HITS_FILE, name + '\n');
}

const trap = (name) =>
  function trapped() {
    record(name);
    throw new Error(`offline test: ${name} is blocked`);
  };

function patch(target, label, names) {
  for (const name of names) if (typeof target[name] === 'function') target[name] = trap(`${label}.${name}`);
}

const DNS_CALLS = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
  'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse'];

// Node: every TCP connection goes through net.Socket#connect (http, https, http2 and tls included).
patch(require('node:net').Socket.prototype, 'net.Socket', ['connect']);
patch(require('node:net'), 'net', ['connect', 'createConnection']);
patch(require('node:tls'), 'tls', ['connect']);
patch(require('node:http'), 'http', ['request', 'get']);
patch(require('node:https'), 'https', ['request', 'get']);
patch(require('node:http2'), 'http2', ['connect']);
patch(require('node:dgram'), 'dgram', ['createSocket']);
const dns = require('node:dns');
patch(dns, 'dns', DNS_CALLS);
patch(dns.Resolver.prototype, 'dns.Resolver', DNS_CALLS);
patch(dns.promises, 'dns.promises', DNS_CALLS);
patch(dns.promises.Resolver.prototype, 'dns.promises.Resolver', DNS_CALLS);
for (const name of ['fetch', 'WebSocket', 'EventSource']) globalThis[name] = trap(name);

// Other processes and threads: the static scan already forbids them in source; this covers the runtime.
patch(require('node:child_process'), 'child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
require('node:worker_threads').Worker = trap('worker_threads.Worker');

const electron = require('electron');
patch(electron.net, 'electron.net', ['request', 'fetch', 'resolveHost']);
patch(electron.utilityProcess, 'electron.utilityProcess', ['fork']);
patch(electron.shell, 'electron.shell', ['openExternal', 'openPath']);

// A throwaway profile, so runs never read or write the developer's `npm start` profile.
if (process.env.XENON_OFFLINE_PROFILE) electron.app.setPath('userData', process.env.XENON_OFFLINE_PROFILE);

globalThis.__copied = [];
electron.clipboard.writeText = (text) => {
  globalThis.__copied.push(text);
};

/** Only the app's own local files; `file://host/…` (a network share on Windows) is not local. */
function local(url) {
  const parsed = new URL(url);
  return (parsed.protocol === 'file:' && parsed.host === '') || parsed.protocol === 'data:';
}

let sessionPatched = false;
function guard(session) {
  // Session methods live on one prototype, so patching once covers every partition.
  if (!sessionPatched) {
    patch(Object.getPrototypeOf(session), 'session', ['preconnect', 'resolveHost', 'resolveProxy', 'fetch']);
    sessionPatched = true;
  }
  session.webRequest.onBeforeRequest((details, callback) => {
    if (local(details.url)) return callback({});
    record(`session request (${new URL(details.url).protocol})`);
    return callback({ cancel: true });
  });
  session.on('spellcheck-dictionary-download-begin', () => record('spellcheck dictionary download'));
}

electron.app.on('session-created', guard);
void electron.app.whenReady().then(() => guard(electron.session.defaultSession));
