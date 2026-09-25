#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createTui, parseTuiArguments } from '../lib/tui/interface.mjs';

function openInBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

let requestedUrl = 'http://127.0.0.1:3086';
try {
  const options = parseTuiArguments(process.argv.slice(2));
  requestedUrl = options.url;
  if (options.help) {
    process.stdout.write(`ColdX TUI — 连接已运行的 ColdX Web Host\n\n用法：pnpm tui [--url http://127.0.0.1:3086] [--session <会话 ID>]\n\n先运行 pnpm start --no-open 启动 Host。TUI 直接使用同一组 DSH 会话；\n退出终端界面不会停止 Host。非交互终端会输出会话列表与指定会话的历史文本。\n`);
  } else {
    const { connect } = await import('../lib/tui/transport.mjs');
    const client = connect({ url: options.url });
    const tui = createTui({ client, url: options.url, openUrl: openInBrowser });
    await tui.start({ sessionId: options.sessionId });
    process.once('SIGTERM', () => tui.stop());
  }
} catch (error) {
  const connectionFailure = error?.message === 'fetch failed' || /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|WebSocket.*(?:timed out|failed to open)/i.test(error?.message ?? '');
  if (connectionFailure) {
    let address = requestedUrl;
    try { address = new URL(requestedUrl).origin; } catch { /* Argument validation reports the detail below. */ }
    process.stderr.write(`ColdX TUI：无法连接到本机 ColdX Host（${address}）。请先运行 pnpm start --no-open，然后重试。\n`);
  } else process.stderr.write(`ColdX TUI：${error.message}\n`);
  process.exitCode = 1;
}
