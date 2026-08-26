# AIPay

AIPay 是面向 AI Agent 的支付编排与信任层。本仓库当前处于工程骨架阶段，已包含 monorepo、严格类型检查、运行配置校验、测试和基础 CI；HTTP API、管理端页面和后台任务循环将在后续阶段实现。

## 环境要求

- Git
- Node.js 24 LTS（仓库通过 `.nvmrc` 固定主版本）
- Corepack
- pnpm 11（精确版本由根目录 `package.json` 固定）

数据库任务需要 Docker Engine；仓库脚本不依赖 Docker Compose 或本机 `psql`。

## 从新环境启动

以下命令假设已安装 NVM，且 GitHub SSH 访问已经配置：

```bash
git clone git@github.com:zhaoge7/AIPay.git
cd AIPay
nvm install
nvm use
corepack enable pnpm
pnpm install --frozen-lockfile
cp .env.example .env
```

先执行完整检查，确认本地工具链和依赖正常：

```bash
pnpm run check
pnpm run test
```

启动固定版本的本地 PostgreSQL 并应用迁移：

```bash
pnpm run db:up
pnpm run db:migrate
```

`db:reset` 只允许重建回环地址上以 `_dev` 或 `_test` 结尾的数据库。停止容器会保留开发数据卷：

```bash
pnpm run db:reset
pnpm run db:down
```

构建全部 workspace，然后启动 API：

```bash
pnpm run build
node --env-file=.env apps/api/dist/index.js
```

API 默认监听 `.env` 中的地址，并提供开发者注册和登录：

```bash
curl -i http://127.0.0.1:3000/v1/auth/register \
  -H 'content-type: application/json' \
  --data '{"email":"developer@example.com","password":"replace-with-a-long-local-password"}'

curl -i http://127.0.0.1:3000/v1/auth/login \
  -H 'content-type: application/json' \
  --data '{"email":"developer@example.com","password":"replace-with-a-long-local-password"}'
```

成功响应通过 `Set-Cookie` 返回 HttpOnly、SameSite=Lax 会话 Cookie。生产环境自动增加 Secure；数据库只保存 Argon2id 密码哈希和会话 Token 的 SHA-256 摘要。Worker 当前入口仍只校验配置，管理端尚无开发服务器。

登录后可通过会话 Cookie 管理 API Key：

| 方法     | 路径                            | 用途                                  |
| -------- | ------------------------------- | ------------------------------------- |
| `POST`   | `/v1/api-keys`                  | 创建 Key；完整 Token 只在本次响应显示 |
| `GET`    | `/v1/api-keys`                  | 列出脱敏 Key 元数据                   |
| `POST`   | `/v1/api-keys/:apiKeyId/rotate` | 原子吊销旧 Key 并创建替代 Key         |
| `DELETE` | `/v1/api-keys/:apiKeyId`        | 幂等吊销 Key                          |

API Key 默认 90 天到期，可在创建或轮换请求中通过 `expiresInDays` 设置 1 至 365 天。数据库只保存完整 Token 的 SHA-256 摘要。

Agent 密钥对必须由 Agent 客户端生成，AIPay 只接收规范 base64url 编码的 32 字节 Ed25519 公钥：

| 方法    | 路径                         | 用途                       |
| ------- | ---------------------------- | -------------------------- |
| `POST`  | `/v1/agents`                 | 注册 Agent 名称和签名公钥  |
| `GET`   | `/v1/agents`                 | 列出当前开发者的 Agent     |
| `PATCH` | `/v1/agents/:agentId/status` | 在 enabled/disabled 间切换 |

Agent 私钥不得发送给 AIPay，也不得写入项目 `.env`、日志或数据库。

## 环境变量

本地开发从 `.env.example` 创建 `.env`。`.env` 已被 Git 忽略，不要在其中提交真实密钥、Token 或用户数据。

| 变量                       | 用途                                               | 当前示例      |
| -------------------------- | -------------------------------------------------- | ------------- |
| `NODE_ENV`                 | 运行环境，可选 `development`、`test`、`production` | `development` |
| `AIPAY_API_HOST`           | API 绑定地址                                       | `127.0.0.1`   |
| `AIPAY_API_PORT`           | API 监听端口                                       | `3000`        |
| `AIPAY_WORKER_CONCURRENCY` | Worker 最大并发数，必须为正整数                    | `1`           |
| `AIPAY_DATABASE_URL`       | PostgreSQL 连接 URL                                | 本地开发 URL  |

配置无效时，程序只报告变量名，不回显变量值。

## 常用命令

| 命令                    | 作用                                   |
| ----------------------- | -------------------------------------- |
| `pnpm run dev`          | 并行运行各 workspace 已定义的开发脚本  |
| `pnpm run build`        | 构建各 workspace 已定义的构建目标      |
| `pnpm run typecheck`    | 对全部 TypeScript 项目执行严格类型检查 |
| `pnpm run lint`         | 执行 ESLint 检查，禁止警告             |
| `pnpm run format:check` | 检查 Prettier 格式                     |
| `pnpm run check`        | 依次执行类型、Lint 和格式检查          |
| `pnpm run test`         | 执行全部 workspace 测试                |
| `pnpm run db:up`        | 启动固定版本的本地 PostgreSQL          |
| `pnpm run db:migrate`   | 应用所有待执行迁移                     |
| `pnpm run db:reset`     | 安全重建开发/测试数据库并重放迁移      |
| `pnpm run db:down`      | 停止数据库容器并保留开发数据卷         |

## 目录结构

```text
apps/
  api/          HTTP API
  web/          管理控制台
  worker/       异步任务处理
packages/
  config/       运行配置加载与校验
  database/     PostgreSQL 访问、迁移与本地生命周期
  contracts/    共享接口契约
  payment/      支付通道抽象
  policy/       确定性授权策略
  sdk-ts/       TypeScript SDK
```

架构和选型记录按仓库策略仅保存在本地开发清单，不上传 `docs/` 目录。

## 常见问题

`pnpm` 不可用时，先确认 `node --version` 为 24.x，再运行 `corepack enable pnpm`。如果使用 NVM，新终端需要先在仓库根目录执行 `nvm use`。

依赖安装必须使用 `pnpm install --frozen-lockfile`。锁文件与依赖声明不一致时应修正并明确更新锁文件，不要在 CI 中关闭冻结检查。

API 或 Worker 抛出 `ConfigurationError` 时，按错误中列出的变量名检查 `.env`；错误不会包含被拒绝的原始值。

## 持续集成

GitHub Actions 会在 push 和 pull request 上使用 Ubuntu 24.04 执行冻结安装、类型检查、Lint、格式检查和测试。工作流只具有仓库内容读取权限，不使用项目密钥。
