/* global document */

import { expect, test } from '@playwright/test';

const developer = {
  developerId: 'dev_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
  email: 'operator@example.com',
  createdAt: '2026-08-29T08:00:00.000Z',
};

function success(data) {
  return JSON.stringify({ data, meta: { traceId: '1'.repeat(32) } });
}

test('logs in and renders the authenticated console shell', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) =>
    route.fulfill({ status: 401, contentType: 'application/problem+json', body: '{}' }),
  );
  await page.route('**/v1/auth/login', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success(developer) }),
  );
  await page.route('**/v1/auth/logout', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: success({ loggedOut: true }),
    }),
  );
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
  await page.getByLabel('邮箱').fill('operator@example.com');
  await page.getByLabel('密码').fill('Correct horse battery staple 2026!');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '支付运行概览' })).toBeVisible();
  await expect(page.getByRole('main').getByText('operator@example.com')).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '登录控制台' })).toBeVisible();
});

test('keeps the desktop dashboard stable without horizontal overflow', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success(developer) }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.locator('.metric-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  await page.screenshot({ path: 'test-results/p9-01-desktop.png', fullPage: true });
});

test('uses an accessible mobile navigation drawer', async ({ page }) => {
  await page.route('**/v1/auth/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success(developer) }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.locator('.side-nav')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(page.getByRole('button', { name: '关闭导航' }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/p9-01-mobile.png' });
});
