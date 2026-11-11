#!/usr/bin/env node
/**
 * Offline smoke test: boots the MCP server over stdio and exercises the
 * JSON-RPC handshake without touching the e-Kinerja API.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
const EXPECTED_TOOLS = [
  'ekinerja_status',
  'ekinerja_set_token',
  'ekinerja_list_skp',
  'ekinerja_list_rhk',
  'ekinerja_list_renaksi',
  'ekinerja_get_daily_activities',
  'ekinerja_add_daily_activity',
  'ekinerja_delete_daily_activity'
];

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const pending = new Map();
let stderr = '';

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`Non-JSON output on stdout: ${line.slice(0, 200)}`);
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function fail(reason) {
  cleanup();
  console.error(`FAIL ${reason}`);
  process.exit(1);
}

function cleanup() {
  if (!child.killed) child.kill('SIGTERM');
}

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), 5000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return promise;
}

function assert(condition, reason) {
  if (!condition) fail(reason);
}

const timer = setTimeout(() => fail('Server did not finish the handshake within 10s'), 10000);

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' }
  });
  assert(init.result, `initialize returned an error: ${JSON.stringify(init.error)}`);
  assert(init.result.serverInfo?.name === 'ekinerja-bkn-mcp', 'Unexpected serverInfo.name');
  assert(init.result.capabilities?.tools, 'Server did not advertise the tools capability');

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const ping = await rpc('ping', {});
  assert(ping.result !== undefined, 'ping did not return a result');

  const list = await rpc('tools/list', {});
  const tools = list.result?.tools ?? [];
  assert(tools.length === EXPECTED_TOOLS.length, `Expected ${EXPECTED_TOOLS.length} tools, got ${tools.length}`);
  for (const name of EXPECTED_TOOLS) {
    assert(tools.some((t) => t.name === name), `Missing tool: ${name}`);
  }
  for (const tool of tools) {
    assert(tool.description, `Tool ${tool.name} has no description`);
    assert(tool.inputSchema?.type === 'object', `Tool ${tool.name} has no object inputSchema`);
  }

  const unknown = await rpc('tools/call', { name: 'does_not_exist', arguments: {} });
  assert(unknown.error?.code === -32603, 'Unknown tool should return JSON-RPC error -32603');

  clearTimeout(timer);
  cleanup();
  console.log(`PASS handshake ok, ${tools.length} tools listed, unknown tool rejected${stderr ? ` (stderr: ${stderr.trim().slice(0, 120)})` : ''}`);
  process.exit(0);
} catch (err) {
  fail(err.message);
}
