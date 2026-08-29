import { Check, Clock3, RefreshCw, ShieldAlert, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { consoleApi, type PendingApprovalView } from './api.js';

function money(value: string) {
  const amount = BigInt(value);
  return `${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2, '0')}`;
}

export function ConfirmationsPage() {
  const [items, setItems] = useState<readonly PendingApprovalView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Readonly<{
    item: PendingApprovalView;
    action: 'approve' | 'reject';
  }> | null>(null);
  const [pending, setPending] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);

    try {
      setItems(await consoleApi.confirmations());
    } catch {
      setError('确认队列载入失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function decide() {
    if (decision === null) return;
    setPending(true);
    setError(null);

    try {
      await consoleApi.decideConfirmation(decision.item.transactionId, decision.action);
      setItems((current) =>
        current.filter((item) => item.transactionId !== decision.item.transactionId),
      );
      setDecision(null);
    } catch {
      setError('确认操作未完成，交易状态可能已变化');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="resource-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">人工门禁</p>
          <h1>待确认交易</h1>
        </div>
        <button
          className="icon-command bordered"
          type="button"
          title="刷新队列"
          aria-label="刷新队列"
          onClick={() => void load()}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      {error === null ? null : (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="data-section table-loading">正在载入确认队列</div>
      ) : items.length === 0 ? (
        <div className="data-section empty-state">
          <ShieldAlert size={25} />
          <strong>暂无待确认交易</strong>
        </div>
      ) : (
        <section className="confirmation-list" aria-label="待确认交易列表">
          {items.map((item) => (
            <article className="confirmation-item" key={item.transactionId}>
              <header>
                <div>
                  <span className="pending-label">
                    <Clock3 size={14} />
                    等待确认
                  </span>
                  <h2>{item.serviceName}</h2>
                  <p>{item.mandatePurpose}</p>
                </div>
                <strong className="approval-amount">¥ {money(item.amount.amountMinor)}</strong>
              </header>
              <dl className="confirmation-facts">
                <div>
                  <dt>Agent</dt>
                  <dd>
                    {item.agentName}
                    <span className="mono-value">{item.agentId}</span>
                  </dd>
                </div>
                <div>
                  <dt>商户</dt>
                  <dd>
                    {item.merchantName}
                    <span className="mono-value">{item.merchantId}</span>
                  </dd>
                </div>
                <div>
                  <dt>服务</dt>
                  <dd>
                    {item.serviceName}
                    <span className="mono-value">{item.serviceId}</span>
                  </dd>
                </div>
                <div>
                  <dt>剩余预算</dt>
                  <dd className="budget-value">
                    ¥ {money(item.remainingBudget.amountMinor)}
                    <span>总额 ¥ {money(item.totalBudget.amountMinor)}</span>
                  </dd>
                </div>
              </dl>
              <footer>
                <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                <div>
                  <button
                    className="secondary-command reject"
                    type="button"
                    onClick={() => {
                      setDecision({ item, action: 'reject' });
                    }}
                  >
                    <XCircle size={16} />
                    拒绝
                  </button>
                  <button
                    className="primary-command compact"
                    type="button"
                    onClick={() => {
                      setDecision({ item, action: 'approve' });
                    }}
                  >
                    <Check size={16} />
                    批准
                  </button>
                </div>
              </footer>
            </article>
          ))}
        </section>
      )}

      {decision === null ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal compact-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="decision-title"
          >
            <header className="modal-header">
              <div>
                <p className={decision.action === 'reject' ? 'eyebrow danger-text' : 'eyebrow'}>
                  {decision.action === 'approve' ? '支付授权确认' : '拒绝交易'}
                </p>
                <h2 id="decision-title">{decision.item.serviceName}</h2>
              </div>
              <button
                className="icon-command"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setDecision(null);
                }}
              >
                <X size={19} />
              </button>
            </header>
            <div className="decision-summary">
              <span>{decision.item.agentName}</span>
              <span>{decision.item.merchantName}</span>
              <strong>¥ {money(decision.item.amount.amountMinor)}</strong>
            </div>
            <div className="modal-actions">
              <button
                className="secondary-command"
                type="button"
                onClick={() => {
                  setDecision(null);
                }}
              >
                取消
              </button>
              <button
                className={
                  decision.action === 'approve' ? 'primary-command compact' : 'danger-command'
                }
                type="button"
                disabled={pending}
                onClick={() => void decide()}
              >
                {decision.action === 'approve' ? (
                  <>
                    <Check size={16} />
                    确认批准
                  </>
                ) : (
                  <>
                    <XCircle size={16} />
                    确认拒绝
                  </>
                )}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
