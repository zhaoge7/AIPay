import { Eye, Plus, RefreshCw, ScrollText, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';

import {
  consoleApi,
  type AgentView,
  type MandateInput,
  type MandateView,
  type MerchantView,
} from './api.js';

function minorToYuan(value: string) {
  const amount = BigInt(value);
  return `${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function yuanToMinor(value: string) {
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/u.exec(value.trim());

  if (match?.[1] === undefined) return null;
  return (BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))).toString();
}

function statusLabel(status: MandateView['status']) {
  const labels = {
    draft: '草稿',
    active: '生效中',
    paused: '已暂停',
    revoked: '已撤销',
    expired: '已过期',
  } as const;
  return labels[status];
}

async function instructionHash(purpose: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(purpose));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

function splitValues(value: string) {
  return [
    ...new Set(
      value
        .split(/[\s,]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function MandatesPage() {
  const [mandates, setMandates] = useState<readonly MandateView[]>([]);
  const [agents, setAgents] = useState<readonly AgentView[]>([]);
  const [merchants, setMerchants] = useState<readonly MerchantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<MandateView | null>(null);
  const [agentId, setAgentId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [merchantIds, setMerchantIds] = useState('');
  const [categories, setCategories] = useState('');
  const [maxPerTransaction, setMaxPerTransaction] = useState('1.00');
  const [totalBudget, setTotalBudget] = useState('10.00');
  const [approvalThreshold, setApprovalThreshold] = useState('1.00');
  const [maxTransactions, setMaxTransactions] = useState('10');
  const [validUntil, setValidUntil] = useState(
    new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString().slice(0, 16),
  );

  async function load() {
    setLoading(true);
    setError(null);

    try {
      const [mandateList, agentList, merchantList] = await Promise.all([
        consoleApi.mandates(),
        consoleApi.agents(),
        consoleApi.merchants(),
      ]);
      setMandates(mandateList);
      setAgents(agentList.filter((agent) => agent.status === 'enabled'));
      setMerchants(merchantList.filter((merchant) => merchant.status === 'active'));
      setAgentId((current) => (current.length > 0 ? current : (agentList[0]?.agentId ?? '')));
      setMerchantIds((current) =>
        current.length > 0 ? current : (merchantList[0]?.merchantId ?? ''),
      );
    } catch {
      setError('授权列表载入失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const maxMinor = yuanToMinor(maxPerTransaction);
    const totalMinor = yuanToMinor(totalBudget);
    const thresholdMinor = yuanToMinor(approvalThreshold);
    const allowedMerchantIds = splitValues(merchantIds);
    const allowedCategories = splitValues(categories);

    if (
      maxMinor === null ||
      totalMinor === null ||
      thresholdMinor === null ||
      agentId.length === 0 ||
      allowedMerchantIds.length === 0 ||
      allowedCategories.length === 0
    ) {
      setError('请完整填写确定授权字段');
      return;
    }

    const input: MandateInput = {
      agentId,
      purpose,
      allowedMerchantIds,
      allowedCategories,
      maxPerTransaction: { currency: 'CNY', amountMinor: maxMinor },
      totalBudget: { currency: 'CNY', amountMinor: totalMinor },
      approvalRequiredAbove: { currency: 'CNY', amountMinor: thresholdMinor },
      maxTransactions: Number(maxTransactions),
      validUntil: new Date(validUntil).toISOString(),
      instructionHash: await instructionHash(purpose),
    };
    setPending(true);
    setError(null);

    try {
      const draft = await consoleApi.createMandate(input);
      await consoleApi.issueMandate(draft.mandateId);
      const active = await consoleApi.mandate(draft.mandateId);
      setMandates((current) => [active, ...current]);
      setDetail(active);
      setCreating(false);
    } catch {
      setError('授权创建失败，请检查白名单、预算和有效期');
    } finally {
      setPending(false);
    }
  }

  async function openDetail(mandateId: string) {
    setPending(true);
    setError(null);

    try {
      setDetail(await consoleApi.mandate(mandateId));
    } catch {
      setError('授权详情载入失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="resource-page">
      <header className="page-heading resource-heading">
        <div>
          <p className="eyebrow">确定性边界</p>
          <h1>授权管理</h1>
        </div>
        <button
          className="primary-command compact"
          type="button"
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus size={17} />
          创建授权
        </button>
      </header>
      {error === null ? null : (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}
      <section className="data-section" aria-label="授权列表">
        <div className="data-toolbar">
          <span>{loading ? '正在载入' : `${String(mandates.length)} 条授权`}</span>
          <button
            className="icon-command"
            type="button"
            title="刷新授权"
            aria-label="刷新授权"
            onClick={() => void load()}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        {loading ? (
          <div className="table-loading">正在载入授权</div>
        ) : mandates.length === 0 ? (
          <div className="empty-state">
            <ScrollText size={24} />
            <strong>暂无授权</strong>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="resource-table mandate-table">
              <thead>
                <tr>
                  <th>用途</th>
                  <th>Agent</th>
                  <th>预算</th>
                  <th>次数</th>
                  <th>有效期</th>
                  <th>状态</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {mandates.map((mandate) => (
                  <tr key={mandate.mandateId}>
                    <td data-label="用途">
                      <strong>{mandate.purpose}</strong>
                      <span className="table-secondary mono-value">{mandate.mandateId}</span>
                    </td>
                    <td data-label="Agent">
                      <span className="mono-value clipped-value">{mandate.agentId}</span>
                    </td>
                    <td data-label="预算">
                      <strong>¥ {minorToYuan(mandate.totalBudget.amountMinor)}</strong>
                      <span className="table-secondary">
                        单笔 ¥ {minorToYuan(mandate.maxPerTransaction.amountMinor)}
                      </span>
                    </td>
                    <td data-label="次数">
                      {String(mandate.completedTransactionCount)} /{' '}
                      {String(mandate.maxTransactions)}
                    </td>
                    <td data-label="有效期">
                      {new Date(mandate.validUntil).toLocaleString('zh-CN')}
                    </td>
                    <td data-label="状态">
                      <span className={`mandate-status ${mandate.status}`}>
                        {statusLabel(mandate.status)}
                      </span>
                    </td>
                    <td className="row-actions">
                      <button
                        className="icon-command"
                        type="button"
                        title="查看授权"
                        aria-label={`查看 ${mandate.purpose}`}
                        disabled={pending}
                        onClick={() => void openDetail(mandate.mandateId)}
                      >
                        <Eye size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {creating ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal wide-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mandate-create-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow">结构化授权</p>
                <h2 id="mandate-create-title">创建授权</h2>
              </div>
              <button
                className="icon-command"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setCreating(false);
                }}
              >
                <X size={19} />
              </button>
            </header>
            <form className="modal-form" onSubmit={(event) => void create(event)}>
              <label htmlFor="mandate-agent">Agent</label>
              <select
                id="mandate-agent"
                value={agentId}
                required
                onChange={(event) => {
                  setAgentId(event.target.value);
                }}
              >
                {agents.map((agent) => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <label htmlFor="mandate-purpose">用途</label>
              <input
                id="mandate-purpose"
                value={purpose}
                required
                maxLength={500}
                onChange={(event) => {
                  setPurpose(event.target.value);
                }}
              />
              <label htmlFor="mandate-merchants">允许商户 ID</label>
              <textarea
                id="mandate-merchants"
                value={merchantIds}
                required
                rows={3}
                onChange={(event) => {
                  setMerchantIds(event.target.value);
                }}
              />
              {merchants.length === 0 ? null : (
                <div className="inline-options">
                  {merchants.map((merchant) => (
                    <button
                      type="button"
                      key={merchant.merchantId}
                      onClick={() => {
                        setMerchantIds((current) =>
                          splitValues(`${current} ${merchant.merchantId}`).join('\n'),
                        );
                      }}
                    >
                      {merchant.name}
                    </button>
                  ))}
                </div>
              )}
              <label htmlFor="mandate-categories">允许品类</label>
              <input
                id="mandate-categories"
                value={categories}
                required
                placeholder="data.weather"
                onChange={(event) => {
                  setCategories(event.target.value);
                }}
              />
              <div className="form-grid three">
                <div>
                  <label htmlFor="mandate-per-txn">单笔上限（元）</label>
                  <input
                    id="mandate-per-txn"
                    value={maxPerTransaction}
                    inputMode="decimal"
                    required
                    onChange={(event) => {
                      setMaxPerTransaction(event.target.value);
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="mandate-total">总预算（元）</label>
                  <input
                    id="mandate-total"
                    value={totalBudget}
                    inputMode="decimal"
                    required
                    onChange={(event) => {
                      setTotalBudget(event.target.value);
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="mandate-approval">确认阈值（元）</label>
                  <input
                    id="mandate-approval"
                    value={approvalThreshold}
                    inputMode="decimal"
                    required
                    onChange={(event) => {
                      setApprovalThreshold(event.target.value);
                    }}
                  />
                </div>
              </div>
              <div className="form-grid">
                <div>
                  <label htmlFor="mandate-count">最大次数</label>
                  <input
                    id="mandate-count"
                    type="number"
                    min="1"
                    max="1000000"
                    value={maxTransactions}
                    required
                    onChange={(event) => {
                      setMaxTransactions(event.target.value);
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="mandate-expiry">有效期至</label>
                  <input
                    id="mandate-expiry"
                    type="datetime-local"
                    value={validUntil}
                    required
                    onChange={(event) => {
                      setValidUntil(event.target.value);
                    }}
                  />
                </div>
              </div>
              <div className="modal-actions">
                <button
                  className="secondary-command"
                  type="button"
                  onClick={() => {
                    setCreating(false);
                  }}
                >
                  取消
                </button>
                <button className="primary-command compact" type="submit" disabled={pending}>
                  创建并签发
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {detail === null ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal wide-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mandate-detail-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow">授权详情</p>
                <h2 id="mandate-detail-title">{detail.purpose}</h2>
              </div>
              <button
                className="icon-command"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setDetail(null);
                }}
              >
                <X size={19} />
              </button>
            </header>
            <div className="mandate-detail">
              <div className="detail-status">
                <ShieldCheck size={20} />
                <span className={`mandate-status ${detail.status}`}>
                  {statusLabel(detail.status)}
                </span>
                <span className="mono-value">{detail.mandateId}</span>
              </div>
              <section>
                <h3>主体与白名单</h3>
                <dl className="detail-grid">
                  <div>
                    <dt>Agent</dt>
                    <dd className="mono-value">{detail.agentId}</dd>
                  </div>
                  <div>
                    <dt>允许商户</dt>
                    <dd>
                      {detail.allowedMerchantIds.map((id) => (
                        <span className="mono-value value-line" key={id}>
                          {id}
                        </span>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt>允许品类</dt>
                    <dd>{detail.allowedCategories.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>指令摘要</dt>
                    <dd className="mono-value break-value">{detail.instructionHash}</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h3>预算与次数</h3>
                <dl className="detail-grid four">
                  <div>
                    <dt>单笔上限</dt>
                    <dd>¥ {minorToYuan(detail.maxPerTransaction.amountMinor)}</dd>
                  </div>
                  <div>
                    <dt>总预算</dt>
                    <dd>¥ {minorToYuan(detail.totalBudget.amountMinor)}</dd>
                  </div>
                  <div>
                    <dt>确认阈值</dt>
                    <dd>¥ {minorToYuan(detail.approvalRequiredAbove.amountMinor)}</dd>
                  </div>
                  <div>
                    <dt>交易次数</dt>
                    <dd>
                      {String(detail.completedTransactionCount)} / {String(detail.maxTransactions)}
                    </dd>
                  </div>
                  <div>
                    <dt>已使用</dt>
                    <dd>¥ {minorToYuan(detail.spentAmount.amountMinor)}</dd>
                  </div>
                  <div>
                    <dt>预占中</dt>
                    <dd>¥ {minorToYuan(detail.reservedAmount.amountMinor)}</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h3>有效期</h3>
                <dl className="detail-grid">
                  <div>
                    <dt>签发时间</dt>
                    <dd>{new Date(detail.issuedAt).toLocaleString('zh-CN')}</dd>
                  </div>
                  <div>
                    <dt>有效期至</dt>
                    <dd>{new Date(detail.validUntil).toLocaleString('zh-CN')}</dd>
                  </div>
                </dl>
              </section>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
