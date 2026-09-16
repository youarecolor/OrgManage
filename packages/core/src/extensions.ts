import {decodeCommand} from '../../contracts/src/index.js';
import type {CoreSession,OrgManageCore} from './index.js';
import type {CoreResult,HomeSnapshot,ClientError} from './model.js';

export type SurfaceRole='human_interactive'|'read_only';
declare const surfaceBrand:unique symbol;
export interface Surface {readonly [surfaceBrand]:true}
interface Binding {session:CoreSession;role:SurfaceRole;expiresAt:number;revoked:boolean}
/** Trusted host registration only. A game/voice surface uses the same Core
 * session and Command path. This is not an in-process plugin loader, model tool,
 * filesystem API, or an alternative approval writer. */
export class ExtensionGateway {
  readonly #surfaces=new WeakMap<Surface,Binding>();
  constructor(readonly core:OrgManageCore,readonly clock:()=>number=Date.now){}
  register(session:CoreSession,role:SurfaceRole,expiresAt:number):Surface{
    if(!['human_interactive','read_only'].includes(role)||!Number.isSafeInteger(expiresAt)||expiresAt<=this.clock()||expiresAt-this.clock()>86400000)throw Error('EXTENSION_REGISTRATION_INVALID');
    const snapshot=this.core.snapshot(session);if('ok' in snapshot||snapshot.status!=='ready')throw Error('EXTENSION_SESSION_INVALID');
    const handle=Object.freeze({}) as Surface;this.#surfaces.set(handle,{session,role,expiresAt,revoked:false});return handle;
  }
  revoke(handle:Surface):void{const binding=this.#surfaces.get(handle);if(binding)binding.revoked=true;}
  #binding(handle:Surface){const b=this.#surfaces.get(handle),now=this.clock();if(!Number.isSafeInteger(now)||!b||b.revoked||now>=b.expiresAt)throw Error('EXTENSION_UNAVAILABLE');return b;}
  snapshot(handle:Surface):HomeSnapshot|ClientError{return this.core.snapshot(this.#binding(handle).session);}
  command(handle:Surface,input:Uint8Array):CoreResult{
    const b=this.#binding(handle);if(b.role!=='human_interactive')return {ok:false,error:{code:'EXTENSION_READ_ONLY',retry:'none'}};
    const parsed=decodeCommand(input);if(!parsed.ok)return {ok:false,error:{code:parsed.error.code,retry:'none'}};
    return this.core.command(b.session,input);
  }
}
