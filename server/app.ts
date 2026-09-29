import express from 'express';
import { z } from 'zod';
import { buildPlan } from '../shared/plan.js';
import { sampleRows } from '../shared/sample.js';
import { businessCsv, importCsv, inputCsv, paymentsCsv } from '../shared/csv.js';
import { health } from './config.js';
import type { Config } from './config.js';
import { SettlementService, ServiceError } from './service.js';
import { reconciliationArchive } from './archive.js';
import { extractSettlement, SettlementExtractionError, type LocalOcrRunner } from './settlement-ocr.js';

const field = z.string().max(2000);
const row = z.object({ id: field, invoiceId: field, payeeId: field, payeeName: field, address: field, token: field, amount: field, note: field,
  reviewedOverLimit: z.boolean().optional(), reviewedAddressChange: z.boolean().optional(), deferred: z.boolean().optional(), reviewNote: field.optional() }).strict();
const rows = z.array(row).min(1).max(500);

export function createApp(service: SettlementService, config: Config, options: { ocr?: LocalOcrRunner } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    if (!/^(localhost|127\.0\.0\.1):(5174|8788)$/.test(request.get('host') || '')) return response.status(403).json({ error: 'Local host only.' });
    const origin = request.get('origin');
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):(5174|8788)$/.test(origin)) return response.status(403).json({ error: 'Origin is not allowed.' });
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/health', (_request, response) => response.json(health(config)));
  app.post('/api/intake/screenshot', async (request, response) => {
    // A read-only extraction route: it does not call the settlement service or any external provider.
    response.json(await extractSettlement(request.body, { ocr: options.ocr,
      protectedValues: [config.apiKey, config.apiSecret, config.tronGridApiKey || ''] }));
  });
  app.get('/api/sample', (_request, response) => {
    const sample = sampleRows();
    response.json({ rows: sample, csv: inputCsv(sample), note: '12 条 KOL 佣金草稿；3 条校验异常，9 条可合并为 3 笔。' });
  });
  app.post('/api/import', (request, response) => {
    const input = z.object({ csv: z.string().max(1_500_000) }).strict().parse(request.body);
    response.json({ rows: importCsv(input.csv) });
  });
  app.post('/api/preview', (request, response) => response.json(buildPlan(z.object({ rows }).strict().parse(request.body).rows)));
  app.post('/api/ops/inspect', (request, response) => {
    const input = z.object({ rows, excludeBatchId: z.string().max(200).optional() }).strict().parse(request.body);
    response.json(service.inspect(input.rows, input.excludeBatchId));
  });
  app.post('/api/demo/reset', async (request, response) => {
    z.object({ confirm: z.literal('RESET_FIXTURE_HISTORY') }).strict().parse(request.body);
    response.json(await service.resetDemo());
  });
  app.post('/api/demo/creator-scenario', async (request, response) => {
    z.object({ confirm: z.literal('PREPARE_CREATOR_SCENARIO') }).strict().parse(request.body);
    response.json(await service.prepareCreatorDemo());
  });
  app.get('/api/batches', (_request, response) => response.json(service.list()));
  app.post('/api/batches', async (request, response) => {
    const input = z.object({ rows, mode: z.enum(['fixture', 'live']).default('fixture'), payerAddress: z.string().max(100).optional() }).strict().parse(request.body);
    response.status(201).json(await service.create(input.rows, input.mode, input.payerAddress));
  });
  app.get('/api/batches/:id', (request, response) => response.json(service.get(request.params.id)));
  app.post('/api/batches/:id/confirm', async (request, response) => {
    const input = z.object({ planDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    response.json(await service.confirm(request.params.id, input.planDigest));
  });
  app.post('/api/batches/:id/run', async (request, response) => response.json(await service.run(request.params.id)));
  app.post('/api/batches/:id/live/prepare', async (request, response) => {
    z.object({}).strict().parse(request.body);
    response.json(await service.prepareLive(request.params.id));
  });
  app.post('/api/batches/:id/live/submit', async (request, response) => {
    const input = z.object({ paymentId: z.string().min(1).max(200), requestId: z.string().uuid(), signature: z.string().regex(/^(?:0x)?[0-9a-f]{130}$/i) }).strict().parse(request.body);
    response.json(await service.submitLive(request.params.id, input.paymentId, input.requestId, input.signature));
  });
  app.post('/api/batches/:id/recover', async (request, response) => response.json(await service.recover(request.params.id)));
  app.get('/api/batches/:id/export/:kind', (request, response) => {
    const batch = service.get(request.params.id);
    const kind = request.params.kind;
    if (kind === 'package.zip') {
      response.type('application/zip').setHeader('Content-Disposition', `attachment; filename="settlemap-${batch.id}-reconciliation.zip"`);
      return response.send(reconciliationArchive(batch));
    }
    if (kind !== 'business.csv' && kind !== 'payments.csv') return response.status(404).json({ error: 'Unknown export.' });
    response.type('text/csv').setHeader('Content-Disposition', `attachment; filename="settlemap-${batch.id}-${kind}"`);
    response.send(kind === 'business.csv' ? businessCsv(batch) : paymentsCsv(batch));
  });
  app.use('/api', (_request, response) => response.status(404).json({ error: 'Unknown API route.' }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof SettlementExtractionError) return response.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof ServiceError) return response.status(error.status).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
    if (error instanceof z.ZodError) return response.status(400).json({ error: 'Invalid request.', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') return response.status(413).json({ error: 'Request body too large.' });
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Malformed JSON.' });
    if (error instanceof Error && /CSV|Provide 1–500|total exceeds integer precision/.test(error.message)) return response.status(400).json({ error: error.message });
    console.error('SettleMap operation failed; credentials and request bodies are not logged.');
    response.status(500).json({ error: 'Local operation failed. Check persisted state before retrying.' });
  });
  return app;
}
