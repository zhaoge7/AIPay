import { expect, test } from '@playwright/test';
import { URL } from 'node:url';

const developer = {
  developerId: 'dev_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
  email: 'operator@example.com',
  createdAt: '2026-08-29T08:00:00.000Z',
};
const agent = {
  agentId: 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d90',
  name: 'Buyer Agent',
  status: 'enabled',
  signingKey: {
    keyId: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d91',
    algorithm: 'ed25519',
    publicKey: 'A'.repeat(43),
    status: 'active',
  },
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:00.000Z',
};
const merchant = {
  merchantId: 'mch_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d92',
  name: 'Weather Studio',
  callbackUrl: 'https://weather.example/webhook',
  status: 'active',
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:00.000Z',
};
const transaction = {
  transactionId: 'txn_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d93',
  mandateId: 'mdt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d94',
  quoteId: 'qte_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d95',
  agentId: agent.agentId,
  agentName: agent.name,
  merchantId: merchant.merchantId,
  merchantName: merchant.name,
  serviceId: 'svc_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d96',
  serviceName: 'Weather API',
  amount: { currency: 'CNY', amountMinor: '250' },
  status: 'delivered',
  createdAt: '2026-08-30T02:00:00.000Z',
  updatedAt: '2026-08-30T02:05:00.000Z',
};

function success(data) {
  return JSON.stringify({ data, meta: { traceId: '6'.repeat(32) } });
}

test('filters transactions and renders the authoritative timeline', async ({ page }) => {
  let filteredUrl = null;
  await page.route('**/v1/auth/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success(developer) }),
  );
  await page.route('**/v1/agents', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success([agent]) }),
  );
  await page.route('**/v1/merchants', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success([merchant]) }),
  );
  await page.route('**/v1/transactions**', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname.endsWith('/timeline')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: success({
          transaction: {
            transactionId: transaction.transactionId,
            mandateId: transaction.mandateId,
            quoteId: transaction.quoteId,
            agentId: transaction.agentId,
            merchantId: transaction.merchantId,
            serviceId: transaction.serviceId,
            amount: transaction.amount,
            status: transaction.status,
          },
          events: [
            {
              eventId: transaction.mandateId,
              phase: 'authorization',
              eventType: 'authorization.mandate',
              objectType: 'mandate',
              objectId: transaction.mandateId,
              occurredAt: '2026-08-30T01:00:00.000Z',
              completedAt: '2026-08-30T01:00:00.000Z',
              status: 'active',
              provider: null,
              operation: null,
              errorCode: null,
            },
            {
              eventId: 'pcl_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d97',
              phase: 'payment',
              eventType: 'payment.provider_call',
              objectType: 'payment_provider_call',
              objectId: 'pcl_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d97',
              occurredAt: '2026-08-30T02:01:00.000Z',
              completedAt: '2026-08-30T02:01:01.000Z',
              status: 'succeeded',
              provider: 'fake',
              operation: 'payment.create',
              errorCode: null,
            },
            {
              eventId: 'dlv_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d98',
              phase: 'delivery',
              eventType: 'delivery.state',
              objectType: 'delivery',
              objectId: 'dlv_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d98',
              occurredAt: '2026-08-30T02:03:00.000Z',
              completedAt: '2026-08-30T02:04:00.000Z',
              status: 'succeeded',
              provider: null,
              operation: null,
              errorCode: null,
            },
          ],
        }),
      });
      return;
    }

    filteredUrl = url;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: success([transaction]),
    });
  });

  await page.goto('/transactions');
  await expect(page.getByText('Weather API')).toBeVisible();
  await page.getByLabel('交易状态').selectOption('delivered');
  await page.getByLabel('Agent 筛选').selectOption(agent.agentId);
  await page.getByLabel('商户筛选').selectOption(merchant.merchantId);
  await page.getByLabel('开始时间').fill('2026-08-30T00:00');
  await page.getByLabel('结束时间').fill('2026-08-30T23:59');
  await page.getByRole('button', { name: '筛选' }).click();
  await expect.poll(() => filteredUrl?.searchParams.get('status')).toBe('delivered');
  expect(filteredUrl.searchParams.get('agentId')).toBe(agent.agentId);
  expect(filteredUrl.searchParams.get('merchantId')).toBe(merchant.merchantId);

  await page.getByRole('button', { name: `查看 ${transaction.transactionId} 时间线` }).click();
  const timelineDialog = page.getByRole('dialog', { name: '交易时间线' });
  await expect(timelineDialog).toBeVisible();
  await expect(timelineDialog.getByText('授权', { exact: true })).toBeVisible();
  await expect(timelineDialog.getByText('支付', { exact: true })).toBeVisible();
  await expect(timelineDialog.getByText('交付', { exact: true })).toBeVisible();
  await expect(timelineDialog.getByText('payment.create')).toBeVisible();
  await page.screenshot({ path: 'test-results/p9-06-timeline.png', fullPage: true });
});
