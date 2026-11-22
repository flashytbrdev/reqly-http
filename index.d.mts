import type { Requester } from './types.js';
export * from './types.js';

declare const request: Requester;
export default request;

export declare const get: Requester;
export declare const post: Requester;
export declare const put: Requester;
export declare const patch: Requester;
export declare const head: Requester;
export declare const options: Requester;
export declare const del: Requester;
declare const _delete: Requester;
export { _delete as delete };
export declare const defaults: Requester['defaults'];
export declare const jar: Requester['jar'];
