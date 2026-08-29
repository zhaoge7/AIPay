import { expect, test } from '@playwright/test';
import { URL } from 'node:url';

const developer = {
  developerId: 'dev_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
  email: 'operator@example.com',
  createdAt: '2026-08-29T08:00:00.000Z',
};
const agent = {
  agentId: 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d70',
  name: 'Buyer Agent',
  status: 'enabled',
  signingKey: {
    keyId: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d71',
    algorithm: 'ed25519',
    publicKey: 'A'.repeat(43),
    status: 'active',
  },
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:00.000Z',
};
const merchant = {
  merchantId: 'mch_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d72',
  name: 'Weather Studio',
  callbackUrl: 'https://weather.example/webhook',
  status: 'active',
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:00.000Z',
};

function mandate(overrides = {}) {
  return {
    mandateId: 'mdt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d73',
    principalId: developer.developerId,
    agentId: agent.agentId,
    purpose: '购买天气数据',
    allowedMerchantIds: [merchant.merchantId],
    allowedCategories: ['data.weather'],
    maxPerTransaction: { currency: 'CNY', amountMinor: '100' },
    totalBudget: { currency: 'CNY', amountMinor: '1000' },
    approvalRequiredAbove: { currency: 'CNY', amountMinor: '100' },
    maxTransactions: 10,
    issuedAt: '2026-08-30T01:00:00.000Z',
    validUntil: '2026-08-31T01:00:00.000Z',
    instructionHash: `sha256:${'a'.repeat(64)}`,
    status: 'active',
    createdAt: '2026-08-30T01:00:00.000Z',
    spentAmount: { currency: 'CNY', amountMinor: '200' },
    reservedAmount: { currency: 'CNY', amountMinor: '100' },
    completedTransactionCount: 2,
    reservedTransactionCount: 1,
    statusChangedAt: '2026-08-30T01:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

function success(data) {
  return JSON.stringify({ data, meta: { traceId: '4'.repeat(32) } });
}

test('creates, signs and displays deterministic Mandate boundaries', async ({ page }) => {
  let mandates = [mandate()];
  await page.route('**/v1/auth/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success(developer) }),
  );
  await page.route('**/v1/agents', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success([agent]) }),
  );
  await page.route('**/v1/merchants', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success([merchant]) }),
  );
  await page.route('**/v1/mandates**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/v1/mandates' && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: success(mandates),
      });
      return;
    }

    if (url.pathname === '/v1/mandates' && request.method() === 'POST') {
      const input = request.postDataJSON();
      const draft = mandate({
        ...input,
        mandateId: 'mdt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d74',
        purpose: input.purpose,
        status: 'draft',
        spentAmount: { currency: 'CNY', amountMinor: '0' },
        reservedAmount: { currency: 'CNY', amountMinor: '0' },
        completedTransactionCount: 0,
        reservedTransactionCount: 0,
      });
      mandates = [draft, ...mandates];
      await route.fulfill({ status: 201, contentType: 'application/json', body: success(draft) });
      return;
    }

    const mandateId = url.pathname.split('/')[3];
    const current = mandates.find((item) => item.mandateId === mandateId);

    if (url.pathname.endsWith('/issue')) {
      mandates = mandates.map((item) =>
        item.mandateId === mandateId ? { ...item, status: 'active' } : item,
      );
      await route.fulfill({ status: 200, contentType: 'application/json', body: success(current) });
      return;
    }

    if (request.method() === 'GET') {
      const active = mandates.find((item) => item.mandateId === mandateId);
      await route.fulfill({ status: 200, contentType: 'application/json', body: success(active) });
      return;
    }

    await route.abort();
  });

  await page.goto('/mandates');
  await expect(page.getByRole('heading', { name: '授权管理' })).toBeVisible();
  await page.getByRole('button', { name: '创建授权' }).click();
  await page.getByLabel('用途').fill('购买研究资料');
  await page.getByLabel('允许品类').fill('data.research');
  await page.getByRole('button', { name: '创建并签发' }).click();
  await expect(page.getByRole('heading', { name: '购买研究资料' })).toBeVisible();
  await expect(page.getByText('单笔上限')).toBeVisible();
  await expect(page.getByText('确认阈值')).toBeVisible();
  await expect(page.getByText('data.research')).toBeVisible();
  await page.screenshot({ path: 'test-results/p9-04-mandate-detail.png', fullPage: true });
});
