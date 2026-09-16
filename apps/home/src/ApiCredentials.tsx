import {useEffect,useRef,useState,type ReactNode} from 'react';
type Result={ok:boolean;stored?:boolean;code?:string;keyLimitVerified?:boolean;reason?:string};
declare global{interface Window{orgmanageCredentials?:{status():Promise<Result>;save(key:string):Promise<Result>;remove():Promise<Result>;check?():Promise<Result>}}}
export function ApiSettingsDialog({onClose,children}:{onClose:()=>void;children?:ReactNode}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{ref.current?.showModal();},[]);
 return <dialog ref={ref} onCancel={onClose} aria-label="ツール・権限" style={{width:'min(640px, 90vw)',maxHeight:'85vh',overflow:'auto',border:'1px solid #ddd',borderRadius:12,padding:24}}>
  <h2>ツール・権限</h2><p>予算、API接続と、このPCの資格情報を管理します。</p>{children}<ApiCredentials/>
  <button type="button" className="button" onClick={onClose}>閉じる</button>
 </dialog>;
}
export function ApiCredentials(){
 const api=window.orgmanageCredentials,input=useRef<HTMLInputElement>(null);
 const [stored,setStored]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[consent,setConsent]=useState(false);
 useEffect(()=>{let live=true;api?.status().then(r=>{if(live&&r.ok)setStored(r.stored===true);}).catch(()=>{});return()=>{live=false;};},[api]);
 if(!api)return null;
 async function act(remove=false){
  if(busy||!consent)return;setBusy(true);setMessage('');
  try{
   const pending=remove?api!.remove():api!.save(input.current?.value??'');
   if(input.current)input.current.value='';
   const result=await pending;
   if(result.ok){setStored(result.stored===true);setMessage(remove?'このPCの保存キーを削除しました。':'暗号化保存しました。接続確認はまだ行っていません。');setConsent(false);}
   else setMessage('保存状態を確認できませんでした。キーを再送する前に状態を確認してください。');
  }catch{setMessage('保存状態が不明です。状態を確認してください。');}
  finally{if(input.current)input.current.value='';setBusy(false);}
 }
 return <details open aria-label="OpenRouter接続設定" style={{margin:'8px 0',padding:12,border:'1px solid #ddd',borderRadius:8}}>
  <summary>OpenRouter接続設定</summary>
  <p>このWindowsユーザー用にAPIキーを暗号化保存します。保存だけでは送信・課金されません。</p>
  <p role="status">{stored===null?'保存状態は未確認':stored?'キー保存済み（接続未確認）':'キー未保存'}</p>
  {!stored&&<label>専用APIキー <input ref={input} type="password" aria-label="OpenRouter APIキー" autoComplete="off" spellCheck={false} maxLength={512} disabled={busy}/></label>}
  <label style={{display:'block'}}><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>{stored?'このPCに保存したキーを削除する':'このPCへの暗号化保存に同意する'}</label>
  <button type="button" disabled={busy||!consent||stored===null} onClick={()=>void act(stored===true)}>{stored?'保存キーを削除':'暗号化して保存'}</button>
  <button type="button" disabled={busy} onClick={()=>{void api.status().then(r=>{if(r.ok){setStored(r.stored===true);setMessage('保存状態を確認しました。');}}).catch(()=>setMessage('状態を確認できませんでした。'));}}>保存状態を確認</button>
  {stored&&api.check&&<button type="button" disabled={busy} onClick={()=>{setBusy(true);void api.check!().then(r=>setMessage(r.keyLimitVerified?'キーの有効性と10ドル以下・リセットなしの上限を確認しました。入金残高と推論接続は未確認です。':r.reason==='nonresetting_limit_required'?'キーの上限リセットを「なし」に設定してください。':r.reason==='limit_outside_trial'?'キーの利用上限を10ドル以下に設定してください。':'キーの上限を確認できませんでした。OpenRouterのキー設定を確認してください。')).catch(()=>setMessage('接続確認ができませんでした。')).finally(()=>setBusy(false));}}>キーの有効性・上限を確認（推論なし）</button>}
  <p role="status">{message}</p>
 </details>;
}
