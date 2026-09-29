import type { Health } from '../shared/types.js';
import { gasFreeConfigFromEnv, validateGasFreeConfig } from './integration/config.js';

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const gasFree = validateGasFreeConfig(gasFreeConfigFromEnv(env));
  return { ...gasFree, port: 8788 };
}
export type Config = ReturnType<typeof readConfig>;

export function health(config: Config): Health {
  const configured = Boolean(config.apiKey && config.apiSecret);
  const executable = configured && config.enabled;
  return { app: 'SettleMap', paymentMode: executable ? 'live' : 'fixture', liveConfigured: configured, liveEnabled: executable,
    gasFree: { apiKeyConfigured: Boolean(config.apiKey), apiSecretConfigured: Boolean(config.apiSecret), baseUrl: config.baseUrl, configured, executable },
    note: !configured ? '当前使用明确标识的 fixture；配置 GasFree Nile API Key/Secret 后可读取真实预检。'
      : !config.enabled ? '已配置 GasFree Nile 凭据，真实 submit 仍被 ENABLE_GASFREE_LIVE 关闭；不会静默回退模拟。'
      : 'GasFree Nile 真实模式已启用；每笔付款仍需在 TronLink 核对并签署 TIP-712 授权。' };
}
