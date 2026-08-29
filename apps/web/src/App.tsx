import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  Gauge,
  KeyRound,
  LockKeyhole,
  LogOut,
  Menu,
  PackageOpen,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import {
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';

import { AgentsPage } from './AgentsPage.js';
import { ConsoleApiError } from './api.js';
import { useAuth } from './auth.js';
import { ServicesPage } from './ServicesPage.js';

function FullPageStatus() {
  return (
    <main className="page-status" aria-live="polite">
      <div className="loading-mark" aria-hidden="true" />
      <span>正在载入会话</span>
    </main>
  );
}

function LoginPage() {
  const { status, authenticate } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await authenticate(mode, email, password);
      await navigate('/', { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ConsoleApiError && caught.code === 'UNAUTHENTICATED'
          ? '邮箱或密码不正确'
          : '请求未完成，请稍后重试',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-brand" aria-label="AIPay">
        <div className="brand-symbol" aria-hidden="true">
          <ShieldCheck size={28} strokeWidth={2.2} />
        </div>
        <div>
          <p className="brand-name">AIPay</p>
          <p className="brand-subtitle">Agent 支付控制台</p>
        </div>
        <div className="auth-signal-list" aria-label="安全状态">
          <span>
            <CheckCircle2 size={16} />
            确定性授权
          </span>
          <span>
            <CheckCircle2 size={16} />
            预算边界
          </span>
          <span>
            <CheckCircle2 size={16} />
            完整审计
          </span>
        </div>
      </section>

      <section className="auth-form-wrap">
        <form
          className="auth-form"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <div className="auth-heading">
            <LockKeyhole size={22} aria-hidden="true" />
            <div>
              <h1>{mode === 'login' ? '登录控制台' : '创建开发者账户'}</h1>
              <p>{mode === 'login' ? '使用本地开发者账户继续' : '建立独立的开发者工作区'}</p>
            </div>
          </div>

          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            required
          />
          <label htmlFor="password">密码</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            minLength={12}
            required
          />

          {error === null ? null : (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <button className="primary-command" type="submit" disabled={submitting}>
            <span>{submitting ? '处理中' : mode === 'login' ? '登录' : '创建账户'}</span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>
          <button
            className="text-command"
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? '创建开发者账户' : '返回登录'}
          </button>
        </form>
      </section>
    </main>
  );
}

function Overview() {
  const { developer } = useAuth();

  if (developer === null) {
    return null;
  }

  return (
    <div className="overview-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">工作区</p>
          <h1>支付运行概览</h1>
        </div>
        <span className="status-badge">
          <CheckCircle2 size={15} />
          会话有效
        </span>
      </header>

      <section className="metric-grid" aria-label="运行状态">
        <article className="metric-card">
          <div className="metric-icon teal">
            <KeyRound size={19} />
          </div>
          <p>身份边界</p>
          <strong>已认证</strong>
          <span>HttpOnly 会话</span>
        </article>
        <article className="metric-card">
          <div className="metric-icon green">
            <ShieldCheck size={19} />
          </div>
          <p>策略引擎</p>
          <strong>确定性</strong>
          <span>支付前强制校验</span>
        </article>
        <article className="metric-card">
          <div className="metric-icon coral">
            <Activity size={19} />
          </div>
          <p>审计链路</p>
          <strong>可追踪</strong>
          <span>交易全生命周期</span>
        </article>
      </section>

      <section className="account-band">
        <div className="section-title">
          <UserRound size={18} />
          <h2>当前开发者</h2>
        </div>
        <dl className="account-details">
          <div>
            <dt>邮箱</dt>
            <dd>{developer.email}</dd>
          </div>
          <div>
            <dt>开发者 ID</dt>
            <dd className="mono-value">{developer.developerId}</dd>
          </div>
          <div>
            <dt>加入时间</dt>
            <dd>{new Date(developer.createdAt).toLocaleString('zh-CN')}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function ConsoleShell() {
  const { status, developer, logout } = useAuth();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  if (status === 'loading') {
    return <FullPageStatus />;
  }

  if (status === 'anonymous' || developer === null) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  async function performLogout() {
    setLoggingOut(true);

    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="console-shell">
      <aside className={navigationOpen ? 'side-nav open' : 'side-nav'}>
        <div className="nav-brand">
          <span className="nav-symbol">
            <ShieldCheck size={21} />
          </span>
          <span>AIPay</span>
          <button
            className="icon-command close-nav"
            type="button"
            title="关闭导航"
            aria-label="关闭导航"
            onClick={() => {
              setNavigationOpen(false);
            }}
          >
            <X size={19} />
          </button>
        </div>
        <nav aria-label="主导航">
          <NavLink
            className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
            to="/"
            end
          >
            <Gauge size={18} />
            概览
          </NavLink>
          <NavLink
            className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
            to="/agents"
          >
            <Bot size={18} />
            Agent
          </NavLink>
          <NavLink
            className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
            to="/services"
          >
            <PackageOpen size={18} />
            服务与定价
          </NavLink>
        </nav>
        <div className="nav-footer">
          <p>{developer.email}</p>
          <button
            className="nav-logout"
            type="button"
            disabled={loggingOut}
            onClick={() => {
              void performLogout();
            }}
          >
            <LogOut size={17} />
            {loggingOut ? '正在退出' : '退出登录'}
          </button>
        </div>
      </aside>
      {navigationOpen ? (
        <button
          className="nav-scrim"
          type="button"
          aria-label="关闭导航"
          onClick={() => {
            setNavigationOpen(false);
          }}
        />
      ) : null}
      <div className="console-main">
        <header className="topbar">
          <button
            className="icon-command menu-command"
            type="button"
            title="打开导航"
            aria-label="打开导航"
            onClick={() => {
              setNavigationOpen(true);
            }}
          >
            <Menu size={20} />
          </button>
          <span className="topbar-title">
            {location.pathname === '/agents'
              ? 'Agent 管理'
              : location.pathname === '/services'
                ? '服务与定价'
                : '控制台'}
          </span>
          <span className="environment-label">本地环境</span>
        </header>
        <main className="content-area">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ConsoleShell />}>
        <Route path="/" element={<Overview />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/services" element={<ServicesPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
