import { buildRelay } from './server.ts';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const dbPath = process.env.RELAY_DB ?? 'relay.db';

const { app } = buildRelay({ dbPath, logger: true });
await app.listen({ port, host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
