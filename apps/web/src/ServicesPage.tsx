import { Cable, CircleDollarSign, Pencil, Plus, Power, RefreshCw, Store, X } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';

import {
  ConsoleApiError,
  consoleApi,
  type ApiRegistrationInput,
  type MerchantView,
  type ServiceInput,
  type ServiceView,
} from './api.js';

const emptyForm: ServiceInput = {
  type: 'api',
  name: '',
  category: '',
  unit: 'request',
  unitPrice: { currency: 'CNY', amountMinor: '1' },
  refundPolicy: 'full_on_delivery_failure',
};

interface ApiEditorForm {
  readonly endpointUrl: string;
  readonly description: string;
  readonly capabilities: string;
  readonly inputSchema: string;
  readonly timeoutMs: string;
  readonly enabled: boolean;
}

const emptyApiForm: ApiEditorForm = {
  endpointUrl: '',
  description: '',
  capabilities: '',
  inputSchema: JSON.stringify(
    {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {},
    },
    null,
    2,
  ),
  timeoutMs: '10000',
  enabled: true,
};

function minorToYuan(value: string) {
  const amount = BigInt(value);
  return `${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function yuanToMinor(value: string) {
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/u.exec(value.trim());

  if (match?.[1] === undefined) return null;
  return (BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))).toString();
}

function typeLabel(type: ServiceView['type']) {
  if (type === 'api') return 'API';
  if (type === 'mcp') return 'MCP';
  return 'Skill';
}

export function ServicesPage() {
  const [merchants, setMerchants] = useState<readonly MerchantView[]>([]);
  const [merchantId, setMerchantId] = useState('');
  const [services, setServices] = useState<readonly ServiceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<'create' | ServiceView | null>(null);
  const [form, setForm] = useState<ServiceInput>(emptyForm);
  const [yuanPrice, setYuanPrice] = useState('0.01');
  const [merchantEditor, setMerchantEditor] = useState(false);
  const [merchantName, setMerchantName] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [apiEditor, setApiEditor] = useState<ServiceView | null>(null);
  const [apiForm, setApiForm] = useState<ApiEditorForm>(emptyApiForm);

  async function loadMerchants() {
    setLoading(true);
    setError(null);

    try {
      const result = await consoleApi.merchants();
      setMerchants(result);
      setMerchantId((current) => (current.length > 0 ? current : (result[0]?.merchantId ?? '')));
    } catch {
      setError('商户列表载入失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadServices(targetMerchantId: string) {
    if (targetMerchantId.length === 0) {
      setServices([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      setServices(await consoleApi.services(targetMerchantId));
    } catch {
      setError('服务列表载入失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMerchants();
  }, []);

  useEffect(() => {
    void loadServices(merchantId);
  }, [merchantId]);

  function openCreate() {
    setForm(emptyForm);
    setYuanPrice('0.01');
    setEditor('create');
    setError(null);
  }

  function openEdit(service: ServiceView) {
    setForm({
      type: service.type,
      name: service.name,
      category: service.category,
      unit: service.unit,
      unitPrice: service.unitPrice,
      refundPolicy: service.refundPolicy,
    });
    setYuanPrice(minorToYuan(service.unitPrice.amountMinor));
    setEditor(service);
    setError(null);
  }

  async function saveService(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountMinor = yuanToMinor(yuanPrice);

    if (amountMinor === null || amountMinor === '0') {
      setError('请输入有效的单次价格');
      return;
    }

    setPending(true);
    setError(null);
    const input = { ...form, unitPrice: { currency: 'CNY' as const, amountMinor } };

    try {
      if (editor === 'create') {
        const created = await consoleApi.createService(merchantId, input);
        setServices((current) => [created, ...current]);
      } else if (editor !== null) {
        const updated = await consoleApi.updateService(merchantId, editor.serviceId, input);
        setServices((current) =>
          current.map((service) => (service.serviceId === updated.serviceId ? updated : service)),
        );
      }

      setEditor(null);
    } catch {
      setError('服务保存失败，请检查名称、目录字段和价格');
    } finally {
      setPending(false);
    }
  }

  async function toggleService(service: ServiceView) {
    setPending(true);
    setError(null);

    try {
      const updated = await consoleApi.updateService(merchantId, service.serviceId, {
        status: service.status === 'enabled' ? 'disabled' : 'enabled',
      });
      setServices((current) =>
        current.map((item) => (item.serviceId === updated.serviceId ? updated : item)),
      );
    } catch {
      setError('服务状态更新失败');
    } finally {
      setPending(false);
    }
  }

  async function openApiEditor(service: ServiceView) {
    setPending(true);
    setError(null);

    try {
      const registration = await consoleApi.apiRegistration(merchantId, service.serviceId);
      setApiForm({
        endpointUrl: registration.endpointUrl,
        description: registration.description,
        capabilities: registration.capabilities.join(', '),
        inputSchema: JSON.stringify(registration.inputSchema, null, 2),
        timeoutMs: String(registration.timeoutMs),
        enabled: registration.status === 'enabled',
      });
      setApiEditor(service);
    } catch (caught) {
      if (caught instanceof ConsoleApiError && caught.code === 'AUTHORIZATION_DENIED') {
        setApiForm(emptyApiForm);
        setApiEditor(service);
      } else {
        setError('API 调用规范载入失败');
      }
    } finally {
      setPending(false);
    }
  }

  async function saveApiRegistration(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();

    if (apiEditor === null) return;
    const timeoutMs = Number(apiForm.timeoutMs);
    const capabilities = apiForm.capabilities
      .split(/[,，\n]/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    let inputSchema: unknown;

    try {
      inputSchema = JSON.parse(apiForm.inputSchema);
    } catch {
      setError('参数规范必须是有效 JSON');
      return;
    }

    if (
      typeof inputSchema !== 'object' ||
      inputSchema === null ||
      Array.isArray(inputSchema) ||
      !Number.isInteger(timeoutMs)
    ) {
      setError('请检查参数规范和超时时间');
      return;
    }

    const input: ApiRegistrationInput = {
      endpointUrl: apiForm.endpointUrl,
      httpMethod: 'POST',
      description: apiForm.description,
      capabilities,
      inputSchema: inputSchema as Readonly<Record<string, unknown>>,
      timeoutMs,
      status: apiForm.enabled ? 'enabled' : 'disabled',
    };
    setPending(true);
    setError(null);

    try {
      await consoleApi.putApiRegistration(merchantId, apiEditor.serviceId, input);
      setApiEditor(null);
    } catch {
      setError('API 调用规范保存失败，请检查地址、能力和参数结构');
    } finally {
      setPending(false);
    }
  }

  async function createMerchant(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const merchant = await consoleApi.createMerchant(merchantName, callbackUrl);
      setMerchants((current) => [merchant, ...current]);
      setMerchantId(merchant.merchantId);
      setMerchantEditor(false);
      setMerchantName('');
      setCallbackUrl('');
    } catch {
      setError('商户创建失败，请检查名称和回调地址');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="resource-page">
      <header className="page-heading resource-heading">
        <div>
          <p className="eyebrow">服务目录</p>
          <h1>服务与定价</h1>
        </div>
        <div className="heading-actions">
          <button
            className="secondary-command"
            type="button"
            onClick={() => {
              setMerchantEditor(true);
            }}
          >
            <Store size={16} />
            新增商户
          </button>
          <button
            className="primary-command compact"
            type="button"
            disabled={merchantId.length === 0}
            onClick={openCreate}
          >
            <Plus size={17} />
            新增服务
          </button>
        </div>
      </header>

      {error === null ? null : (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}

      <section className="data-section" aria-label="服务列表">
        <div className="data-toolbar service-toolbar">
          <label htmlFor="merchant-selector">商户</label>
          <select
            id="merchant-selector"
            value={merchantId}
            onChange={(event) => {
              setMerchantId(event.target.value);
            }}
          >
            {merchants.length === 0 ? (
              <option value="">暂无商户</option>
            ) : (
              merchants.map((merchant) => (
                <option key={merchant.merchantId} value={merchant.merchantId}>
                  {merchant.name}
                </option>
              ))
            )}
          </select>
          <span>{loading ? '正在载入' : `${String(services.length)} 项服务`}</span>
          <button
            className="icon-command"
            type="button"
            title="刷新服务"
            aria-label="刷新服务"
            onClick={() => void loadServices(merchantId)}
          >
            <RefreshCw size={17} />
          </button>
        </div>

        {loading ? (
          <div className="table-loading">正在载入服务</div>
        ) : services.length === 0 ? (
          <div className="empty-state">
            <CircleDollarSign size={24} />
            <strong>暂无付费服务</strong>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="resource-table service-table">
              <thead>
                <tr>
                  <th>服务</th>
                  <th>类型</th>
                  <th>目录</th>
                  <th>单价</th>
                  <th>退款</th>
                  <th>状态</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.serviceId}>
                    <td data-label="服务">
                      <strong>{service.name}</strong>
                      <span className="table-secondary mono-value">{service.serviceId}</span>
                    </td>
                    <td data-label="类型">
                      <span className="type-badge">{typeLabel(service.type)}</span>
                    </td>
                    <td data-label="目录">
                      {service.category}
                      <span className="table-secondary">/{service.unit}</span>
                    </td>
                    <td data-label="单价">
                      <strong>¥ {minorToYuan(service.unitPrice.amountMinor)}</strong>
                      <span className="table-secondary">每 {service.unit}</span>
                    </td>
                    <td data-label="退款">
                      {service.refundPolicy === 'full_on_delivery_failure'
                        ? '交付失败全退'
                        : '不可退款'}
                    </td>
                    <td data-label="状态">
                      <span
                        className={`agent-status ${service.status === 'enabled' ? 'enabled' : 'disabled'}`}
                      >
                        {service.status === 'enabled' ? '已启用' : '已停用'}
                      </span>
                    </td>
                    <td className="row-actions">
                      {service.type === 'api' ? (
                        <button
                          className="icon-command"
                          type="button"
                          title="配置 API 调用"
                          aria-label={`配置 ${service.name} 的 API 调用`}
                          disabled={pending}
                          onClick={() => void openApiEditor(service)}
                        >
                          <Cable size={17} />
                        </button>
                      ) : null}
                      <button
                        className="icon-command"
                        type="button"
                        title="编辑服务"
                        aria-label={`编辑 ${service.name}`}
                        onClick={() => {
                          openEdit(service);
                        }}
                      >
                        <Pencil size={17} />
                      </button>
                      <button
                        className="icon-command"
                        type="button"
                        title={service.status === 'enabled' ? '停用服务' : '启用服务'}
                        aria-label={`${service.status === 'enabled' ? '停用' : '启用'} ${service.name}`}
                        disabled={pending}
                        onClick={() => void toggleService(service)}
                      >
                        <Power size={17} />
                      </button>
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
            aria-labelledby="service-editor-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow">固定价格</p>
                <h2 id="service-editor-title">{editor === 'create' ? '新增服务' : '编辑服务'}</h2>
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
            <form className="modal-form" onSubmit={(event) => void saveService(event)}>
              <label>类型</label>
              <div className="segmented-control">
                {(['api', 'mcp', 'skill'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    disabled={editor !== 'create'}
                    className={form.type === type ? 'selected' : ''}
                    onClick={() => {
                      setForm((current) => ({ ...current, type }));
                    }}
                  >
                    {typeLabel(type)}
                  </button>
                ))}
              </div>
              <label htmlFor="service-name">名称</label>
              <input
                id="service-name"
                value={form.name}
                required
                maxLength={200}
                onChange={(event) => {
                  setForm((current) => ({ ...current, name: event.target.value }));
                }}
              />
              <div className="form-grid">
                <div>
                  <label htmlFor="service-category">目录</label>
                  <input
                    id="service-category"
                    value={form.category}
                    required
                    pattern="[a-z][a-z0-9._-]{0,63}"
                    onChange={(event) => {
                      setForm((current) => ({ ...current, category: event.target.value }));
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="service-unit">计费单位</label>
                  <input
                    id="service-unit"
                    value={form.unit}
                    required
                    pattern="[a-z][a-z0-9._-]{0,63}"
                    onChange={(event) => {
                      setForm((current) => ({ ...current, unit: event.target.value }));
                    }}
                  />
                </div>
              </div>
              <div className="form-grid">
                <div>
                  <label htmlFor="service-price">单价（元）</label>
                  <input
                    id="service-price"
                    value={yuanPrice}
                    inputMode="decimal"
                    required
                    onChange={(event) => {
                      setYuanPrice(event.target.value);
                    }}
                  />
                </div>
                <div>
                  <label htmlFor="refund-policy">退款规则</label>
                  <select
                    id="refund-policy"
                    value={form.refundPolicy}
                    onChange={(event) => {
                      setForm((current) => ({
                        ...current,
                        refundPolicy: event.target.value as ServiceInput['refundPolicy'],
                      }));
                    }}
                  >
                    <option value="full_on_delivery_failure">交付失败全退</option>
                    <option value="non_refundable">不可退款</option>
                  </select>
                </div>
              </div>
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
                <button className="primary-command compact" type="submit" disabled={pending}>
                  保存服务
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {apiEditor === null ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="api-editor-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow">商户 API</p>
                <h2 id="api-editor-title">{apiEditor.name}</h2>
              </div>
              <button
                className="icon-command"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setApiEditor(null);
                }}
              >
                <X size={19} />
              </button>
            </header>
            <form className="modal-form" onSubmit={(event) => void saveApiRegistration(event)}>
              <label htmlFor="api-endpoint">调用地址</label>
              <input
                id="api-endpoint"
                type="url"
                value={apiForm.endpointUrl}
                required
                onChange={(event) => {
                  setApiForm((current) => ({ ...current, endpointUrl: event.target.value }));
                }}
              />
              <label htmlFor="api-description">能力描述</label>
              <textarea
                id="api-description"
                value={apiForm.description}
                required
                maxLength={1000}
                onChange={(event) => {
                  setApiForm((current) => ({ ...current, description: event.target.value }));
                }}
              />
              <label htmlFor="api-capabilities">能力标签</label>
              <input
                id="api-capabilities"
                value={apiForm.capabilities}
                required
                onChange={(event) => {
                  setApiForm((current) => ({ ...current, capabilities: event.target.value }));
                }}
              />
              <label htmlFor="api-input-schema">参数规范</label>
              <textarea
                id="api-input-schema"
                className="mono-value api-schema-input"
                value={apiForm.inputSchema}
                required
                spellCheck={false}
                onChange={(event) => {
                  setApiForm((current) => ({ ...current, inputSchema: event.target.value }));
                }}
              />
              <div className="form-grid">
                <div>
                  <label htmlFor="api-timeout">超时（毫秒）</label>
                  <input
                    id="api-timeout"
                    type="number"
                    min={1000}
                    max={30000}
                    step={1000}
                    value={apiForm.timeoutMs}
                    required
                    onChange={(event) => {
                      setApiForm((current) => ({ ...current, timeoutMs: event.target.value }));
                    }}
                  />
                </div>
                <label className="checkbox-line" htmlFor="api-enabled">
                  <input
                    id="api-enabled"
                    type="checkbox"
                    checked={apiForm.enabled}
                    onChange={(event) => {
                      setApiForm((current) => ({ ...current, enabled: event.target.checked }));
                    }}
                  />
                  参与 Agent 筛选
                </label>
              </div>
              <div className="modal-actions">
                <button
                  className="secondary-command"
                  type="button"
                  onClick={() => {
                    setApiEditor(null);
                  }}
                >
                  取消
                </button>
                <button className="primary-command compact" type="submit" disabled={pending}>
                  保存 API
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {merchantEditor ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal compact-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="merchant-editor-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow">收款主体</p>
                <h2 id="merchant-editor-title">新增商户</h2>
              </div>
              <button
                className="icon-command"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setMerchantEditor(false);
                }}
              >
                <X size={19} />
              </button>
            </header>
            <form className="modal-form" onSubmit={(event) => void createMerchant(event)}>
              <label htmlFor="merchant-name">名称</label>
              <input
                id="merchant-name"
                value={merchantName}
                required
                onChange={(event) => {
                  setMerchantName(event.target.value);
                }}
              />
              <label htmlFor="callback-url">Webhook 地址</label>
              <input
                id="callback-url"
                type="url"
                value={callbackUrl}
                required
                onChange={(event) => {
                  setCallbackUrl(event.target.value);
                }}
              />
              <div className="modal-actions">
                <button
                  className="secondary-command"
                  type="button"
                  onClick={() => {
                    setMerchantEditor(false);
                  }}
                >
                  取消
                </button>
                <button className="primary-command compact" type="submit" disabled={pending}>
                  创建商户
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
