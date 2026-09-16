import type {RoutingView} from '../../../packages/core/src/model';
const reasons:Record<string,string>={valid_session_continuation:'有効な対話を継続',only_admissible_configuration:'条件を満たす構成が1つ',comparable_total_cost_and_time:'比較評価の範囲で総費用と完了時間を優先',standard_profile_under_uncertainty:'優劣が確定しないため標準構成を提案',active_turn_reconcile_before_routing:'実行中の処理を確認してから選択',run_policy_changed:'実行中の方針版が変更されています',no_admissible_configuration:'許可・品質・予算を満たす構成がありません',incomparable_candidates_require_decision:'候補の優劣を判断する情報が不足しています'};
export function RoutingPanel({items}:{items:RoutingView[]}){
  const item=items.at(-1);if(!item)return null;
  return <section className="artifact" aria-label="AI構成の選択記録"><h3>AI構成の選択</h3><p>{item.kind==='pool'?'承認対象として記録した候補':reasons[item.reason]??'選択記録を確認してください'}</p>
    {item.kind==='pool'&&<><p>Autoの候補群です。この記録だけでは応答モデルは確定しません。</p><ul>{item.candidateModels?.map(model=><li key={model} style={{overflowWrap:'anywhere'}}>{model}</li>)}</ul><p>取得済みの応答モデルは「APIの実行と費用」で確認できます。候補の現在の利用可否は送信前に再確認します。</p></>}
    {item.model&&<dl><dt>モデル / 思考深度</dt><dd>{item.model} / {item.effort}</dd><dt>実行環境</dt><dd>{item.runtime}</dd><dt>課金経路</dt><dd>{item.billingRoute}</dd></dl>}
    <p>この選択記録だけでは実行されません。実行時にも権限・予算・送信する情報を確認します。</p>
    <details style={{overflowWrap:'anywhere'}}><summary>選択時の根拠</summary><p>方針版：{item.policyVersion}</p><p>{item.kind==='pool'?'候補群と入力の照合値':'入力の照合値'}：{item.inputDigest}</p></details>
  </section>;
}
