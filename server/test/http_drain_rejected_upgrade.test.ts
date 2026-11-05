import { expect, it } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { installHttpDrain } from '../src/app/httpDrain.js';

it('closes a rejected upgrade when writer admission fails before websocket hooks run', async () => {
  const app = Fastify();
  installHttpDrain(app);
  // The writer authority hook precedes registration of the websocket plugin.
  app.addHook('onRequest', async (_req, reply) => {
    return reply.code(503).send({ error: 'writer unavailable' });
  });
  await app.register(websocket);
  app.get('/ws', { websocket: true }, () => {});
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as net.AddressInfo).port;
  const socket = net.connect(port, '127.0.0.1');
  let body = '';
  socket.on('data', chunk => { body += chunk.toString(); });
  try {
    await once(socket, 'connect');
    socket.write('GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    await once(socket, 'data');
    expect(body).toContain('503 Service Unavailable');
    expect(body).toContain('{"error":"writer unavailable"}');
    const closing = app.close();
    expect(await Promise.race([closing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1000))]), 'a rejected upgrade must not retain the HTTP listener').toBe(true);
  } finally {
    socket.destroy();
    await app.close();
  }
});

it('keeps a successful websocket usable until graceful shutdown', async () => {
  const app = Fastify();
  installHttpDrain(app);
  await app.register(websocket);
  app.get('/ws', { websocket: true }, socket => {
    socket.on('message', data => socket.send(data));
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as net.AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await once(socket, 'open');
    const echoed = once(socket, 'message');
    socket.send('accepted upgrade remains active');
    expect(String((await echoed)[0])).toBe('accepted upgrade remains active');
    const closed = once(socket, 'close');
    await app.close();
    await closed;
  } finally {
    socket.terminate();
    await app.close();
  }
});
