import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractSettlement, validateSettlementImage, runLocalOcr } from '../server/settlement-ocr';
import { createApp } from '../server/app';
import { readConfig } from '../server/config';
import { Store } from '../server/store';
import { SettlementService } from '../server/service';
import { fixtureAddress } from '../shared/plan';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execute }));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=';
const body = () => ({ imageDataUrl: `data:image/png;base64,${png}` });
const recognized = [{ text: 'invoice\tpayee\taddress\tamount (USDT)\tnote', confidence: .99 },
  { text: `INV-01\tMina\t${fixtureAddress(1)}\t12.5\tCommission`, confidence: .98 }];
afterEach(() => { execute.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('strict local image validation', () => {
  it('checks file magic, canonical base64, dimensions, MIME, and request keys before OCR', () => {
    expect(validateSettlementImage(body())).toMatchObject({ mime: 'image/png', width: 1, height: 1 });
    for (const invalid of [{ imageDataUrl: 'https://example.com/image.png' }, { ...body(), autoPay: true },
      { imageDataUrl: 'data:image/jpeg;base64,' + png }, { imageDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
      { imageDataUrl: 'data:image/png;base64,AAAA' }]) expect(() => validateSettlementImage(invalid)).toThrow();
    const huge = Buffer.from(png, 'base64'); huge.writeUInt32BE(8193, 16);
    expect(() => validateSettlementImage({ imageDataUrl: 'data:image/png;base64,' + huge.toString('base64') })).toThrow(/8192/);
    expect(() => validateSettlementImage({ imageDataUrl: 'data:image/png;base64,' + 'A'.repeat(1_400_000) })).toThrow(/1 MiB/);
  });
  it('never uses fetch and redacts configured synthetic secrets before returning row evidence', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const result = await extractSettlement(body(), { ocr: async () => [{ ...recognized[0] }, { ...recognized[1], text: recognized[1].text.replace('Commission', 'SYNTHETIC_KEY_ONLY') }], protectedValues: ['SYNTHETIC_KEY_ONLY'] });
    expect(result.drafts).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_KEY_ONLY');
    expect(JSON.stringify(result)).toContain('[REDACTED]');
    expect(result).not.toHaveProperty('rawText');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns a fixed failure without OCR text or errors from the worker', async () => {
    await expect(extractSettlement(body(), { ocr: async () => { throw new Error('PRIVATE_OCR_CONTENT'); } })).rejects.toMatchObject({ code: 'OCR_FAILED', status: 422 });
    try { await extractSettlement(body(), { ocr: async () => { throw new Error('PRIVATE_OCR_CONTENT'); } }); } catch (error) { expect(String(error)).not.toContain('PRIVATE_OCR_CONTENT'); }
  });
  it('uses a secret-free child environment, fixed timeout and private temporary files, then cleans up', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    let imagePath = '';
    execute.mockImplementation((file, args, options, callback) => {
      expect(file).toBe('/usr/bin/swift'); expect(options.timeout).toBe(30_000); expect(options.killSignal).toBe('SIGKILL');
      expect(Object.keys(options.env).sort()).toEqual(['LANG', 'PATH', 'TMPDIR']);
      imagePath = args.at(-1);
      expect(readFileSync(imagePath)).toEqual(Buffer.from(png, 'base64'));
      expect(statSync(imagePath).mode & 0o777).toBe(0o600);
      expect(statSync(options.env.TMPDIR).mode & 0o777).toBe(0o700);
      callback(null, JSON.stringify({ lines: recognized }));
    });
    expect(await runLocalOcr(validateSettlementImage(body()))).toHaveLength(2);
    expect(existsSync(imagePath)).toBe(false);
  });
  it('fails explicitly on non-macOS without launching a worker', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    await expect(runLocalOcr(validateSettlementImage(body()))).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE', status: 503 });
    expect(execute).not.toHaveBeenCalled();
  });
  it('times out with a fixed error and still removes the private image', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    let imagePath = '';
    execute.mockImplementation((_file, args, _options, callback) => {
      imagePath = args.at(-1); callback(Object.assign(new Error('PRIVATE_NATIVE_DETAIL'), { killed: true }), '');
    });
    await expect(runLocalOcr(validateSettlementImage(body()))).rejects.toMatchObject({ code: 'OCR_TIMEOUT', status: 504 });
    expect(existsSync(imagePath)).toBe(false);
  });
  it('allows only one local worker at a time', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    let finish: (() => void) | undefined;
    execute.mockImplementation((_file, _args, _options, callback) => { finish = () => callback(null, JSON.stringify({ lines: recognized })); });
    const first = runLocalOcr(validateSettlementImage(body()));
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(runLocalOcr(validateSettlementImage(body()))).rejects.toMatchObject({ code: 'OCR_BUSY', status: 429 });
    finish!(); await first;
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe('screenshot endpoint has no settlement side effects', () => {
  it('extracts only after explicit POST, rejects external origins, and never creates a batch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'settlemap-ocr-test-'));
    const config = readConfig({}); const store = new Store(join(directory, 'state.json')); await store.initialize();
    const service = new SettlementService(store, config); const created = vi.spyOn(service, 'create'); const run = vi.spyOn(service, 'run');
    const ocr = vi.fn(async () => recognized);
    const app = createApp(service, config, { ocr });
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const location = server.address(); if (!location || typeof location === 'string') throw new Error('Missing server address');
    const call = (origin?: string, payload: unknown = body()) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const outgoing = httpRequest({ hostname: '127.0.0.1', port: location.port, path: '/api/intake/screenshot', method: 'POST',
        headers: { Host: '127.0.0.1:8788', 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); outgoing.on('error', reject); outgoing.end(JSON.stringify(payload));
    });
    try {
      expect((await call('https://example.com')).status).toBe(403); expect(ocr).not.toHaveBeenCalled();
      expect((await call(undefined, { ...body(), run: true })).status).toBe(400); expect(ocr).not.toHaveBeenCalled();
      const result = await call('http://127.0.0.1:5174'); expect(result.status).toBe(200);
      expect(result.body.source).toBe('local-vision'); expect(result.body.drafts).toHaveLength(1);
      expect(created).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(store.batches.size).toBe(0);
    } finally { server.close(); await once(server, 'close'); await rm(directory, { recursive: true, force: true }); }
  });
});
