import { expect, test } from '@playwright/test';
import { URL } from 'node:url';

const developer = {
  developerId: 'dev_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
  email: 'operator@example.com',
  createdAt: '2026-08-29T08:00:00.000Z',
};

function approval(suffix, amount, serviceName) {
  return {
    transactionId: `txn_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d${suffix}`,
    quoteId: `qte_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d${suffix}`,
    mandateId: 'mdt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d80',
    agentId: 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d81',
    agentName: 'Buyer Agent',
    merchantId: 'mch_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d82',
    merchantName: 'Weather Studio',
    serviceId: 'svc_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d83',
    serviceName,
    mandatePurpose: '研究数据采购',
    amount: { currency: 'CNY', amountMinor: amount },
    totalBudget: { currency: 'CNY', amountMinor: '10000' },
    spentAmount: { currency: 'CNY', amountMinor: '2000' },
    reservedAmount: { currency: 'CNY', amountMinor: '1000' },
    remainingBudget: { currency: 'CNY', amountMinor: '7000' },
    status: 'requires_confirmation',
    createdAt: '2026-08-30T02:00:00.000Z',
    updatedAt: '2026-08-30T02:00:00.000Z',
  };
}

function success(data) {
  return JSON.stringify({ data, meta: { traceId: '5'.repeat(32) } });
}

test('shows complete payment facts before approving or rejecting', async ({ page }) => {
  let items = [approval('84', '2500', 'Research API'), approval('85', '1800', 'Weather MCP')];
  await page.route('**/v1/auth/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success(developer) }),
  );
  await page.route('**/v1/transactions/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/v1/transactions/confirmations') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: success(items) });
      return;
    }

    const transactionId = url.pathname.split('/')[3];
    const input = request.postDataJSON();
    items = items.filter((item) => item.transactionId !== transactionId);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: success({
        transactionId,
        status: input.action === 'approve' ? 'authorized' : 'cancelled',
      }),
    });
  });

  await page.goto('/confirmations');
  await expect(page.getByRole('heading', { name: '待确认交易' })).toBeVisible();
  await expect(page.getByText('Buyer Agent').first()).toBeVisible();
  await expect(page.getByText('Weather Studio').first()).toBeVisible();
  await expect(page.getByText('¥ 70.00').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/p9-05-confirmations.png', fullPage: true });

  await page.getByRole('button', { name: '批准' }).first().click();
  await expect(page.getByRole('alertdialog')).toContainText('¥ 25.00');
  await page.getByRole('button', { name: '确认批准' }).click();
  await expect(page.getByText('Research API')).toHaveCount(0);

  await page.getByRole('button', { name: '拒绝' }).click();
  await page.getByRole('button', { name: '确认拒绝' }).click();
  await expect(page.getByText('暂无待确认交易')).toBeVisible();
});
