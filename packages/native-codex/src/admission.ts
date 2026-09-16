/** Missing metadata is unknown, never a default grant. This packet has no live qualification. */
export interface CodexCatalogEntry { model:string; efforts:readonly string[] }
export function assessCodexModel(model:string,effort:string,catalog:readonly CodexCatalogEntry[]):Readonly<{eligible:boolean;reason:'listed'|'model_not_advertised'|'effort_not_advertised';model:string;effort:string;fallback:false}>{
  const entry=catalog.find(m=>m.model===model);
  const reason=!entry?'model_not_advertised':!entry.efforts.includes(effort)?'effort_not_advertised':'listed';
  return Object.freeze({eligible:reason==='listed',reason,model,effort,fallback:false});
}
export const CODEX_LIVE_BLOCKERS=Object.freeze([
  'tool_and_environment_boundary_not_verified',
  'source_destination_account_binding_not_qualified',
  'subscription_budget_and_stop_limits_not_qualified',
  'live_cancellation_reconciliation_retention_not_qualified',
] as const);
