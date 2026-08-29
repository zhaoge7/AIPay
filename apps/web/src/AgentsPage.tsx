import {
  Ban,
  CheckCircle2,
  Copy,
  KeyRound,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldOff,
  X,
} from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';

import { ConsoleApiError, consoleApi, type AgentView } from './api.js';

type EditorState =
  Readonly<{ kind: 'create' }> | Readonly<{ kind: 'rotate'; agent: AgentView }> | null;

function statusLabel(status: AgentView['status']) {
  if (status === 'enabled') return '运行中';
  if (status === 'disabled') return '已暂停';
  return '已吊销';
}

function replaceAgent(agents: readonly AgentView[], updated: AgentView) {
  return agents.map((agent) => (agent.agentId === updated.agentId ? updated : agent));
}

export function AgentsPage() {
  const [agents, setAgents] = useState<readonly AgentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [revokeTarget, setRevokeTarget] = useState<AgentView | null>(null);
  const [name, setName] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  async function loadAgents() {
    setLoading(true);
    setError(null);

    try {
      setAgents(await consoleApi.agents());
    } catch {
      setError('Agent 列表载入失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAgents();
  }, []);

  function openCreate() {
    setName('');
    setPublicKey('');
    setError(null);
    setEditor({ kind: 'create' });
  }

  function openRotate(agent: AgentView) {
    setName('');
    setPublicKey('');
    setError(null);
    setEditor({ kind: 'rotate', agent });
  }

  async function submitEditor(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();

    if (editor === null) return;
    setPendingId(editor.kind === 'rotate' ? editor.agent.agentId : 'create');
    setError(null);

    try {
      if (editor.kind === 'create') {
        const created = await consoleApi.createAgent(name, publicKey);
        setAgents((current) => [created, ...current]);
      } else {
        const rotated = await consoleApi.rotateAgentKey(editor.agent.agentId, publicKey);
        setAgents((current) => replaceAgent(current, rotated));
      }

      setEditor(null);
    } catch (caught) {
      setError(
        caught instanceof ConsoleApiError && caught.code === 'INVALID_REQUEST'
          ? '名称或公钥不可用'
          : '操作未完成，请稍后重试',
      );
    } finally {
      setPendingId(null);
    }
  }

  async function toggleStatus(agent: AgentView) {
    setPendingId(agent.agentId);
    setError(null);

    try {
      const updated = await consoleApi.setAgentStatus(
        agent.agentId,
        agent.status === 'enabled' ? 'disabled' : 'enabled',
      );
      setAgents((current) => replaceAgent(current, updated));
    } catch {
      setError('Agent 状态更新失败');
    } finally {
      setPendingId(null);
    }
  }

  async function revoke() {
    if (revokeTarget === null) return;
    setPendingId(revokeTarget.agentId);
    setError(null);

    try {
      const revoked = await consoleApi.revokeAgent(revokeTarget.agentId);
      setAgents((current) => replaceAgent(current, revoked));
      setRevokeTarget(null);
    } catch {
      setError('Agent 吊销失败');
    } finally {
      setPendingId(null);
    }
  }

  async function copyPublicKey(agent: AgentView) {
    await navigator.clipboard.writeText(agent.signingKey.publicKey);
    setCopiedKeyId(agent.signingKey.keyId);
    window.setTimeout(() => {
      setCopiedKeyId(null);
    }, 1_500);
  }

  return (
    <div className="resource-page">
      <header className="page-heading resource-heading">
        <div>
          <p className="eyebrow">身份与密钥</p>
          <h1>Agent 管理</h1>
        </div>
        <button className="primary-command compact" type="button" onClick={openCreate}>
          <Plus size={17} />
          新增 Agent
        </button>
      </header>

      {error === null ? null : (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}

      <section className="data-section" aria-label="Agent 列表">
        <div className="data-toolbar">
          <span>{loading ? '正在载入' : `${String(agents.length)} 个 Agent`}</span>
          <button
            className="icon-command"
            type="button"
            aria-label="刷新 Agent"
            title="刷新 Agent"
            onClick={() => void loadAgents()}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        {loading ? (
          <div className="table-loading" aria-live="polite">
            正在载入 Agent
          </div>
        ) : agents.length === 0 ? (
          <div className="empty-state">
            <KeyRound size={24} />
            <strong>暂无 Agent</strong>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="resource-table agent-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>状态</th>
                  <th>活动密钥</th>
                  <th>更新时间</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.agentId}>
                    <td data-label="Agent">
                      <strong>{agent.name}</strong>
                      <span className="table-secondary mono-value">{agent.agentId}</span>
                    </td>
                    <td data-label="状态">
                      <span className={`agent-status ${agent.status}`}>
                        {agent.status === 'enabled' ? (
                          <CheckCircle2 size={14} />
                        ) : (
                          <ShieldOff size={14} />
                        )}
                        {statusLabel(agent.status)}
                      </span>
                    </td>
                    <td data-label="活动密钥">
                      <span className="key-line">
                        <span className="mono-value key-value">{agent.signingKey.publicKey}</span>
                        <button
                          className="icon-command small"
                          type="button"
                          title="复制公钥"
                          aria-label={`复制 ${agent.name} 公钥`}
                          onClick={() => void copyPublicKey(agent)}
                        >
                          <Copy size={15} />
                        </button>
                      </span>
                      <span className="table-secondary">
                        {copiedKeyId === agent.signingKey.keyId ? '已复制' : agent.signingKey.keyId}
                      </span>
                    </td>
                    <td data-label="更新时间">
                      {new Date(agent.updatedAt).toLocaleString('zh-CN')}
                    </td>
                    <td className="row-actions">
                      {agent.status === 'revoked' ? null : (
                        <>
                          <button
                            className="icon-command"
                            type="button"
                            title={agent.status === 'enabled' ? '暂停 Agent' : '恢复 Agent'}
                            aria-label={`${agent.status === 'enabled' ? '暂停' : '恢复'} ${agent.name}`}
                            disabled={pendingId === agent.agentId}
                            onClick={() => void toggleStatus(agent)}
                          >
                            {agent.status === 'enabled' ? <Pause size={17} /> : <Play size={17} />}
                          </button>
                          <button
                            className="icon-command"
                            type="button"
                            title="轮换公钥"
                            aria-label={`轮换 ${agent.name} 公钥`}
                            onClick={() => {
                              openRotate(agent);
                            }}
                          >
                            <RotateCw size={17} />
                          </button>
                          <button
                            className="icon-command danger"
                            type="button"
                            title="吊销 Agent"
                            aria-label={`吊销 ${agent.name}`}
                            onClick={() => {
                              setRevokeTarget(agent);
                            }}
                          >
                            <Ban size={17} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editor === null ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-editor-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow">Agent 密钥</p>
                <h2 id="agent-editor-title">
                  {editor.kind === 'create' ? '新增 Agent' : '轮换公钥'}
                </h2>
              </div>
              <button
                className="icon-command"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setEditor(null);
                }}
              >
                <X size={19} />
              </button>
            </header>
            <form className="modal-form" onSubmit={(event) => void submitEditor(event)}>
              {editor.kind === 'create' ? (
                <>
                  <label htmlFor="agent-name">名称</label>
                  <input
                    id="agent-name"
                    value={name}
                    maxLength={100}
                    required
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                  />
                </>
              ) : (
                <p className="modal-context">{editor.agent.name}</p>
              )}
              <label htmlFor="agent-public-key">Ed25519 公钥</label>
              <textarea
                id="agent-public-key"
                value={publicKey}
                rows={4}
                required
                minLength={43}
                maxLength={43}
                onChange={(event) => {
                  setPublicKey(event.target.value.trim());
                }}
              />
              <div className="modal-actions">
                <button
                  className="secondary-command"
                  type="button"
                  onClick={() => {
                    setEditor(null);
                  }}
                >
                  取消
                </button>
                <button
                  className="primary-command compact"
                  type="submit"
                  disabled={pendingId !== null}
                >
                  {editor.kind === 'create' ? '创建' : '确认轮换'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {revokeTarget === null ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal compact-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="revoke-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow danger-text">不可逆操作</p>
                <h2 id="revoke-title">吊销 {revokeTarget.name}</h2>
              </div>
            </header>
            <p className="confirm-copy">吊销后该 Agent 与当前公钥将立即失效。</p>
            <div className="modal-actions">
              <button
                className="secondary-command"
                type="button"
                onClick={() => {
                  setRevokeTarget(null);
                }}
              >
                取消
              </button>
              <button
                className="danger-command"
                type="button"
                disabled={pendingId !== null}
                onClick={() => void revoke()}
              >
                <ShieldOff size={16} />
                确认吊销
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
