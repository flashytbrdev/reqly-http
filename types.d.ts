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
  forever?: boolean;
  keepAlive?: boolean;
  buffer?: boolean;
  maxResponseSize?: number;
  family?: 4 | 6;
  localAddress?: string;
  lookup?: (...args: any[]) => void;
  auth?: AuthOptions;
  timeout?: number;
  gzip?: boolean;
  encoding?: BufferEncoding | null;
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

export type FormValue =
  | string | number | boolean | Buffer | NodeJS.ReadableStream
  | { value: string | number | boolean | Buffer | NodeJS.ReadableStream; options?: { filename?: string; contentType?: string } };

export interface Cookie {
  name: string; value: string; domain: string; hostOnly: boolean; path: string;
  expires: number | null; secure: boolean; httpOnly: boolean; created: number;
}

export declare class Jar {
  setCookie(cookie: string, uri: string | URL): boolean;
  getCookies(uri: string | URL): Cookie[];
  getCookieString(uri: string | URL): string;
  clear(): void;
}

export interface Response<T = any> extends IncomingMessage {
  body: T;
  request: Request;
}

export type Callback<T = any> = (error: Error | null, response: Response<T>, body: T) => void;

export declare class Request extends EventEmitter implements PromiseLike<Response> {
  options: Options;
  method: string;
  uri: URL;
  headers: Record<string, any>;
  redirects: Array<{ statusCode: number; redirectUri: string }>;
  response?: Response;
  then<R1 = Response, R2 = never>(
    onfulfilled?: ((value: Response) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
  ): Promise<R1 | R2>;
  catch<R = never>(onrejected?: ((reason: any) => R | PromiseLike<R>) | null): Promise<Response | R>;
  finally(onfinally?: (() => void) | null): Promise<Response>;
  pipe<T extends Writable>(dest: T, options?: { end?: boolean }): T;
  abort(): void;
}

export interface Requester {
  (uri: string | URL, options?: Options, callback?: Callback): Request;
  (uri: string | URL, callback?: Callback): Request;
  (options: Options, callback?: Callback): Request;
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
