import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const request = require('./index.js');

export default request;
export const { get, post, put, patch, head, options, del, defaults, jar, Jar, Request } = request;
export { del as delete };
