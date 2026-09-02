// S4a (#113): a REAL HTTP server standing in for Lark's Open API, written before
// the driver.
//
// The S11 precedent (`__testHelpers__/smtp/server.js`) and its ruling apply
// unchanged: a fixture server, never `jest.mock`. A mock shallow enough to assert
// "listPrincipals was called" cannot assert the property that matters here, which is
// what the driver did with a page sequence it did not control — whether it stopped,
// retried, double-counted, or returned a short list. Mocking the transport removes
// the sequence.
//
// The failure this fixture exists to reproduce is not a 500. It is TL-1's RF-1:
// pages 1..36 succeed, page 37 fails, pages 38..100 would have succeeded. A driver
// that catches and returns what it collected produces 36 pages of "the truth" — and
// S4b, reading absence as departure, would deactivate everyone in pages 37..100. So
// the fixture has to be able to fail in the MIDDLE, not at the edges: failing on
// page 1 or the last page is green against that bug.

const http = require("http");

const DEFAULT_PAGE_SIZE = 50; // Lark's documented maximum

/**
 * @param {{
 *   users?: number,            total principals to serve
 *   departments?: number,      total departments to serve
 *   pageSize?: number,
 *   failOnPage?: number|null,  1-based page that fails
 *   failMode?: "500"|"429"|"drop"|"hang",
 *   failTimes?: number,        how many times that page fails before succeeding
 *   tenantToken?: string,
 * }} options
 */
async function startLarkFixture(options = {}) {
  const {
    users = 0,
    departments = 0,
    pageSize = DEFAULT_PAGE_SIZE,
    failOnPage = null,
    failMode = "500",
    failTimes = Infinity,
    tenantToken = "t-fixture-token",
    // RF-6: serve a `page_token` on EVERY page, including the last one where
    // `has_more` is false. Real APIs do this, and a driver that loops on "is there a
    // token" rather than on `has_more` never terminates — or worse, re-reads the
    // final page forever. The default fixture omits the trailing token, so that
    // guard had no test until this switch existed.
    alwaysToken = false,
    // #138: hang the TOKEN endpoint rather than a page. Separate switch because the
    // token call happens before any page is requested, so `failOnPage` cannot reach it.
    hangToken = false,
    // #138: what the 429 advertises. Lark can send a very large value, and honouring
    // it verbatim parks the run for that long — the same stalled-lease outcome as a
    // hung socket, arriving through a header instead of a socket.
    retryAfterSeconds = 1,
  } = options;

  // Every request, in order. Assertions about retries and skipped pages are made
  // against THIS rather than against a call count, because "36 requests" cannot
  // distinguish "read 36 pages" from "read page 36 thirty-six times".
  const requests = [];
  let failuresServed = 0;
  // Sockets held open by `failMode: "hang"`, destroyed on close so the server can
  // actually shut down and jest does not hang on an open handle.
  const hungSockets = [];

  const principal = (i) => ({
    // `user_id` is the subject (recon §7.2). `open_id` is served too — deliberately,
    // and with a value that would be obviously wrong to key on — so a driver that
    // reaches for it produces a visibly incorrect subject rather than something
    // plausible.
    user_id: `u-${String(i).padStart(5, "0")}`,
    open_id: `ou_MUST_NOT_BE_USED_${i}`,
    union_id: `on_${i}`,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    enterprise_email: i % 3 === 0 ? "" : `user${i}@corp.example.com`,
    status: { is_activated: true },
    department_ids: [`od-${i % Math.max(1, departments || 1)}`],
  });

  const department = (i) => ({
    department_id: `od-${i}`,
    name: `Department ${i}`,
    parent_department_id: i === 0 ? "0" : "od-0",
  });

  const pageOf = (total, index, build) => {
    const start = (index - 1) * pageSize;
    return Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, k) =>
      build(start + k)
    );
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const pageToken = url.searchParams.get("page_token");
    // `page_token` is an opaque cursor to the driver; the fixture encodes the page
    // number in it. A driver that invents its own paging (an offset it computes
    // rather than the token it was handed) desynchronises here rather than working
    // by luck.
    const page = pageToken ? Number(pageToken) : 1;
    requests.push({ path: url.pathname, page, at: Date.now() });

    if (url.pathname.endsWith("/auth/v3/tenant_access_token/internal")) {
      // #138: the token call is a THIRD unbounded fetch, on the path every
      // enumeration goes through first. A timeout on `_page` alone would leave a
      // hung token endpoint stalling the run before a single page is requested, so
      // it needs its own switch to be testable at all.
      if (hangToken) {
        hungSockets.push(request.socket);
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(
        JSON.stringify({ code: 0, tenant_access_token: tenantToken, expire: 7200 })
      );
    }

    const isUsers = url.pathname.includes("/contact/v3/users");
    const isDepartments = url.pathname.includes("/contact/v3/departments");
    if (!isUsers && !isDepartments) {
      response.writeHead(404, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ code: 99991663, msg: "not found" }));
    }

    if (page === failOnPage && failuresServed < failTimes) {
      failuresServed += 1;
      if (failMode === "drop") return request.socket.destroy();
      // #138: ACCEPT the connection and never answer. Distinct from "drop" in the
      // only way that matters here — a destroyed socket rejects the fetch promptly,
      // so a driver with no timeout looks fine against it. A server that holds the
      // connection open is what a hung Lark tenant actually does, and without a
      // request timeout the driver waits forever: the run keeps its job lease alive
      // only while the process lives, and a stalled process loses the lease to a
      // second worker that starts a concurrent apply.
      //
      // The socket is kept referenced so Node does not exit under it, and closed by
      // `close()` below rather than here.
      if (failMode === "hang") {
        hungSockets.push(request.socket);
        return; // no writeHead, no end — deliberately
      }
      if (failMode === "429") {
        response.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfterSeconds),
        });
        return response.end(JSON.stringify({ code: 99991400, msg: "rate limited" }));
      }
      response.writeHead(500, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ code: 99999, msg: "internal error" }));
    }

    const total = isUsers ? users : departments;
    const items = pageOf(total, page, isUsers ? principal : department);
    const hasMore = page * pageSize < total;

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        code: 0,
        data: {
          items,
          has_more: hasMore,
          // With `alwaysToken`, the final page still carries a token — `has_more`
          // is the only thing saying the enumeration is over.
          page_token: hasMore || alwaysToken ? String(page + 1) : undefined,
        },
      })
    );
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    host: "127.0.0.1",
    port: server.address().port,
    get baseUrl() {
      return `http://127.0.0.1:${server.address().port}`;
    },
    /** Every request in order — assert page sequences against this, not a count. */
    requests,
    /** Pages actually requested, in order, for the users endpoint. */
    get userPages() {
      return requests
        .filter((r) => r.path.includes("/contact/v3/users"))
        .map((r) => r.page);
    },
    get failuresServed() {
      return failuresServed;
    },
    async close() {
      // Hung sockets first: `server.close` waits for open connections, so a held
      // socket would make close() itself hang — the fixture reproducing the bug it
      // tests for.
      for (const socket of hungSockets) socket.destroy();
      hungSockets.length = 0;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startLarkFixture, DEFAULT_PAGE_SIZE };
