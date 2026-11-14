'use strict';

/**
 * Free proxy list fetcher. Tries primary GitHub Raw endpoints and CDN mirrors,
 * honors common Windows/system proxy settings, and reports per-source errors.
 */

const fetch = require('node-fetch');
const dns = require('dns');
const https = require('https');
const { execFileSync } = require('child_process');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { logToFile } = require('./logger');

const SOURCES = {
  http: [
    { name: 'TheSpeedX', urls: [
      'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
      'https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/http.txt',
    ] },
    { name: 'monosans', urls: [
      'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
      'https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies/http.txt',
    ] },
    { name: 'proxifly', urls: [
      'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
      'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt',
    ] },
    { name: 'proxyscrape', urls: [
      'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=http&proxy_format=ipport&format=text',
      'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
    ] },
  ],
  socks4: [
    { name: 'TheSpeedX', urls: [
      'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
      'https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/socks4.txt',
    ] },
    { name: 'monosans', urls: [
      'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
      'https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies/socks4.txt',
    ] },
    { name: 'proxyscrape', urls: [
      'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=socks4&proxy_format=ipport&format=text',
      'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country=all',
    ] },
  ],
  socks5: [
    { name: 'TheSpeedX', urls: [
      'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
      'https://cdn.jsdelivr.net/gh/TheSpeedX/PROXY-List@master/socks5.txt',
    ] },
    { name: 'monosans', urls: [
      'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
      'https://cdn.jsdelivr.net/gh/monosans/proxy-list@main/proxies/socks5.txt',
    ] },
    { name: 'proxifly', urls: [
      'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt',
      'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt',
    ] },
    { name: 'proxyscrape', urls: [
      'https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=socks5&proxy_format=ipport&format=text',
      'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all',
    ] },
  ],
};
SOURCES.https = SOURCES.http;

const FETCH_TIMEOUT = 12000;
const LINE_RE = /^(?:[a-z0-9]+:\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/i;
let cachedProxyAgent;
let proxyAgentResolved = false;

/**
 * Use the operating system resolver (same DNS path as other native apps),
 * but prefer IPv4 when both A and AAAA records exist. This avoids long
 * IPv6 connection stalls on networks where IPv6 DNS works but IPv6 routing
 * does not. It does NOT select a public DNS server or bypass router DNS.
 */
function createIPv4FirstLookup(lookup = dns.lookup) {
  return function lookupIPv4First(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = typeof options === 'number' ? { family: options } : (options || {});
    if (opts.family === 4 || opts.family === 6) {
      return lookup(hostname, options, callback);
    }
    lookup(hostname, {
      all: true,
      verbatim: true,
      hints: opts.hints || 0,
    }, (err, addresses) => {
      if (err) return callback(err);
      const ordered = addresses.slice().sort((a, b) => a.family - b.family);
      if (ordered.length === 0) {
        const empty = new Error('DNS lookup returned no addresses');
        empty.code = 'ENOTFOUND';
        return callback(empty);
      }
      if (opts.all) return callback(null, ordered);
      return callback(null, ordered[0].address, ordered[0].family);
    });
  };
}

const systemLookup = createIPv4FirstLookup();

/**
 * Resolve a proxy from environment variables or Windows Internet Settings.
 * node-fetch does not automatically inherit the browser's Windows proxy.
 */
function getSystemProxyUrl() {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
  if (envProxy) return normalizeProxyUrl(envProxy);

  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyEnable',
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) return null;

    const serverOutput = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyServer',
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!match) return null;

    const entries = match[1].trim().split(';').map((part) => part.trim()).filter(Boolean);
    const selected = entries.find((part) => /^https=/i.test(part)) ||
      entries.find((part) => /^http=/i.test(part)) ||
      entries.find((part) => !part.includes('='));
    if (!selected) return null;
    return normalizeProxyUrl(selected.replace(/^(?:https?|socks[45])=/i, ''));
  } catch {
    return null;
  }
}

function normalizeProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw;
}

function getProxyAgent() {
  if (proxyAgentResolved) return cachedProxyAgent;
  proxyAgentResolved = true;
  const proxyUrl = getSystemProxyUrl();
  if (!proxyUrl) return null;
  try {
    if (/^socks4a?:\/\//i.test(proxyUrl)) cachedProxyAgent = new SocksProxyAgent(proxyUrl, { lookup: systemLookup });
    else if (/^socks5h?:\/\//i.test(proxyUrl)) cachedProxyAgent = new SocksProxyAgent(proxyUrl, { lookup: systemLookup });
    else cachedProxyAgent = new HttpsProxyAgent(proxyUrl, { lookup: systemLookup });
    logToFile('using system proxy', proxyUrl.replace(/\/\/[^/@]+:[^/@]+@/, '//***:***@'));
  } catch (err) {
    logToFile('invalid system proxy', err && err.message);
    cachedProxyAgent = null;
  }
  return cachedProxyAgent;
}

function describeError(err) {
  if (!err) return '未知网络错误';
  const code = err.code || (err.cause && err.cause.code);
  const message = String(err.message || err);
  if (err.name === 'AbortError' || /aborted|aborterror/i.test(message)) return '连接超时（12 秒）';
  const known = {
    ENOTFOUND: 'DNS 解析失败',
    EAI_AGAIN: 'DNS 暂时不可用',
    ECONNRESET: '连接被重置',
    ECONNREFUSED: '连接被拒绝',
    ETIMEDOUT: '连接超时',
    CERT_HAS_EXPIRED: 'TLS 证书已过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书验证失败',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS 证书链包含自签名证书',
  };
  return code ? (known[code] || code) + '：' + message : message;
}

/** Extract valid IPv4 host:port pairs from a text blob. */
function parseLines(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const port = parseInt(m[2], 10);
    const octetsOk = m[1].split('.').every((o) => Number(o) <= 255);
    if (octetsOk && port >= 1 && port <= 65535) out.push(m[1] + ':' + m[2]);
  }
  return out;
}

/** Fetch one source with CDN/API fallback; retain a useful diagnostic on failure. */
async function fetchSource(src) {
  const attempts = [];
  const configuredProxyAgent = getProxyAgent();
  // node-fetch v2 does not provide browser-style Happy Eyeballs. Prefer the
  // system-resolved IPv4 address to avoid waiting on broken IPv6 routes.
  const agent = configuredProxyAgent || new https.Agent({ keepAlive: true, lookup: systemLookup });
  for (const url of (src.urls || [src.url]).filter(Boolean)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Pulse/1.0.1' },
        ...(agent ? { agent } : {}),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      const body = await res.text();
      const proxies = parseLines(body);
      if (proxies.length === 0) {
        throw new Error('响应成功，但未解析到有效 IP:端口（响应 ' + body.length + ' 字符）');
      }
      logToFile('fetched source', src.name, proxies.length, url);
      return { proxies, ok: true, url, error: null, attempts };
    } catch (err) {
      const error = describeError(err);
      attempts.push({ url, error });
      logToFile('source attempt failed', src.name, url, error);
    } finally {
      clearTimeout(timer);
    }
  }

  const error = attempts.length
    ? attempts.map((item) => item.error).join('；备用地址：')
    : '未配置下载地址';
  logToFile('source failed', src.name, error);
  return { proxies: [], ok: false, url: null, error, attempts };
}

/**
 * Fetch free proxies for a protocol and return source-level diagnostics.
 * @returns {{ proxies: string[], perSource: object, sourceDetails: object, protocol: string }}
 */
async function fetchFreeProxies(protocol) {
  const proto = SOURCES[protocol] ? protocol : 'http';
  const list = SOURCES[proto];
  const results = await Promise.all(list.map(fetchSource));

  const perSource = {};
  const sourceDetails = {};
  const seen = new Set();
  const proxies = [];

  results.forEach((result, i) => {
    perSource[list[i].name] = result.proxies.length;
    sourceDetails[list[i].name] = {
      ok: result.ok,
      count: result.proxies.length,
      url: result.url,
      error: result.error,
      attempts: result.attempts,
    };
    for (const hp of result.proxies) {
      if (!seen.has(hp)) {
        seen.add(hp);
        proxies.push(proto + '://' + hp);
      }
    }
  });

  logToFile('fetchFreeProxies', proto, proxies.length, perSource, sourceDetails);
  return { proxies, perSource, sourceDetails, protocol: proto };
}

module.exports = { fetchFreeProxies, parseLines, SOURCES, getSystemProxyUrl, describeError, createIPv4FirstLookup };
