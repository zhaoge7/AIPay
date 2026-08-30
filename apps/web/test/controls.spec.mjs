import { expect, test } from '@playwright/test';
import { URL } from 'node:url';

const developer = {
  developerId: 'dev_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
  email: 'operator@example.com',
  createdAt: '2026-08-29T08:00:00.000Z',
};
const mandate = {
  mandateId: 'mdt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3da0',
  principalId: developer.developerId,
  agentId: 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3da1',
  purpose: '生产资料采购',
  allowedMerchantIds: [],
  allowedCategories: [],
  maxPerTransaction: { currency: 'CNY', amountMinor: '100' },
  totalBudget: { currency: 'CNY', amountMinor: '1000' },
  approvalRequiredAbove: { currency: 'CNY', amountMinor: '100' },
  maxTransactions: 10,
  issuedAt: '2026-08-30T01:00:00.000Z',
  validUntil: '2026-08-31T01:00:00.000Z',
  instructionHash: `sha256:${'a'.repeat(64)}`,
  status: 'active',
  createdAt: '2026-08-30T01:00:00.000Z',
  spentAmount: { currency: 'CNY', amountMinor: '0' },
  reservedAmount: { currency: 'CNY', amountMinor: '0' },
  completedTransactionCount: 0,
  reservedTransactionCount: 0,
  statusChangedAt: '2026-08-30T01:00:00.000Z',
  revokedAt: null,
};

function success(data) {
  return JSON.stringify({ data, meta: { traceId: '7'.repeat(32) } });
}

test('globally pauses payments and irreversibly revokes a Mandate', async ({ page }) => {
  let controls = { paymentsPaused: false, updatedAt: null };
  await page.route('**/v1/auth/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success(developer) }),
  );
  await page.route('**/v1/mandates**', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === '/v1/mandates') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: success([mandate]),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: success({ mandateId: mandate.mandateId, status: 'revoked' }),
    });
  });
  await page.route('**/v1/payment-controls', async (route) => {
    if (route.request().method() === 'PATCH') {
      controls = {
        paymentsPaused: route.request().postDataJSON().paymentsPaused,
        updatedAt: '2026-08-30T04:00:00.000Z',
      };
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: success(controls) });
  });

  await page.goto('/controls');
  await expect(page.getByText('正常运行')).toBeVisible();
  await page.getByRole('button', { name: '全局停付' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('新交易、人工批准和实际支付');
  await page.getByRole('button', { name: '确认停付' }).click();
  await expect(page.getByText('已全局暂停')).toBeVisible();

  await page.getByRole('button', { name: '撤销 生产资料采购' }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByText('已撤销')).toBeVisible();
  await page.screenshot({ path: 'test-results/p9-07-controls.png', fullPage: true });
});
