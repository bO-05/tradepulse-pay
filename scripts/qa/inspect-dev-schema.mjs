import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "esbuild";

// Read schema metadata only. Never read records, export credentials, or enable production access.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deployment = "exuberant-boar-323";
if (process.env.CONVEX_DEPLOY_KEY) throw new Error("Unset CONVEX_DEPLOY_KEY before this dev-only inspection.");
const output = path.join(root, "evidence");
await fs.mkdir(output, { recursive: true });
const client = new Client({ name: "tradepulse-dev-schema-inspection", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(root, "node_modules/convex/bin/main.js"), "mcp", "start",
    "--project-dir", root, "--deployment", deployment,
    "--disable-tools", "data,envGet,envList,envRemove,envSet,functionSpec,insights,logs,run,runOneoffQuery",
  ],
  stderr: "inherit",
});

function payload(result) {
  if (result.isError) throw new Error("Convex schema inspection failed.");
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Convex returned no schema metadata.");
  return JSON.parse(text);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

try {
  await client.connect(transport);
  const status = payload(await client.callTool({ name: "status", arguments: { projectDir: root } }));
  const target = status.availableDeployments.find((item) => item.url === `https://${deployment}.convex.cloud`);
  if (!target || target.kind === "prod") throw new Error("Expected development target was not resolved.");
  const remote = payload(await client.callTool({ name: "tables", arguments: { deploymentSelector: target.deploymentSelector } }));
  await fs.writeFile(path.join(output, "development-schema-metadata.json"), JSON.stringify(remote, null, 2));

  const bundled = await build({
    absWorkingDir: root, entryPoints: ["convex/schema.ts"], bundle: true,
    platform: "node", format: "esm", packages: "external", write: false,
  });
  const modulePath = path.join(output, "local-schema.mjs");
  await fs.writeFile(modulePath, bundled.outputFiles[0].text);
  const { pathToFileURL } = await import("node:url");
  const { default: schema } = await import(pathToFileURL(modulePath).href);
  const local = JSON.parse(schema.export());
  await fs.writeFile(path.join(output, "local-schema-metadata.json"), JSON.stringify(local, null, 2));
  const localTables = new Map(local.tables.map((table) => [table.tableName, table]));
  const differences = [];
  for (const [name, table] of Object.entries(remote.tables)) {
    const current = localTables.get(name);
    if (!current) {
      differences.push({ table: name, difference: "remote-only table" });
    } else if (table.schema && JSON.stringify(canonical(table.schema.documentType)) !== JSON.stringify(canonical(current.documentType))) {
      const remoteFields = table.schema.documentType.value ?? {};
      const localFields = current.documentType.value ?? {};
      const changedFields = [...new Set([...Object.keys(remoteFields), ...Object.keys(localFields)])]
        .filter((key) => JSON.stringify(canonical(remoteFields[key])) !== JSON.stringify(canonical(localFields[key])));
      differences.push({ table: name, difference: "validator differs", changedFields });
    }
  }
  console.log(JSON.stringify({ deployment, differences }, null, 2));
} finally {
  await client.close();
}
