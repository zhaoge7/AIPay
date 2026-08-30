import { expect, test } from '@playwright/test';
import { URL } from 'node:url';

const ids = {
  developer: 'dev_01890f3e-9b44-7cc2-98c5-7f6a1b2c3dc0',
  agent: 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3dc1',
  merchant: 'mch_01890f3e-9b44-7cc2-98c5-7f6a1b2c3dc2',
  service: 'svc_01890f3e-9b44-7cc2-98c5-7f6a1b2c3dc3',
  mandate: 'mdt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3dc4',
  transaction: 'txn_01890f3e-9b44-7cc2-98c5-7f6a1b2c3dc5',
};

function success(data) {
  return JSON.stringify({ data, meta: { traceId: '9'.repeat(32) } });
}

async function mockConsole(page) {
  const session = {
    developerId: ids.developer,
    email: 'operator@example.com',
    createdAt: '2026-08-30T00:00:00.000Z',
  };
  const agent = {
    agentId: ids.agent,
    name: 'Buyer Agent',
    status: 'enabled',
    signingKey: {
      keyId: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3dc6',
      algorithm: 'ed25519',
      publicKey: 'A'.repeat(43),
      status: 'active',
    },
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  };
  const merchant = {
    merchantId: ids.merchant,
    name: 'Weather Studio',
    callbackUrl: 'https://weather.example/webhook',
    status: 'active',
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  };
  const service = {
    serviceId: ids.service,
    merchantId: ids.merchant,
    type: 'api',
    name: 'Weather API',
    category: 'data.weather',
    unit: 'request',
    unitPrice: { currency: 'CNY', amountMinor: '10' },
    refundPolicy: 'full_on_delivery_failure',
    status: 'enabled',
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  };
  const mandate = {
    mandateId: ids.mandate,
    principalId: ids.developer,
    agentId: ids.agent,
    purpose: '天气数据采购',
    allowedMerchantIds: [ids.merchant],
    allowedCategories: ['data.weather'],
    maxPerTransaction: { currency: 'CNY', amountMinor: '100' },
    totalBudget: { currency: 'CNY', amountMinor: '1000' },
    approvalRequiredAbove: { currency: 'CNY', amountMinor: '100' },
    maxTransactions: 10,
    issuedAt: session.createdAt,
    validUntil: '2026-08-31T00:00:00.000Z',
    instructionHash: `sha256:${'a'.repeat(64)}`,
    status: 'active',
    createdAt: session.createdAt,
    spentAmount: { currency: 'CNY', amountMinor: '0' },
    reservedAmount: { currency: 'CNY', amountMinor: '0' },
    completedTransactionCount: 0,
    reservedTransactionCount: 0,
    statusChangedAt: session.createdAt,
    revokedAt: null,
  };
  const transaction = {
    transactionId: ids.transaction,
    mandateId: ids.mandate,
    quoteId: 'qte_01890f3e-9b44-7cc2-98c5-7f6a1b2c3dc7',
    agentId: ids.agent,
    agentName: agent.name,
    merchantId: ids.merchant,
    merchantName: merchant.name,
    serviceId: ids.service,
    serviceName: service.name,
    amount: { currency: 'CNY', amountMinor: '10' },
    status: 'requires_confirmation',
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  };

  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data;

    if (path === '/v1/auth/session') data = session;
    else if (path === '/v1/agents') data = [agent];
    else if (path === '/v1/merchants') data = [merchant];
    else if (path.endsWith('/services')) data = [service];
    else if (path === '/v1/mandates') data = [mandate];
    else if (path === '/v1/transactions/confirmations')
      data = [
        {
          ...transaction,
          agentName: agent.name,
          merchantName: merchant.name,
          serviceName: service.name,
          mandatePurpose: mandate.purpose,
          totalBudget: mandate.totalBudget,
          spentAmount: mandate.spentAmount,
          reservedAmount: mandate.reservedAmount,
          remainingBudget: mandate.totalBudget,
        },
      ];
    else if (path === '/v1/transactions') data = [transaction];
    else if (path === '/v1/payment-controls') data = { paymentsPaused: false, updatedAt: null };
    else data = {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: success(data) });
  });
}

test('passes Gate P9 through every management workflow without database or CLI access', async ({
  page,
}) => {
  await mockConsole(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '支付运行概览' })).toBeVisible();

  await page.getByRole('link', { name: 'Agent' }).click();
  await expect(page.getByRole('button', { name: '新增 Agent' })).toBeVisible();

  await page.getByRole('link', { name: '服务与定价' }).click();
  await expect(page.getByRole('button', { name: '新增服务' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新增商户' })).toBeVisible();

  await page.getByRole('link', { name: '授权' }).click();
  await expect(page.getByRole('button', { name: '创建授权' })).toBeVisible();

  await page.getByRole('link', { name: '人工确认' }).click();
  await expect(page.getByRole('button', { name: '批准' })).toBeVisible();
  await expect(page.getByRole('button', { name: '拒绝' })).toBeVisible();

  await page.getByRole('link', { name: '交易' }).click();
  await expect(page.getByRole('button', { name: '筛选' })).toBeVisible();
  await expect(page.getByRole('button', { name: /查看 .* 时间线/u })).toBeVisible();

  await page.getByRole('link', { name: '安全控制' }).click();
  await expect(page.getByRole('button', { name: '全局停付' })).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销 天气数据采购' })).toBeVisible();
  await page.screenshot({ path: 'test-results/gate-p9.png', fullPage: true });
});
