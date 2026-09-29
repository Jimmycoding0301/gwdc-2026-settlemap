import { fixtureAddress } from './plan.js';
import type { InputRow } from './types.js';

export function sampleRows(): InputRow[] {
  const ana = fixtureAddress(1), bao = fixtureAddress(2), miko = fixtureAddress(3);
  const rows: InputRow[] = [
    { id: 'sim_row_01', invoiceId: 'AURORA-SEP-TT-042', payeeId: 'creator_ana', payeeName: 'ana.moves', address: ana, token: 'USDT', amount: '20', note: 'AURORA SEA · TikTok TT-042' },
    { id: 'sim_row_02', invoiceId: 'AURORA-SEP-IG-017', payeeId: 'creator_ana', payeeName: 'Ana Cruz', address: ana, token: 'USDT', amount: '35', note: 'AURORA SEA · Instagram IG-017' },
    { id: 'sim_row_03', invoiceId: 'AURORA-SEP-X-008', payeeId: 'creator_ana', payeeName: 'ANA.MOVES', address: ana, token: 'USDT', amount: '25', note: 'AURORA SEA · X X-008' },
    { id: 'sim_row_04', invoiceId: 'NEON-SEP-YT-011', payeeId: 'creator_bao', payeeName: 'bao.chain', address: bao, token: 'USDT', amount: '40', note: 'NEON Korea · YouTube YT-011' },
    { id: 'sim_row_05', invoiceId: 'NEON-AUG-TT-003', payeeId: 'creator_bao', payeeName: 'Bao Nguyen', address: bao, token: 'USDT', amount: '15', note: '上月已付误复制 · TikTok TT-003' },
    { id: 'sim_row_06', invoiceId: 'NEON-SEP-X-027', payeeId: 'creator_bao', payeeName: 'BAO.CHAIN', address: bao, token: 'USDT', amount: '30', note: 'NEON Korea · X X-027' },
    { id: 'sim_row_07', invoiceId: 'ORBIT-SEP-YT-014', payeeId: 'creator_miko', payeeName: 'miko.lab', address: miko, token: 'USDT', amount: '10', note: 'ORBIT Wallet · YouTube YT-014' },
    { id: 'sim_row_08', invoiceId: 'ORBIT-SEP-IG-021', payeeId: 'creator_miko', payeeName: 'Miko Santos', address: miko, token: 'USDT', amount: '25', note: 'ORBIT Wallet · Instagram IG-021' },
    { id: 'sim_row_09', invoiceId: 'ORBIT-SEP-TT-029', payeeId: 'creator_miko', payeeName: 'MIKO.LAB', address: miko, token: 'USDT', amount: '35', note: 'ORBIT Wallet · TikTok TT-029' },
  ];
  // One OCR character is deliberately upper-cased. The address still looks plausible,
  // but its Base58Check checksum is invalid and must never be guessed back into shape.
  rows.push({ ...rows[0], id: 'sim_row_10', invoiceId: 'AURORA-SEP-TT-099', address: ana.replace('Y', 'y'), amount: '35', note: 'Telegram OCR · 地址单字符误读' });
  rows.push({ ...rows[1], id: 'sim_row_11', invoiceId: rows[0].invoiceId, amount: '20', note: '同内容链接重复申报 · TikTok TT-042' });
  rows.push({ ...rows[8], id: 'sim_row_12', invoiceId: 'ORBIT-SEP-YT-088', amount: '650', note: '金额异常 · YouTube YT-088' });
  return rows;
}

/** Confirmed August payouts used only to prime the explicit local demo scenario. */
export function priorMonthRows(): InputRow[] {
  return [
    { id: 'sim_history_01', invoiceId: 'AURORA-AUG-IG-006', payeeId: 'creator_ana', payeeName: 'ana.moves', address: fixtureAddress(1), token: 'USDT', amount: '40', note: 'AURORA SEA · August archive' },
    { id: 'sim_history_02', invoiceId: 'NEON-AUG-TT-003', payeeId: 'creator_bao', payeeName: 'bao.chain', address: fixtureAddress(4), token: 'USDT', amount: '15', note: 'NEON Korea · August paid' },
    { id: 'sim_history_03', invoiceId: 'ORBIT-AUG-YT-002', payeeId: 'creator_miko', payeeName: 'miko.lab', address: fixtureAddress(3), token: 'USDT', amount: '95', note: 'ORBIT Wallet · August archive' },
  ];
}
