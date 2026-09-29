export type GasFreeTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, unknown>;
};

const NILE_CHAIN_HEX = '0xcd8690dc';
const NILE_CHAIN_DECIMAL = 3448148188;
const NILE_CONTROLLER = 'THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc';
const NILE_RPC_ORIGIN = 'https://nile.trongrid.io';

type TronWebLike = {
  ready?: boolean;
  defaultAddress?: { base58?: string };
  fullNode?: { host?: string; fullHost?: string };
  trx?: {
    _signTypedData?: (
      domain: GasFreeTypedData['domain'],
      types: GasFreeTypedData['types'],
      message: GasFreeTypedData['message'],
    ) => Promise<string>;
  };
};

type RequestInput = { method: string; params?: unknown[] };
type TronProviderLike = {
  isTronLink?: boolean;
  request?: (input: RequestInput) => Promise<unknown>;
  tronWeb?: TronWebLike | false;
};

declare global {
  interface Window {
    /** Current TIP-1193 provider surface. */
    tron?: TronProviderLike;
    /** Backward-compatible provider used only if the current surface is unavailable. */
    tronLink?: TronProviderLike;
    tronWeb?: TronWebLike;
  }
}

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? Number((error as { code: unknown }).code) : undefined;
const methodUnavailable = (error: unknown) => [4200, -32601].includes(errorCode(error) ?? 0);

function legacyTronWeb(): TronWebLike | undefined {
  const candidate = window.tronLink?.tronWeb || window.tronWeb;
  return candidate || undefined;
}

function assertNileTronWeb(tronWeb: TronWebLike | undefined): TronWebLike {
  if (!tronWeb?.ready || !tronWeb.defaultAddress?.base58) {
    throw new Error('TronLink 未连接。请先解锁插件并授权当前页面。');
  }
  const host = tronWeb.fullNode?.host || tronWeb.fullNode?.fullHost;
  let origin = '';
  try { origin = host ? new URL(host).origin : ''; } catch { origin = ''; }
  if (origin !== NILE_RPC_ORIGIN) throw new Error('TronLink 当前不是 Nile 测试网。请切换到 Nile 后再签名。');
  return tronWeb;
}

async function switchToNile(provider: TronProviderLike): Promise<void> {
  if (!provider.request) throw new Error('当前 TronLink 无法验证 Nile 网络，未允许签名。');
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: NILE_CHAIN_HEX }] });
}

async function currentProviderTronWeb(): Promise<TronWebLike> {
  const provider = window.tron;
  if (!provider?.request || provider.isTronLink !== true) throw new Error('CURRENT_PROVIDER_UNAVAILABLE');
  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new Error('TronLink 未返回已授权账户。');
    await switchToNile(provider);
    const tronWeb = assertNileTronWeb(provider.tronWeb || undefined);
    if (tronWeb.defaultAddress?.base58 !== accounts[0]) throw new Error('TronLink 授权账户与当前账户不一致，请重新连接。');
    return tronWeb;
  } catch (error) {
    if (methodUnavailable(error)) throw new Error('CURRENT_PROVIDER_UNAVAILABLE');
    throw error;
  }
}

async function legacyProviderTronWeb(): Promise<TronWebLike> {
  const provider = window.tronLink;
  if (!provider) throw new Error('未检测到 TronLink。请安装并解锁插件。');
  if (provider.request) {
    const result = await provider.request({ method: 'tron_requestAccounts' });
    if (result && typeof result === 'object' && 'code' in result && Number((result as { code: unknown }).code) !== 200) {
      throw new Error('TronLink 未授权当前页面。');
    }
    await switchToNile(provider);
  }
  return assertNileTronWeb(provider.tronWeb || legacyTronWeb());
}

async function connectedNileTronWeb(): Promise<TronWebLike> {
  try { return await currentProviderTronWeb(); }
  catch (error) {
    if (error instanceof Error && error.message === 'CURRENT_PROVIDER_UNAVAILABLE') return legacyProviderTronWeb();
    throw error;
  }
}

/** Connects the current TronLink provider first, with a legacy fallback. */
export async function connectTronLink(): Promise<string> {
  return assertNileTronWeb(await connectedNileTronWeb()).defaultAddress!.base58!;
}

/** Signs the exact GasFree TIP-712 payload, only with the bound payer on Nile. */
export async function signGasFreeAuthorization(typedData: GasFreeTypedData): Promise<string> {
  if (Number(typedData.domain.chainId) !== NILE_CHAIN_DECIMAL || typedData.domain.verifyingContract !== NILE_CONTROLLER) {
    throw new Error('GasFree 授权不是官方 Nile 域，未允许签名。');
  }
  const tronWeb = assertNileTronWeb(await connectedNileTronWeb());
  const trx = tronWeb.trx;
  if (!trx?._signTypedData) throw new Error('当前钱包不支持 TIP-712 签名，未提交付款。');
  const connectedAddress = tronWeb.defaultAddress?.base58;
  const authorizedAddress = typedData.message.user;
  if (typeof authorizedAddress !== 'string' || connectedAddress !== authorizedAddress) {
    throw new Error('TronLink 当前账户与已确认付款账户不同。请切回原账户或重新生成清单；未提交付款。');
  }
  const signature = await trx._signTypedData(typedData.domain, typedData.types, typedData.message);
  if (typeof signature !== 'string' || !/^(0x)?[0-9a-f]{130}$/i.test(signature)) {
    throw new Error('钱包返回的 TIP-712 签名格式无效，未提交付款。');
  }
  return signature.replace(/^0x/i, '');
}
