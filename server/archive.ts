import { createHash } from 'node:crypto';
import type { Batch } from '../shared/types.js';
import { businessCsv, paymentsCsv } from '../shared/csv.js';

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Standard ZIP STORE archive; bounded, fixed filenames; no dependency or compression runtime. */
function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(file.data.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, file.data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(file.data.length, 20); directory.writeUInt32LE(file.data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + file.data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function reconciliationArchive(batch: Batch): Buffer {
  const contents = [
    { name: 'business.csv', data: Buffer.from(businessCsv(batch), 'utf8') },
    { name: 'payments.csv', data: Buffer.from(paymentsCsv(batch), 'utf8') },
    { name: 'batch.json', data: Buffer.from(JSON.stringify(batch, null, 2), 'utf8') },
  ];
  const fixtureNotes = [
    'Local fixture only. sim_ trace IDs are not blockchain transaction hashes; no USDT was transferred.',
    'UNKNOWN means query the original fixture trace; do not create another payment attempt.',
  ];
  const liveNotes = [
    'Live GasFree record. The GasFree Provider supplies the traceId-to-txnHash association; Nile RPC cannot independently prove that association.',
    'VERIFIED means Nile solidity RPC independently matched the transaction body, successful receipt, authorization time window, and exact TRC-20 Transfer token/from/to/amount.',
    'manifestHash and operationHash are local reconciliation metadata. They are neither on-chain nor included in the GasFree TIP-712 signature.',
    'Within this local store, one txnHash/Transfer-log-index pair may be claimed by only one payment/operation.',
    'UNKNOWN without a traceId requires manual reconciliation. The requestId is diagnostic and must not be treated as an idempotency guarantee.',
  ];
  const manifest = {
    version: '2', batchId: batch.id, mode: batch.mode, status: batch.status,
    exportedAt: batch.updatedAt, planDigest: batch.planDigest, settlementManifestHash: batch.manifestHash,
    settlementManifest: batch.settlementManifest, summary: batch.plan.summary,
    chainVerification: batch.payments.map(payment => ({ paymentId: payment.id, operationHash: payment.operationHash,
      txHash: payment.txHash, status: payment.chainVerification?.status, blockNumber: payment.chainVerification?.blockNumber,
      explorerUrl: payment.chainVerification?.explorerUrl })),
    files: contents.map(file => ({ name: file.name, bytes: file.data.length, sha256: createHash('sha256').update(file.data).digest('hex') })),
    notes: [
      ...(batch.mode === 'fixture' ? fixtureNotes : liveNotes),
      'Fees appear once per payment in payments.csv; business.csv preserves original rows, review and deferral decisions.',
      'reviewedAddressChange records a manual review declaration; it does not prove ownership of an address.',
      'Checksums describe package contents, not independently authenticated proof of a payment.',
    ],
  };
  return zipStore([...contents, { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }]);
}
