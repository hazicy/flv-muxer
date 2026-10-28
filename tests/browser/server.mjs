import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { rollup } from "rollup";
import resolve from "@rollup/plugin-node-resolve";
import ts from "typescript";

// Bundle current source in memory; do not depend on a pre-existing dist build.
const bundle = await rollup({
  input: "src/main.ts",
  onwarn(warning, warn) {
    // TypeScript's ES2020 private-field helpers probe top-level `this`; undefined is correct.
    if (warning.code !== "THIS_IS_UNDEFINED") warn(warning);
  },
  plugins: [
    resolve({ extensions: [".ts", ".js"] }),
    {
      name: "browser-test-typescript",
      transform(code, id) {
        if (!id.endsWith(".ts")) return null;

        return ts.transpileModule(code, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText;
      },
    },
  ],
});
const { output } = await bundle.generate({ format: "es" });
await bundle.close();

const fixture = await readFile(
  new URL("./fixture.js", import.meta.url),
  "utf8"
);
const routes = new Map([
  [
    "/",
    [
      "text/html",
      '<!doctype html><title>FLV browser tests</title><script type="module" src="/fixture.js"></script>',
    ],
  ],
  ["/muxer.js", ["text/javascript", output[0].code]],
  ["/fixture.js", ["text/javascript", fixture]],
]);

const server = createServer((request, response) => {
  const route = routes.get(request.url);
  response.writeHead(route ? 200 : 404, {
    "Content-Type": route?.[0] ?? "text/plain",
  });
  response.end(route?.[1] ?? "Not found");
});

server.listen(4179, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
