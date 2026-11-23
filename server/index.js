// Entry point: `npm start`
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const trustProxy = process.env.TRUST_PROXY ? (Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY) : false;

const { server, close } = createApp({
  dbFile: process.env.DB_FILE || undefined,
  trustProxy,
});

server.listen(port, host, () => {
  console.log(`♞ Chess server listening on http://localhost:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('Shutting down…');
    server.close();
    await close();
    process.exit(0);
  });
}
