import { LedgerBusyError } from '../../ledger/src/index.js';
import type { OrgManageCore } from './index.js';
import type { ApprovalData, IntentData } from './model.js';
import { isLocalFixtureIntent } from './local-fixture-boundary.js';

type Pending = { principalId: string; intentId: string; tries: number; nextAt: number; stage: 'inspect' | 'acquire' | 'observation' | 'exhausted' };
/** Fixed local fixture scheduler. This class never handles a real provider route. */
export class LocalFakeDispatcher {
  readonly #pending = new Map<string, Pending>();
  readonly #finished = new Set<string>();
  constructor(readonly core: OrgManageCore, readonly clock: () => number = () => performance.now()) {}
  /** canDispatch must be pure: Core also evaluates it inside the TX2 transaction. */
  tick(canDispatch: () => boolean = () => true): { status: 'ready' | 'recovery_required' } {
    try {
      if (!canDispatch()) return { status: 'ready' };
      this.core.maintain();
      const candidates = this.core.store.read(tx => tx.listPrincipal().flatMap(p => tx.listRecord(p.id, 'intent').flatMap(row => {
        const value = JSON.parse(row.data) as IntentData;
        if (!isLocalFixtureIntent(tx, p.id, value)) return [];
        if (value.state !== 'prepared' || this.#pending.has(row.id) || this.#finished.has(row.id)) return [];
        const approval = tx.getRecord(p.id, value.approvalId);
        return approval && (JSON.parse(approval.data) as ApprovalData).state === 'approved' ? [{ principalId: p.id, intentId: row.id }] : [];
      })));
      for (const item of candidates) this.#pending.set(item.intentId, { ...item, tries: 0, nextAt: this.clock(), stage: 'acquire' });
      let processed = 0;
      for (const [id, item] of this.#pending) {
        if (processed >= 8 || !canDispatch()) break;
        if (this.clock() < item.nextAt) continue;
        processed++;
        if (item.stage === 'inspect') {
          // A BUSY response does not say whether TX2 or only its observation write
          // failed. Keep this stage until a read succeeds; never assume "acquire".
          let state: IntentData['state'] | null;
          try {
            state = this.core.store.read(tx => {
              const row = tx.getRecord(item.principalId, id); return row ? (JSON.parse(row.data) as IntentData).state : null;
            });
          } catch (cause) {
            if (!(cause instanceof LedgerBusyError)) throw cause;
            item.nextAt = this.clock() + 1000;
            continue;
          }
          if (state === null) return { status: 'recovery_required' };
          if (state !== 'prepared' && state !== 'send_intent') { this.#pending.delete(id); this.#finished.add(id); continue; }
          item.stage = item.tries >= 3 ? 'exhausted' : state === 'prepared' ? 'acquire' : 'observation';
        }
        const stage = item.stage;
        const result = item.stage === 'exhausted' ? this.core.exhaustFakeRetry(item.principalId, id)
          : item.stage === 'acquire' ? this.core.executeFake(item.principalId, id, canDispatch) : this.core.finishFakeObservation(item.principalId, id);
        if (!result.ok && result.error.code === 'RECOVERY_REQUIRED') return { status: 'recovery_required' };
        if (!result.ok && (result.error.code === 'BUSY_NOT_COMMITTED' || (stage === 'acquire' && result.error.code === 'DENIED'))) {
          item.tries++;
          item.stage = 'inspect';
          item.nextAt = this.clock() + 1000;
          continue;
        }
        this.#pending.delete(id); this.#finished.add(id);
      }
      return { status: 'ready' };
    } catch (cause) {
      if (cause instanceof LedgerBusyError) return { status: 'ready' };
      return { status: 'recovery_required' };
    }
  }
}
