'use strict';


type UnknownRecord = Record<string, any>;

type QuotaRow = {
  id: string;
  label: string;
  value: string;
  percent: number | null;
  detail: string;
};

type QuotaAdapter = {
  id: string;
  label: string;
  matches(host: string, provider: string): boolean;
  url(origin: string, host: string): string;
  headers(credential: string): Record<string, string>;
  parse(payload: unknown, host: string): QuotaRow[];
};

const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$', RMB: '¥' };

function hostOf(baseUrl: unknown): string {
  try {
    return new URL(String(baseUrl || '')).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function originOf(baseUrl: unknown): string {
  try {
    return new URL(String(baseUrl || '')).origin;
  } catch (_) {
    return '';
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function money(symbol: string, amount: unknown): string {
  const text = String(amount ?? '').trim();
  return text ? `${symbol}${text}` : '';
}

function percentOf(used: unknown, limit: unknown): number | null {
  const a = Number(used);
  const b = Number(limit);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(a / b * 100)));
}

function resetDetail(resetsAt: unknown, now: number): string {
  const iso = String(resetsAt || '').trim();
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((at - now) / 60000));
  if (minutes < 60) return `${minutes} 分钟后重置`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} 小时后重置`;
  return `${new Date(at).toLocaleDateString()} 重置`;
}

const QUOTA_ADAPTERS: QuotaAdapter[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    matches: (host, provider) => provider === 'deepseek' || host.endsWith('deepseek.com'),
    url: (origin) => `${origin}/user/balance`,
    headers: (credential) => ({
      Authorization: `Bearer ${credential}`,
      Accept: 'application/json',
    }),
    parse: (payload) => {
      const body = asRecord(payload);
      const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
      const rows: QuotaRow[] = [];
      for (const entry of infos) {
        const info = asRecord(entry);
        if (!info) continue;
        const currency = String(info.currency || '').toUpperCase();
        const symbol = CURRENCY_SYMBOL[currency] ?? '';
        const total = money(symbol, info.total_balance);
        if (!total) continue;
        const parts: string[] = [];
        if (String(info.topped_up_balance ?? '').trim()) {
          parts.push(`充值 ${money(symbol, info.topped_up_balance)}`);
        }
        if (String(info.granted_balance ?? '').trim()) {
          parts.push(`赠送 ${money(symbol, info.granted_balance)}`);
        }
        rows.push({
          id: `balance-${currency || rows.length}`,
          label: currency ? `余额 (${currency})` : '余额',
          value: total,
          percent: null,
          detail: parts.join(' · '),
        });
      }
      return rows;
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    matches: (host, provider) => provider === 'openrouter' || host.endsWith('openrouter.ai'),
    url: (origin) => `${origin}/api/v1/key`,
    headers: (credential) => ({ Authorization: `Bearer ${credential}` }),
    parse: (payload) => {
      const data = asRecord(asRecord(payload)?.data);
      if (!data) return [];
      const rows: QuotaRow[] = [];
      const limit = Number(data.limit);
      const used = Number(data.usage);
      if (Number.isFinite(limit) && limit > 0) {
        const remaining = Number.isFinite(Number(data.limit_remaining))
          ? Number(data.limit_remaining)
          : limit - (Number.isFinite(used) ? used : 0);
        rows.push({
          id: 'credit',
          label: '额度',
          value: `$${remaining.toFixed(2)} / $${limit.toFixed(2)}`,
          percent: percentOf(used, limit),
          detail: '',
        });
      } else if (Number.isFinite(used)) {
        rows.push({
          id: 'credit',
          label: '已用',
          value: `$${used.toFixed(2)}`,
          percent: null,
          detail: data.is_free_tier === true ? '免费额度' : '无上限',
        });
      }
      for (const [key, label] of [['usage_weekly', '本周'], ['usage_monthly', '本月']] as const) {
        const amount = Number(data[key]);
        if (!Number.isFinite(amount)) continue;
        rows.push({ id: key, label, value: `$${amount.toFixed(2)}`, percent: null, detail: '' });
      }
      return rows;
    },
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    matches: (host, provider) => (
      provider === 'moonshot' || provider === 'kimi'
      || host.endsWith('moonshot.cn') || host.endsWith('moonshot.ai') || host.endsWith('kimi.com')
    ),
    url: (origin) => `${origin}/v1/users/me/balance`,
    headers: (credential) => ({ Authorization: `Bearer ${credential}` }),
    parse: (payload, host) => {
      const data = asRecord(asRecord(payload)?.data);
      if (!data) return [];
      const symbol = host.endsWith('moonshot.ai') || host.endsWith('kimi.ai') ? '$' : '¥';
      const available = Number(data.available_balance);
      if (!Number.isFinite(available)) return [];
      const parts: string[] = [];
      const cash = Number(data.cash_balance);
      const voucher = Number(data.voucher_balance);
      if (Number.isFinite(cash)) parts.push(`现金 ${symbol}${cash.toFixed(2)}`);
      if (Number.isFinite(voucher)) parts.push(`代金券 ${symbol}${voucher.toFixed(2)}`);
      return [{
        id: 'balance',
        label: '余额',
        value: `${symbol}${available.toFixed(2)}`,
        percent: null,
        detail: parts.join(' · '),
      }];
    },
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    matches: (host, provider) => provider === 'opencode' || host.endsWith('opencode.ai'),
    url: (origin) => `${origin}/zen/go/v1/usage`,
    headers: (credential) => ({ Authorization: `Bearer ${credential}` }),
    parse: (payload, _host) => {
      const usage = asRecord(asRecord(payload)?.usage);
      if (!usage) return [];
      const windows: Array<[string, string]> = [
        ['rolling', '5 小时'],
        ['weekly', '本周'],
        ['monthly', '本月'],
      ];
      const rows: QuotaRow[] = [];
      for (const [key, label] of windows) {
        const window = asRecord(usage[key]);
        if (!window) continue;
        const percent = Number(window.percent);
        if (!Number.isFinite(percent)) continue;
        rows.push({
          id: key,
          label,
          value: `${Math.max(0, Math.min(100, Math.round(percent)))}%`,
          percent: Math.max(0, Math.min(100, Math.round(percent))),
          detail: resetDetail(window.resetsAt, Date.now()),
        });
      }
      return rows;
    },
  },
];

function quotaAdapterFor(profile: UnknownRecord | null): QuotaAdapter | null {
  if (!profile) return null;
  const host = hostOf(profile.baseUrl);
  const provider = String(profile.provider || '').trim().toLowerCase();
  if (String(profile.apiMode || '') === 'local') return null;
  return QUOTA_ADAPTERS.find((adapter) => adapter.matches(host, provider)) || null;
}

type ProbeInput = {
  provider?: unknown;
  baseUrl?: unknown;
  apiMode?: unknown;
  credential?: unknown;
  fetchImpl?: typeof fetch;
  now?: number;
};

async function probeQuota(input: ProbeInput): Promise<UnknownRecord> {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const adapter = quotaAdapterFor({
    provider: input.provider,
    baseUrl: input.baseUrl,
    apiMode: input.apiMode,
  });
  if (!adapter) return { adapter: null, label: '', rows: [], error: '', source: '', fetchedAt: now };
  const credential = String(input.credential ?? '');
  const origin = originOf(input.baseUrl);
  const url = origin ? adapter.url(origin, hostOf(input.baseUrl)) : '';
  if (!url) {
    return { adapter: adapter.id, label: adapter.label, rows: [], error: 'base URL 不可用，读不到配额', source: '', fetchedAt: now };
  }
  if (!credential) {
    return { adapter: adapter.id, label: adapter.label, rows: [], error: '这个配置没有可用的密钥，读不到配额', source: url, fetchedAt: now };
  }
  const doFetch = input.fetchImpl || fetch;
  try {
    const response = await doFetch(url, { method: 'GET', headers: adapter.headers(credential) });
    if (!response || response.ok !== true) {
      const status = response ? `${response.status}` : '无响应';
      return { adapter: adapter.id, label: adapter.label, rows: [], error: `配额接口返回 ${status}`, source: url, fetchedAt: now };
    }
    const payload = await response.json();
    const rows = adapter.parse(payload, hostOf(input.baseUrl));
    return {
      adapter: adapter.id,
      label: adapter.label,
      rows,
      error: rows.length ? '' : '配额接口没有返回可读的数字',
      source: url,
      fetchedAt: now,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { adapter: adapter.id, label: adapter.label, rows: [], error: `配额读取失败：${message}`, source: url, fetchedAt: now };
  }
}

module.exports = {
  QUOTA_ADAPTERS,
  hostOf,
  originOf,
  probeQuota,
  quotaAdapterFor,
};
