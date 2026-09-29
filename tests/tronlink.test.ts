import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectTronLink, signGasFreeAuthorization } from '../src/tronlink.js';

const fixtureAddress = 'TA4Wt1DUCqz6YegbnsmqsWC5uUfbdBqPxm';
const controller = 'THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc';
const typedData = (user = fixtureAddress) => ({ domain: { chainId: 3448148188, verifyingContract: controller }, types: {}, message: { user } });
const tronWeb = (trx: object = {}) => ({ ready: true, defaultAddress: { base58: fixtureAddress },
  fullNode: { host: 'https://nile.trongrid.io' }, trx });

afterEach(() => vi.unstubAllGlobals());

describe('TronLink signing boundary', () => {
  it('uses the current provider, requests accounts, switches to Nile, and keeps the trx receiver bound', async () => {
    const trx = { marker: 'bound', async _signTypedData(this: { marker: string }) {
      expect(this.marker).toBe('bound'); return '1'.repeat(130);
    } };
    const request = vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [fixtureAddress] : null);
    vi.stubGlobal('window', { tron: { isTronLink: true, request, tronWeb: tronWeb(trx) } });
    expect(await connectTronLink()).toBe(fixtureAddress);
    expect(await signGasFreeAuthorization(typedData())).toBe('1'.repeat(130));
    expect(request.mock.calls.map(([value]) => value)).toContainEqual({ method: 'eth_requestAccounts' });
    expect(request.mock.calls.map(([value]) => value)).toContainEqual({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xcd8690dc' }] });
  });

  it('uses the legacy request only when the current provider is unavailable', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => method === 'tron_requestAccounts' ? { code: 200 } : null);
    vi.stubGlobal('window', { tronLink: { request, tronWeb: tronWeb() } });
    expect(await connectTronLink()).toBe(fixtureAddress);
    expect(request).toHaveBeenNthCalledWith(1, { method: 'tron_requestAccounts' });
  });

  it('refuses to sign if the switched wallet still exposes a non-Nile full node', async () => {
    const signer = vi.fn(async () => '1'.repeat(130));
    const request = vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [fixtureAddress] : null);
    vi.stubGlobal('window', { tron: { isTronLink: true, request, tronWeb: { ...tronWeb({ _signTypedData: signer }), fullNode: { host: 'https://api.trongrid.io' } } } });
    await expect(signGasFreeAuthorization(typedData())).rejects.toThrow('当前不是 Nile');
    expect(signer).not.toHaveBeenCalled();
  });

  it('refuses a non-Nile typed-data domain and an account different from the authorized payer', async () => {
    const signer = vi.fn(async () => '1'.repeat(130));
    const request = vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [fixtureAddress] : null);
    vi.stubGlobal('window', { tron: { isTronLink: true, request, tronWeb: tronWeb({ _signTypedData: signer }) } });
    await expect(signGasFreeAuthorization({ domain: { chainId: 1, verifyingContract: controller }, types: {}, message: { user: fixtureAddress } }))
      .rejects.toThrow('不是官方 Nile 域');
    await expect(signGasFreeAuthorization(typedData('TX9fYn6t7pofFQAaRNEod3x8un7cEFVEwu')))
      .rejects.toThrow('当前账户与已确认付款账户不同');
    expect(signer).not.toHaveBeenCalled();
  });
});
