'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');
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
  return out;
}

function pickEncoding(o, res) {
  if (o.encoding !== undefined) return o.encoding;
  const m = /charset=["']?([\w-]+)/i.exec(res.headers['content-type'] || '');
  return (m && CHARSETS[m[1].toLowerCase()]) || 'utf8';
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

  clear() { this._cookies = []; }
}

const defaultJar = new Jar();
function resolveJar(j) {
  if (j === true) return defaultJar;
  if (j && typeof j.setCookie === 'function' && typeof j.getCookieString === 'function') return j;
  return null;
}

function collectStream(s) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    s.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('error', reject);
  });
}

const quote = (s) => String(s).replace(/"/g, '%22').replace(/\r?\n/g, ' ');

async function buildMultipart(formData, boundary) {
  const out = [];
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
      if (isStream(value)) {
        if (!filename && value.path) filename = path.basename(String(value.path));
        data = await collectStream(value);
      } else if (Buffer.isBuffer(value)) data = value;
      else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') data = Buffer.from(String(value));
      else throw new TypeError('formData."' + name + '" must be string, number, Buffer, stream or {value, options}');

      let head = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + quote(name) + '"';
      if (filename) head += '; filename="' + quote(filename) + '"';
      head += '\r\n';
      const ctype = opts.contentType ||
        (filename ? MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream' : (Buffer.isBuffer(value) ? 'application/octet-stream' : null));
      if (ctype) head += 'Content-Type: ' + ctype + '\r\n';
      out.push(Buffer.from(head + '\r\n'), data, Buffer.from('\r\n'));
    }
  }
  out.push(Buffer.from('--' + boundary + '--\r\n'));
  return Buffer.concat(out);
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
      const boundary = '----HyperionBoundary' + crypto.randomBytes(12).toString('hex');
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
    Promise.resolve(this._payload).then((payload) => {
      if (this._finished) return;
      this._payload = payload;
      const h = this.headers;
      if (Buffer.isBuffer(payload)) h['content-length'] = String(payload.length);
      else if (!payload && ['POST', 'PUT', 'PATCH'].includes(this.method)) h['content-length'] = '0';
      this._request(this.uri, this.method, payload, h);
    }, (err) => this._finish(err));
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

    const tlsOpts = {};
    if (isHttps) {
      tlsOpts.rejectUnauthorized = o.rejectUnauthorized ?? o.strictSSL !== false;
      for (const k of TLS_KEYS) if (o[k] !== undefined) tlsOpts[k] = o[k];
      Object.assign(reqOpts, tlsOpts);
    }

    let lib = isHttps ? https : http;
    let agent = o.agent;
    if (!agent && (o.forever || o.keepAlive)) agent = sharedAgent(isHttps);

    const proxy = resolveProxy(o, url);
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

    const ctx = {
      url, method, payload, headers,
      canRetry: () =>
        !this._finished && this._attempt < (o.retries || 0) && !isStream(payload) &&
        (IDEMPOTENT.has(method) || !!o.retryNonIdempotent),
      retry: (res) => {
        this._attempt++;
        let delay = typeof o.retryDelay === 'function'
          ? o.retryDelay(this._attempt)
          : (o.retryDelay ?? 200) * 2 ** (this._attempt - 1);
        const ra = res && Number(res.headers['retry-after']);
        if (ra > 0) delay = Math.max(delay, Math.min(ra * 1000, 30000));
        this.emit('retry', this._attempt, res);
        setTimeout(() => {
          if (!this._finished) this._request(url, method, payload, headers);
        }, delay);
      }
    };

    const req = lib.request(reqOpts, (res) => this._onResponse(res, ctx));
    req.on('error', (err) => {
      if (RETRY_ERRORS.has(err.code) && ctx.canRetry()) return ctx.retry();
      this._finish(err);
    });
    if (o.timeout) {
      req.setTimeout(o.timeout, () => {
        const err = new Error('ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });
    }
    this._req = req;
    this.emit('request', req);
    if (isStream(payload)) {
      payload.on('error', (e) => req.destroy(e));
      payload.pipe(req);
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

    if (this._jar && res.headers['set-cookie']) {
      for (const sc of [].concat(res.headers['set-cookie'])) this._jar.setCookie(sc, url);
    }

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
      if (next.host !== url.host) delete nh.authorization;
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
    });
    stream.on('end', () => {
      this.emit('end');
      let body;
      if (!buffering) {
        body = undefined;
      } else if (method === 'HEAD') {
        body = o.encoding === null ? Buffer.alloc(0) : '';
      } else {
        const buf = Buffer.concat(chunks);
        const encoding = pickEncoding(o, res);
        body = encoding === null ? buf : buf.toString(encoding);
        if (this._jsonMode && typeof body === 'string' && body.length) {
          try { body = JSON.parse(body.replace(/^\uFEFF/, ''), o.jsonReviver); } catch (_) {}
        }
      }
      this._finish(null, res, body);
    });
  }

  _finish(err, res, body) {
    if (this._finished) return;
    this._finished = true;
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
    this._finish(err);
    if (this._req) this._req.destroy();
    if (this.response) this.response.destroy();
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
