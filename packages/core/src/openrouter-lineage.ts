import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerReader} from '../../ledger/src/index.js';
import type {OpenRouterView} from './model.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Historical references only. Current grants are deliberately not restored. */
export function openrouterLineage(tx:LedgerReader,p:string,id:string,intent:Record<string,any>):OpenRouterView['sourceLineage']{
 const witness=tx.getRecordVersion(p,intent.witnessVersion);
 if(witness?.kind!=='evidence')return null;
 const w=JSON.parse(witness.data);
 if(w.format!=='openrouter_action_witness_v1'||w.intentId!==id||w.missionId!==intent.missionId||sha(canonicalize(w)!)!==intent.actionDigest)return null;
 const row=tx.getRecord(p,w.manifestId);
 if(row?.kind!=='context_manifest'||row.revision!==1n)return null;
 const m=JSON.parse(row.data),{digest,...body}=m;
 if(w.disclosure?.id!==row.id||w.disclosure.digest!==digest||w.disclosure.inputDigest!==m.inputDigest)return null;
 if(m.format!=='disclosure_manifest_v1'||digest!==sha(canonicalize(body)!)||m.scopeId!==w.missionId||m.contractVersion!==w.contractVersion||canonicalize(m.destination)!==canonicalize(w.destination)||m.input!==w.input||m.inputDigest!==sha(w.input)||!Array.isArray(m.parts)||m.parts.length<1||m.parts.length>16)return null;
 const sources=[];
 for(const part of m.parts){
  const source=tx.getRecordVersion(p,part.sourceVersion);
  if(source?.kind!=='source'||source.id!==part.sourceId)return null;
  const s=JSON.parse(source.data);
  if(s.format!=='disclosure_source_v1'||s.scopeId!==w.missionId||typeof s.text!=='string'||sha(s.text)!==part.sourceDigest)return null;
  sources.push({id:source.id,version:source.versionId,digest:part.sourceDigest as string});
 }
 return {manifestId:row.id,inputDigest:m.inputDigest,sources};
}
