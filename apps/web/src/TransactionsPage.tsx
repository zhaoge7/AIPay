import { Eye, Filter, RefreshCw, ReceiptText, X } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';

import {
  consoleApi,
  type AgentView,
  type MerchantView,
  type TransactionListItem,
  type TransactionTimeline,
} from './api.js';

const statusOptions = [
  'requires_confirmation',
  'authorized',
  'payment_pending',
  'payment_review',
  'paid',
  'delivery_pending',
  'delivery_review',
  'delivered',
  'refund_pending',
  'refund_review',
  'refunded',
  'settled',
  'failed',
  'cancelled',
] as const;

const statusLabels: Readonly<Record<string, string>> = {
  requires_confirmation: '待确认',
  authorized: '已授权',
  payment_pending: '支付中',
  payment_review: '支付复核',
  paid: '已付款',
  delivery_pending: '交付中',
  delivery_review: '交付复核',
  delivered: '已交付',
  refund_pending: '退款中',
  refund_review: '退款复核',
  refunded: '已退款',
  settled: '已结算',
  failed: '失败',
  cancelled: '已取消',
};

const phaseLabels: Readonly<Record<string, string>> = {
  authorization: '授权',
  quote: '报价',
  transaction: '交易',
  payment: '支付',
  delivery: '交付',
  refund: '退款',
  notification: '通知',
  reconciliation: '对账',
};

function money(value: string) {
  const amount = BigInt(value);
  return `${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function utc(value: string) {
  return value.length === 0 ? undefined : new Date(value).toISOString();
}

interface FilterState {
  readonly status: string;
  readonly agentId: string;
  readonly merchantId: string;
  readonly from: string;
  readonly to: string;
}

const emptyFilters: FilterState = { status: '', agentId: '', merchantId: '', from: '', to: '' };

export function TransactionsPage() {
  const [items, setItems] = useState<readonly TransactionListItem[]>([]);
  const [agents, setAgents] = useState<readonly AgentView[]>([]);
  const [merchants, setMerchants] = useState<readonly MerchantView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [timeline, setTimeline] = useState<TransactionTimeline | null>(null);

  async function load(nextFilters: FilterState = filters) {
    setLoading(true);
    setError(null);

    try {
      const from = utc(nextFilters.from);
      const to = utc(nextFilters.to);
      setItems(
        await consoleApi.transactions({
          ...(nextFilters.status.length === 0 ? {} : { status: nextFilters.status }),
          ...(nextFilters.agentId.length === 0 ? {} : { agentId: nextFilters.agentId }),
          ...(nextFilters.merchantId.length === 0 ? {} : { merchantId: nextFilters.merchantId }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        }),
      );
    } catch {
      setError('交易列表载入失败，请检查时间区间');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void Promise.all([consoleApi.agents(), consoleApi.merchants()])
      .then(([agentList, merchantList]) => {
        setAgents(agentList);
        setMerchants(merchantList);
      })
      .catch(() => {
        setError('筛选项载入失败');
      });
    void load(emptyFilters);
  }, []);

  async function applyFilters(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    await load();
  }

  async function openTimeline(transactionId: string) {
    setError(null);

    try {
      setTimeline(await consoleApi.timeline(transactionId));
    } catch {
      setError('交易时间线载入失败');
    }
  }

  function setFilter(name: keyof FilterState, value: string) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  function clearFilters() {
    setFilters(emptyFilters);
    void load(emptyFilters);
  }

  return (
    <div className="resource-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">交易审计</p>
          <h1>交易与时间线</h1>
        </div>
        <button
          className="icon-command bordered"
          type="button"
          title="刷新交易"
          aria-label="刷新交易"
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
      <form className="filter-bar" onSubmit={(event) => void applyFilters(event)}>
        <Filter size={17} aria-hidden="true" />
        <select
          aria-label="交易状态"
          value={filters.status}
          onChange={(event) => {
            setFilter('status', event.target.value);
          }}
        >
          <option value="">全部状态</option>
          {statusOptions.map((value) => (
            <option value={value} key={value}>
              {statusLabels[value]}
            </option>
          ))}
        </select>
        <select
          aria-label="Agent 筛选"
          value={filters.agentId}
          onChange={(event) => {
            setFilter('agentId', event.target.value);
          }}
        >
          <option value="">全部 Agent</option>
          {agents.map((agent) => (
            <option value={agent.agentId} key={agent.agentId}>
              {agent.name}
            </option>
          ))}
        </select>
        <select
          aria-label="商户筛选"
          value={filters.merchantId}
          onChange={(event) => {
            setFilter('merchantId', event.target.value);
          }}
        >
          <option value="">全部商户</option>
          {merchants.map((merchant) => (
            <option value={merchant.merchantId} key={merchant.merchantId}>
              {merchant.name}
            </option>
          ))}
        </select>
        <input
          aria-label="开始时间"
          type="datetime-local"
          value={filters.from}
          onChange={(event) => {
            setFilter('from', event.target.value);
          }}
        />
        <input
          aria-label="结束时间"
          type="datetime-local"
          value={filters.to}
          onChange={(event) => {
            setFilter('to', event.target.value);
          }}
        />
        <button className="primary-command compact" type="submit">
          筛选
        </button>
        <button className="text-command inline" type="button" onClick={clearFilters}>
          清除
        </button>
      </form>
      <section className="data-section" aria-label="交易列表">
        <div className="data-toolbar">
          <span>{loading ? '正在载入' : `${String(items.length)} 笔交易`}</span>
        </div>
        {loading ? (
          <div className="table-loading">正在载入交易</div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <ReceiptText size={24} />
            <strong>暂无匹配交易</strong>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="resource-table transaction-table">
              <thead>
                <tr>
                  <th>交易</th>
                  <th>Agent</th>
                  <th>商户 / 服务</th>
                  <th>金额</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.transactionId}>
                    <td data-label="交易">
                      <span className="mono-value clipped-value">{item.transactionId}</span>
                    </td>
                    <td data-label="Agent">
                      <strong>{item.agentName}</strong>
                      <span className="table-secondary mono-value">{item.agentId}</span>
                    </td>
                    <td data-label="商户 / 服务">
                      <strong>{item.serviceName}</strong>
                      <span className="table-secondary">{item.merchantName}</span>
                    </td>
                    <td data-label="金额">
                      <strong>¥ {money(item.amount.amountMinor)}</strong>
                    </td>
                    <td data-label="状态">
                      <span className={`transaction-status ${item.status}`}>
                        {statusLabels[item.status] ?? item.status}
                      </span>
                    </td>
                    <td data-label="创建时间">
                      {new Date(item.createdAt).toLocaleString('zh-CN')}
                    </td>
                    <td className="row-actions">
                      <button
                        className="icon-command"
                        type="button"
                        title="查看时间线"
                        aria-label={`查看 ${item.transactionId} 时间线`}
                        onClick={() => void openTimeline(item.transactionId)}
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

      {timeline === null ? null : (
        <div className="modal-backdrop timeline-backdrop" role="presentation">
          <section
            className="timeline-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="timeline-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow">权威审计投影</p>
                <h2 id="timeline-title">交易时间线</h2>
              </div>
              <button
                className="icon-command"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setTimeline(null);
                }}
              >
                <X size={19} />
              </button>
            </header>
            <div className="timeline-summary">
              <span className="mono-value">{timeline.transaction.transactionId}</span>
              <strong>¥ {money(timeline.transaction.amount.amountMinor)}</strong>
              <span className={`transaction-status ${timeline.transaction.status}`}>
                {statusLabels[timeline.transaction.status] ?? timeline.transaction.status}
              </span>
            </div>
            <ol className="timeline-list">
              {timeline.events.map((event) => (
                <li key={event.eventId}>
                  <span className={`timeline-dot ${event.phase}`} />
                  <div>
                    <header>
                      <strong>{phaseLabels[event.phase] ?? event.phase}</strong>
                      <time>{new Date(event.occurredAt).toLocaleString('zh-CN')}</time>
                    </header>
                    <p>{event.eventType}</p>
                    <span className="mono-value">{event.objectId}</span>
                    <footer>
                      <span>{event.status}</span>
                      {event.provider === null ? null : <span>{event.provider}</span>}
                      {event.operation === null ? null : <span>{event.operation}</span>}
                      {event.errorCode === null ? null : (
                        <span className="danger-text">{event.errorCode}</span>
                      )}
                    </footer>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}
