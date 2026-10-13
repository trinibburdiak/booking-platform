import 'reflect-metadata';
import 'dotenv/config';
import { createGatewayApp } from './app';

void (async () => {
  const { app } = await createGatewayApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`api-gateway en http://localhost:${port}/api/v1`);
})();
