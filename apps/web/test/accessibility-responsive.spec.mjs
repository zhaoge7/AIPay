/* global document, getComputedStyle */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { URL } from 'node:url';

const ids = {
  developer: 'dev_01890f3e-9b44-7cc2-98c5-7f6a1b2c3db0',
  agent: 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3db1',
  key: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3db2',
  merchant: 'mch_01890f3e-9b44-7cc2-98c5-7f6a1b2c3db3',
  service: 'svc_01890f3e-9b44-7cc2-98c5-7f6a1b2c3db4',
  mandate: 'mdt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3db5',
  transaction: 'txn_01890f3e-9b44-7cc2-98c5-7f6a1b2c3db6',
};
const session = {
  developerId: ids.developer,
  email: 'operator@example.com',
  createdAt: '2026-08-30T00:00:00.000Z',
};
const agent = {
  agentId: ids.agent,
  name: 'Buyer Agent',
  status: 'enabled',
  signingKey: { keyId: ids.key, algorithm: 'ed25519', publicKey: 'A'.repeat(43), status: 'active' },
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
  quoteId: 'qte_01890f3e-9b44-7cc2-98c5-7f6a1b2c3db7',
  agentId: ids.agent,
  agentName: agent.name,
  merchantId: ids.merchant,
  merchantName: merchant.name,
  serviceId: ids.service,
  serviceName: service.name,
  amount: { currency: 'CNY', amountMinor: '10' },
  status: 'delivered',
  createdAt: session.createdAt,
  updatedAt: session.createdAt,
};

function success(data) {
  return JSON.stringify({ data, meta: { traceId: '8'.repeat(32) } });
}

async function mockConsole(page) {
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    let data;

    if (url.pathname === '/v1/auth/session') data = session;
    else if (url.pathname === '/v1/agents') data = [agent];
    else if (url.pathname === '/v1/merchants') data = [merchant];
    else if (url.pathname.endsWith('/services')) data = [service];
    else if (url.pathname === '/v1/mandates') data = [mandate];
    else if (url.pathname === '/v1/transactions/confirmations')
      data = [
        {
          ...transaction,
          quoteId: transaction.quoteId,
          agentName: agent.name,
          merchantName: merchant.name,
          serviceName: service.name,
          mandatePurpose: mandate.purpose,
          totalBudget: mandate.totalBudget,
          spentAmount: mandate.spentAmount,
          reservedAmount: mandate.reservedAmount,
          remainingBudget: mandate.totalBudget,
          status: 'requires_confirmation',
        },
      ];
    else if (url.pathname === '/v1/transactions') data = [transaction];
    else if (url.pathname === '/v1/payment-controls')
      data = { paymentsPaused: false, updatedAt: null };
    else data = {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: success(data) });
  });
}

const pages = [
  ['/', '支付运行概览'],
  ['/agents', 'Agent 管理'],
  ['/services', '服务与定价'],
  ['/mandates', '授权管理'],
  ['/confirmations', '待确认交易'],
  ['/transactions', '交易与时间线'],
  ['/controls', '安全控制'],
];

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} pages have no serious accessibility or layout defects`, async ({
    page,
  }) => {
    await mockConsole(page);
    await page.setViewportSize(viewport);

    for (const [path, heading] of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      const overlaps = await page
        .locator('button, a, input, select, textarea')
        .evaluateAll((elements) => {
          const visible = elements.filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              rect.width > 0 &&
              rect.height > 0
            );
          });
          const collisions = [];

          for (let left = 0; left < visible.length; left += 1) {
            for (let right = left + 1; right < visible.length; right += 1) {
              const a = visible[left].getBoundingClientRect();
              const b = visible[right].getBoundingClientRect();
              const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);

              if (width > 1 && height > 1)
                collisions.push([visible[left].tagName, visible[right].tagName]);
            }
          }

          return collisions;
        });
      expect(overlaps).toEqual([]);
      const accessibility = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      if (viewport.name === 'mobile' && path === '/transactions') {
        await page.screenshot({
          path: 'test-results/p9-08-mobile-transactions.png',
          fullPage: true,
        });
      }
    }
  });
}

test('core Agent workflow is operable from the keyboard', async ({ page }) => {
  await mockConsole(page);
  await page.goto('/agents');
  const createButton = page.getByRole('button', { name: '新增 Agent' });
  await createButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '新增 Agent' })).toBeVisible();
  await page.getByLabel('名称').focus();
  await page.keyboard.type('Keyboard Agent');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Ed25519 公钥')).toBeFocused();
  await page.getByRole('button', { name: '关闭' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '新增 Agent' })).toHaveCount(0);
});
