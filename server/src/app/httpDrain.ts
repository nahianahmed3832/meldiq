import type { FastifyInstance } from 'fastify';

/** Requests admitted before close must finish, then relinquish their HTTP keep-alive socket.
 * Node's initial idle sweep cannot reap sockets whose responses are still pending at close().
 * Never use closeAllConnections here: it would interrupt those requests and their durable writes.
 */
export function installHttpDrain(app: FastifyInstance): void {
  let draining = false;
  app.addHook('preClose', async () => {
    draining = true;
    app.log.info({stage:'http-admission-closed'}, 'shutdown stage');
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (draining && !reply.raw.headersSent) reply.header('Connection', 'close');
    return payload;
  });
  app.addHook('onResponse', async () => {
    // Also covers a streaming response whose headers were sent before shutdown began.
    // Defer until Node has marked the completed response idle; active sockets are never closed.
    if (draining) setImmediate(() => app.server.closeIdleConnections());
  });
  app.server.on('close', () => app.log.info({stage:'http-drained'}, 'shutdown stage'));
}
