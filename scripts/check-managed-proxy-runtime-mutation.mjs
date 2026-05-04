#!/usr/bin/env node

import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { runAsScript, toLine, unwrapExpression } from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src", "extensions"];

const allowedManagedProxyRuntimeMutationCallsites = new Set([
  // Canonical managed proxy lifecycle owns process proxy env/global-agent mutation.
  "src/infra/net/proxy/proxy-lifecycle.ts:113",
  "src/infra/net/proxy/proxy-lifecycle.ts:116",
  "src/infra/net/proxy/proxy-lifecycle.ts:118",
  "src/infra/net/proxy/proxy-lifecycle.ts:119",
  "src/infra/net/proxy/proxy-lifecycle.ts:120",
  "src/infra/net/proxy/proxy-lifecycle.ts:122",
  "src/infra/net/proxy/proxy-lifecycle.ts:125",
  "src/infra/net/proxy/proxy-lifecycle.ts:126",
  "src/infra/net/proxy/proxy-lifecycle.ts:127",
  "src/infra/net/proxy/proxy-lifecycle.ts:312",
  "src/infra/net/proxy/proxy-lifecycle.ts:313",
  "src/infra/net/proxy/proxy-lifecycle.ts:314",
  "src/infra/net/proxy/proxy-lifecycle.ts:315",
  "src/infra/net/proxy/proxy-lifecycle.ts:316",
  "src/infra/net/proxy/proxy-lifecycle.ts:317",
  "src/infra/net/proxy/proxy-lifecycle.ts:318",
  "src/infra/net/proxy/proxy-lifecycle.ts:319",
  "src/infra/net/proxy/proxy-lifecycle.ts:329",
  "src/infra/net/proxy/proxy-lifecycle.ts:330",
  "src/infra/net/proxy/proxy-lifecycle.ts:331",
  "src/infra/net/proxy/proxy-lifecycle.ts:332",
  "src/infra/net/proxy/proxy-lifecycle.ts:333",
  "src/infra/net/proxy/proxy-lifecycle.ts:334",
  "src/infra/net/proxy/proxy-lifecycle.ts:335",
  "src/infra/net/proxy/proxy-lifecycle.ts:336",
  "src/infra/net/proxy/proxy-lifecycle.ts:369",
  "src/infra/net/proxy/proxy-lifecycle.ts:376",

  // Browser CDP loopback control-plane helper leases NO_PROXY only for localhost/loopback CDP URLs.
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:87",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:88",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:120",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:122",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:125",
  "extensions/browser/src/browser/cdp-proxy-bypass.ts:127",
]);

const forbiddenEnvKeys = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "GLOBAL_AGENT_HTTP_PROXY",
  "GLOBAL_AGENT_HTTPS_PROXY",
  "GLOBAL_AGENT_NO_PROXY",
  "OPENCLAW_PROXY_ACTIVE",
]);

const forbiddenGlobalAgentKeys = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);

function stringLiteralText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function envMutationTarget(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const object = unwrapExpression(unwrapped.expression);
    if (ts.isPropertyAccessExpression(object)) {
      const base = unwrapExpression(object.expression);
      if (ts.isIdentifier(base) && base.text === "process" && object.name.text === "env") {
        const key = unwrapped.name.text;
        return forbiddenEnvKeys.has(key) ? unwrapped : null;
      }
    }
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const object = unwrapExpression(unwrapped.expression);
    if (ts.isPropertyAccessExpression(object)) {
      const base = unwrapExpression(object.expression);
      if (ts.isIdentifier(base) && base.text === "process" && object.name.text === "env") {
        const key = stringLiteralText(unwrapExpression(unwrapped.argumentExpression));
        return key && forbiddenEnvKeys.has(key) ? unwrapped : null;
      }
    }
  }
  return null;
}

function globalAgentExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const object = unwrapExpression(unwrapped.expression);
    if (
      ts.isIdentifier(object) &&
      object.text === "global" &&
      unwrapped.name.text === "GLOBAL_AGENT"
    ) {
      return unwrapped;
    }
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const object = unwrapExpression(unwrapped.expression);
    const key = stringLiteralText(unwrapExpression(unwrapped.argumentExpression));
    if (ts.isIdentifier(object) && object.text === "global" && key === "GLOBAL_AGENT") {
      return unwrapped;
    }
  }
  return null;
}

function globalAgentMutationTarget(expression) {
  const unwrapped = unwrapExpression(expression);
  if (globalAgentExpression(unwrapped)) {
    return unwrapped;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const object = unwrapExpression(unwrapped.expression);
    if (globalAgentExpression(object)) {
      const key = unwrapped.name.text;
      return forbiddenGlobalAgentKeys.has(key) ? unwrapped : null;
    }
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const object = unwrapExpression(unwrapped.expression);
    if (globalAgentExpression(object)) {
      const key = stringLiteralText(unwrapExpression(unwrapped.argumentExpression));
      return key && forbiddenGlobalAgentKeys.has(key) ? unwrapped : null;
    }
  }
  return null;
}

function mutationTarget(expression) {
  return envMutationTarget(expression) ?? globalAgentMutationTarget(expression);
}

function deleteTarget(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isDeleteExpression(unwrapped) ? mutationTarget(unwrapped.expression) : null;
}

function assignmentTarget(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isBinaryExpression(unwrapped) && ts.isAssignmentOperator(unwrapped.operatorToken.kind)) {
    return mutationTarget(unwrapped.left);
  }
  return null;
}

function mutatingCallTarget(expression) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isCallExpression(unwrapped)) {
    return null;
  }
  const callee = unwrapExpression(unwrapped.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }
  const method = callee.name.text;
  if (method !== "defineProperty" && method !== "assign") {
    return null;
  }
  const receiver = unwrapExpression(callee.expression);
  if (!ts.isIdentifier(receiver) || receiver.text !== "Object") {
    return null;
  }
  const first = unwrapped.arguments[0] ? unwrapExpression(unwrapped.arguments[0]) : null;
  if (!first) {
    return null;
  }
  if (method === "assign") {
    return (
      globalAgentExpression(first) ??
      (ts.isPropertyAccessExpression(first) && first.name.text === "env" ? first : null)
    );
  }
  const keyArg = unwrapped.arguments[1]
    ? stringLiteralText(unwrapExpression(unwrapped.arguments[1]))
    : null;
  if (keyArg && ts.isPropertyAccessExpression(first)) {
    const base = unwrapExpression(first.expression);
    if (ts.isIdentifier(base) && base.text === "process" && first.name.text === "env") {
      return forbiddenEnvKeys.has(keyArg) ? first : null;
    }
  }
  if (keyArg && globalAgentExpression(first)) {
    return forbiddenGlobalAgentKeys.has(keyArg) ? first : null;
  }
  return mutationTarget(first);
}

export function findManagedProxyRuntimeMutationLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    const match = assignmentTarget(node) ?? deleteTarget(node) ?? mutatingCallTarget(node);
    if (match) {
      lines.push(toLine(sourceFile, match));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
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
    findCallLines: findManagedProxyRuntimeMutationLines,
    allowCallsite: (callsite) => allowedManagedProxyRuntimeMutationCallsites.has(callsite),
    header: "Found unmanaged managed-proxy runtime mutation:",
    footer:
      "Only proxy lifecycle code may mutate GLOBAL_AGENT or proxy-related process.env runtime state.",
  });
}

runAsScript(import.meta.url, main);
