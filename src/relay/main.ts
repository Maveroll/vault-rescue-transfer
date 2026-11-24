import { createRelay } from './server';
const server = createRelay(process.env.RELAY_KEY ?? '');
const port = Number(process.env.PORT ?? 8787);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Vault Rescue relay listening on ${port}`));
for (const event of ['SIGTERM', 'SIGINT'] as const) process.on(event, () => {
  server.closeAllConnections(); server.close();
});
