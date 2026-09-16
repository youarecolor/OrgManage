import type {CandidateEvaluationSummary} from '../../../packages/core/src/model';
const labels:Record<CandidateEvaluationSummary['status'],string>={prepared:'検証の準備完了',unknown:'結果を照合中',passed:'検証を通過',failed:'検証で問題あり',quarantined:'条件が変わったため保留'};
export function CandidateEvaluations({evaluations}:{evaluations:CandidateEvaluationSummary[]}){
  if(!evaluations.length)return null;
  return <section className="native-responses" aria-label="候補の検証">
    <h3>候補の検証</h3>
    {evaluations.map(e=><article className="artifact" key={e.id}>
      <div className="artifact-heading"><h4>候補版 {e.candidateDigest.slice(0,12)}</h4><span className="status-pill">{labels[e.status]}</span></div>
      <p className="muted">{e.evidenceKind==='synthetic'?'合成データによる検証です。候補コードの実行結果ではありません。':'隔離環境で取得した検証結果です。'}</p>
      <p>検証項目：{e.checks.join(' / ')}</p>
      {e.status==='unknown'&&<p className="notice warning">結果を確認できるまで、再実行せず照合を続けます。</p>}
      {e.status==='quarantined'&&<p className="notice warning">依頼・権限・対象版などの条件を再確認する必要があります。</p>}
      {e.status==='passed'&&<p>適用・検証・回収した候補版の一致を確認しました。採択とアプリの更新には、それぞれ別の判断が必要です。</p>}
      {e.review?.status==='unavailable'&&<p className="notice warning" role="alert">変更内容の一致を確認できません。採択前に成果を再確認してください。</p>}
      {e.review?.status==='ready'&&<section className="candidate-review" aria-label="候補の変更内容">
        <h4>変更内容 · {e.review.files.length}ファイル</h4>
        <p className="muted">{e.review.source==='unverified_text'?'保存した返答から作成した変更案です。生成元の確認はまだ完了していません。':'生成元は確認していません。'}</p>
        <p className="muted">検証後に回収した成果と同じ内容です。各ファイルを開くと変更前後の全文を確認できます。</p>
        {e.review.files.map(f=><details className="candidate-file" key={f.path}>
          <summary>{f.path}</summary>
          <div className="candidate-file-versions">
            <section><h5>変更前</h5><pre aria-label={`${f.path} 変更前`}><code>{f.before}</code></pre></section>
            <section><h5>変更後</h5><pre aria-label={`${f.path} 変更後`}><code>{f.after}</code></pre></section>
          </div>
        </details>)}
        <details className="candidate-identity"><summary>成果の照合情報</summary><dl>
          <dt>成果ID</dt><dd>{e.review.artifactId}</dd><dt>成果の内容版</dt><dd>{e.review.artifactDigest}</dd>
          <dt>変更前の構成版</dt><dd>{e.review.beforeTreeDigest}</dd><dt>変更後の構成版</dt><dd>{e.review.afterTreeDigest}</dd>
        </dl></details>
      </section>}
    </article>)}
  </section>;
}
