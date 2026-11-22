/// <reference types="node" />
import { EventEmitter } from 'events';
import { IncomingMessage, Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { Writable } from 'stream';
import { URL } from 'url';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | (string & {});

export interface AuthOptions {
  user?: string;
  username?: string;
  pass?: string;
  password?: string;
  bearer?: string;
}

export interface Options {
  uri?: string | URL;
  url?: string | URL;
  baseUrl?: string;
  method?: Method;
  headers?: Record<string, string | number | string[] | undefined>;
  qs?: string | Record<string, unknown>;
  body?: string | Buffer | NodeJS.ReadableStream | object;
  form?: string | Record<string, unknown>;
  json?: boolean | object;
  jsonReviver?: (key: string, value: any) => any;
  jsonReplacer?: (key: string, value: any) => any;
  formData?: Record<string, FormValue | FormValue[]>;
  jar?: boolean | Jar;
  proxy?: string | URL | false;
  noProxy?: string | string[];
  retries?: number;
  retryDelay?: number | ((attempt: number) => number);
  retryOn?: number[];
  retryNonIdempotent?: boolean;
  signal?: AbortSignal;
  socketPath?: string;
  maxConcurrent?: number;
  cache?: boolean | CacheStore;
  throwHttpErrors?: boolean;
  forever?: boolean;
  keepAlive?: boolean;
  buffer?: boolean;
  maxResponseSize?: number;
  family?: 4 | 6;
  localAddress?: string;
  lookup?: (...args: any[]) => void;
  auth?: AuthOptions;
  timeout?: number | TimeoutOptions;
  hooks?: Hooks;
  onUploadProgress?: ProgressCallback;
  onDownloadProgress?: ProgressCallback;
  gzip?: boolean;
  encoding?: BufferEncoding | (string & {}) | null;
  followRedirect?: boolean | ((res: IncomingMessage) => boolean);
  followAllRedirects?: boolean;
  maxRedirects?: number;
  strictSSL?: boolean;
  rejectUnauthorized?: boolean;
  agent?: HttpAgent | HttpsAgent;
  ca?: string | Buffer | Array<string | Buffer>;
  cert?: string | Buffer;
  key?: string | Buffer;
  passphrase?: string;
  pfx?: string | Buffer;
  servername?: string;
  ciphers?: string;
}

export interface CacheEntry {
  etag?: string;
  lastModified?: string;
  buf: Buffer;
  headers: Record<string, any>;
  statusCode: number;
}

export interface CacheStore {
  get(key: string): CacheEntry | undefined | null;
  set(key: string, value: CacheEntry): unknown;
}

export type FormValue =
  | string | number | boolean | Buffer | NodeJS.ReadableStream
  | { value: string | number | boolean | Buffer | NodeJS.ReadableStream; options?: { filename?: string; contentType?: string; knownLength?: number } };

export interface Cookie {
  name: string; value: string; domain: string; hostOnly: boolean; path: string;
  expires: number | null; secure: boolean; httpOnly: boolean; created: number;
}

export interface JarData {
  version: number;
  cookies: Cookie[];
}

export declare class Jar {
  setCookie(cookie: string, uri: string | URL): boolean;
  getCookies(uri: string | URL): Cookie[];
  getCookieString(uri: string | URL): string;
  toJSON(): JarData;
  static fromJSON(data: string | JarData | Cookie[]): Jar;
  clear(): void;
}

export interface TimeoutOptions {
  connect?: number;
  response?: number;
  total?: number;
  idle?: number;
}

export interface Progress {
  transferred: number;
  total?: number;
}

export type ProgressCallback = (progress: Progress) => void;

export interface RetryInfo {
  request: Request;
  attempt: number;
  error?: Error;
  response?: Response;
  headers: Record<string, any>;
}

export type BeforeRequestHook = (request: Request) => void | Promise<void>;
export type BeforeRetryHook = (info: RetryInfo) => void | Promise<void>;
export type AfterResponseHook = (response: Response, request: Request) => void | Promise<void>;

export interface Hooks {
  beforeRequest?: BeforeRequestHook | BeforeRequestHook[];
  beforeRetry?: BeforeRetryHook | BeforeRetryHook[];
  afterResponse?: AfterResponseHook | AfterResponseHook[];
}

export interface Response<T = any> extends IncomingMessage {
  body: T;
  fromCache?: boolean;
  request: Request;
}

export interface HTTPError extends Error {
  code: 'EHTTP';
  statusCode: number;
  response: Response;
  body: any;
}

export type Callback<T = any> = (error: Error | null, response: Response<T>, body: T) => void;

export declare class Request<T = any> extends EventEmitter implements PromiseLike<Response<T>> {
  options: Options;
  method: string;
  uri: URL;
  headers: Record<string, any>;
  redirects: Array<{ statusCode: number; redirectUri: string }>;
  response?: Response<T>;
  then<R1 = Response<T>, R2 = never>(
    onfulfilled?: ((value: Response<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2>;
  catch<R = never>(onrejected?: ((reason: any) => R | PromiseLike<R>) | null): Promise<Response<T> | R>;
  finally(onfinally?: (() => void) | null): Promise<Response<T>>;
  pipe<W extends Writable>(dest: W, options?: { end?: boolean }): W;
  abort(): void;
}

export interface Requester {
  <T = any>(uri: string | URL, options?: Options, callback?: Callback<T>): Request<T>;
  <T = any>(uri: string | URL, callback?: Callback<T>): Request<T>;
  <T = any>(options: Options, callback?: Callback<T>): Request<T>;
  get: Requester;
  post: Requester;
  put: Requester;
  patch: Requester;
  head: Requester;
  options: Requester;
  delete: Requester;
  del: Requester;
  defaults(options: Options): Requester;
  jar(): Jar;
  Jar: typeof Jar;
  Request: typeof Request;
}
