import '../server.js';
import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';

const appHandler = httpServerHandler({ port: 3000 });

function requiresCoordination(request) {
  return request.method !== 'GET' && request.method !== 'HEAD';
}

export class RequestCoordinator extends DurableObject {
  constructor(context, env) {
    super(context, env);
    this.tail = Promise.resolve();
  }

  fetch(request) {
    const executionContext = {
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      passThroughOnException() {},
      props: {}
    };
    const response = this.tail.then(() => appHandler.fetch(request, this.env, executionContext));
    this.tail = response.then(() => undefined, () => undefined);
    return response;
  }
}

export default {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname.startsWith('/assets/')) return env.ASSETS.fetch(request);
    if (requiresCoordination(request)) {
      return env.REQUEST_COORDINATOR.getByName('global').fetch(request);
    }
    return appHandler.fetch(request, env, context);
  }
};
