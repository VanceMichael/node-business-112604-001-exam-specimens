import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './src/store.mjs';
import { createHandler } from './src/app.mjs';
import { PeerClient } from './src/peer-client.mjs';

const home = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(await readFile(path.join(home, 'data/catalog.json'), 'utf8'));
const statePath = path.resolve(process.env.SERVICE_STATE || '.local/service-state.json');
const store = new JsonStore(statePath);
await store.load();
await store.mutate(state => {
  // The synthetic catalog already contains two physically collected tubes.
  // Seed them as queryable specimen facts while leaving usability unconfirmed.
  for (const sample of catalog.samples || []) {
    if (state.samples.some(s => s.id === sample.id)) continue;
    const personId = sample.personId || sample.person;
    const actualMl = sample.actualMl || sample.ml;
    const seeded = {
      id: sample.id,
      personId,
      sampleType: sample.sampleType || sample.type,
      container: sample.container,
      actualMl,
      collectedAt: sample.collectedAt,
      conditions: sample.conditions || [],
      collectorId: sample.collectorId || null,
      parentSampleId: sample.parentSampleId || null,
      rootSampleId: sample.rootSampleId || sample.id,
      status: 'catalog_seeded_pending_usability',
      currentHolderId: sample.currentHolderId || 'center-custody',
      custodyLocation: sample.custodyLocation || '中心标本待检验确认',
      seededFromCatalog: true,
      createdAt: new Date().toISOString()
    };
    state.samples.push(seeded);
    state.custodyEvents.push({
      id: `custody-seed-${sample.id}`,
      sampleId: sample.id,
      at: sample.collectedAt,
      type: 'catalog_seeded_collection',
      toHolderId: seeded.currentHolderId,
      location: seeded.custodyLocation,
      actorId: 'synthetic-catalog',
      facts: { container: sample.container, actualMl, conditions: seeded.conditions }
    });
  }
});
const peer = new PeerClient();
const handler = createHandler({ store, catalog, peer });
const server = http.createServer(handler);
const port = Number(process.env.PORT || process.env.SERVICE_PORT || 4100);
const host = process.env.HOST || process.env.SERVICE_HOST || '127.0.0.1';
server.listen(port, host, () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ service: 'exam-specimen-service', message: '体检业务 HTTP 服务已启动', port: address.port, host, statePath }) + '\n');
});

function shutdown(signal) {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
