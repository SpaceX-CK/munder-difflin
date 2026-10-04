'use strict';

/**
 * The app is often launched from inside a Claude Code session, and the parent
 * session's identity markers used to flow into every agent PTY. One of them
 * (CLAUDE_CODE_CHILD_SESSION) silently disables transcript saving, which broke
 * --resume for every agent of a run — invisible until someone needed a resume.
 * These tests pin the layering rule: inherited env is stripped of the parent's
 * Claude identity by PREFIX, config-not-identity names survive, and per-agent
 * values always win.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildPtyEnv } = loadTs('src/main/ptyEnv.ts');

/** The twelve markers dumped from a live Claude Code session in review of the
 *  fix — the original hardcoded list caught only the first five. */
const LIVE_SESSION_MARKERS = {
  CLAUDE_CODE_CHILD_SESSION: 'true',
  CLAUDE_CODE_SESSION_ID: 'abc-123',
  CLAUDE_PID: '4242',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
  CLAUDE_EFFORT: 'high',
  CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX: 'rc'
};

test('every live-session identity marker is stripped from the inherited env', () => {
  const env = buildPtyEnv({ HOME: '/Users/x', ...LIVE_SESSION_MARKERS }, '/bin', undefined, 'darwin');
  for (const k of Object.keys(LIVE_SESSION_MARKERS)) {
    assert.ok(!(k in env), `${k} must not leak into an agent PTY`);
  }
  assert.equal(env.HOME, '/Users/x');
});

test('markers the CLI has not invented yet are stripped by the prefix rule', () => {
  const env = buildPtyEnv(
    { CLAUDE_CODE_SOME_FUTURE_THING: 'x', CLAUDE_NEXT_YEAR: 'y' },
    '/bin', undefined, 'darwin'
  );
  assert.ok(!('CLAUDE_CODE_SOME_FUTURE_THING' in env));
  assert.ok(!('CLAUDE_NEXT_YEAR' in env));
});

test('operator configuration sharing the prefix survives: config dir, auth, backend', () => {
  const env = buildPtyEnv(
    {
      CLAUDE_CONFIG_DIR: '/Users/x/.claude-alt',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      ...LIVE_SESSION_MARKERS
    },
    '/bin', undefined, 'darwin'
  );
  assert.equal(env.CLAUDE_CONFIG_DIR, '/Users/x/.claude-alt');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, '1');
  assert.ok(!('CLAUDE_CODE_SESSION_ID' in env), 'keep-list must not weaken the strip');
});

test('names that merely start with CLAUDE are not the prefix and survive', () => {
  const env = buildPtyEnv({ CLAUDES_HOUSE: 'blue', ANTHROPIC_API_KEY: 'k' }, '/bin', undefined, 'darwin');
  assert.equal(env.CLAUDES_HOUSE, 'blue');
  assert.equal(env.ANTHROPIC_API_KEY, 'k');
});

test('per-agent env wins over the strip AND over the defaults', () => {
  const env = buildPtyEnv(
    LIVE_SESSION_MARKERS,
    '/bin',
    { CLAUDE_CODE_SESSION_ID: 'deliberate', TERM: 'vt100', AGENT_ID: 'a1' },
    'darwin'
  );
  // A marker set on purpose by the app (or a future per-agent env feature) is
  // NOT wiped — only the inherited layer is stripped.
  assert.equal(env.CLAUDE_CODE_SESSION_ID, 'deliberate');
  assert.equal(env.TERM, 'vt100');
  assert.equal(env.AGENT_ID, 'a1');
});

test('app defaults land: PATH, terminal identity, color', () => {
  const env = buildPtyEnv({ PATH: '/stale' }, '/resolved/bin', undefined, 'darwin');
  assert.equal(env.PATH, '/resolved/bin');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.FORCE_COLOR, '1');
});

test('locale: UTF-8 defaults on darwin, the user\'s exported locale wins, win32 untouched', () => {
  const bare = buildPtyEnv({}, '/bin', undefined, 'darwin');
  assert.equal(bare.LANG, 'en_US.UTF-8');
  assert.equal(bare.LC_CTYPE, 'en_US.UTF-8');

  const exported = buildPtyEnv({ LANG: 'es_ES.UTF-8', LC_ALL: 'fr_FR.UTF-8' }, '/bin', undefined, 'linux');
  assert.equal(exported.LANG, 'es_ES.UTF-8');
  assert.equal(exported.LC_CTYPE, 'fr_FR.UTF-8');

  const win = buildPtyEnv({}, 'C:\\bin', undefined, 'win32');
  assert.ok(!('LANG' in win));
  assert.ok(!('LC_CTYPE' in win));
});

// ─── hidden sessions ─────────────────────────────────────────────────────────
// runHiddenClaude spawns its own PTY (memory condensing, AI character drawing). It
// used to spread raw process.env, so an app launched from inside a Claude session
// handed CLAUDE_CODE_CHILD_SESSION to it: the session ANSWERED on screen but wrote no
// transcript, and the reply was never found ("no assistant response found").

test('hidden sessions spawn with the parent Claude session markers stripped', async () => {
  const pty = require('node-pty');
  const realSpawn = pty.spawn;
  const savedEnv = { ...process.env };
  let seen;
  pty.spawn = (_file, _args, opts) => {
    seen = opts;
    // pid 0 is ignored by ensureKilled, so no real process can be signalled.
    return { pid: 0, onData() {}, onExit() {}, write() {}, kill() {} };
  };
  Object.assign(process.env, LIVE_SESSION_MARKERS, { CLAUDE_CONFIG_DIR: '/keep/me' });
  try {
    const { runHiddenClaude } = loadTs('src/main/hiddenClaude.ts');
    const res = await runHiddenClaude('hello', { model: 'haiku', cwd: process.cwd(), bootCapMs: 20, timeoutMs: 120, env: { HIVE_ROOT: '/x' } });
    assert.equal(res.ok, false); // the fake session never answers; we only care about the env
    assert.ok(seen, 'spawned a pty');
    for (const k of Object.keys(LIVE_SESSION_MARKERS)) assert.equal(k in seen.env, false, `${k} must not reach the hidden session`);
    assert.equal(seen.env.CLAUDE_CONFIG_DIR, '/keep/me', 'operator config survives');
    assert.equal(seen.env.HIVE_ROOT, '/x', 'per-call env still applies');
    assert.ok(seen.env.PATH && seen.env.TERM, 'normal terminal env present');
  } finally {
    pty.spawn = realSpawn;
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
});
