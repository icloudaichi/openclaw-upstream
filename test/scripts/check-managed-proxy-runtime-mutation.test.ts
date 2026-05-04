import { describe, expect, it } from "vitest";
import { findManagedProxyRuntimeMutationLines } from "../../scripts/check-managed-proxy-runtime-mutation.mjs";

describe("check-managed-proxy-runtime-mutation", () => {
  it("finds assignments and deletes for proxy env vars", () => {
    const source = `
      process.env.HTTP_PROXY = "http://proxy";
      process.env["HTTPS_PROXY"] = "http://proxy";
      delete process.env.NO_PROXY;
      delete process.env["GLOBAL_AGENT_NO_PROXY"];
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([2, 3, 4, 5]);
  });

  it("finds GLOBAL_AGENT mutations", () => {
    const source = `
      global.GLOBAL_AGENT = {};
      global.GLOBAL_AGENT.NO_PROXY = "localhost";
      global["GLOBAL_AGENT"].HTTP_PROXY = "http://proxy";
      delete global.GLOBAL_AGENT.HTTPS_PROXY;
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([2, 3, 4, 5]);
  });

  it("finds Object.assign and Object.defineProperty mutations", () => {
    const source = `
      Object.assign(global.GLOBAL_AGENT, { NO_PROXY: "localhost" });
      Object.assign(process.env, { NO_PROXY: "localhost" });
      Object.defineProperty(process.env, "HTTP_PROXY", { value: "http://proxy" });
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([2, 3, 4]);
  });

  it("ignores reads, unrelated env vars, comments, and strings", () => {
    const source = `
      const current = process.env.HTTP_PROXY;
      process.env.PATH = "/usr/bin";
      const text = "process.env.NO_PROXY = '*'";
      // global.GLOBAL_AGENT.NO_PROXY = '*';
    `;

    expect(findManagedProxyRuntimeMutationLines(source)).toEqual([]);
  });
});
