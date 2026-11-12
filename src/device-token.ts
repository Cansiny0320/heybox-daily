import { createHash } from 'node:crypto';
import { runInContext } from 'node:vm';
import type { DOMWindow, JSDOM } from 'jsdom';
import { observeTokenNetwork } from './device-token-network.js';

const sdkUrl = 'https://static.portal101.cn/dist/web/v3.0.0/fp.min.js';
// Reviewed official SDK. Do not execute an upstream replacement in Node without review.
const sdkSha256 = '654b94891624c759ba1b887b39261d8e894144da5f56a6dc42b5b6e0d66562f9';
const tokenPattern = /^B[A-Za-z0-9+/=_-]{88}$/;
const deviceProfileUrl = 'https://fp-it.portal101.cn/deviceprofile/v4';
const publicConfig = {
  organization: '0yD85BjYvGFAvHaSQ1mc', appId: 'heybox_website',
  publicKey: 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCXj9exmI4nQjmT52iwr+yf7hAQ06bfSZHTAHUfRBYiagCf/whhd8es0R79wBigpiHLd28TKA8b8mGR8OiiI1hV+qfynCWihvp3mdj8MiiH6SU3lhro2hkfYzImZB0RmWr2zE4Xt1+A6Oyp6bf+W7JSxYUXHw3nNv7Td4jw4jEFKQIDAQAB',
  staticHost: 'static.portal101.cn', protocol: 'https', noNeedRetry: true,
};

export interface DeviceTokenDetails {
  sdkCode?: number;
  httpStatus?: number;
  upstreamCode?: number;
  requestDurationMs?: number;
  networkCode?: string;
  networkPhase?: 'dns' | 'tcp' | 'tls' | 'response';
}
export type DeviceTokenTiming = (stage: 'token_sdk_download' | 'token_initialize' | 'token_sdk_execute'
  | 'token_wait' | 'token_upstream' | 'token_dns' | 'token_tcp' | 'token_tls', durationMs: number) => void;
export class DeviceTokenError extends Error {
  readonly stage: string;
  readonly details: DeviceTokenDetails;
  constructor(stage: string, message: string, cause?: unknown, details: DeviceTokenDetails = {}) {
    super(message, { cause });
    this.stage = stage;
    this.details = { ...details };
  }
}
interface DeviceTokenOptions { fetchImpl?: typeof fetch; loadSdk?: () => Promise<string>; timeoutMs?: number;
  connectTimeoutMs?: number; requestTimeoutMs?: number; onTiming?: DeviceTokenTiming }
type SdkWindow = DOMWindow & { _smConf: typeof publicConfig & { onError(code: unknown): void };
  _smReadyFuncs: Array<() => void>; SMSdk: { getDeviceId?: () => unknown } };

async function loadRuntime() {
  const [dom, { FingerprintGenerator }] = await Promise.all([import('jsdom'), import('fingerprint-generator')]);
  return { ...dom, generator: new FingerprintGenerator() };
}
let runtime: ReturnType<typeof loadRuntime> | undefined;
export async function prepareDeviceToken(): Promise<void> {
  // Only dependencies and the generator are warmed. No fingerprint, DOM, SDK or network yet.
  runtime ||= loadRuntime();
  await runtime;
}

async function downloadSdk(fetchImpl: typeof fetch) {
  const response = await fetchImpl(sdkUrl, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new DeviceTokenError('download_sdk', `设备令牌组件下载失败：HTTP ${response.status}`,
    undefined, { httpStatus: response.status });
  const source = await response.text();
  if (createHash('sha256').update(source).digest('hex') !== sdkSha256) {
    throw new DeviceTokenError('sdk_integrity', '官网设备令牌组件已更新，需要更新程序后重试');
  }
  return source;
}

function applyProperties(target: object, values: object, keys: string[]) {
  const record = values as Record<string, unknown>;
  for (const key of keys) if (record[key] !== undefined) {
    Object.defineProperty(target, key, { configurable: true, get: () => record[key] });
  }
}

function observeTokenResponse(window: SdkWindow, record: (details: DeviceTokenDetails) => void,
  timeoutMs: number, timing?: DeviceTokenTiming) {
  const open = window.XMLHttpRequest.prototype.open;
  // Observe the SDK's response without copying its fingerprint payload, headers or token.
  window.XMLHttpRequest.prototype.open = function (method: string, url: string | URL,
    async: boolean = true, username?: string | null, password?: string | null) {
    open.call(this, method, url, async, username, password);
    const target = new URL(String(url), window.location.href);
    if (method.toUpperCase() !== 'POST' || target.origin + target.pathname !== deviceProfileUrl) return;
    const started = performance.now();
    this.timeout = timeoutMs;
    this.addEventListener('timeout', () => record({ networkCode: 'ETIMEDOUT', networkPhase: 'response' }), { once: true });
    const capture = () => {
      if (this.readyState !== 4) return;
      this.removeEventListener('readystatechange', capture);
      const details: DeviceTokenDetails = { httpStatus: this.status,
        requestDurationMs: Math.max(0, Math.round(performance.now() - started)) };
      try {
        const response: unknown = this.response;
        const code = response && typeof response === 'object' && 'code' in response ? response.code : undefined;
        const numeric = typeof code === 'string' && /^\d{1,6}$/.test(code) ? Number(code) : code;
        if (typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 0 && numeric <= 999_999)
          details.upstreamCode = numeric;
      } catch { /* Some XHR failure states do not expose a response. */ }
      record(details);
      timing?.('token_upstream', details.requestDurationMs!);
    };
    this.addEventListener('readystatechange', capture);
  };
}

export async function getDeviceToken(options: DeviceTokenOptions = {}): Promise<string> {
  let dom: JSDOM | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let stage = 'download_sdk';
  let responseDetails: DeviceTokenDetails = {};
  let phaseStarted = performance.now();
  const stageTiming = () => {
    const key = { download_sdk: 'token_sdk_download', initialize: 'token_initialize',
      execute_sdk: 'token_sdk_execute', wait_token: 'token_wait' }[stage] as Parameters<DeviceTokenTiming>[0];
    options.onTiming?.(key, performance.now() - phaseStarted);
    phaseStarted = performance.now();
  };
  const network = observeTokenNetwork(details => Object.assign(responseDetails, details), options.onTiming,
    options.connectTimeoutMs, options.requestTimeoutMs);
  try {
    return await network.run(async () => {
      const source = await (options.loadSdk || (() => downloadSdk(options.fetchImpl || fetch)))();
      stageTiming();
      stage = 'initialize';
      // Lazy imports keep the daily-task image independent of login dependencies.
      await prepareDeviceToken();
      const { JSDOM, ResourceLoader, VirtualConsole, generator } = await runtime!;
      const { fingerprint } = generator.getFingerprint({
        browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['linux'], locales: ['zh-CN', 'zh'],
      });
      dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url: 'https://www.xiaoheihe.cn/', runScripts: 'outside-only',
        resources: new ResourceLoader({ userAgent: fingerprint.navigator.userAgent }), virtualConsole: new VirtualConsole(),
      });
      const window = dom.window as SdkWindow;
      applyProperties(window.navigator, fingerprint.navigator, ['appCodeName', 'appName', 'appVersion', 'userAgent',
        'language', 'languages', 'platform', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'vendor', 'product', 'productSub']);
      applyProperties(window.screen, fingerprint.screen, ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth', 'availTop', 'availLeft']);
      applyProperties(window, fingerprint.screen, ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio']);
      observeTokenResponse(window, details => Object.assign(responseDetails, details), options.requestTimeoutMs ?? 5000, options.onTiming);
      window.SMSdk = {};
      return await new Promise<string>((resolve, reject) => {
        window._smConf = { ...publicConfig, onError: value => {
          const sdkCode = typeof value === 'number' && [-1, -2, -3, -4].includes(value) ? value : undefined;
          const message = sdkCode === -1 ? '设备令牌服务连接失败'
            : sdkCode === -2 ? '设备令牌服务 HTTP 请求失败'
            : sdkCode === -3 ? '设备令牌服务拒绝请求' : '设备令牌 SDK 返回错误';
          reject(new DeviceTokenError(sdkCode && sdkCode !== -4 ? 'request_token' : 'sdk_error', message,
            undefined, { ...responseDetails, sdkCode }));
        } };
        const check = () => {
          try {
            const token = window.SMSdk.getDeviceId?.();
            if (typeof token === 'string' && tokenPattern.test(token)) resolve(token);
          } catch (error) { reject(error); }
        };
        window._smReadyFuncs = [check];
        window.addEventListener('error', event => { event.preventDefault(); reject(new Error(event.message)); });
        timer = setTimeout(() => reject(Object.assign(new Error('等待设备令牌超时'), { code: 'ETIMEDOUT' })), options.timeoutMs ?? 8000);
        poll = setInterval(check, 50);
        stageTiming();
        stage = 'execute_sdk';
        runInContext(source, dom!.getInternalVMContext(), { timeout: 2000, filename: 'heybox-device-sdk.js' });
        stageTiming();
        stage = 'wait_token';
        check();
      });
    });
  } catch (cause) {
    if (cause instanceof DeviceTokenError) throw cause;
    throw new DeviceTokenError(stage, '未能从官网获取设备令牌',
      cause instanceof Error ? cause : new Error(String(cause)), responseDetails);
  } finally {
    stageTiming();
    clearTimeout(timer); clearInterval(poll);
    dom?.window.close();
    network.close();
  }
}
