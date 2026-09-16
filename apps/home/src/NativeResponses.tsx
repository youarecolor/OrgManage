import type { NativeAttemptView } from '../../../packages/core/src/model';

const states:Record<NativeAttemptView['state'],string>={prepared:'送信前',send_intent:'開始確認待ち',running:'応答を受信中',completed:'応答完了',interrupted:'停止を確認',failed:'失敗',unknown:'結果を照合中',discarded:'送信前に中止'};
export function NativeResponses({attempts}:{attempts:NativeAttemptView[]}){
  if(!attempts.length)return null;
  return <section aria-label="Codex応答の検証" className="native-responses">
    <h3>Codex応答の検証</h3>
    {attempts.map(a=><article className="artifact" key={a.id}>
      <p className="muted">{a.mode==='synthetic'?'合成データによるローカル検証です。実際のAIへの送信は行っていません。':'外部Codex経路の記録です。送信・応答・停止の確認状態は以下に表示します。'}</p>
      <div className="artifact-heading"><h4>{a.model} / {a.effort}</h4><span className="status-pill">{states[a.state]}</span></div>
      {a.quarantined&&<p className="danger-text">結果に未確認または矛盾があるため、照合するまで再送しません。</p>}
      {a.cancellation==='requested'&&<p className="notice warning">停止要求済み。{a.interruptionAcknowledged?'要求の受付を確認しましたが、停止はまだ未確認です。':'停止の確認を待っています。'}</p>}
      {a.cancellation==='observed'&&<p>停止を観測済みです。</p>}
      {a.messages.length>0&&<p className="muted">{a.quarantined?'照合待ちの本文':a.state==='completed'?'受信した本文':'受信済みの本文（応答全体は未完了）'}</p>}
      {a.messages.map(m=><pre key={m.id}>{m.text}</pre>)}
      {a.sourceLineage&&<details><summary>送信した文脈の出典</summary><p>送信時の出典記録です。現在の再利用許可とは別です。</p><ul>{a.sourceLineage.sources.map(s=><li key={s.id}>出典 {s.id}<br/>版 {s.version}<br/>照合値 {s.digest}</li>)}</ul><p>入力の照合値：{a.sourceLineage.inputDigest}</p></details>}
      <p className="muted">{a.usage?`${a.mode==='synthetic'?'模擬使用量':'観測使用量'}：入力 ${a.usage.inputTokens.toLocaleString()} / 出力 ${a.usage.outputTokens.toLocaleString()} トークン`:'使用量は未観測です。ゼロとして扱いません。'}</p>
    </article>)}
  </section>;
}
