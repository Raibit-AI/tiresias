// SPDX-License-Identifier: Apache-2.0
// N-10: safe fetching. Note: the private-address block is ON in this file
// except where a test turns the test-only flag on for a moment.
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { afterEach, test } from "node:test";
import { freshHome, html, serve, timing } from "./helper.js";

freshHome();
delete process.env.TIRESIAS_ALLOW_PRIVATE;
const { isPrivateAddress, safeFetch, withSignal, SafetyError, FetchError } = await import("../safety.js");
const engine = await import("../engine.js");

const realLookup = dns.lookup;
afterEach(() => {
  (dns as any).lookup = realLookup;
  delete process.env.TIRESIAS_ALLOW_PRIVATE;
  delete process.env.TIRESIAS_MAX_BYTES;
});

test("private, loopback, link-local, CGNAT, mapped and special-use addresses are recognized", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
    "64:ff9b::7f00:1", "2002:7f00:1::", "::a00:1"])
    assert.equal(isPrivateAddress(ip), true, ip);
  // Codex #2: site-local, local-use NAT64, and other non-global families
  for (const ip of ["fec0::1", "64:ff9b:1::a00:1", "2001::1", "2001:db8::1", "3fff::1", "100::1", "5f00::1", "2001:1::1"])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::", "2001:4860:4860::8888"])
    assert.equal(isPrivateAddress(ip), false, ip);
});

test("read refuses private addresses without the test flag", async () => {
  for (const url of ["http://127.0.0.1:9/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fec0::1]/"]) {
    const r = await engine.read(url);
    assert.equal(r.status, "refused", url);
    assert.match(r.message ?? "", /private or internal/);
  }
});

test("only http and https are allowed", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "http://user:pw@example.com/"]) {
    assert.equal((await engine.read(url)).status, "refused", url);
  }
});

test("a redirect to a private address is refused", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1"; // lets us reach the local test server for hop one only
  const s = await serve((req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  try {
    await assert.rejects(
      safeFetch(s.url + "/start", {
        // After hop one is checked, turn the block back on so hop two is judged for real.
        beforeRequest: async () => void delete process.env.TIRESIAS_ALLOW_PRIVATE,
      }),
      (e: any) => e instanceof SafetyError && e.detail === "169.254.169.254",
    );
  } finally {
    await s.close();
  }
});

test("Codex #1: DNS rebinding. The checked address is the address used, in one lookup", async () => {
  // A hostile resolver answers private on the lookup the socket uses. If the
  // check were a separate earlier lookup, it could have answered public.
  let calls = 0;
  (dns as any).lookup = async () => {
    calls++;
    return [{ address: "127.0.0.1", family: 4 }];
  };
  await assert.rejects(safeFetch("http://rebind.test:8081/"), (e: any) => e instanceof SafetyError && /private or internal/.test(e.message));
  assert.equal(calls, 1);
  // A mixed answer (one public, one private) is refused as a whole.
  (dns as any).lookup = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }];
  await assert.rejects(safeFetch("http://mixed.test/"), SafetyError);
  // And the redirect case: hop two resolves to a private address.
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => {
    res.writeHead(302, { location: "http://evil.test/" });
    res.end();
  });
  try {
    (dns as any).lookup = async (h: string) => [{ address: "127.0.0.1", family: 4 }];
    await assert.rejects(
      safeFetch(s.url.replace("127.0.0.1", "start.test") + "/", { beforeRequest: async (u) => void (u.hostname === "evil.test" && delete process.env.TIRESIAS_ALLOW_PRIVATE) }),
      SafetyError,
    );
  } finally {
    await s.close();
  }
});

test("the socket really connects to the address the lookup returned (pinning)", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => html(res, "pinned ok"));
  let calls = 0;
  (dns as any).lookup = async () => (calls++, [{ address: "127.0.0.1", family: 4 }]);
  try {
    const port = new URL(s.url).port;
    const r = await safeFetch(`http://pinned.test:${port}/`);
    assert.equal(r.body, "pinned ok");
    assert.equal(calls, 1);
    assert.equal(s.hits[0].headers.host, `pinned.test:${port}`); // the name is kept for Host and TLS
  } finally {
    await s.close();
  }
});

test("more than 5 redirects stops", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => {
    res.writeHead(302, { location: "/loop" });
    res.end();
  });
  try {
    await assert.rejects(safeFetch(s.url + "/loop"), (e: Error) => e instanceof FetchError && /redirects/.test(e.message));
    assert.equal(s.hits.length, 6);
  } finally {
    await s.close();
  }
});

test("body over the cap is aborted", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => html(res, "x".repeat(50_000)));
  try {
    await assert.rejects(safeFetch(s.url + "/", { maxBytes: 1000 }), (e: Error) => e instanceof FetchError && /larger than/.test(e.message));
    const part = await safeFetch(s.url + "/", { maxBytes: 1000, truncate: true });
    assert.equal(part.body.length, 1000);
    assert.equal(part.truncated, true);
  } finally {
    await s.close();
  }
});

test("Codex #24: an invalid size setting is rejected, not silently unlimited", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => html(res, "x".repeat(50_000)));
  try {
    process.env.TIRESIAS_MAX_BYTES = "5MB";
    await assert.rejects(safeFetch(s.url + "/"), /positive whole number/);
    await assert.rejects(safeFetch(s.url + "/", { maxBytes: Number.NaN }), /positive whole number/);
    await assert.rejects(safeFetch(s.url + "/", { maxBytes: -1 }), /positive whole number/);
    assert.equal(s.hits.length, 0); // rejected before any networking
  } finally {
    await s.close();
  }
});

test("a compressed bomb is capped on the decoded size", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const zlib = await import("node:zlib");
  const gz = zlib.gzipSync(Buffer.alloc(2_000_000, 97)); // ~2 KB on the wire, 2 MB decoded
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    res.end(gz);
  });
  try {
    await assert.rejects(safeFetch(s.url + "/", { maxBytes: 100_000 }), (e: Error) => e instanceof FetchError && /larger than/.test(e.message));
    const ok = await safeFetch(s.url + "/", { maxBytes: 3_000_000 });
    assert.equal(ok.body.length, 2_000_000);
  } finally {
    await s.close();
  }
});

test("v0.7 integration round 1: a redirect whose headers cross the connection cap ends the whole fetch", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => {
    if (req.url === "/ok") return html(res, "<p>small</p>");
    // One write: the status line, big headers and the end of the response arrive in the read that passes the cap.
    res.writeHead(302, { location: "/ok", "x-pad": "a".repeat(4000) });
    res.end();
  });
  try {
    await assert.rejects(safeFetch(s.url + "/", { maxBytes: 100_000, wireBytes: 500 }), (e: any) => e instanceof FetchError && e.code === "too_large");
    assert.ok(!s.hits.some((h) => h.path === "/ok"), "the next hop is never requested once the cap is passed");
  } finally {
    await s.close();
  }
});

test("v0.7 integration round 2: headers completed by the read that passes the cap still reach onHeaders (Retry-After)", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const s = await serve((req, res) => {
    res.writeHead(429, { "retry-after": "120", "x-pad": "a".repeat(4000) });
    res.end();
  });
  try {
    const seen: number[] = [];
    await assert.rejects(
      safeFetch(s.url + "/", { maxBytes: 100_000, wireBytes: 500, onHeaders: (h: any) => void seen.push(h.status) }),
      (e: any) => e instanceof FetchError && e.code === "too_large",
    );
    assert.deepEqual(seen, [429]);
  } finally {
    await s.close();
  }
});

test("Codex #11: the deadline covers DNS, and cancellation stops a call", async () => {
  (dns as any).lookup = () => new Promise(() => {}); // a lookup that never answers
  const t0 = Date.now();
  await assert.rejects(safeFetch("http://slow-dns.test/", { timeoutMs: 300 }), (e: any) => e instanceof FetchError && e.code === "timeout");
  timing(Date.now() - t0 < 3000);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(withSignal(ctl.signal, () => safeFetch("http://slow-dns.test/")), (e: any) => e instanceof FetchError && e.code === "cancelled");
});

test("Codex #25: charset from a meta tag and a BOM is honored", async () => {
  process.env.TIRESIAS_ALLOW_PRIVATE = "1";
  const latin = Buffer.from('<meta charset="iso-8859-1"><p>caf\xe9</p>', "latin1");
  const s = await serve((req, res) => {
    if (req.url === "/bom") {
      res.writeHead(200, { "content-type": "text/html" });
      return void res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<p>café</p>", "utf16le")]));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(latin);
  });
  try {
    assert.match((await safeFetch(s.url + "/")).body, /café/);
    assert.match((await safeFetch(s.url + "/bom")).body, /café/);
  } finally {
    await s.close();
  }
});

test("HTTPS: the socket goes to the pinned address and TLS still checks the site's name (v0.5.1)", async () => {
  // A throwaway certificate for pinned.test, made by openssl, trusted by a child process only.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync, spawn } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiresias-tls-"));
  const key = path.join(dir, "k.pem");
  const cert = path.join(dir, "c.pem");
  const gen = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=pinned.test", "-addext", "subjectAltName=DNS:pinned.test"], { encoding: "utf8" });
  if (gen.status !== 0) return; // no openssl on this machine: nothing to test with
  const https = await import("node:https");
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_q, res) => (res.writeHead(200, { "content-type": "text/plain" }), res.end("over tls")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const mod = path.resolve("dist/safety.js");
  const script = `
    const dns = (await import("node:dns/promises")).default;
    let calls = 0;
    dns.lookup = async () => (calls++, [{ address: "127.0.0.1", family: 4 }]);
    const s = await import(${JSON.stringify(mod)});
    const out = {};
    try { const r = await s.safeFetch("https://pinned.test:${port}/"); out.ok = r.body; } catch (e) { out.ok = "ERR " + e.message; }
    try { await s.safeFetch("https://other.test:${port}/"); out.wrong = "connected"; } catch (e) { out.wrong = "refused"; }
    out.calls = calls;
    console.log(JSON.stringify(out));`;
  try {
    const out = await new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, TIRESIAS_ALLOW_PRIVATE: "1", NODE_TEST_CONTEXT: "child" } });
      let o = "";
      c.stdout.on("data", (d) => (o += d));
      c.on("close", () => resolve(o));
    });
    const r = JSON.parse(out.trim());
    assert.equal(r.ok, "over tls", "connected to the pinned address, with the certificate checked for pinned.test");
    assert.equal(r.wrong, "refused", "a certificate for another name is refused even at the same address");
    assert.equal(r.calls, 2, "one lookup per request: the checked address is the one used");
  } finally {
    server.close();
  }
});
