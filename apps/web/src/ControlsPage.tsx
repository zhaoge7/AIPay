import { Ban, CheckCircle2, PauseCircle, PlayCircle, ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { consoleApi, type MandateView, type PaymentControlView } from './api.js';

export function ControlsPage() {
  const [controls, setControls] = useState<PaymentControlView | null>(null);
  const [mandates, setMandates] = useState<readonly MandateView[]>([]);
  const [confirmGlobal, setConfirmGlobal] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<MandateView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([consoleApi.paymentControls(), consoleApi.mandates()])
      .then(([controlView, mandateList]) => {
        setControls(controlView);
        setMandates(mandateList);
      })
      .catch(() => {
        setError('安全控制状态载入失败');
      });
  }, []);

  async function toggleGlobal() {
    if (controls === null) return;
    setPending(true);
    setError(null);

    try {
      setControls(await consoleApi.setPaymentControls(!controls.paymentsPaused));
      setConfirmGlobal(false);
    } catch {
      setError('全局支付状态更新失败');
    } finally {
      setPending(false);
    }
  }

  async function revokeMandate() {
    if (revokeTarget === null) return;
    setPending(true);
    setError(null);

    try {
      await consoleApi.transitionMandate(revokeTarget.mandateId, 'revoke');
      setMandates((current) =>
        current.map((mandate) =>
          mandate.mandateId === revokeTarget.mandateId
            ? { ...mandate, status: 'revoked', revokedAt: new Date().toISOString() }
            : mandate,
        ),
      );
      setRevokeTarget(null);
    } catch {
      setError('授权撤销失败，状态可能已变化');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="resource-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">紧急控制</p>
          <h1>安全控制</h1>
        </div>
      </header>
      {error === null ? null : (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}

      <section
        className={controls?.paymentsPaused === true ? 'global-control paused' : 'global-control'}
      >
        <div className="control-icon">
          {controls?.paymentsPaused === true ? (
            <PauseCircle size={25} />
          ) : (
            <CheckCircle2 size={25} />
          )}
        </div>
        <div>
          <p>Agent 支付</p>
          <h2>
            {controls === null ? '正在载入' : controls.paymentsPaused ? '已全局暂停' : '正常运行'}
          </h2>
          <span>
            {controls?.updatedAt === null || controls?.updatedAt === undefined
              ? '尚未变更'
              : new Date(controls.updatedAt).toLocaleString('zh-CN')}
          </span>
        </div>
        <button
          className={
            controls?.paymentsPaused === true ? 'primary-command compact' : 'danger-command'
          }
          type="button"
          disabled={controls === null}
          onClick={() => {
            setConfirmGlobal(true);
          }}
        >
          {controls?.paymentsPaused === true ? (
            <>
              <PlayCircle size={17} />
              恢复支付
            </>
          ) : (
            <>
              <PauseCircle size={17} />
              全局停付
            </>
          )}
        </button>
      </section>

      <section className="data-section control-mandates" aria-label="授权撤销列表">
        <div className="data-toolbar">
          <span>授权撤销</span>
        </div>
        {mandates.length === 0 ? (
          <div className="empty-state">
            <ShieldAlert size={24} />
            <strong>暂无授权</strong>
          </div>
        ) : (
          <div className="control-list">
            {mandates.map((mandate) => (
              <article key={mandate.mandateId}>
                <div>
                  <strong>{mandate.purpose}</strong>
                  <span className="mono-value">{mandate.mandateId}</span>
                </div>
                <span className={`mandate-status ${mandate.status}`}>
                  {mandate.status === 'active'
                    ? '生效中'
                    : mandate.status === 'paused'
                      ? '已暂停'
                      : mandate.status === 'revoked'
                        ? '已撤销'
                        : mandate.status === 'expired'
                          ? '已过期'
                          : '草稿'}
                </span>
                <button
                  className="icon-command danger"
                  type="button"
                  title="撤销授权"
                  aria-label={`撤销 ${mandate.purpose}`}
                  disabled={
                    mandate.status === 'revoked' ||
                    mandate.status === 'expired' ||
                    mandate.status === 'draft'
                  }
                  onClick={() => {
                    setRevokeTarget(mandate);
                  }}
                >
                  <Ban size={17} />
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      {confirmGlobal ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal compact-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="global-control-title"
          >
            <header className="modal-header">
              <div>
                <p
                  className={controls?.paymentsPaused === true ? 'eyebrow' : 'eyebrow danger-text'}
                >
                  {controls?.paymentsPaused === true ? '恢复支付' : '紧急停付'}
                </p>
                <h2 id="global-control-title">
                  {controls?.paymentsPaused === true ? '恢复 Agent 支付' : '暂停全部 Agent 支付'}
                </h2>
              </div>
              <button
                className="icon-command"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setConfirmGlobal(false);
                }}
              >
                <X size={19} />
              </button>
            </header>
            <p className="confirm-copy">
              {controls?.paymentsPaused === true
                ? '恢复后，新交易仍需通过各自 Mandate 策略。'
                : '暂停后，新交易、人工批准和实际支付将立即被拒绝。'}
            </p>
            <div className="modal-actions">
              <button
                className="secondary-command"
                type="button"
                onClick={() => {
                  setConfirmGlobal(false);
                }}
              >
                取消
              </button>
              <button
                className={
                  controls?.paymentsPaused === true ? 'primary-command compact' : 'danger-command'
                }
                type="button"
                disabled={pending}
                onClick={() => void toggleGlobal()}
              >
                {controls?.paymentsPaused === true ? '确认恢复' : '确认停付'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {revokeTarget === null ? null : (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal compact-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="control-revoke-title"
          >
            <header className="modal-header">
              <div>
                <p className="eyebrow danger-text">不可逆操作</p>
                <h2 id="control-revoke-title">撤销授权</h2>
              </div>
              <button
                className="icon-command"
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setRevokeTarget(null);
                }}
              >
                <X size={19} />
              </button>
            </header>
            <p className="confirm-copy">{revokeTarget.purpose}</p>
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
                disabled={pending}
                onClick={() => void revokeMandate()}
              >
                <Ban size={16} />
                确认撤销
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
