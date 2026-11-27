import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function initialState() {
  return {
    version: 1,
    seq: {},
    orders: [],
    items: [],
    consents: [],
    samples: [],
    assessments: [],
    allocations: [],
    custodyEvents: [],
    commissions: [],
    results: [],
    deliveries: [],
    notifications: [],
    paymentIntents: [],
    payments: [],
    refunds: [],
    qualityIssues: [],
    qualityReviews: [],
    audit: [],
    idempotency: {}
  };
}

export class JsonStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.state = initialState();
    this.chain = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      this.state = { ...initialState(), ...raw };
      for (const key of Object.keys(initialState())) {
        if (key !== 'version' && this.state[key] === undefined) this.state[key] = initialState()[key];
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
    return this.state;
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.file);
  }

  // mutator must be synchronous. All business check-and-write decisions run
  // through this serialized chain, closing the concurrent specimen race.
  mutate(mutator) {
    const operation = this.chain.then(async () => {
      const result = mutator(this.state);
      await this.save();
      return result;
    });
    this.chain = operation.catch(() => {});
    return operation;
  }
}
