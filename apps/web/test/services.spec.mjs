import { expect, test } from '@playwright/test';
import { URL } from 'node:url';

const developer = {
  developerId: 'dev_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
  email: 'operator@example.com',
  createdAt: '2026-08-29T08:00:00.000Z',
};
const merchant = {
  merchantId: 'mch_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d60',
  name: 'Weather Studio',
  callbackUrl: 'https://weather.example/webhook',
  status: 'active',
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:00.000Z',
};
const initialService = {
  serviceId: 'svc_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d61',
  merchantId: merchant.merchantId,
  type: 'api',
  name: 'Weather API',
  category: 'data.weather',
  unit: 'request',
  unitPrice: { currency: 'CNY', amountMinor: '10' },
  refundPolicy: 'full_on_delivery_failure',
  status: 'enabled',
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:00.000Z',
};

function success(data) {
  return JSON.stringify({ data, meta: { traceId: '3'.repeat(32) } });
}

test('creates, edits and disables a paid service', async ({ page }) => {
  let services = [initialService];
  await page.route('**/v1/auth/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success(developer) }),
  );
  await page.route('**/v1/merchants**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/v1/merchants' && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: success([merchant]),
      });
      return;
    }

    if (url.pathname.endsWith('/services') && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: success(services),
      });
      return;
    }

    if (url.pathname.endsWith('/services') && request.method() === 'POST') {
      const input = request.postDataJSON();
      const created = {
        ...input,
        serviceId: 'svc_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d62',
        merchantId: merchant.merchantId,
        status: 'enabled',
        createdAt: '2026-08-30T02:00:00.000Z',
        updatedAt: '2026-08-30T02:00:00.000Z',
      };
      services = [created, ...services];
      await route.fulfill({ status: 201, contentType: 'application/json', body: success(created) });
      return;
    }

    if (request.method() === 'PATCH') {
      const serviceId = url.pathname.split('/').at(-1);
      const input = request.postDataJSON();
      const current = services.find((service) => service.serviceId === serviceId);
      const updated = { ...current, ...input, updatedAt: '2026-08-30T03:00:00.000Z' };
      services = services.map((service) => (service.serviceId === serviceId ? updated : service));
      await route.fulfill({ status: 200, contentType: 'application/json', body: success(updated) });
      return;
    }

    await route.abort();
  });

  await page.goto('/services');
  await expect(page.getByRole('heading', { name: '服务与定价' })).toBeVisible();
  await expect(page.getByText('Weather API')).toBeVisible();

  await page.getByRole('button', { name: '新增服务' }).click();
  await page.getByRole('button', { name: 'MCP' }).click();
  await page.getByLabel('名称').fill('Weather MCP');
  await page.getByLabel('目录').fill('data.weather');
  await page.getByLabel('计费单位').fill('tool_call');
  await page.getByLabel('单价（元）').fill('0.25');
  await page.getByLabel('退款规则').selectOption('non_refundable');
  await page.getByRole('button', { name: '保存服务' }).click();
  await expect(page.getByText('Weather MCP')).toBeVisible();
  await expect(page.getByText('¥ 0.25')).toBeVisible();

  await page.getByRole('button', { name: '编辑 Weather MCP' }).click();
  await page.getByLabel('单价（元）').fill('0.30');
  await page.getByRole('button', { name: '保存服务' }).click();
  await expect(page.getByText('¥ 0.30')).toBeVisible();

  await page.getByRole('button', { name: '停用 Weather MCP' }).click();
  await expect(page.getByText('已停用')).toBeVisible();
  await page.screenshot({ path: 'test-results/p9-03-services.png', fullPage: true });
});
