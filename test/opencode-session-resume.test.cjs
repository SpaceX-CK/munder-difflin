'use strict';

/**
 * opencode agents used to open a brand-new session on EVERY app start (the old ones sat
 * untouched in opencode.db) because (1) the bundled hive-bridge plugin never sent the
 * session id, so the registry never held one, and (2) the preset had no resume flag.
 *
 * These tests run the REAL plugin source (extracted from hive.ts) against a real unix
 * socket, push its payloads through the real HookServer into a real HiveManager registry,
 * and pin the preset. No opencode install and no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const loadTs = require('./load-ts.cjs');

// hooks.ts pulls Notification from electron; outside Electron seed what the server touches.
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { providerPreset, supportsResume } = loadTs('src/shared/agentProvider.ts');

/** The plugin exactly as hive.ts ships it: cook the TS template literal, write it out as ESM. */
function pluginSource() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/hive.ts'), 'utf8');
  const start = src.indexOf('const OPENCODE_PLUGIN = `');
  assert.ok(start >= 0, 'OPENCODE_PLUGIN not found in hive.ts');
  const body = src.slice(start + 'const OPENCODE_PLUGIN = `'.length, src.indexOf('`;\n', start));
  return new Function('return `' + body + '`')();
}

let seq = 0;
/** Start a socket server that collects every JSON line; load a fresh copy of the plugin pointed at it. */
async function rig(t, { agent = 'jim-1', sock } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-oc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sockPath = sock ?? path.join(dir, 'h.sock');
  const got = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { for (const l of buf.split('\n')) if (l.trim()) got.push(JSON.parse(l)); });
  });
  if (!sock) await new Promise((r) => server.listen(sockPath, r));
  t.after(() => server.close());
  const file = path.join(dir, `plugin-${++seq}.mjs`);
  fs.writeFileSync(file, pluginSource());
  const saved = { s: process.env.HIVE_SOCK, a: process.env.AGENT_ID };
  process.env.HIVE_SOCK = sockPath;
  process.env.AGENT_ID = agent;
  const mod = await import(pathToFileURL(file).href);
  const hooks = await mod.HiveBridge();
  if (saved.s === undefined) delete process.env.HIVE_SOCK; else process.env.HIVE_SOCK = saved.s;
  if (saved.a === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = saved.a;
  const settle = () => new Promise((r) => setTimeout(r, 120));
  return { hooks, got, settle };
}

test('every payload carries the opencode session id', async (t) => {
  const { hooks, got, settle } = await rig(t);
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_main' });
  await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_main' });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_main' } } });
  await settle();
  assert.deepEqual(got.map((p) => p.hook_event_name).sort(), ['PostToolUse', 'PreToolUse', 'Stop']);
  for (const p of got) {
    assert.equal(p.session_id, 'ses_main');
    assert.equal(p.agent_id, 'jim-1');
  }
  assert.equal(got.find((p) => p.hook_event_name === 'PreToolUse').tool_name, 'bash');
});

test('a sub-agent (child) session id is never reported, so it cannot replace the main one', async (t) => {
  const { hooks, got, settle } = await rig(t);
  // opencode announces the child first; its tool calls and idle follow.
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_main' } } } });
  await hooks['tool.execute.before']({ tool: 'read', sessionID: 'ses_child' });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } });
  await hooks['tool.execute.before']({ tool: 'edit', sessionID: 'ses_main' });
  await settle();
  const byTool = (name) => got.filter((p) => p.tool_name === name);
  assert.equal(byTool('read').length, 1, 'the event itself still reaches the hive');
  assert.equal('session_id' in byTool('read')[0], false, 'child id withheld');
  assert.equal(got.find((p) => p.hook_event_name === 'Stop').session_id, undefined);
  assert.equal(byTool('edit')[0].session_id, 'ses_main', 'main session still reported');
  // session.updated also teaches us about children.
  await hooks.event({ event: { type: 'session.updated', properties: { info: { id: 'ses_c2', parentID: 'ses_main' } } } });
  await hooks['tool.execute.after']({ tool: 'grep', sessionID: 'ses_c2' });
  await settle();
  assert.equal('session_id' in got.find((p) => p.tool_name === 'grep'), false);
});

test('events without an id, and junk input, still post and never throw', async (t) => {
  const { hooks, got, settle } = await rig(t);
  await hooks['tool.execute.before']({ tool: 'bash' });
  await hooks['tool.execute.before'](undefined);
  await hooks['tool.execute.after'](null);
  await hooks.event(undefined);
  await hooks.event({});
  await hooks.event({ event: { type: 'session.created' } });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 42 } } });
  await settle();
  assert.ok(got.length >= 3);
  for (const p of got) assert.equal('session_id' in p, false, JSON.stringify(p));
});

test('a missing or dead hive socket is harmless', async (t) => {
  const dead = await rig(t, { sock: '/nonexistent/dir/h.sock' });
  await dead.hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_main' });
  await dead.hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_main' } } });
  await dead.settle(); // an unhandled 'error' event would crash the process here
  assert.equal(dead.got.length, 0);
});

test('plugin -> hook server -> registry: the id is recorded and a respawn can read it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-oc-hive-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'opencode', cwd: home });
  const server = new HookServer(hive, () => null, () => ({ notifications: false }), undefined, undefined);
  assert.equal(hive.lastSession('jim-1'), undefined, 'nothing recorded before the first turn');

  const { hooks, got, settle } = await rig(t);
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_main' } } } });
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_child' });
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_main' });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_main' } } });
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_child' } } });
  await settle();
  for (const p of got) server.handle(p); // what the real socket listener does with each line

  assert.equal(hive.lastSession('jim-1'), 'ses_main');
  // ...and it survives an app restart: a new HiveManager over the same home still has it, and
  // re-registering the agent at spawn (ensureAgent spreads the previous entry) keeps it.
  const after = new HiveManager(() => home);
  await after.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'opencode', cwd: home });
  assert.equal(after.lastSession('jim-1'), 'ses_main');
  const registry = JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8'));
  assert.equal(registry.agents['jim-1'].sessionId, 'ses_main');
});

test('the opencode preset resumes by id; providers that cannot resume are known', () => {
  assert.equal(providerPreset('opencode').resumeFlag, '--session');
  assert.equal(supportsResume('opencode'), true);
  assert.equal(supportsResume('claude'), true);
  assert.equal(supportsResume('codex'), true); // subcommand form
  assert.equal(supportsResume('qwen'), false);
  assert.equal(supportsResume(undefined), false);
});
