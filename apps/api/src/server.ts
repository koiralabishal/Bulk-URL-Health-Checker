import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { env } from "./env";
import { registerBatchesRoutes } from "./routes";
import { registerSocketRoutes } from "./ws";

export async function buildServer() {
  const app = Fastify({ logger: { level: "info" } });

  await app.register(cors, { origin: true });
  await app.register(multipart);
  await app.register(websocket);

  app.get("/", async () => ({ status: "ok", uptime: process.uptime() }));

  await registerBatchesRoutes(app);
  await registerSocketRoutes(app);

  return app;
}

export async function start() {
  const app = await buildServer();
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`API listening on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}