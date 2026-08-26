# AIPay

AIPay 是面向 AI Agent 的支付编排与信任层。本仓库当前处于工程骨架阶段，已包含 monorepo、严格类型检查、运行配置校验、测试和基础 CI；HTTP API、管理端页面和后台任务循环将在后续阶段实现。

## 环境要求

- Git
- Node.js 24 LTS（仓库通过 `.nvmrc` 固定主版本）
- Corepack
- pnpm 11（精确版本由根目录 `package.json` 固定）

当前骨架的安装和启动不需要 Docker 或数据库。

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

构建共享配置包，然后分别启动 API 和 Worker 的当前入口：

```bash
pnpm run build
node --env-file=.env apps/api/src/index.ts
node --env-file=.env apps/worker/src/index.ts
```

当前两个入口只负责加载并校验配置。命令无输出并以状态码 `0` 退出即表示启动校验成功；它们暂时不会持续监听端口或处理任务。管理端目前也只有空入口，尚无开发服务器。根命令 `pnpm run dev` 会在后续应用加入 `dev` 脚本后统一并行启动它们。

## 环境变量

本地开发从 `.env.example` 创建 `.env`。`.env` 已被 Git 忽略，不要在其中提交真实密钥、Token 或用户数据。

| 变量                       | 用途                                               | 当前示例      |
| -------------------------- | -------------------------------------------------- | ------------- |
| `NODE_ENV`                 | 运行环境，可选 `development`、`test`、`production` | `development` |
| `AIPAY_API_HOST`           | API 绑定地址                                       | `127.0.0.1`   |
| `AIPAY_API_PORT`           | API 监听端口                                       | `3000`        |
| `AIPAY_WORKER_CONCURRENCY` | Worker 最大并发数，必须为正整数                    | `1`           |

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

## 目录结构

```text
apps/
  api/          HTTP API
  web/          管理控制台
  worker/       异步任务处理
packages/
  config/       运行配置加载与校验
  contracts/    共享接口契约
  payment/      支付通道抽象
  policy/       确定性授权策略
  sdk-ts/       TypeScript SDK
```

## 常见问题

`pnpm` 不可用时，先确认 `node --version` 为 24.x，再运行 `corepack enable pnpm`。如果使用 NVM，新终端需要先在仓库根目录执行 `nvm use`。

依赖安装必须使用 `pnpm install --frozen-lockfile`。锁文件与依赖声明不一致时应修正并明确更新锁文件，不要在 CI 中关闭冻结检查。

API 或 Worker 抛出 `ConfigurationError` 时，按错误中列出的变量名检查 `.env`；错误不会包含被拒绝的原始值。

## 持续集成

GitHub Actions 会在 push 和 pull request 上使用 Ubuntu 24.04 执行冻结安装、类型检查、Lint、格式检查和测试。工作流只具有仓库内容读取权限，不使用项目密钥。
