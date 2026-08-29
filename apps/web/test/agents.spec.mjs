import { expect, test } from '@playwright/test';
import { URL } from 'node:url';

const developer = {
  developerId: 'dev_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
  email: 'operator@example.com',
  createdAt: '2026-08-29T08:00:00.000Z',
};
const initialAgent = {
  agentId: 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d51',
  name: 'Research Agent',
  status: 'enabled',
  signingKey: {
    keyId: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d52',
    algorithm: 'ed25519',
    publicKey: 'A'.repeat(43),
    status: 'active',
  },
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:00.000Z',
};

function success(data) {
  return JSON.stringify({ data, meta: { traceId: '2'.repeat(32) } });
}

test('pauses, rotates and revokes an Agent from the console', async ({ page }) => {
  let agent = { ...initialAgent, signingKey: { ...initialAgent.signingKey } };
  await page.route('**/v1/auth/session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: success(developer) }),
  );
  await page.route('**/v1/agents**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() === 'GET' && url.pathname === '/v1/agents') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: success([agent]) });
      return;
    }

    if (request.method() === 'PATCH' && url.pathname.endsWith('/status')) {
      agent = { ...agent, status: 'disabled', updatedAt: '2026-08-30T01:00:00.000Z' };
      await route.fulfill({ status: 200, contentType: 'application/json', body: success(agent) });
      return;
    }

    if (request.method() === 'POST' && url.pathname.endsWith('/rotate-key')) {
      const input = request.postDataJSON();
      agent = {
        ...agent,
        signingKey: {
          ...agent.signingKey,
          keyId: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d53',
          publicKey: input.publicKey,
        },
      };
      await route.fulfill({ status: 200, contentType: 'application/json', body: success(agent) });
      return;
    }

    if (request.method() === 'DELETE') {
      agent = {
        ...agent,
        status: 'revoked',
        signingKey: { ...agent.signingKey, status: 'revoked' },
      };
      await route.fulfill({ status: 200, contentType: 'application/json', body: success(agent) });
      return;
    }

    await route.abort();
  });

  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Agent 管理' })).toBeVisible();
  await expect(page.getByText('Research Agent')).toBeVisible();

  await page.getByRole('button', { name: '暂停 Research Agent' }).click();
  await expect(page.getByText('已暂停')).toBeVisible();

  await page.getByRole('button', { name: '轮换 Research Agent 公钥' }).click();
  await page.getByLabel('Ed25519 公钥').fill('B'.repeat(43));
  await page.getByRole('button', { name: '确认轮换' }).click();
  await expect(page.getByText('key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d53')).toBeVisible();

  await page.getByRole('button', { name: '吊销 Research Agent' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: '确认吊销' }).click();
  await expect(page.getByText('已吊销')).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复 Research Agent' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/p9-02-agents.png', fullPage: true });
});
