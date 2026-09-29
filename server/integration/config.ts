export interface GasFreeConfig {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  rpcUrl?: string;
  tronGridApiKey?: string;
  enabled?: boolean;
  timeoutMs?: number;
}

export const NILE_CHAIN_ID = 3448148188 as const;
export const NILE_CONTROLLER = 'THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc';
export const NILE_API = 'https://open-test.gasfree.io/nile';
export const NILE_RPC = 'https://nile.trongrid.io';

/** Read supplied environment only; no files, wallet keys, or implicit dotenv loading. */
export function gasFreeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GasFreeConfig {
  return {
    apiKey: env.GASFREE_API_KEY?.trim() || '',
    apiSecret: env.GASFREE_API_SECRET?.trim() || '',
    baseUrl: env.GASFREE_BASE_URL || NILE_API,
    rpcUrl: env.GASFREE_TRON_RPC_URL || NILE_RPC,
    tronGridApiKey: env.TRONGRID_API_KEY?.trim() || '',
    enabled: env.ENABLE_GASFREE_LIVE === 'true',
    timeoutMs: 15_000,
  };
}

/** Keep server credentials on the official Nile origin; redirects are also disabled by the client. */
export function validateGasFreeConfig(config: GasFreeConfig): Required<GasFreeConfig> {
  if (config.baseUrl.replace(/\/$/, '') !== NILE_API || (config.rpcUrl || NILE_RPC).replace(/\/$/, '') !== NILE_RPC) {
    throw new Error('GasFree live integration only permits the official Nile testnet API and RPC.');
  }
  const timeoutMs = config.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('Invalid GasFree timeout.');
  return { apiKey: config.apiKey, apiSecret: config.apiSecret, baseUrl: NILE_API, rpcUrl: NILE_RPC,
    tronGridApiKey: config.tronGridApiKey || '', enabled: config.enabled === true, timeoutMs };
}
