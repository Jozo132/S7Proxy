// @ts-check
// Worker thread entry point — runs ProxyServer in a worker_threads context

import { parentPort, workerData } from 'node:worker_threads';
import { loadConfig } from './config.js';
import { ProxyServer } from './proxy-server.js';

if (!parentPort) {
  throw new Error('This module must be run as a worker thread');
}

const config = workerData?.config ?? loadConfig(workerData?.configPath);
const server = new ProxyServer(config);

parentPort.on('message', async (msg) => {
  switch (msg?.type) {
    case 'start':
      await server.start();
      parentPort?.postMessage({ type: 'started' });
      break;

    case 'stop':
      await server.stop();
      parentPort?.postMessage({ type: 'stopped' });
      break;

    default:
      parentPort?.postMessage({ type: 'error', error: `Unknown message type: ${msg?.type}` });
  }
});

// Auto-start if workerData says so
if (workerData?.autoStart) {
  server.start().then(() => {
    parentPort?.postMessage({ type: 'started' });
  });
}
