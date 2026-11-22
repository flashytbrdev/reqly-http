'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RETRY_STATUS = [408, 429, 500, 502, 503, 504];
const RETRY_ERRORS = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']);
const TLS_KEYS = ['ca', 'cert', 'key', 'passphrase', 'pfx', 'servername', 'ciphers'];
const NET_KEYS = ['family', 'localAddress', 'lookup'];
const METHODS = ['get', 'post', 'put', 'patch', 'head', 'options', 'delete'];
const CHARSETS = {
  'utf-8': 'utf8', utf8: 'utf8', 'iso-8859-1': 'latin1', latin1: 'latin1',
  'us-ascii': 'ascii', ascii: 'ascii', 'utf-16le': 'utf16le', 'ucs-2': 'ucs2'
};
const MIME = {
  '.json': 'application/json', '.txt': 'text/plain', '.html': 'text/html', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip', '.js': 'text/javascript'
};

const isStream = (v) => !!v && typeof v === 'object' && typeof v.pipe === 'function' && typeof v.on === 'function';
const stripBrackets = (h) => String(h).replace(/^\[|\]$/g, '');

function lowerHeaders(h) {
  const out = {};
  for (const k of Object.keys(h || {})) {
    if (h[k] !== undefined && h[k] !== null) out[k.toLowerCase()] = h[k];
  }
  return out;
}

function appendParams(params, obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((i) => params.append(k, String(i)));
    else params.append(k, String(v));
  }
}

function encodeForm(obj) {
  const p = new URLSearchParams();
  appendParams(p, obj);
  return p.toString();
}

function buildUrl(opts) {
  let raw = opts.uri || opts.url;
  if (!raw) throw new TypeError('options.uri is a required argument');
  if (raw instanceof URL) raw = raw.href;
  if (opts.baseUrl) {
    raw = String(opts.baseUrl).replace(/\/+$/, '') + '/' + String(raw).replace(/^\/+/, '');
  }
  const url = new URL(raw);
  if (opts.qs) {
    if (typeof opts.qs === 'string') {
      for (const [k, v] of new URLSearchParams(opts.qs)) url.searchParams.append(k, v);
    } else {
      appendParams(url.searchParams, opts.qs);
    }
  }
  return url;
}

function normalizeArgs(a, b, c) {
  let opts;
  let cb;
  if (typeof a === 'string' || a instanceof URL) {
    opts = b && typeof b === 'object' ? { ...b } : {};
    opts.uri = a;
    cb = typeof b === 'function' ? b : c;
  } else {
    opts = { ...(a || {}) };
    cb = typeof b === 'function' ? b : undefined;
  }
  return [opts, typeof cb === 'function' ? cb : undefined];
}

function mergeOptions(base, extra) {
  const out = { ...base, ...extra };
  if (base.headers || extra.headers) {
    out.headers = { ...lowerHeaders(base.headers), ...lowerHeaders(extra.headers) };
  }
  if (base.hooks || extra.hooks) out.hooks = mergeHooks(base.hooks, extra.hooks);
  return out;
}

function validLabel(label) {
  if (typeof TextDecoder === 'undefined') return false;
  try {
    new TextDecoder(label);
    return true;
  } catch (_) {
    return false;
  }
}

function pickEncoding(o, res) {
  if (o.encoding !== undefined) return o.encoding;
  const m = /charset=["']?([\w.:-]+)/i.exec(res.headers['content-type'] || '');
  if (!m) return 'utf8';
  const label = m[1].toLowerCase();
  return CHARSETS[label] || (validLabel(label) ? label : 'utf8');
}

function decodeBuffer(buf, enc) {
  if (enc === null) return buf;
  if (Buffer.isEncoding(enc)) return buf.toString(enc);
  if (validLabel(enc)) return new TextDecoder(enc).decode(buf);
  return buf.toString('utf8');
}

function retryAfterMs(res) {
  const v = res && res.headers['retry-after'];
  if (!v) return 0;
  const secs = Number(v);
  if (!isNaN(secs)) return secs > 0 ? secs * 1000 : 0;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : Math.max(0, t - Date.now());
}

function timeouts(v) {
  if (typeof v === 'number') return v > 0 ? { idle: v } : {};
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const k of ['connect', 'response', 'total', 'idle']) if (v[k] > 0) out[k] = v[k];
  return out;
}

function hookList(hooks, name) {
  const v = hooks && hooks[name];
  return (Array.isArray(v) ? v : v ? [v] : []).filter((f) => typeof f === 'function');
}

function mergeHooks(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const k of Object.keys(src || {})) out[k] = (out[k] || []).concat(src[k]);
  }
  return out;
}

function sendBuffer(req, buf, onProgress) {
  const total = buf.length;
  const step = 65536;
  let off = 0;
  const next = () => {
    while (off < total) {
      if (req.destroyed) return;
      const chunk = buf.subarray(off, Math.min(off + step, total));
      off += chunk.length;
      const sent = off;
      const ok = req.write(chunk, (err) => {
        if (!err) onProgress({ transferred: sent, total });
      });
      if (!ok) return req.once('drain', next);
    }
    req.end();
  };
  next();
}

const GLOBAL_CACHE_MAX = 100;
const globalCache = new Map();
const globalCacheStore = {
  get: (k) => {
    const v = globalCache.get(k);
    if (v) {
      globalCache.delete(k);
      globalCache.set(k, v);
    }
    return v;
  },
  set: (k, v) => {
    globalCache.delete(k);
    globalCache.set(k, v);
    if (globalCache.size > GLOBAL_CACHE_MAX) globalCache.delete(globalCache.keys().next().value);
  }
};

function resolveCache(c) {
  if (c === true) return globalCacheStore;
  if (c && typeof c.get === 'function' && typeof c.set === 'function') return c;
  return null;
}

const limiters = new Map();

function acquireSlot(host, max, go) {
  let lim = limiters.get(host);
  if (!lim) {
    lim = { active: 0, queue: [] };
    limiters.set(host, lim);
  }
  const entry = { max, go, held: false };
  const drain = () => {
    while (lim.queue.length && lim.active < lim.queue[0].max) {
      const next = lim.queue.shift();
      next.held = true;
      lim.active++;
      next.go();
    }
    if (!lim.active && !lim.queue.length && limiters.get(host) === lim) limiters.delete(host);
  };
  entry.release = () => {
    if (entry.held) {
      entry.held = false;
      lim.active--;
    } else {
      const i = lim.queue.indexOf(entry);
      if (i >= 0) lim.queue.splice(i, 1);
    }
    drain();
  };
  lim.queue.push(entry);
  drain();
  return entry;
}

let shared;
function sharedAgent(isHttps) {
  if (!shared) shared = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
  return isHttps ? shared.https : shared.http;
}

const domainMatch = (host, d) => host === d || host.endsWith('.' + d);
const pathMatch = (reqPath, cp) =>
  reqPath === cp || (reqPath.startsWith(cp) && (cp.endsWith('/') || reqPath[cp.length] === '/'));
function defaultPath(p) {
  if (!p || p[0] !== '/') return '/';
  const i = p.lastIndexOf('/');
  return i === 0 ? '/' : p.slice(0, i);
}

class Jar {
  constructor() { this._cookies = []; }

  setCookie(cookieStr, uri) {
    const url = typeof uri === 'string' ? new URL(uri) : uri;
    const host = url.hostname.toLowerCase();
    const parts = String(cookieStr).split(';');
    const first = parts.shift();
    const eq = first.indexOf('=');
    if (eq < 1) return false;
    const c = {
      name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim(),
      domain: host, hostOnly: true, path: null, expires: null,
      secure: false, httpOnly: false, created: Date.now()
    };
    let maxAge;
    for (const p of parts) {
      const i = p.indexOf('=');
      const k = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : p.slice(i + 1).trim();
      if (k === 'domain') {
        const d = v.replace(/^\./, '').toLowerCase();
        if (!d || !domainMatch(host, d)) return false;
        c.domain = d; c.hostOnly = false;
      } else if (k === 'path') { if (v.startsWith('/')) c.path = v; }
      else if (k === 'expires') { const t = Date.parse(v); if (!isNaN(t)) c.expires = t; }
      else if (k === 'max-age') { const n = parseInt(v, 10); if (!isNaN(n)) maxAge = n; }
      else if (k === 'secure') c.secure = true;
      else if (k === 'httponly') c.httpOnly = true;
    }
    if (maxAge !== undefined) c.expires = Date.now() + maxAge * 1000;
    if (!c.path) c.path = defaultPath(url.pathname);
    this._cookies = this._cookies.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
    if (c.expires !== null && c.expires <= Date.now()) return true;
    this._cookies.push(c);
    return true;
  }

  getCookies(uri) {
    const url = typeof uri === 'string' ? new URL(uri) : uri;
    const host = url.hostname.toLowerCase();
    const now = Date.now();
    this._cookies = this._cookies.filter((c) => c.expires === null || c.expires > now);
    return this._cookies
      .filter((c) =>
        (c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) &&
        pathMatch(url.pathname || '/', c.path) &&
        (!c.secure || url.protocol === 'https:'))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  }

  getCookieString(uri) {
    return this.getCookies(uri).map((c) => c.name + '=' + c.value).join('; ');
  }

  toJSON() {
    const now = Date.now();
    return {
      version: 1,
      cookies: this._cookies.filter((c) => c.expires === null || c.expires > now).map((c) => ({ ...c }))
    };
  }

  static fromJSON(data) {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const list = Array.isArray(parsed) ? parsed : parsed && parsed.cookies;
    if (!Array.isArray(list)) throw new TypeError('Invalid cookie jar data');
    const jar = new Jar();
    for (const c of list) {
      if (!c || typeof c.name !== 'string' || typeof c.domain !== 'string' || !c.domain) continue;
      jar._cookies.push({
        name: c.name,
        value: String(c.value ?? ''),
        domain: c.domain.toLowerCase(),
        hostOnly: !!c.hostOnly,
        path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
        expires: typeof c.expires === 'number' ? c.expires : null,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        created: typeof c.created === 'number' ? c.created : Date.now()
      });
    }
    return jar;
  }

  clear() { this._cookies = []; }
}

const defaultJar = new Jar();
function resolveJar(j) {
  if (j === true) return defaultJar;
  if (j && typeof j.setCookie === 'function' && typeof j.getCookieString === 'function') return j;
  return null;
}

const quote = (s) => String(s).replace(/"/g, '%22').replace(/\r?\n/g, ' ');

async function streamLength(stream, opts) {
  if (typeof opts.knownLength === 'number') return opts.knownLength;
  const wholeFile = (stream.start === undefined || stream.start === 0) &&
    (stream.end === undefined || stream.end === Infinity);
  if (stream.path && wholeFile && !stream.bytesRead) {
    try {
      const st = await fs.promises.stat(String(stream.path));
      if (st.isFile()) return st.size;
    } catch (_) {}
  }
  return undefined;
}

async function buildMultipart(formData, boundary) {
  const parts = [];
  for (const [name, raw] of Object.entries(formData)) {
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      if (item === undefined || item === null) continue;
      let value = item;
      let opts = {};
      if (item && typeof item === 'object' && !Buffer.isBuffer(item) && !isStream(item) && 'value' in item) {
        value = item.value;
        opts = item.options || {};
      }
      let filename = opts.filename;
      let data;
      let length;
      if (isStream(value)) {
        if (!filename && value.path) filename = path.basename(String(value.path));
        data = value;
        length = await streamLength(value, opts);
      } else if (Buffer.isBuffer(value)) {
        data = value;
        length = value.length;
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        data = Buffer.from(String(value));
        length = data.length;
      } else throw new TypeError('formData."' + name + '" must be string, number, Buffer, stream or {value, options}');

      let head = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + quote(name) + '"';
      if (filename) head += '; filename="' + quote(filename) + '"';
      head += '\r\n';
      const ctype = opts.contentType ||
        (filename ? MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream' : (Buffer.isBuffer(value) ? 'application/octet-stream' : null));
      if (ctype) head += 'Content-Type: ' + ctype + '\r\n';
      parts.push({ head: Buffer.from(head + '\r\n'), data, length });
    }
  }
  const tail = Buffer.from('--' + boundary + '--\r\n');
  const crlf = Buffer.from('\r\n');

  if (!parts.some((p) => isStream(p.data))) {
    const out = [];
    for (const p of parts) out.push(p.head, p.data, crlf);
    out.push(tail);
    return Buffer.concat(out);
  }

  let total = tail.length;
  for (const p of parts) {
    if (p.length === undefined) {
      total = undefined;
      break;
    }
    total += p.head.length + p.length + crlf.length;
  }

  async function* generate() {
    try {
      for (const p of parts) {
        yield p.head;
        if (isStream(p.data)) {
          for await (const chunk of p.data) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        } else {
          yield p.data;
        }
        yield crlf;
      }
      yield tail;
    } finally {
      for (const p of parts) if (isStream(p.data) && typeof p.data.destroy === 'function') p.data.destroy();
    }
  }

  const body = Readable.from(generate(), { objectMode: false });
  body._length = total;
  return body;
}

const isLoopback = (h) => h === 'localhost' || h === '::1' || /^127\./.test(h);

function noProxyMatch(host, list) {
  const items = Array.isArray(list) ? list : String(list || '').split(',');
  for (let item of items) {
    item = String(item).trim().toLowerCase().replace(/:\d+$/, '');
    if (!item) continue;
    if (item === '*') return true;
    item = item.replace(/^\*?\./, '');
    if (host === item || host.endsWith('.' + item)) return true;
  }
  return false;
}

function resolveProxy(o, url) {
  if (o.proxy === false) return null;
  const host = stripBrackets(url.hostname).toLowerCase();
  let p = o.proxy;
  if (!p) {
    if (isLoopback(host)) return null;
    const e = process.env;
    p = url.protocol === 'https:'
      ? e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy
      : e.HTTP_PROXY || e.http_proxy;
    if (!p) return null;
  }
  const np = o.noProxy !== undefined ? o.noProxy : process.env.NO_PROXY || process.env.no_proxy;
  if (noProxyMatch(host, np)) return null;
  return p instanceof URL ? p : new URL(String(p).includes('://') ? p : 'http://' + p);
}

class TunnelAgent extends https.Agent {
  constructor(proxy, proxyHeaders, tlsOpts) {
    super({ keepAlive: false });
    this._proxy = proxy;
    this._proxyHeaders = proxyHeaders;
    this._tlsOpts = tlsOpts;
  }

  createConnection(options, cb) {
    const p = this._proxy;
    const target = options.host + ':' + options.port;
    const preq = (p.protocol === 'https:' ? https : http).request({
      hostname: stripBrackets(p.hostname),
      port: p.port || (p.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: target,
      headers: { host: target, ...this._proxyHeaders },
      agent: false
    });
    preq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const e = new Error('Proxy CONNECT failed with status ' + res.statusCode);
        e.code = 'EPROXY';
        return cb(e);
      }
      const t = tls.connect({
        ...this._tlsOpts,
        socket,
        servername: this._tlsOpts.servername || (/^[\d.:]+$/.test(options.host) ? undefined : stripBrackets(options.host))
      });
      cb(null, t);
    });
    preq.once('error', (e) => cb(e));
    preq.end();
  }
}

class Request extends EventEmitter {
  constructor(opts, callback) {
    super();
    this.options = opts;
    this.callback = callback;
    this.method = String(opts.method || 'GET').toUpperCase();
    this.headers = lowerHeaders(opts.headers);
    this.redirects = [];
    this._pipes = [];
    this._stream = null;
    this._req = null;
    this._result = null;
    this._promise = null;
    this._settle = null;
    this._finished = false;
    this._attempt = 0;
    this._jar = resolveJar(opts.jar);
    this._jsonMode = opts.json !== undefined && opts.json !== false;
    this._onSignalAbort = null;
    this._totalTimer = null;
    this._slot = null;
    this._clearAttempt = null;
    if (opts.signal && typeof opts.signal.addEventListener === 'function') {
      this._onSignalAbort = () => this.abort();
      opts.signal.addEventListener('abort', this._onSignalAbort, { once: true });
    }

    try {
      this.uri = buildUrl(opts);
      this._payload = this._buildPayload();
    } catch (err) {
      setImmediate(() => this._finish(err));
      return;
    }
    setImmediate(() => this._start());
  }

  _buildPayload() {
    const o = this.options;
    const h = this.headers;
    let body = o.body;
    if (this._jsonMode && typeof o.json !== 'boolean') body = o.json;
    let payload = null;

    if (o.formData !== undefined) {
      const boundary = '----ReqlyBoundary' + crypto.randomBytes(12).toString('hex');
      h['content-type'] = 'multipart/form-data; boundary=' + boundary;
      return buildMultipart(o.formData, boundary);
    }
    if (o.form !== undefined) {
      payload = Buffer.from(typeof o.form === 'string' ? o.form : encodeForm(o.form));
      if (!h['content-type']) h['content-type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body) || isStream(body)) payload = body;
      else if (typeof body === 'string') payload = Buffer.from(body);
      else if (this._jsonMode) payload = Buffer.from(JSON.stringify(body, o.jsonReplacer));
      else throw new TypeError('options.body must be a string, Buffer or stream (use json: true for objects)');
      if (this._jsonMode && !h['content-type']) h['content-type'] = 'application/json';
    }
    if (this._jsonMode && !h.accept) h.accept = 'application/json';
    return payload;
  }

  _start() {
    if (this._finished) return;
    if (this.options.signal && this.options.signal.aborted) return this.abort();
    const t = timeouts(this.options.timeout);
    if (t.total) {
      this._totalTimer = setTimeout(() => {
        const err = new Error('ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        err.phase = 'total';
        this._kill(err);
      }, t.total);
    }
    Promise.resolve(this._payload)
      .then((payload) => {
        if (this._finished) return;
        this._payload = payload;
        return this._runHooks('beforeRequest', [this]).then(() => {
          if (this._finished) return;
          const go = () => {
            if (this._finished) return;
            const h = this.headers;
            if (Buffer.isBuffer(payload)) h['content-length'] = String(payload.length);
            else if (payload && payload._length !== undefined && !h['content-length'] && !h['transfer-encoding']) {
              h['content-length'] = String(payload._length);
            } else if (!payload && ['POST', 'PUT', 'PATCH'].includes(this.method)) h['content-length'] = '0';
            this._request(this.uri, this.method, payload, h);
          };
          const max = Number(this.options.maxConcurrent);
          if (max > 0) {
            this._slot = acquireSlot(this.uri.host, Math.floor(max) || 1, go);
            if (this._finished) this._slot.release();
          }
          else go();
        });
      })
      .catch((err) => {
        if (this._finished) throw err;
        this._finish(err);
      });
  }

  _runHooks(name, args) {
    let p = Promise.resolve();
    for (const fn of hookList(this.options.hooks, name)) p = p.then(() => fn(...args));
    return p;
  }

  _progress(fn) {
    if (typeof fn !== 'function') return null;
    return (p) => {
      try {
        fn(p);
      } catch (e) {
        this._kill(e);
      }
    };
  }

  _kill(err) {
    this._finish(err);
    if (this._req) this._req.destroy();
    if (this.response) this.response.destroy();
  }

  _request(url, method, payload, headers) {
    const o = this.options;
    const isHttps = url.protocol === 'https:';
    if (!isHttps && url.protocol !== 'http:') {
      return this._finish(new Error('Invalid protocol: ' + url.protocol));
    }

    const h = { ...headers };
    if (o.gzip !== false && !h['accept-encoding']) h['accept-encoding'] = 'gzip, deflate, br';

    if (!h.authorization && url.host === this.uri.host) {
      const a = o.auth;
      if (a && a.bearer) {
        h.authorization = 'Bearer ' + a.bearer;
      } else if (a) {
        const u = a.user ?? a.username ?? '';
        const p = a.pass ?? a.password ?? '';
        h.authorization = 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
      } else if (url.username || url.password) {
        h.authorization = 'Basic ' + Buffer.from(
          decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password)).toString('base64');
      }
    }

    if (this._jar) {
      const cs = this._jar.getCookieString(url);
      if (cs) h.cookie = h.cookie ? h.cookie + '; ' + cs : cs;
    }

    const reqOpts = {
      protocol: url.protocol,
      hostname: stripBrackets(url.hostname),
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: h
    };
    for (const k of NET_KEYS) if (o[k] !== undefined) reqOpts[k] = o[k];
    if (o.socketPath) reqOpts.socketPath = o.socketPath;

    const tlsOpts = {};
    if (isHttps) {
      tlsOpts.rejectUnauthorized = o.rejectUnauthorized ?? o.strictSSL !== false;
      for (const k of TLS_KEYS) if (o[k] !== undefined) tlsOpts[k] = o[k];
      Object.assign(reqOpts, tlsOpts);
    }

    let lib = isHttps ? https : http;
    let agent = o.agent;
    if (!agent && (o.forever || o.keepAlive)) agent = sharedAgent(isHttps);

    const proxy = o.socketPath ? null : resolveProxy(o, url);
    if (proxy) {
      const ph = {};
      if (proxy.username || proxy.password) {
        ph['proxy-authorization'] = 'Basic ' + Buffer.from(
          decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
      }
      if (isHttps) {
        agent = new TunnelAgent(proxy, ph, tlsOpts);
      } else {
        lib = proxy.protocol === 'https:' ? https : http;
        const abs = new URL(url.href);
        abs.username = ''; abs.password = ''; abs.hash = '';
        reqOpts.protocol = proxy.protocol;
        reqOpts.hostname = stripBrackets(proxy.hostname);
        reqOpts.port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
        reqOpts.path = abs.href;
        h.host = url.host;
        Object.assign(h, ph);
      }
    }
    if (agent) reqOpts.agent = agent;

    const cache = method === 'GET' && !h.range ? resolveCache(o.cache) : null;
    let cacheEntry = null;
    if (cache) {
      cacheEntry = cache.get(url.href) || null;
      if (cacheEntry && !h['if-none-match'] && !h['if-modified-since']) {
        if (cacheEntry.etag) h['if-none-match'] = cacheEntry.etag;
        else if (cacheEntry.lastModified) h['if-modified-since'] = cacheEntry.lastModified;
      } else {
        cacheEntry = null;
      }
    }

    const timers = [];
    const ctx = {
      url, method, payload, headers,
      cache, cacheEntry, cacheable: !!cache && o.buffer !== false,
      timer: (ms, fn) => {
        const id = setTimeout(fn, ms);
        timers.push(id);
        return id;
      },
      clearTimers: () => {
        timers.splice(0).forEach((id) => clearTimeout(id));
      },
      canRetry: () =>
        !this._finished && this._attempt < (o.retries || 0) && !isStream(payload) &&
        (IDEMPOTENT.has(method) || !!o.retryNonIdempotent),
      retry: (res, err) => {
        this._attempt++;
        let delay = typeof o.retryDelay === 'function'
          ? o.retryDelay(this._attempt)
          : (o.retryDelay ?? 200) * 2 ** (this._attempt - 1);
        const ra = retryAfterMs(res);
        if (ra > 0) delay = Math.max(delay, Math.min(ra, 30000));
        this.emit('retry', this._attempt, res, err);
        setTimeout(() => {
          if (this._finished) return;
          const info = { request: this, attempt: this._attempt, error: err, response: res, headers };
          this._runHooks('beforeRetry', [info]).then(() => {
            if (!this._finished) this._request(url, method, payload, headers);
          }, (e) => this._finish(e));
        }, delay);
      }
    };
    this._clearAttempt = ctx.clearTimers;

    const req = lib.request(reqOpts, (res) => this._onResponse(res, ctx));
    req.on('error', (err) => {
      ctx.clearTimers();
      if (RETRY_ERRORS.has(err.code) && ctx.canRetry()) return ctx.retry(undefined, err);
      this._finish(err);
    });

    const t = timeouts(o.timeout);
    const expire = (phase) => {
      const err = new Error('ETIMEDOUT');
      err.code = 'ETIMEDOUT';
      err.phase = phase;
      req.destroy(err);
    };
    if (t.idle) req.setTimeout(t.idle, () => expire('idle'));
    if (t.connect) {
      const timer = ctx.timer(t.connect, () => expire('connect'));
      req.on('socket', (socket) => {
        const ready = isHttps ? !!(socket.getProtocol && socket.getProtocol()) : !socket.connecting;
        if (ready) return clearTimeout(timer);
        socket.once(isHttps ? 'secureConnect' : 'connect', () => clearTimeout(timer));
      });
    }
    if (t.response) req.on('finish', () => ctx.timer(t.response, () => expire('response')));

    this._req = req;
    this.emit('request', req);
    const up = this._progress(o.onUploadProgress);
    if (isStream(payload)) {
      payload.on('error', (e) => req.destroy(e));
      if (up) {
        const total = Number(h['content-length']) || undefined;
        let sent = 0;
        payload.on('data', (c) => {
          sent += c.length;
          up({ transferred: sent, total });
        });
      }
      payload.pipe(req);
    } else if (up && Buffer.isBuffer(payload) && payload.length) {
      sendBuffer(req, payload, up);
    } else {
      req.end(payload || undefined);
    }
  }

  _shouldRedirect(res, method, payload) {
    if (!REDIRECT_CODES.has(res.statusCode) || !res.headers.location) return false;
    if (isStream(payload) && (res.statusCode === 307 || res.statusCode === 308)) return false;
    const fr = this.options.followRedirect;
    if (typeof fr === 'function') return !!fr(res);
    if (fr === false) return false;
    return method === 'GET' || method === 'HEAD' || !!this.options.followAllRedirects;
  }

  _onResponse(res, ctx) {
    if (this._finished) return res.resume();
    const o = this.options;
    const { url, method, payload, headers } = ctx;
    const status = res.statusCode;
    ctx.clearTimers();

    if (this._jar && res.headers['set-cookie']) {
      for (const sc of [].concat(res.headers['set-cookie'])) this._jar.setCookie(sc, url);
    }

    if (status === 304 && ctx.cacheEntry) return this._fromCache(res, ctx, ctx.cacheEntry);

    if ((o.retryOn || RETRY_STATUS).includes(status) && ctx.canRetry()) {
      res.resume();
      return ctx.retry(res);
    }

    if (this._shouldRedirect(res, method, payload)) {
      res.resume();
      const max = o.maxRedirects ?? 10;
      if (this.redirects.length >= max) {
        return this._finish(new Error('Exceeded maxRedirects. Probably stuck in a redirect loop ' + url.href));
      }
      const next = new URL(res.headers.location, url);
      this.redirects.push({ statusCode: status, redirectUri: next.href });
      let nm = method;
      let np = payload;
      const nh = { ...headers };
      const toGet = status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD');
      if (toGet) {
        if (method !== 'HEAD') nm = 'GET';
        np = null;
        delete nh['content-type'];
        delete nh['content-length'];
        delete nh['transfer-encoding'];
      }
      if (next.host !== url.host) {
        delete nh.authorization;
        delete nh.cookie;
      }
      this.emit('redirect', res, next);
      return this._request(next, nm, np, nh);
    }

    let stream = res;
    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
    if (o.gzip !== false && method !== 'HEAD' && status !== 204 && status !== 304) {
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
    }

    res.request = this;
    this.response = res;
    this._stream = stream;
    const premature = () => {
      const e = new Error('Response closed before it was complete');
      e.code = 'ECONNRESET';
      this._finish(e);
    };
    res.on('error', (e) => this._finish(e));
    res.on('aborted', premature);
    res.on('close', () => { if (!res.complete) premature(); });
    stream.on('error', (e) => this._finish(e));
    this.emit('response', res);
    for (const d of this._pipes) stream.pipe(d);

    const buffering = o.buffer !== false && !(this._pipes.length && !this.callback && !this._promise);
    const limit = o.maxResponseSize;
    const down = this._progress(o.onDownloadProgress);
    const knownTotal = stream === res ? Number(res.headers['content-length']) || undefined : undefined;
    const chunks = [];
    let total = 0;
    stream.on('data', (c) => {
      total += c.length;
      if (limit && total > limit) {
        const e = new Error('Response exceeded maxResponseSize (' + limit + ' bytes)');
        e.code = 'ERESPONSETOOLARGE';
        this._finish(e);
        res.destroy();
        return;
      }
      this.emit('data', c);
      if (buffering) chunks.push(c);
      if (down) down({ transferred: total, total: knownTotal });
    });
    stream.on('end', () => {
      this.emit('end');
      const buf = buffering ? Buffer.concat(chunks) : null;
      if (buf && ctx.cacheable && status === 200 && !res.headers['set-cookie']) this._cacheStore(ctx, res, buf);
      this._complete(res, buf, buffering, method);
    });
  }

  _complete(res, buf, buffering, method) {
    const o = this.options;
    const status = res.statusCode;
    let body;
    if (!buffering) {
      body = undefined;
    } else if (method === 'HEAD') {
      body = o.encoding === null ? Buffer.alloc(0) : '';
    } else {
      const encoding = pickEncoding(o, res);
      try {
        body = decodeBuffer(buf, encoding);
      } catch (e) {
        return this._finish(e, res);
      }
      if (this._jsonMode && typeof body === 'string' && body.length) {
        try { body = JSON.parse(body.replace(/^\uFEFF/, ''), o.jsonReviver); } catch (_) {}
      }
    }
    const settle = () => {
      if (o.throwHttpErrors && status >= 400) {
        const e = new Error('Request failed with status code ' + status);
        e.code = 'EHTTP';
        e.statusCode = status;
        e.response = res;
        e.body = body;
        return this._finish(e, res, body);
      }
      this._finish(null, res, body);
    };
    if (!hookList(o.hooks, 'afterResponse').length) return settle();
    res.body = body;
    this._runHooks('afterResponse', [res, this]).then(() => {
      body = res.body;
      settle();
    }, (e) => this._finish(e, res, body));
  }

  _cacheStore(ctx, res, buf) {
    const etag = res.headers.etag;
    const lastModified = res.headers['last-modified'];
    if (!etag && !lastModified) return;
    if (/\bno-store\b/i.test(String(res.headers['cache-control'] || ''))) return;
    const keep = {};
    for (const k of ['content-type', 'content-language', 'etag', 'last-modified', 'cache-control', 'expires']) {
      if (res.headers[k] !== undefined) keep[k] = res.headers[k];
    }
    ctx.cache.set(ctx.url.href, { etag, lastModified, buf, headers: keep, statusCode: res.statusCode });
  }

  _fromCache(res, ctx, entry) {
    res.resume();
    res.statusCode = entry.statusCode;
    res.headers = { ...res.headers, ...entry.headers };
    res.fromCache = true;
    res.request = this;
    this.response = res;
    this.emit('response', res);
    const buffering = this.options.buffer !== false && !(this._pipes.length && !this.callback && !this._promise);
    this.emit('data', entry.buf);
    for (const d of this._pipes) d.end(entry.buf);
    this.emit('end');
    this._complete(res, buffering ? entry.buf : null, buffering, ctx.method);
  }

  _finish(err, res, body) {
    if (this._finished) return;
    this._finished = true;
    clearTimeout(this._totalTimer);
    if (this._slot) this._slot.release();
    if (this._clearAttempt) this._clearAttempt();
    if (this._onSignalAbort) this.options.signal.removeEventListener('abort', this._onSignalAbort);
    if (res) res.body = body;
    this._result = { err: err || null, res, body };

    if (this.callback) this.callback(err || null, res, body);
    if (this._settle) this._settleNow();
    else if (err && !this.callback && err.code !== 'ABORTED') this.emit('error', err);
    if (!err) this.emit('complete', res, body);
  }

  _settleNow() {
    const { err, res } = this._result;
    if (err) this._settle.rej(err);
    else this._settle.res(res);
  }

  _toPromise() {
    if (!this._promise) {
      this._promise = new Promise((res, rej) => { this._settle = { res, rej }; });
      if (this._result) this._settleNow();
    }
    return this._promise;
  }

  then(a, b) { return this._toPromise().then(a, b); }
  catch(fn) { return this._toPromise().catch(fn); }
  finally(fn) { return this._toPromise().finally(fn); }

  pipe(dest, opts) {
    this._pipes.push(dest);
    if (this._stream) this._stream.pipe(dest, opts);
    return dest;
  }

  abort() {
    if (this._finished) return;
    const err = new Error('Aborted');
    err.code = 'ABORTED';
    this._kill(err);
    this.emit('abort');
  }
}

function makeRequester(defaults) {
  const fn = function request(a, b, c) {
    const [opts, cb] = normalizeArgs(a, b, c);
    return new Request(mergeOptions(defaults, opts), cb);
  };
  for (const m of METHODS) {
    fn[m] = (a, b, c) => {
      const [opts, cb] = normalizeArgs(a, b, c);
      opts.method = m.toUpperCase();
      return fn(opts, cb);
    };
  }
  fn.del = fn.delete;
  fn.defaults = (extra) => makeRequester(mergeOptions(defaults, extra || {}));
  fn.jar = () => new Jar();
  fn.Jar = Jar;
  fn.Request = Request;
  return fn;
}

module.exports = makeRequester({});
module.exports.default = module.exports;
