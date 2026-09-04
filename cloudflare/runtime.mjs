import adminHtml from '../views/admin.html' with { type: 'text' };
import frontHtml from '../views/front.html' with { type: 'text' };

export { env, waitUntil } from 'cloudflare:workers';
export { adminHtml, frontHtml };
