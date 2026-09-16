import type {OpenRouterView} from '../../../packages/core/src/model';
export function ApiResponses({items}:{items:OpenRouterView[]}){
 if(items.length===0)return null;
 return <section className="artifact" aria-label="APIの実行と費用"><h3>APIの実行と費用</h3>{items.map(item=><article key={item.id}>
  <h4>OpenRouter · {item.mode==='provider'?'実API':item.mode==='synthetic'?'合成試験':'実行経路は未確認'}</h4>
  <p>返答：{item.outputState==='unsent'?'送信前に取消':item.outputState==='completed'?'取得済み':'未確認'} / 費用：{item.financialState==='released'?'拘束解除・課金なし':item.financialState==='settled'?'精算済み':'未精算・拘束を保持'}</p>
  <p>会計月 {item.month} · 共通拘束 {item.commonCash?`${item.commonCash.held} USD`:`${item.heldYen??'未確認'}円`} · 共通計上 {item.commonCash?`${item.commonCash.booked} USD`:`${item.bookedYen??'未確認'}円`} · API試験枠の拘束 {item.heldUsd} USD / 計上 {item.bookedUsd} USD</p>
  {(item.model||item.provider)&&<p>応答モデル：{item.model??'未確認'} / 提供元：{item.provider??'未確認'}</p>}
  {item.recovery.count>0&&<details><summary>費用の照会履歴（{item.recovery.count}件）</summary><p>最新5件まで表示。照会値と確定精算は区別して記録します。</p>{item.recovery.costConflict&&<p className="danger-text">照会ごとの費用が異なります。照合が必要です。</p>}<ul>{item.recovery.recent.map(r=><li key={r.id}>{r.observedAt}：{r.status==='observed'?`${r.costCredits} credits`:'未確認'}</li>)}</ul></details>}
  {item.text!==null&&<details><summary>取得した返答（未採択）</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.text}</pre></details>}
  {item.sourceLineage?<details><summary>要求に含めた文脈の出典</summary><p>準備時の出典記録です。送信完了や現在の再利用許可を示しません。</p><ul>{item.sourceLineage.sources.map(s=><li key={s.id}>出典 {s.id}<br/>版 {s.version}<br/>照合値 {s.digest}</li>)}</ul><p>入力の照合値：{item.sourceLineage.inputDigest}</p></details>:<p>文脈の出典記録は未確認です。</p>}
 </article>)}</section>;
}
