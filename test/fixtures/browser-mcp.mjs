import { createInterface } from 'node:readline';
const tools = ['browser_snapshot', 'browser_state', 'browser_take_screenshot', 'browser_navigate', 'browser_close', 'browser_run_code_unsafe'];
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!('id' in message)) continue;
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: tools.map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } })) };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'fixture ' + message.params.name }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
}
