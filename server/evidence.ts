import { createHash } from 'node:crypto';
import { canonical } from '../shared/plan.js';
import type { GasFreePreflight, PaymentPlan, SettlementManifest, SettlementPlan } from '../shared/types.js';

const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/**
 * A stable, timestamp-free statement of what this batch intends to settle.
 * It is evidence metadata, not an extra smart-contract parameter: GasFree's
 * fixed TIP-712 message signs token/user/receiver/value for each operation.
 */
export function buildSettlementManifest(plan: SettlementPlan, preflight: GasFreePreflight): SettlementManifest {
  if (plan.mode !== 'live' || preflight.mode !== 'live') throw new Error('A live Nile plan and preflight are required.');
  return {
    version: '1', network: 'nile', payerAddress: preflight.payerAddress, gasFreeAddress: preflight.gasFreeAddress,
    tokenAddress: preflight.selectedToken.tokenAddress, providerAddress: preflight.selectedProvider.address,
    payments: plan.payments.map(payment => ({ paymentId: payment.id, payeeId: payment.payeeId, address: payment.address,
      token: payment.token, amountMicros: payment.amountMicros, rowIds: [...payment.rowIds], invoiceIds: [...payment.invoiceIds] })),
  };
}

export function settlementManifestHash(manifest: SettlementManifest): string { return sha256(manifest); }

export function operationHash(manifestHash: string, payment: Pick<PaymentPlan, 'id' | 'address' | 'amountMicros'>,
  fields: { token: string; user: string; gasFreeAddress: string; serviceProvider: string; maxFee: string; deadline: string; version: string; nonce: string }): string {
  if (!/^[a-f0-9]{64}$/.test(manifestHash)) throw new Error('Invalid settlement manifest hash.');
  return sha256({ version: '1', manifestHash, paymentId: payment.id, token: fields.token, user: fields.user,
    gasFreeAddress: fields.gasFreeAddress, receiver: payment.address, value: String(payment.amountMicros),
    serviceProvider: fields.serviceProvider, maxFee: fields.maxFee, deadline: fields.deadline, authorizationVersion: fields.version, nonce: fields.nonce });
}

export function manifestMatchesPlan(manifest: SettlementManifest, plan: SettlementPlan, preflight: GasFreePreflight, payerAddress?: string): boolean {
  try { return canonical(manifest) === canonical(buildSettlementManifest(plan, preflight)) && manifest.payerAddress === payerAddress; }
  catch { return false; }
}
