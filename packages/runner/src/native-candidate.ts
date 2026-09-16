import {createHash} from 'node:crypto';
import {candidateSnapshotBytes,importCandidatePatch} from './candidate.js';
import type {CandidateSnapshot,CandidateProposal} from './candidate.js';
import {reopenNativeEditRequest,applyNativeEditProposal} from './native-edit.js';

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function check(v:unknown,code:string):asserts v {if(!v)throw Error('NATIVE_CANDIDATE_'+code);}
/** Records exact proposal data, not proof that a provider sent or completed a turn. */
export interface NativeCandidateSource {
  readonly version:'NATIVE-CANDIDATE-SOURCE-v1';readonly attribution:'unverified';
  readonly requestDigest:string;readonly requestBase64:string;
  readonly responseDigest:string;readonly responseBase64:string;readonly digest:string;
}
export interface PreparedNativeCandidate {
  readonly source:Readonly<NativeCandidateSource>;readonly patchBase64:string;
  readonly proposal:CandidateProposal;readonly status:'unverified';
}
export function prepareNativeCandidate(base:CandidateSnapshot,requestBytes:Uint8Array,expectedRequestDigest:string,responseBytes:Uint8Array):PreparedNativeCandidate {
  // Reject an unsealed snapshot even if the caller supplied a lookalike object.
  candidateSnapshotBytes(base);
  for(const wire of [requestBytes,responseBytes])check(wire instanceof Uint8Array&&!(wire.buffer instanceof SharedArrayBuffer)&&wire.byteLength<=16384,'WIRE');
  const requestWire=Buffer.from(requestBytes),responseWire=Buffer.from(responseBytes);
  const request=reopenNativeEditRequest(requestWire,expectedRequestDigest);
  const before=base.files.find(file=>file.path===request.filePath);
  check(before&&base.writeSet.includes(request.filePath),'TARGET');
  const applied=applyNativeEditProposal(before.text,request,responseWire);
  const patch=Buffer.from(JSON.stringify({version:'CANDIDATE-PATCH-v1',baseDigest:base.digest,changes:[{path:before.path,beforeDigest:before.digest,text:applied.text}]}));
  const proposal=importCandidatePatch(base,patch);
  const body={version:'NATIVE-CANDIDATE-SOURCE-v1' as const,attribution:'unverified' as const,requestDigest:request.digest,requestBase64:requestWire.toString('base64'),responseDigest:applied.responseDigest,responseBase64:responseWire.toString('base64')};
  const source=Object.freeze({...body,digest:sha(JSON.stringify(body))});
  return Object.freeze({source,patchBase64:patch.toString('base64'),proposal,status:'unverified'});
}
/** Replays persisted original bytes; source metadata cannot substitute a different patch. */
export function reopenNativeCandidateSource(base:CandidateSnapshot,value:unknown,patchBase64:string):Readonly<NativeCandidateSource> {
  check(value!==null&&typeof value==='object'&&!Array.isArray(value),'SOURCE');
  const source=value as Record<string,unknown>;
  check(Object.keys(source).sort().join('|')===['version','attribution','requestDigest','requestBase64','responseDigest','responseBase64','digest'].sort().join('|'),'FIELDS');
  const decode=(wire:unknown)=>{
    check(typeof wire==='string'&&wire.length<=21848,'WIRE');
    const bytes=Buffer.from(wire,'base64');check(bytes.toString('base64')===wire,'BASE64');return bytes;
  };
  check(typeof source.requestDigest==='string','REQUEST_DIGEST');
  const prepared=prepareNativeCandidate(base,decode(source.requestBase64),source.requestDigest,decode(source.responseBase64));
  for(const key of Object.keys(prepared.source) as (keyof NativeCandidateSource)[])check(source[key]===prepared.source[key],'SOURCE_CHANGED');
  check(prepared.patchBase64===patchBase64,'PATCH_CHANGED');
  return prepared.source;
}
