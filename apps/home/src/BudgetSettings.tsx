import {useEffect,useState} from 'react';
import type {HomeSnapshot} from '../../../packages/core/src/model';
type Policy=NonNullable<HomeSnapshot['budgetPolicy']>;
export function BudgetSettings({policy,disabled,notice,onSave}:{policy:Policy;disabled:boolean;notice:string;onSave:(normal:string,reserve:string,autonomousE:string)=>Promise<boolean>}){
 const [normal,setNormal]=useState(''),[reserve,setReserve]=useState(''),[e,setE]=useState('');
 useEffect(()=>{setNormal(policy.currency==='USD'?policy.normalLimit:'');setReserve(policy.currency==='USD'?policy.reserveLimit??'':'');setE(policy.currency==='USD'?policy.autonomousELimit:'');},[policy.id,policy.revision]);
 return <details open aria-label="月予算設定" style={{margin:'12px 0',padding:12,border:'1px solid #ddd',borderRadius:8}}>
  <summary>月予算（USD）</summary>
  <p>通常枠と予備枠を設定します。自主改善Eは通常枠の内数です。予備費を使う承認は別途必要です。</p>
  <p>現在の設定通貨：{policy.currency}。通貨を変更しても過去の費用記録は保持されます。</p>
  <form onSubmit={event=>{event.preventDefault();if(!disabled)void onSave(normal,reserve,e);}}>
   <fieldset disabled={disabled} style={{border:0,padding:0,display:'grid',gap:10}}>
    <label>通常枠（USD）<input aria-label="通常枠（USD）" inputMode="decimal" required maxLength={19} value={normal} onChange={event=>setNormal(event.target.value)} style={{display:'block',width:'100%',boxSizing:'border-box'}}/></label>
    <label>予備枠（USD）<input aria-label="予備枠（USD）" inputMode="decimal" required maxLength={19} value={reserve} onChange={event=>setReserve(event.target.value)} style={{display:'block',width:'100%',boxSizing:'border-box'}}/></label>
    <label>自主改善Eの内枠（USD）<input aria-label="自主改善Eの内枠（USD）" inputMode="decimal" required maxLength={19} value={e} onChange={event=>setE(event.target.value)} style={{display:'block',width:'100%',boxSizing:'border-box'}}/></label>
    <button className="button" type="submit">USDの月予算を保存</button>
   </fieldset>
  </form>
  <p role="status">{notice}</p>
 </details>;
}
