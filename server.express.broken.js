import express from "express";
import { createRequestHandler } from "@react-router/express";

const app = express();

app.all(
  "/*",
  createRequestHandler({
    build: await import("./build/server/index.js"),
  })
);

const port = Number(process.env.PORT || 3000);

app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Server listening on http://0.0.0.0:${port}`);
});
