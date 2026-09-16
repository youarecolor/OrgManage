import type {KnowledgeView} from '../../../packages/core/src/model';

export function KnowledgePanel({items,disabled,onDecide}:{items:KnowledgeView[];disabled:boolean;onDecide(item:KnowledgeView,choice:'adopt'|'reject'|'revoke'):Promise<boolean>}){
  if(!items.length)return null;
  const labels={candidate:'評価・採用待ち',active:'利用可能',rejected:'不採用',revoked:'撤回済み'};
  return <section aria-label="知見の採用と撤回"><h3>次の案件に使う知見</h3><p>知見の採用は、コードの適用や外部送信の許可とは別です。</p>{items.map(item=><article className="artifact" key={item.id}>
    <h4>{labels[item.state]} · {item.worker}</h4><p>{item.text}</p>
    <details><summary>出典と利用記録</summary><p>別案件での利用記録：{item.useCount}件。効果の実証件数とは異なります。</p><ul>{item.sourceVersions.map(ref=><li key={ref}>{ref}</li>)}</ul></details>
    {item.state==='candidate'&&<div><button className="button" disabled={disabled||!item.evaluationId} onClick={()=>void onDecide(item,'adopt')}>この知見を採用</button><button className="button" disabled={disabled} onClick={()=>void onDecide(item,'reject')}>採用しない</button>{!item.evaluationId&&<p>必須評価の合格を確認できていません。</p>}</div>}
    {item.state==='active'&&<button className="button" disabled={disabled} onClick={()=>void onDecide(item,'revoke')}>この知見を撤回</button>}
  </article>)}</section>;
}
