import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { SettlementService } from './service.js';
import { createGasFreeAdapter } from './integration/index.js';

const config = readConfig();
// Resolve against this project's files, independent of the shell's working directory.
const store = new Store(fileURLToPath(new URL('../.data/state.json', import.meta.url)));
await store.initialize();
const service = new SettlementService(store, config, createGasFreeAdapter(config));
createApp(service, config).listen(config.port, '127.0.0.1', () => {
  console.log(`SettleMap API: http://127.0.0.1:${config.port} — ${config.enabled && config.apiKey && config.apiSecret ? 'GasFree Nile enabled; wallet signatures required' : 'fixture default; live submit disabled'}.`);
});
