import { describe, expect, it } from "vitest";
import { findRawSocketClientCallLines } from "../../scripts/check-raw-socket-callsite-classification.mjs";

describe("check-raw-socket-callsite-classification", () => {
  it("finds raw net, tls, and http2 client calls", () => {
    const source = `
      import net from "node:net";
      import * as tls from "node:tls";
      import http2 from "node:http2";
      net.connect({ host: "example.com", port: 6667 });
      tls.connect({ host: "example.com", port: 6697 });
      http2.connect("https://api.example.com");
    `;

    expect(findRawSocketClientCallLines(source)).toEqual([5, 6, 7]);
  });

  it("ignores comments, strings, and unrelated connect methods", () => {
    const source = `
      // net.connect({ host: "example.com" });
      const text = "tls.connect({ host: 'example.com' })";
      client.connect(transport);
      websocket.connect();
    `;

    expect(findRawSocketClientCallLines(source)).toEqual([]);
  });

  it("handles aliased imports, requires, and dynamic literal imports", () => {
    const source = `
      import * as rawNet from "node:net";
      const rawTls = require("node:tls");
      const rawHttp2 = await import("node:http2");
      rawNet.connect({ host: "127.0.0.1", port: 1 });
      rawTls.connect({ host: "127.0.0.1", port: 1 });
      rawHttp2.connect("https://example.com");
    `;

    expect(findRawSocketClientCallLines(source)).toEqual([5, 6, 7]);
  });

  it("handles parenthesized and asserted module identifiers", () => {
    const source = `
      import net from "node:net";
      import tls from "node:tls";
      import http2 from "node:http2";
      (net as typeof import("node:net")).connect({ host: "127.0.0.1", port: 1 });
      (tls as typeof import("node:tls")).connect({ host: "127.0.0.1", port: 1 });
      (http2 as typeof import("node:http2")).connect("https://example.com");
    `;

    expect(findRawSocketClientCallLines(source)).toEqual([5, 6, 7]);
  });
});
