import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ApprovalView, CoreResult, HomeSnapshot, MissionView, OutcomeView } from '../../../packages/core/src/model';
import type { Command } from '../../../packages/contracts/src/generated/command';
import type { SetupRequest } from '../../../packages/contracts/src/generated/setup-request';
import { bridge } from './transport';
import { NativeResponses } from './NativeResponses';
import { CandidateEvaluations } from './CandidateEvaluations';
import { KnowledgePanel } from './KnowledgePanel';
import { RoutingPanel } from './RoutingPanel';
import { ApiSettingsDialog } from './ApiCredentials';
import { BudgetSettings } from './BudgetSettings';
import { ApiResponses } from './ApiResponses';
import {formatMoney, type Money} from '../../../packages/core/src/money';

type Pane = 'dialogue' | 'outcome';
type WriteRequest = { kind: 'setup'; request: SetupRequest } | { kind: 'command'; request: Command };
type Uncertain = { id: string; operation: WriteRequest };
type IconName = 'home' | 'approval' | 'people' | 'member' | 'project' | 'book' | 'release' | 'audit' | 'settings' | 'message' | 'document' | 'send' | 'check' | 'edit' | 'pause' | 'close' | 'stop' | 'chevron' | 'refresh';
const iconPaths: Record<IconName, string> = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  approval: 'M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 9 3 3 5-6',
  people: 'M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-3a5 5 0 0 1 10 0v3Zm12-7a5 5 0 0 1 6 4v3h-5',
  member: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  project: 'M3 6h7l2 2h9v12H3Zm0 0V4h7l2 2h9v2M9 12h6v5H9Z',
  book: 'M5 3h14v18H5Zm4 5h6m-6 4h6m-6 4h4',
  release: 'm6 14 6-6 6 6m-6-6v13M5 10V5h14v5',
  audit: 'M4 4h16v16H4Zm4 4h8m-8 4h8m-8 4h4',
  settings: 'm10 3 4 0 1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3Zm2 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  message: 'M21 11a9 9 0 0 1-9 9H5l-3 2v-9a10 10 0 0 1 10-10 9 9 0 0 1 9 8ZM8 10h8m-8 4h5',
  document: 'M6 3h8l4 4v14H6Zm8 0v5h4M9 12h6m-6 4h6',
  send: 'm3 11 18-8-8 18-2-8Zm8 2L21 3',
  check: 'm5 12 4 4L19 6', edit: 'm4 16 12-12 4 4L8 20H4Zm10-10 4 4',
  pause: 'M8 4v16M16 4v16', close: 'm6 6 12 12M18 6 6 18',
  stop: 'M6 6h12v12H6Z', chevron: 'm6 9 6 6 6-6', refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6',
};
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}
const phaseLabels: Record<MissionView['phase'], string> = { intake: '入口の確認', approval: '承認待ち', execution: '実行中', review: '確認待ち', exit: '終了' };
const outcomeLabels: Record<OutcomeView['state'], string> = { pending: '確認待ち', accepted: '採択済み', revise: '修正待ち', hold: '保留', close: '終了' };
const errorLabels: Record<string, string> = {
  BUDGET_MIGRATION_UNRESOLVED: '未解決の円債務、または当月の円建て費用があります。照合してから通貨を変更してください。',
  BUDGET_E_NOT_SUBSET: '自主改善Eの内枠は通常枠以下にしてください。',
  SCHEMA_INVALID: '入力の形式を確認してください。USDは小数9桁以内の半角数字で入力します。',
  REVISION_CONFLICT: '対象が更新されました。最新の内容を確認して操作してください。',
  STALE_REVISION: '対象が更新されました。最新の内容を確認して操作してください。',
  NOT_AUTHORIZED: '現在の利用者には、この操作の権限がありません。',
  FORBIDDEN: '現在の利用者には、この操作の権限がありません。',
  SCOPE_STOPPED: '新しい実行は停止中です。原文と現在の成果は保持されています。',
  ALREADY_INITIALIZED: '初期設定は完了しています。最新の画面へ更新してください。',
  APPROVAL_EXPIRED: '承認の期限を過ぎました。期限内の新しい要求が必要です。',
  UNKNOWN_EFFECT: '前の処理結果が未確認です。照合が終わるまで追加実行できません。',
};
function labelError(code: string) { return errorLabels[code] ?? `操作を確定できませんでした（${code}）。`; }
function dateLabel(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '確認できません' : new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
function money(value: string | Money | undefined) { if(typeof value==='object'){try{return `${formatMoney(value)} ${value.currency}`;}catch{return '未確認';}} return typeof value==='string' && /^\d+$/.test(value) ? `${BigInt(value).toLocaleString('ja-JP')}円` : '未確認'; }
function usd(value:string){return /^(0|[1-9][0-9]*)(\.[0-9]{1,9})?(?![\s\S])/.test(value)?`${value} USD`:'未確認';}
function requestId(operation: WriteRequest) { return operation.kind === 'setup' ? operation.request.setup_command_id : operation.request.command_id; }
function command<T extends Command['command_type']>(kind: T, targetId: string, revision: string, payload: Extract<Command, { command_type: T }>['payload']): Command {
  return { protocol_version: 1, command_id: crypto.randomUUID(), command_type: kind, target_id: targetId, expected_revision: revision, payload } as Command;
}
function draftKey(snapshot: HomeSnapshot | null) {
  return snapshot?.principal && snapshot.conversation ? `orgmanage:draft:${snapshot.principal.id}:${snapshot.conversation.id}` : null;
}

export function App() {
  const [snapshot, setSnapshot] = useState<HomeSnapshot | null>(null);
  const [online, setOnline] = useState(false);
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState<Uncertain[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>('dialogue');
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [draft, setDraft] = useState('');
  const [relation, setRelation] = useState<'new' | 'continue'>('new');
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const readInFlight = useRef(false);
  const mounted = useRef(true);
  const currentDraftKey = useRef<string | null>(null);
  const draftRef = useRef('');
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (readInFlight.current) return;
    readInFlight.current = true;
    setRefreshing(true);
    try {
      const value = await bridge.snapshot();
      if ('ok' in value) throw new Error(value.error.code);
      if (!mounted.current) return;
      setSnapshot(value); setOnline(true); setReadError(''); setLastRead(new Date().toISOString());
    } catch {
      if (mounted.current) { setOnline(false); setReadError('更新が止まっています。最後に取得した内容を参照しています。原文はこの画面に残ります。'); }
    } finally { readInFlight.current = false; if (mounted.current) setRefreshing(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh]);
  const key = draftKey(snapshot);
  useEffect(() => {
    if (currentDraftKey.current === key) return;
    currentDraftKey.current = key;
    let restored = '';
    try { restored = key ? sessionStorage.getItem(key) ?? '' : ''; } catch { /* In-memory draft remains available without browser storage. */ }
    draftRef.current = restored; setDraft(restored); setRelation('new');
  }, [key]);
  const updateDraft = (text: string) => {
    draftRef.current = text; setDraft(text);
    try { if (currentDraftKey.current) sessionStorage.setItem(currentDraftKey.current, text); } catch { /* Storage denial does not block saving the raw text through the core. */ }
  };
  const write = useCallback(async (operation: WriteRequest): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setNotice('');
    const id = requestId(operation);
    try {
      const result: CoreResult = operation.kind === 'setup' ? await bridge.setup(operation.request) : await bridge.command(operation.request);
      setUncertain(previous => previous.filter(item => item.id !== id));
      if (!result.ok) { setNotice(labelError(result.error.code)); await refresh(); return false; }
      if (result.receipt.disposition !== 'committed') { setNotice(labelError(result.receipt.error_code ?? 'REJECTED')); await refresh(); return false; }
      setNotice('判断を記録しました。'); await refresh(); return true;
    } catch {
      setUncertain(previous => previous.some(item => item.id === id) ? previous : [...previous, { id, operation }]);
      setOnline(false);
      setNotice('応答を確認できません。操作の結果は未確認です。同じ操作IDで結果を確認できます。');
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }, [refresh]);
  const submitCommand = (value: Command) => write({ kind: 'command', request: value });
  const ready = online && snapshot?.status === 'ready';
  const disabled = !ready || busy || uncertain.length > 0;
  const selected = snapshot?.missions.find(mission => mission.id === selectedId) ?? snapshot?.missions.at(-1) ?? null;
  const outcome = snapshot?.outcomes.find(item => item.id === selected?.outcomeId) ?? null;
  const approval = snapshot?.approvals.filter(item => item.missionId === selected?.id).at(-1) ?? null;
  const applicationPaused = snapshot?.application?.state !== 'active';
  const bytes = new TextEncoder().encode(draft).byteLength;
  const post = async () => {
    const conversation = snapshot?.conversation;
    if (disabled || composingRef.current || !conversation || !draft.trim() || bytes > 65_536) return;
    const sent = draft;
    const sentKey = key;
    const ok = await submitCommand(command('conversation.post', conversation.id, conversation.revision, { message_id: crypto.randomUUID(), raw_text: sent, attachment_refs: [], relation_hint: relation }));
    if (ok && draftRef.current === sent && currentDraftKey.current === sentKey) { updateDraft(''); setNotice('原文を保存しました。'); }
    composeRef.current?.focus();
  };
  const start = async (mission: MissionView) => {
    await submitCommand(command('mission.start', mission.id, mission.scope.revision, { brief_revision: mission.briefRef, contract_revision: mission.contractRef }));
  };
  const control = (choice: 'halt_dispatch' | 'resume_dispatch') => {
    const app = snapshot?.application;
    if (app) void submitCommand(command('application.control', app.id, app.revision, { choice, comment: null }));
  };
  const onComposeKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.ctrlKey && !composingRef.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void post(); }
  };
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">O</span><div><strong>OrgManage</strong><small>AI COLLECTIVE OS</small></div></div>
      <div className="top-context"><span className="principal-chip"><span className="principal-diamond" />{snapshot?.principal?.displayName ?? '初回設定'}<Icon name="chevron" size={16} /></span><div className="budget-top"><strong>当月の追加費用 {snapshot ? snapshot.budget.cash?usd(snapshot.budget.cash.actualExternalCost):money(snapshot.budget.actualExternalCostYen) : '—'}</strong><span>{snapshot?.budget.simulation===false?'API費用を含む':'ローカル検証'}</span></div><button className="button stop-button" disabled={!ready || busy} onClick={() => control('halt_dispatch')}><Icon name="stop" size={16} />停止</button></div>
      <div className="top-utility"><span className="local-tag">ローカル検証</span><button className="icon-button" aria-label="最新の内容に更新" title="最新の内容に更新" disabled={refreshing} onClick={() => void refresh()}><Icon name="refresh" /></button><span className="owner-avatar" aria-label="現在の利用者">{snapshot?.principal?.displayName.slice(0, 1) ?? 'O'}</span></div>
    </header>
    <aside className="sidebar" aria-label="ナビゲーション">
      <div className="authority"><small>ACTIVE AUTHORITY</small><strong>{snapshot?.principal ? 'プロジェクトオーナー' : '未設定'}</strong><span>◆ {snapshot?.principal ? 'Owner / ローカル本人' : '初回設定が必要'}</span></div>
      <nav><button className="nav-item selected" onClick={() => setPane('dialogue')}><Icon name="home" /><span>ホーム</span></button><button className="nav-item" onClick={() => { setPane('outcome'); document.getElementById('approval-section')?.scrollIntoView({ block: 'start' }); }}><Icon name="approval" /><span>申請・承認</span>{!!snapshot?.pendingCount && <span className="count">{snapshot.pendingCount}</span>}</button><small className="nav-group">OBSERVE</small>{([['people', '組織'], ['member', 'AIメンバー'], ['project', 'プロジェクト'], ['book', 'ナレッジ'], ['release', 'リリース'], ['audit', '監査ログ']] as const).map(([icon, label]) => <button key={label} className="nav-item unavailable" disabled title="後続の実装で利用できます"><Icon name={icon} /><span>{label}</span><small>準備中</small></button>)}</nav>
      <div className="sidebar-bottom"><small className="nav-group">CONTROL</small><button className="nav-item" onClick={()=>setSettingsOpen(true)}><Icon name="settings" /><span>ツール・権限</span></button></div>
    </aside>
    <main className="main-area">
      {settingsOpen&&<ApiSettingsDialog onClose={()=>setSettingsOpen(false)}>{snapshot?.budgetPolicy&&<BudgetSettings policy={snapshot.budgetPolicy} disabled={disabled} notice={notice} onSave={(normal,reserve,e)=>submitCommand(command('budget.configure',snapshot.budgetPolicy!.id,snapshot.budgetPolicy!.revision,{currency:'USD',normal_limit:normal,reserve_limit:reserve,autonomous_e_limit:e}))}/>}</ApiSettingsDialog>}
      <div className="page-heading"><div><div className="title-row"><h1>ホーム</h1>{selected && <><span className="mission-reference">{selected.id.slice(0, 8)}</span><strong className="mission-title">{selected.title}</strong><span className={`status-pill ${selected.phase === 'exit' ? 'neutral' : ''}`}>{phaseLabels[selected.phase]}</span></>}</div><p>話す・確かめる・判断するを、この画面で</p></div><span className="last-updated">最終取得 {dateLabel(lastRead)}</span></div>
      <div className="notifications" aria-live="polite" aria-atomic="true">{readError && <div className="notice warning" role="status">{readError}</div>}{notice && <div className="notice">{notice}</div>}{uncertain.map(item => <div className="notice warning" key={item.id}><span>操作結果が未確認です。別の操作として再送せず、同じIDの結果を確認します。</span><button className="button" disabled={busy} onClick={() => void write(item.operation)}>同じ操作を確認</button></div>)}{ready && applicationPaused && <div className="notice warning"><span>新しい実行は停止中です。原文の保存・成果の参照・処理中の照合は続けられます。</span><button className="button" disabled={busy || uncertain.length > 0} onClick={() => control('resume_dispatch')}>新規実行を再開</button></div>}</div>
      {!snapshot ? <div className="loading-state"><Icon name="home" size={32} /><h2>{readError ? 'Homeへ接続できません' : 'Homeを読み込んでいます'}</h2><p>接続できると、保存済みの対話と成果を表示します。</p><button className="button primary" onClick={() => void refresh()} disabled={refreshing}>再接続</button></div> : snapshot.status === 'setup_required' ? <Setup disabled={!online || busy || uncertain.length > 0} onSubmit={request => write({ kind: 'setup', request })} /> : <>
        <div className="mobile-pane-tabs" role="tablist" aria-label="Home内の表示"><button role="tab" aria-selected={pane === 'dialogue'} onClick={() => setPane('dialogue')}>対話</button><button role="tab" aria-selected={pane === 'outcome'} onClick={() => setPane('outcome')}>成果と判断 {snapshot.pendingCount > 0 ? `(${snapshot.pendingCount})` : ''}</button></div>
        <div className={`workspace pane-${pane}`}>
          <section className="panel dialogue-panel" aria-labelledby="dialogue-heading"><div className="panel-heading"><span className="section-icon assistant-icon"><Icon name="message" size={23} /></span><h2 id="dialogue-heading">秘書AIとの対話</h2><span>履歴はここだけスクロール</span></div><div className="timeline scroll-region" tabIndex={0} aria-label="対話の履歴">{snapshot.messages.length === 0 ? <div className="empty-dialogue"><div className="empty-icon"><Icon name="message" size={30} /></div><h3>何から始めましょうか</h3><p>目的や修正したいことを、そのまま入力してください。</p><p className="muted">この段階では原文を保存し、ローカルの検証経路で承認と成果確認を試せます。</p></div> : snapshot.messages.map(message => <article key={message.id} className={`message message-${message.role}`}><span className={`message-avatar ${message.role === 'system' ? 'assistant-icon' : ''}`}>{message.role === 'user' ? 'U' : <Icon name="message" size={21} />}</span><div className="message-content"><div className="message-byline"><strong>{message.role === 'user' ? 'あなた' : 'OrgManage'}</strong><time dateTime={message.createdAt}>{dateLabel(message.createdAt)}</time></div><p>{message.text}</p></div></article>)}</div><form className="composer" onSubmit={event => { event.preventDefault(); void post(); }}><div className="composer-top"><label className="relation-select"><Icon name="message" size={16} /><select aria-label="投稿と案件の関係" value={relation} onChange={event => setRelation(event.target.value as 'new' | 'continue')}><option value="new">新しい案件</option><option value="continue">この対話の案件を続ける</option></select></label><span>{bytes > 60_000 ? `${bytes.toLocaleString()} / 65,536 bytes` : '原文のまま保存'}</span></div><div className="composer-row"><textarea ref={composeRef} aria-label="目的や修正したいこと" value={draft} onChange={event => updateDraft(event.target.value)} onKeyDown={onComposeKey} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} placeholder="目的や修正したいことを、そのまま入力" rows={3} /><button className="button primary send-button" disabled={disabled || !draft.trim() || bytes > 65_536} type="submit"><Icon name="send" size={18} />送信</button></div><div className={`composer-hint ${bytes > 65_536 ? 'danger-text' : ''}`}>{bytes > 65_536 ? '原文は64 KiBまでです。入力は保持しています。' : 'Enterで改行 · Ctrl+Enterで送信'}</div></form></section>
          <section className="outcome-column" aria-label="成果と判断"><div className="panel outcome-panel"><div className="panel-heading"><span className="section-icon"><Icon name="document" size={24} /></span><h2>成果と判断</h2><span>長い成果はこの欄で確認</span></div><div className="outcome-body scroll-region" tabIndex={0}>
            <MissionList missions={snapshot.missions} selected={selected?.id ?? null} onSelect={setSelectedId} />
            <KnowledgePanel items={snapshot.knowledge??[]} disabled={disabled} onDecide={(item,choice)=>submitCommand(command('knowledge.decide',item.id,item.revision,{choice,candidate_ref:item.id,evaluation_ref:item.evaluationId,scope_ref:item.scopeId,comment:null}))} />
            {!selected ? <div className="empty-outcome"><Icon name="document" size={36} /><h3>成果はここで確認できます</h3><p>左の入力から依頼すると、同じHomeで対象と承認、成果の内容を確認できます。</p></div> : <>
              <div className="selected-mission"><h3>{selected.title}</h3><span className="target-version">対象版 {selected.revision} · {phaseLabels[selected.phase]}</span></div>
              <NativeResponses attempts={snapshot.nativeAttempts.filter(a=>a.scopeId===selected.id)} />
              <ApiResponses items={(snapshot.apiAttempts??[]).filter(a=>a.missionId===selected.id)} />
              <RoutingPanel items={(snapshot.routing??[]).filter(r=>r.missionId===selected.id)} />
              <CandidateEvaluations evaluations={(snapshot.candidateEvaluations??[]).filter(e=>e.missionId===selected.id)} />
              {selected.phase === 'intake' && <div className="start-section"><h3>依頼内容を確認して進める</h3><p>原文と契約を保持して、ローカル検証の実行承認を作成します。外部へは送信しません。</p><button className="button primary" disabled={disabled || applicationPaused || selected.scope.state !== 'active'} onClick={() => void start(selected)}>実行内容を確認する</button></div>}
              {approval && selected.phase !== 'intake' && <ApprovalCard key={`${approval.id}:${approval.revision}`} approval={approval} disabled={disabled} onDecide={(choice, comment) => submitCommand(command('approval.decide', approval.id, approval.revision, { action_digest: approval.actionDigest, choice, comment: comment || null, explanation_revision: approval.explanationRevision }))} />}
              {snapshot.intents.filter(intent => intent.missionId === selected.id && (intent.state === 'unknown' || intent.cancellation !== 'not_requested')).map(intent => <div className="notice warning" key={intent.id}><strong>{intent.state === 'unknown' ? '実行結果が未確認です' : '停止の状態'}</strong><p>{intent.state === 'unknown' ? '照合するまで再実行しません。未確定の拘束と履歴を保持しています。' : '取消要求と停止の観測は別に記録します。'}</p><span>取消：{intent.cancellation === 'observed' ? '停止を観測済み' : intent.cancellation === 'requested' ? '要求済み・停止は未確認' : '未要求'} / 模擬拘束 {intent.cash?usd(intent.cash.held):money(intent.heldYen)}</span></div>)}
              {outcome && <article className="artifact"><div className="artifact-heading"><h3>成果のプレビュー</h3><span className="status-pill">{outcomeLabels[outcome.state]}</span></div><p className="muted">ローカル検証で生成した成果です。使用中アプリへの反映はありません。</p><pre>{outcome.text}</pre><div className="verification"><Icon name="check" /><strong>ローカル検証の成果</strong><span>対象版 {outcome.revision}</span></div></article>}
              {!outcome && selected.phase !== 'intake' && !approval && <p className="empty-outcome">まだ成果はありません。確認が必要な内容はここに表示します。</p>}
              <div className="mission-controls"><span>案件の実行状態：{selected.scope.state === 'active' ? '有効' : selected.scope.state === 'paused' ? '停止中' : '終了'}</span>{selected.scope.state !== 'closed' && <button className="button small" disabled={disabled} onClick={() => void submitCommand(command('mission.control', selected.id, selected.scope.revision, { choice: selected.scope.state === 'paused' ? 'resume' : 'pause', comment: null }))}>{selected.scope.state === 'paused' ? '案件を再開' : '案件を一時停止'}</button>}</div>
            </>}
            <div className="pending-summary"><div><strong>実行承認待ち {snapshot.pendingCount}件</strong><span>最古 {dateLabel(snapshot.oldestPendingAt)}</span></div><div><span>{snapshot.budget.simulation?'模擬拘束':'共通拘束'} {snapshot.budget.cash?usd(snapshot.budget.cash.held):money(snapshot.budget.heldYen)}</span><span>{snapshot.budget.simulation?'模擬計上':'共通計上'} {snapshot.budget.cash?usd(snapshot.budget.cash.booked):money(snapshot.budget.bookedYen)}</span><span>{snapshot.budget.simulation?'模擬上限':'共通上限'} {snapshot.budget.cash?usd(snapshot.budget.cash.limit):money(snapshot.budget.limitYen)}</span></div></div>
          </div></div><OutcomeDecision key={outcome ? `${outcome.id}:${outcome.revision}` : 'empty'} outcome={outcome} disabled={disabled || selected?.scope.state === 'closed'} onDecide={async (choice, comment) => { if (!outcome) return false; const result = await submitCommand(command('outcome.decide', outcome.id, outcome.revision, { artifact_revision_id: outcome.artifactId, choice, comment: comment || null, explanation_revision: outcome.explanationRevision })); if (result && choice === 'revise') { setPane('dialogue'); window.requestAnimationFrame(() => composeRef.current?.focus()); } return result; }} /></section>
        </div>
      </>}
    </main>
  </div>;
}

function Setup({ disabled, onSubmit }: { disabled: boolean; onSubmit(request: SetupRequest): Promise<boolean> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'person' | 'organization'>('person');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled || !name.trim()) return;
    void onSubmit({ protocol_version: 1, setup_command_id: crypto.randomUUID(), principal: { kind, display_name: name.trim() }, owner_binding_candidate: null });
  };
  return <div className="setup-layout"><section className="panel setup-panel"><span className="section-icon"><Icon name="home" size={28} /></span><h2>あなたのHomeを準備する</h2><p>この端末の利用者に、最初の組織と対話を結び付けます。</p><form onSubmit={submit}><label>利用する主体<select value={kind} onChange={event => setKind(event.target.value as 'person' | 'organization')}><option value="person">個人</option><option value="organization">組織</option></select></label><label>表示名<input value={name} onChange={event => setName(event.target.value)} maxLength={120} autoComplete="off" placeholder="Homeに表示する名前" /></label><p className="setup-note">API接続・外部送信は無効で開始します。原文の保存と、ローカルでの承認・成果確認が利用できます。</p><button className="button primary" disabled={disabled || !name.trim()}>Homeを準備する</button></form></section></div>;
}

function MissionList({ missions, selected, onSelect }: { missions: MissionView[]; selected: string | null; onSelect(id: string): void }) {
  const [filter, setFilter] = useState('all');
  if (!missions.length) return null;
  const counts = {
    all: missions.length,
    approval: missions.filter(mission => mission.phase === 'approval' || mission.phase === 'review').length,
    execution: missions.filter(mission => mission.phase === 'execution').length,
    exit: missions.filter(mission => mission.phase === 'exit').length,
  };
  const shown = missions.filter(mission => filter === 'all' || (filter === 'approval' ? mission.phase === 'approval' || mission.phase === 'review' : filter === 'execution' ? mission.phase === 'execution' : mission.phase === 'exit'));
  return <div className="mission-list"><h3>タスク一覧</h3><div className="filters" aria-label="タスクの絞り込み">{([['all', 'すべて'], ['approval', '確認待ち'], ['execution', '実行中'], ['exit', '終了']] as const).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{counts[value]}</span></button>)}</div><div className="task-table"><table><thead><tr><th>タイトル</th><th>状態</th><th>版</th></tr></thead><tbody>{shown.map(mission => <tr className={mission.id === selected ? 'selected-row' : ''} key={mission.id}><td><button className="task-link" aria-pressed={mission.id === selected} onClick={() => onSelect(mission.id)}>{mission.title}</button></td><td><span className={`status-pill ${mission.phase === 'exit' ? 'neutral' : ''}`}>{phaseLabels[mission.phase]}</span></td><td>{mission.revision}</td></tr>)}</tbody></table>{!shown.length && <p className="table-empty">この条件に合う案件はありません。選択中の案件は保持しています。</p>}</div></div>;
}
function ApprovalCard({ approval, disabled, onDecide }: { approval: ApprovalView; disabled: boolean; onDecide(choice: 'approve' | 'deny', comment: string): Promise<boolean> }) {
  const [comment, setComment] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const explanation = approval.explanation;
  const pending = approval.state === 'pending';
  const stateLabels: Record<ApprovalView['state'], string> = { pending: '実行の承認待ち', approved: '承認済み', denied: '拒否済み', expired: '期限切れ', superseded: '更新済み・旧判断は無効' };
  return <section id="approval-section" className="approval-card" aria-labelledby={`approval-${approval.id}`}><div className="approval-heading"><Icon name="approval" /><h3 id={`approval-${approval.id}`}>実行の承認</h3><span className="status-pill">{stateLabels[approval.state]}</span></div><p className="approval-intro">成果の採択とは別の判断です。この対象と条件だけに適用します。</p><div className="approval-essentials"><strong>{explanation.change}</strong><dl><div><dt>宛先</dt><dd>{explanation.destination} / {explanation.account} / {explanation.route}</dd></div><div><dt>追加費用上限</dt><dd>{money(explanation.maximum ?? explanation.maximumYen)} · {explanation.month}</dd></div><div><dt>許可の期限</dt><dd>{dateLabel(approval.expiresAt)}</dd></div><div><dt>対象版</dt><dd>{approval.revision} / 説明 {approval.explanationRevision}</dd></div></dl></div><details className="approval-details" open><summary>影響・代替・送る資料を確認する</summary><dl><div><dt>現在の見積りとの差</dt><dd>{explanation.estimateDifference}</dd></div><div><dt>代替</dt><dd>{explanation.alternatives.join(' / ')}</dd></div><div><dt>期待する効果と確度</dt><dd>{explanation.expectedBenefit}</dd></div><div><dt>失敗時の扱い</dt><dd>{explanation.failureHandling}</dd></div><div><dt>資料の範囲・機密区分</dt><dd>{explanation.disclosure} / {explanation.dataClassification}</dd></div><div><dt>追加の開示条件</dt><dd>{explanation.additionalDisclosure}</dd></div><div><dt>保管先・期間</dt><dd>{explanation.retention}</dd></div><div><dt>7日後の成果回収</dt><dd>{explanation.recovery}</dd></div><div><dt>リスク</dt><dd>{explanation.risk}</dd></div></dl><p className="digest">対象digest {approval.actionDigest}</p></details>{pending && <div className="approval-actions"><label className="check-label"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} />表示中の対象・宛先・費用・開示条件を確認しました</label><label className="sr-only" htmlFor={`comment-${approval.id}`}>実行承認のコメント（任意）</label><input id={`comment-${approval.id}`} value={comment} onChange={event => setComment(event.target.value)} placeholder="コメント（任意）" maxLength={4000} /><div><button className="button primary" disabled={disabled || !confirmed} onClick={() => void onDecide('approve', comment)}><Icon name="check" size={17} />この実行を承認</button><button className="button" disabled={disabled} onClick={() => void onDecide('deny', comment)}>承認しない</button></div></div>}</section>;
}

function OutcomeDecision({ outcome, disabled, onDecide }: { outcome: OutcomeView | null; disabled: boolean; onDecide(choice: 'accepted' | 'revise' | 'hold' | 'close', comment: string): Promise<boolean> }) {
  const [comment, setComment] = useState('');
  const [choice, setChoice] = useState<'accepted' | 'revise' | 'hold' | 'close' | null>(null);
  const choices = [{ value: 'accepted', title: '成果を採択', icon: 'check', description: 'この成果版を受け入れます。公開・送信・使用中アプリの更新は別承認です。' }, { value: 'revise', title: '修正して続ける', icon: 'edit', description: '同じ案件の入口へ戻り、成果と履歴を残して直します。変更に関係する承認は再確認します。' }, { value: 'hold', title: '保留', icon: 'pause', description: '新しい実行を止めます。処理中の停止確認・結果回収・費用照合は続けます。' }, { value: 'close', title: '今回は終了', icon: 'close', description: 'この案件の新しい作業を閉じます。成果・履歴・未照合費用は残ります。' }] as const;
  const chosen = choices.find(item => item.value === choice);
  const inactive = disabled || !outcome || outcome.state !== 'pending';
  return <section className="decision-dock" aria-label="成果の判断"><div className="decision-note"><strong>成果の採択と、使用中アプリの更新承認は別です</strong>{outcome && <span>判断版 {outcome.revision}</span>}</div><label className="sr-only" htmlFor="outcome-comment">成果へのコメント（任意）</label><input id="outcome-comment" placeholder="コメント（任意）" value={comment} onChange={event => setComment(event.target.value)} maxLength={4000} /><div className="decision-buttons">{choices.map(item => <button key={item.value} className={`button ${item.value === 'accepted' ? 'primary' : ''} ${item.value === 'close' ? 'danger' : ''}`} aria-pressed={choice === item.value} disabled={inactive} onClick={() => setChoice(item.value)}><Icon name={item.icon} size={17} />{item.title}</button>)}</div>{chosen && !inactive ? <div className="decision-confirm"><p>{chosen.description}</p><button className={`button ${choice === 'close' ? 'danger' : 'primary'}`} disabled={inactive} onClick={() => { if (choice) void onDecide(choice, comment); }}>判断版 {outcome?.revision} を「{chosen.title}」で確定</button><button className="text-button" onClick={() => setChoice(null)}>戻る</button></div> : <p className="decision-help">{outcome ? `現在の判断：${outcomeLabels[outcome.state]}。対象の成果を確認して選んでください。` : '成果が届くと、この場所で判断できます。'}</p>}</section>;
}
