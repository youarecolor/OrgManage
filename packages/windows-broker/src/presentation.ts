import type {ApprovalView} from '../../core/src/model.js';
import type {SimulationEffect, SimulationConnection, BrokerSimulation} from './simulation.js';

/** The MCP-shaped test adapter is only an existing-connection request forwarder.
 * It exposes no connect, approve, enroll, update, execute-string or receipt minting. */
export function createCodexSimulationAdapter(broker: BrokerSimulation, connection: SimulationConnection) {
  return Object.freeze({request: (bytes: Uint8Array) => broker.start(connection, bytes)});
}
export interface BrokerHomeProjection {
  evidence: 'simulation';
  subject: SimulationEffect['subject'];
  approvalId: string;
  actionDigest: string;
  state: SimulationEffect['state'];
  cancellation: SimulationEffect['cancellation'];
  statusText: string;
  explanation: ApprovalView['explanation'];
  liveEnabled: false;
}
/** Reuses Home's explanation contract without fabricating a Mission or a human
 * decision. Read-only projection; not a registered Home command or admin UI. */
export function projectSimulationForHome(effect: SimulationEffect): BrokerHomeProjection {
  const states = {running: '模擬実行中', succeeded: '模擬完了', failed: '模擬失敗', unknown: '結果不明・照合待ち'};
  return {evidence: 'simulation', subject: {...effect.subject}, approvalId: effect.approvalId,
    actionDigest: effect.actionDigest, state: effect.state, cancellation: effect.cancellation,
    statusText: `${states[effect.state]}${effect.cancellation === 'requested' ? '／停止要求済み・停止未確認' : effect.cancellation === 'observed' ? '／停止観測あり' : ''}`,
    liveEnabled: false,
    explanation: {
      change: '登録済みサービスの再起動を模擬', destination: 'ローカルの仮想ハンドラー', account: '合成の承認主体',
      route: 'Windows特権操作の契約試験', maximumYen: '0', month: '非課金の模擬試験',
      estimateDifference: 'OSサービスへの操作・実課金は発生しません', alternatives: ['通常権限の方法を確認', '申請を修正', '保留'],
      expectedBenefit: '接続・許可・停止・結果確認の契約を検証', failureHandling: '結果不明は再実行せず同じ要求を照合',
      disclosure: '操作・対象・設定版・期限に限定した申請', retention: '試験process内のみ。実監査の永続保存は未実装',
      recovery: '失効は新規実行を止める。停止観測と副作用の取消しは別', risk: 'Windowsの実認証・特権境界は未検証',
      dataClassification: '合成fixture', additionalDisclosure: '通常Homeのクリックから管理者認証や特権有効化はできません',
    }};
}
