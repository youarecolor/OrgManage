import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,openSync,closeSync,readFileSync,writeFileSync,readdirSync,realpathSync} from 'node:fs';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {candidateSnapshotBytes} from './candidate.js';
import {openCandidateTransfer} from './candidate-transfer.js';
import type {CandidateTransferExpectation,OpenedCandidateTransfer} from './candidate-transfer.js';

/** Trusted data materializer. The caller must own and protect the parent against other writers.
 * Never call in a candidate-writable parent. This function does not establish a Windows ACL. */
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
function requireThat(v:unknown,message:string):asserts v {if(!v)throw Error('MATERIALIZE_'+message);}
function plainAncestors(path:string):void{
  for(let at=resolve(path);;at=dirname(at)){
    requireThat(!lstatSync(at).isSymbolicLink(),'REPARSE');
    if(dirname(at)===at)break;
  }
}
function inside(root:string,path:string):string{
  const full=resolve(root,path),rel=relative(root,full);
  requireThat(rel!==''&&!rel.startsWith('..'+sep)&&rel!=='..'&&!resolve(full).startsWith('\\\\'),'PATH');
  requireThat(full.startsWith(root+sep),'PATH');return full;
}
export interface CandidateMaterializationReceipt {
  readonly version:'CANDIDATE-MATERIALIZATION-v1';readonly planDigest:string;readonly attemptId:string;
  readonly wireDigest:string;readonly baseDigest:string;readonly baseTreeDigest:string;readonly writeSetDigest:string;
  readonly patchDigest:string;readonly afterDigest:string;readonly afterTreeDigest:string;readonly fileCount:number;
  readonly candidateExecuted:false;readonly appliedAt:number;readonly receiptDigest:string;
}
/** CreateNew only: an existing or partially populated directory must be reconciled, never overwritten. */
export function materializeCandidateTransfer(parent:string,bytes:Uint8Array,expected:CandidateTransferExpectation,now=Date.now()):CandidateMaterializationReceipt{
  requireThat(Number.isSafeInteger(now)&&now>=0,'CLOCK');
  const opened=openCandidateTransfer(bytes,expected);
  requireThat(now>=opened.plan.createdAt,'TIME_BEFORE_PLAN');
  const canonicalParent=resolve(parent);plainAncestors(canonicalParent);
  requireThat(realpathSync.native(canonicalParent).toLowerCase()===canonicalParent.toLowerCase(),'PARENT_ALIAS');
  const target=join(canonicalParent,opened.attemptId);
  // No recursive mkdir here: exclusive ownership of this new attempt directory is a precondition.
  mkdirSync(target);
  for(const [name,snapshot] of [['base',opened.proposal.base],['after',opened.proposal.after]] as const){
    const tree=join(target,name);mkdirSync(tree);
    for(const file of snapshot.files){
      const dest=inside(tree,file.path);mkdirSync(dirname(dest),{recursive:true});
      const handle=openSync(dest,'wx');
      try{writeFileSync(handle,file.text,{encoding:'utf8'});}finally{closeSync(handle);}
    }
    verifyTree(tree,snapshot.files);
    writeFileSync(join(target,name+'.snapshot.json'),candidateSnapshotBytes(snapshot),{flag:'wx'});
  }
  writeFileSync(join(target,'transfer.json'),bytes,{flag:'wx'});
  // Re-read the retained wire; materialization only succeeds for the same independently expected object.
  requireThat(openCandidateTransfer(readFileSync(join(target,'transfer.json')),expected).wireDigest===opened.wireDigest,'WIRE_CHANGED');
  const p=opened.plan,body={version:'CANDIDATE-MATERIALIZATION-v1' as const,planDigest:p.digest,attemptId:opened.attemptId,wireDigest:opened.wireDigest,baseDigest:p.baseDigest,baseTreeDigest:p.baseTreeDigest,writeSetDigest:p.writeSetDigest,patchDigest:p.patchDigest,afterDigest:p.afterDigest,afterTreeDigest:p.afterTreeDigest,fileCount:opened.proposal.after.files.length,candidateExecuted:false as const,appliedAt:now};
  const receipt=Object.freeze({...body,receiptDigest:sha(JSON.stringify(body))});
  writeFileSync(join(target,'materialization.json'),JSON.stringify(receipt),{flag:'wx'});return receipt;
}
function verifyTree(tree:string,files:readonly {path:string;digest:string}[]):void{
  const found:string[]=[],pending=[tree];
  while(pending.length){
    const dir=pending.pop()!;
    requireThat(!lstatSync(dir).isSymbolicLink(),'REPARSE');
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      requireThat(!entry.isSymbolicLink(),'REPARSE');const full=join(dir,entry.name);
      if(entry.isDirectory())pending.push(full);
      else{
        const stat=lstatSync(full);requireThat(stat.isFile()&&stat.nlink===1&&stat.size<=65536,'FILE_KIND');
        const path=relative(tree,full).split(sep).join('/'),expected=files.find(f=>f.path===path);
        requireThat(expected&&sha(readFileSync(full))===expected.digest,'FILE_CHANGED');found.push(path);
      }
    }
  }
  requireThat(found.length===files.length,'FILE_COUNT');
}
/** Read-only reopening. The OS caller still holds responsibility for immutable parent/ACL admission. */
export function inspectMaterializedCandidate(parent:string,expected:CandidateTransferExpectation):{transfer:OpenedCandidateTransfer;receipt:CandidateMaterializationReceipt}{
  requireThat(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(expected.attemptId),'ATTEMPT');
  const root=resolve(parent);plainAncestors(root);
  const target=join(root,expected.attemptId);plainAncestors(target);
  for(const [name,max] of [['transfer.json',196608],['materialization.json',4096],['base.snapshot.json',262144],['after.snapshot.json',262144]] as const){
    const stat=lstatSync(join(target,name));requireThat(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=max,'METADATA_KIND');
  }
  const transfer=openCandidateTransfer(readFileSync(join(target,'transfer.json')),expected);
  const receipt=JSON.parse(readFileSync(join(target,'materialization.json'),'utf8')) as CandidateMaterializationReceipt;
  const {receiptDigest,...body}=receipt;
  requireThat(receipt.version==='CANDIDATE-MATERIALIZATION-v1'&&receiptDigest===sha(JSON.stringify(body))&&receipt.planDigest===expected.planDigest&&receipt.attemptId===expected.attemptId&&receipt.wireDigest===transfer.wireDigest&&receipt.baseDigest===transfer.plan.baseDigest&&receipt.afterDigest===transfer.plan.afterDigest&&receipt.baseTreeDigest===transfer.plan.baseTreeDigest&&receipt.afterTreeDigest===transfer.plan.afterTreeDigest&&receipt.patchDigest===transfer.plan.patchDigest&&receipt.writeSetDigest===transfer.plan.writeSetDigest&&receipt.fileCount===transfer.proposal.after.files.length&&receipt.candidateExecuted===false&&Number.isSafeInteger(receipt.appliedAt)&&receipt.appliedAt>=transfer.plan.createdAt,'RECEIPT_CHANGED');
  for(const [name,snapshot] of [['base',transfer.proposal.base],['after',transfer.proposal.after]] as const){
    verifyTree(join(target,name),snapshot.files);
    requireThat(Buffer.from(candidateSnapshotBytes(snapshot)).equals(readFileSync(join(target,name+'.snapshot.json'))),'SNAPSHOT_CHANGED');
  }
  return {transfer,receipt:Object.freeze(receipt)};
}
