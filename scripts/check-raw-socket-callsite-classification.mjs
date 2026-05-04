#!/usr/bin/env node

import ts from "typescript";
import { bundledPluginCallsite } from "./lib/bundled-plugin-paths.mjs";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src", "extensions"];

// Managed-proxy raw-socket classification allowlist.
// Each entry is intentionally a concrete callsite so new raw socket egress fails until reviewed.
const allowedRawSocketCallsites = new Set([
  // Local loopback readiness probe for SSH tunnels.
  "src/infra/ssh-tunnel.ts:80",

  // Local Unix-domain socket IPC client.
  "src/infra/jsonl-socket.ts:35",

  // Managed HTTP CONNECT tunnel helper used by APNs and proxy validation.
  "src/infra/net/http-connect-tunnel.ts:117",
  "src/infra/net/http-connect-tunnel.ts:123",
  "src/infra/net/http-connect-tunnel.ts:268",

  // APNs HTTP/2 wrapper: direct only when managed proxy is inactive; tunneled when active.
  "src/infra/push-apns-http2.ts:74",
  "src/infra/push-apns-http2.ts:85",

  // Debug proxy CONNECT internals. PR #77010 guards this path while managed proxy mode is active.
  "src/proxy-capture/proxy-server.ts:266",

  // QA-lab tunnel helper used for local lab diagnostics.
  bundledPluginCallsite("qa-lab", "src/lab-server-ui.ts", 207),
  bundledPluginCallsite("qa-lab", "src/lab-server-ui.ts", 212),

  // IRC is a raw TCP/TLS channel and is documented as outside managed HTTP proxy coverage.
  bundledPluginCallsite("irc", "src/client.ts", 124),
  bundledPluginCallsite("irc", "src/client.ts", 129),
]);

const rawModuleSpecifiers = new Map([
  ["node:net", "net"],
  ["net", "net"],
  ["node:tls", "tls"],
  ["tls", "tls"],
  ["node:http2", "http2"],
  ["http2", "http2"],
]);

function unwrapInitializer(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isAwaitExpression(unwrapped)) {
    return unwrapExpression(unwrapped.expression);
  }
  return unwrapped;
}

function collectRawModuleAliases(sourceFile) {
  const aliases = new Map();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleKind = rawModuleSpecifiers.get(node.moduleSpecifier.text);
      const clause = node.importClause;
      if (moduleKind && clause) {
        if (clause.name) {
          aliases.set(clause.name.text, moduleKind);
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          aliases.set(clause.namedBindings.name.text, moduleKind);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapInitializer(node.initializer);
      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(unwrapExpression(initializer.expression)) &&
        unwrapExpression(initializer.expression).text === "require" &&
        initializer.arguments.length === 1 &&
        ts.isStringLiteral(initializer.arguments[0])
      ) {
        const moduleKind = rawModuleSpecifiers.get(initializer.arguments[0].text);
        if (moduleKind) {
          aliases.set(node.name.text, moduleKind);
        }
      }
      if (
        ts.isCallExpression(initializer) &&
        initializer.expression.kind === ts.SyntaxKind.ImportKeyword &&
        initializer.arguments.length === 1 &&
        ts.isStringLiteral(initializer.arguments[0])
      ) {
        const moduleKind = rawModuleSpecifiers.get(initializer.arguments[0].text);
        if (moduleKind) {
          aliases.set(node.name.text, moduleKind);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function rawSocketCallee(expression, aliases) {
  const callee = unwrapExpression(expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "connect") {
    return null;
  }
  const receiver = unwrapExpression(callee.expression);
  if (!ts.isIdentifier(receiver)) {
    return null;
  }
  const moduleKind = aliases.get(receiver.text);
  return moduleKind === "net" || moduleKind === "tls" || moduleKind === "http2" ? callee : null;
}

export function findRawSocketClientCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const aliases = collectRawModuleAliases(sourceFile);
  return collectCallExpressionLines(ts, sourceFile, (node) =>
    rawSocketCallee(node.expression, aliases),
  );
}

export async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots,
    extraTestSuffixes: [
      ".browser.test.ts",
      ".node.test.ts",
      ".live.test.ts",
      ".e2e.test.ts",
      ".integration.test.ts",
    ],
    findCallLines: findRawSocketClientCallLines,
    skipRelativePath: (relPath) => relPath.includes("/test-support/"),
    allowCallsite: (callsite) => allowedRawSocketCallsites.has(callsite),
    header: "Found unclassified raw socket client calls:",
    footer:
      "Classify raw net/tls/http2 egress as managed/proxied, local-only, diagnostic guarded, or documented unsupported before adding callsites.",
  });
}

runAsScript(import.meta.url, main);
