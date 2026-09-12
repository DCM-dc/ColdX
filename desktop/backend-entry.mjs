const SHUTDOWN_MESSAGE = 'coldx:shutdown';
let shuttingDown = false;

function emitShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (process.connected) process.disconnect();
  process.emit('SIGINT');
}

// Loaded with Node's --import before ColdX. Emitting SIGINT inside the child
// reaches DSH's JavaScript signal handlers on Windows, where child.kill(SIGINT)
// would terminate the process without running its native cleanup path.
process.on('message', message => {
  if (message?.type === SHUTDOWN_MESSAGE) emitShutdown();
});
process.on('disconnect', emitShutdown);

// Receiving shutdown over IPC remains possible while the backend owns active
// work, but the channel alone must not keep a failed CLI bootstrap alive.
process.channel?.unref();
