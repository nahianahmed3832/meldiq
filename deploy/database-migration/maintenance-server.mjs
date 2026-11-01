// No database, credentials, application writers or request logging. Bind through a loopback-only Docker port.
import http from "node:http";
import fs from "node:fs";
const config = JSON.parse(fs.readFileSync("/review/maintenance-public.json", "utf8"));
const origins = new Set(config.origins);
const message = "Meldiq is undergoing maintenance. Please try again shortly.";
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("retry-after", "300");
  response.setHeader("x-content-type-options", "nosniff");
  if (origins.has(request.headers.origin)) {
    response.setHeader("access-control-allow-origin", request.headers.origin);
    response.setHeader("vary", "Origin");
    if (request.method === "OPTIONS") {
      response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE");
      response.setHeader("access-control-allow-headers", "authorization, content-type, x-meldiq-client");
      response.writeHead(204); response.end(); request.resume(); return;
    }
  }
  const path = request.url?.split("?")[0];
  if (request.method === "GET" && path === "/v1/server-info") {
    response.writeHead(200);
    response.end(JSON.stringify({ ...config.serverInfo, maintenance: { enabled: true, message } }));
  } else if (request.method === "GET" && path === "/v2/site/details") {
    response.writeHead(200); response.end(JSON.stringify(config.siteDetails));
  } else {
    response.writeHead(503);
    response.end(JSON.stringify({ error: { code: "maintenance", message } }));
  }
  request.resume();
});
server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.maxHeadersCount = 64;
server.listen(8080, "0.0.0.0");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
