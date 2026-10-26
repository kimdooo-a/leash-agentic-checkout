// Tiny JSON-file store. One process owns it. Good enough for a single-user demo agent.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MANDATE, normalizeMandate } from './policy.js';

export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'state.json');
    this.auditFile = path.join(dir, 'audit.jsonl');
    const fresh = { mandate: { ...DEFAULT_MANDATE }, ledger: [], proposals: {}, orders: {}, audit: [] };
    this.state = existsSync(this.file) ? { ...fresh, ...JSON.parse(readFileSync(this.file, 'utf8')) } : fresh;
    this.state.mandate = normalizeMandate(this.state.mandate);
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  audit(kind, data) {
    const e = { at: new Date().toISOString(), kind, ...data };
    this.state.audit.push(e);
    if (this.state.audit.length > 400) this.state.audit.splice(0, this.state.audit.length - 400);
    appendFileSync(this.auditFile, JSON.stringify(e) + '\n');
    return e;
  }
}
