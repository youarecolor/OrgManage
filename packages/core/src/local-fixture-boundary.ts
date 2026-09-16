import type { LedgerReader } from '../../ledger/src/index.js';
import type { IntentData } from './model.js';

/** Legacy intents have no route field; their complete Attempt/Run chain is required. */
export function isLocalFixtureIntent(tx: LedgerReader, principalId: string, intent: IntentData): boolean {
  const explicitRoute = (intent as IntentData & { route?: unknown }).route;
  if (explicitRoute !== undefined && explicitRoute !== 'local-fixture') return false;
  if (typeof intent.attemptId !== 'string' || typeof intent.missionId !== 'string') return false;
  const attempt = tx.getRecord(principalId, intent.attemptId);
  if (!attempt || attempt.kind !== 'attempt') return false;
  const a = JSON.parse(attempt.data);
  if (a.route !== 'local-fixture' || a.model !== null || typeof a.runId !== 'string') return false;
  const run = tx.getRecord(principalId, a.runId);
  if (!run || run.kind !== 'run') return false;
  const r = JSON.parse(run.data);
  return r.mode === 'local_fake' && r.model === null && r.scopeKind === 'mission'
    && r.missionId === intent.missionId && r.conversationId === null && r.purpose === 'production';
}
