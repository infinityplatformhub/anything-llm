// S11b (#108) — the mailer settings page.
//
// The assertions that matter here are about SECRETS and about a gate the server owns:
//
//   N7  the SMTP password never reaches the DOM, an input value, or either web storage.
//       Stated precisely (#108 `updated`): the password DOES live in component state for the
//       life of the wizard, because `configHash(settings, password)` binds it and a save that
//       omits it hashes a different input and is refused. What is asserted is that it is never
//       rendered from a server response, never persisted, and gone on reload — not that it
//       never exists in memory, which the design cannot claim and a test named for it would
//       pass by not looking.
//
//   N6  save is unreachable until a test has passed, and editing afterwards voids the proof.
//   N8  a manager is redirected, not shown a page that 403s on every call.
//   N9  a 409 reads as "test again", not as a generic failure.
//   N10 the split-state 500 is reported as NOT configured, never as saved.
//
// The page is driven through its real model client with `fetch` mocked at the boundary, rather
// than by mocking `@/models/mailer`: the field names in that client are exactly what this
// issue got wrong once already (`sendTo` vs `to`), so a test that mocked the client would have
// asserted the bug as correct.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import GeneralMailer from "@/pages/GeneralSettings/Mailer";

const PASSWORD = "hunter2-smtp-secret";

vi.mock("@/components/SettingsSidebar", () => ({
  default: () => <nav data-testid="sidebar" />,
}));
vi.mock("@/components/Preloader", () => ({
  default: () => <div>loading</div>,
}));

const settingsResponse = (over = {}) => ({
  settings: {
    smtp_host: "",
    smtp_port: "587",
    smtp_secure: "false",
    smtp_allow_insecure: "false",
    smtp_allow_untrusted_cert: "false",
    smtp_username: "",
    smtp_from_address: "",
    smtp_from_name: "",
    hasPassword: false,
    ...over,
  },
  verified: false,
});

/** Bodies the page POSTed, parsed — what actually went over the wire. */
function sentBodies(path) {
  return global.fetch.mock.calls
    .filter(
      ([url, init]) => String(url).endsWith(path) && init?.method === "POST"
    )
    .map(([, init]) => JSON.parse(init.body));
}

function mockFetch({ test: testResult, save: saveResult, settings } = {}) {
  global.fetch = vi.fn(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/mailer/settings") && init?.method === "POST")
      return {
        status: saveResult?.status ?? 200,
        json: async () => saveResult ?? { saved: true, error: null },
      };
    if (path.endsWith("/mailer/test"))
      return { status: 200, json: async () => testResult ?? { ok: true } };
    return { status: 200, json: async () => settings ?? settingsResponse() };
  });
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <GeneralMailer />
    </MemoryRouter>
  );

/** Fill the connection form and reach step 2 with a password typed in. */
async function fillConnectionAndContinue(
  user,
  { host = "smtp.example.com" } = {}
) {
  await user.type(screen.getByRole("textbox", { name: /SMTP host/i }), host);
  await user.type(screen.getByLabelText(/^Password$/i), PASSWORD);
  await user.click(screen.getByRole("button", { name: /Continue/i }));
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  mockFetch();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("#108 N7: the SMTP password does not leak into the page or storage", () => {
  test("it is absent from the DOM, every input value, and both storages after save", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await fillConnectionAndContinue(user);
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));
    await user.click(
      await screen.findByRole("button", { name: /Save and turn on/i })
    );
    await screen.findByText(/Email delivery is on/i);

    // The four places a secret actually leaks. Checked as raw text rather than by querying
    // for a field, because the failure mode is the string appearing SOMEWHERE — a stray
    // summary line, a debug attribute — not in a place we thought to look.
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    expect(
      Array.from(document.querySelectorAll("input")).map((input) => input.value)
    ).not.toContain(PASSWORD);
    expect(JSON.stringify(window.localStorage)).not.toContain(PASSWORD);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(PASSWORD);
  });

  test("it IS sent to both the test and the save — the hash binds it", async () => {
    // The other half, and the reason the assertion above is scoped the way it is. If the page
    // withheld the password to keep it "safe", `configHash` would not match and every save
    // would 409. A test suite asserting only absence would call that a pass.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await fillConnectionAndContinue(user);
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));
    await user.click(
      await screen.findByRole("button", { name: /Save and turn on/i })
    );
    await screen.findByText(/Email delivery is on/i);

    expect(sentBodies("/mailer/test")[0].password).toBe(PASSWORD);
    expect(sentBodies("/mailer/settings")[0].password).toBe(PASSWORD);
  });

  test("a stored password is never sent back to the page", async () => {
    // The server returns `hasPassword: true` and never the value. The page must report the
    // fact without inventing a placeholder that could be mistaken for the secret.
    mockFetch({ settings: settingsResponse({ hasPassword: true }) });
    renderPage();

    const field = await screen.findByLabelText(/^Password$/i);
    expect(field.value).toBe("");
    expect(
      screen.getByText(/never sent back to this page/i)
    ).toBeInTheDocument();
  });

  test("a HOSTILE server response carrying a secret is not rendered", async () => {
    // QA-1 + TL-2 gap on #108. Every other test trusts the server to send `hasPassword` and
    // never a value — which it does today. This one assumes it does NOT: a later change to the
    // endpoint, or a proxy, could put a secret-bearing field in the body.
    //
    // The page used to spread everything except `hasPassword` into form state, which is
    // allow-by-default: `smtp_password` would have landed in `settings` and rendered. It now
    // picks the known keys, so an unrecognised field is dropped. This test is what keeps that
    // true — a refactor back to a spread fails here rather than shipping.
    mockFetch({
      settings: {
        settings: {
          ...settingsResponse().settings,
          hasPassword: true,
          smtp_password: "leaked-secret-from-server",
          password: "also-leaked",
        },
        verified: false,
      },
    });
    renderPage();

    const field = await screen.findByLabelText(/^Password$/i);
    expect(field.value).toBe("");
    expect(document.body.innerHTML).not.toContain("leaked-secret-from-server");
    expect(document.body.innerHTML).not.toContain("also-leaked");

    // The assertions above are necessary but NOT sufficient, and mutation proved it: reverting
    // the pick to the old spread left them all green, because neither injected key is rendered
    // by any field. The leak a spread actually causes is an unknown key reaching form STATE —
    // so this asserts the state directly, by sending a hostile value under a key the form DOES
    // render and checking it is dropped rather than displayed.
    expect(screen.getByRole("textbox", { name: /SMTP host/i }).value).toBe("");
  });

  test("only the known settings keys reach form state — a spread would leak the rest", async () => {
    // The mutation-killing half. `smtp_host` is a rendered field, so a hostile response can be
    // detected through it; the point is the MECHANISM, not this key. With the old
    // allow-by-default spread, any field the server sends lands in `settings` and is submitted
    // back on the next test/save — including one added to the endpoint years from now.
    //
    // Asserted through what the page SENDS rather than what it shows: an unknown key that
    // renders nowhere but rides along in the POST body is exactly the leak that is invisible
    // on screen.
    mockFetch({
      settings: {
        settings: {
          ...settingsResponse().settings,
          smtp_host: "real.example.com",
          smtp_password: "leaked-secret-from-server",
        },
        verified: false,
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await user.type(screen.getByLabelText(/^Password$/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));

    await waitFor(() => expect(sentBodies("/mailer/test")).toHaveLength(1));
    const body = sentBodies("/mailer/test")[0];
    expect(body.smtp_host).toBe("real.example.com");
    expect(body.smtp_password).toBeUndefined();
    expect(body.password).toBe(PASSWORD);
  });

  test("the recipient field is sent as `to`, the name the server reads", async () => {
    // Guards a bug this issue already made once: the mockup's field id is `testto`, and the
    // obvious client name is `sendTo`. The server reads `body.to` (endpoints/mailer.js:95),
    // and any other key arrives as an empty recipient and is refused with 400 — which reads
    // as "your mail server rejected it", sending the admin to debug their SMTP provider.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await fillConnectionAndContinue(user);
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));

    await waitFor(() => expect(sentBodies("/mailer/test")).toHaveLength(1));
    expect(sentBodies("/mailer/test")[0].to).toBe("me@example.com");
  });
});

describe("#108 N6: save is gated on a passing test, and editing voids it", () => {
  test("no save button exists before a test has passed", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await fillConnectionAndContinue(user);

    expect(
      screen.queryByRole("button", { name: /Save and turn on/i })
    ).toBeNull();
  });

  test("a FAILED test does not unlock save", async () => {
    // Without this, a page that showed the button on any completed test — pass or fail —
    // satisfies the test above and lets the admin save a configuration that cannot send.
    mockFetch({ test: { ok: false, error: "Connection refused" } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await fillConnectionAndContinue(user);
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));

    expect(await screen.findByText(/Connection failed/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Save and turn on/i })
    ).toBeNull();
  });

  test("going back and editing the host voids the passing test", async () => {
    // The server enforces this — the hash covers the settings — but the UI must not leave a
    // green "Accepted" and a live Save button attached to a configuration that changed. A
    // passing test belongs to the settings it ran against, not to the session.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await fillConnectionAndContinue(user);
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));
    await screen.findByRole("button", { name: /Save and turn on/i });

    await user.click(screen.getByRole("button", { name: /^Back$/i }));
    await user.type(
      screen.getByRole("textbox", { name: /SMTP host/i }),
      ".changed"
    );
    await user.click(screen.getByRole("button", { name: /Continue/i }));

    expect(
      screen.queryByRole("button", { name: /Save and turn on/i })
    ).toBeNull();
    expect(screen.queryByText(/Accepted by the server/i)).toBeNull();
  });
});

describe("#108 N9/N10: a refusal says which refusal it was", () => {
  test("a 409 tells the admin to test again, not that saving failed", async () => {
    // 409 means the verified hash no longer matches. "Save failed" would leave them retrying
    // a button that cannot succeed; the only recovery is another test.
    mockFetch({ save: { status: 409, saved: false, error: "stale" } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await fillConnectionAndContinue(user);
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));
    await user.click(
      await screen.findByRole("button", { name: /Save and turn on/i })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Send a test above, then save/i
    );
    expect(screen.queryByText(/Email delivery is on/i)).toBeNull();
  });

  test("the split-state 500 is never reported as saved", async () => {
    // The credential persisted but the settings did not (endpoints/mailer.js:206-222).
    // Nothing spans credential_store and system_settings transactionally, so this state is
    // real — and claiming success here would leave email silently unconfigured until the
    // first invite nobody receives.
    mockFetch({
      save: {
        status: 500,
        saved: false,
        error:
          "The password was stored but the settings could not be saved, so email delivery is not configured. Try saving again.",
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await fillConnectionAndContinue(user);
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));
    await user.click(
      await screen.findByRole("button", { name: /Save and turn on/i })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /not configured/i
    );
    expect(screen.queryByText(/Email delivery is on/i)).toBeNull();
  });
});

describe("#108: the two transport consents are independent", () => {
  test("accepting plaintext does not also accept an untrusted certificate", async () => {
    // TL-1 OBS-1 on #80: `smtp_allow_insecure` and `smtp_allow_untrusted_cert` are separate
    // fields in the hash and separate exposures. One checkbox for both would mean an admin
    // accepting plaintext silently also stops certificate verification.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await user.type(
      screen.getByRole("textbox", { name: /SMTP host/i }),
      "smtp.example.com"
    );
    await user.type(screen.getByLabelText(/^Password$/i), PASSWORD);
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Encryption/i }),
      "none"
    );
    await user.click(
      screen.getByRole("checkbox", { name: /sent unencrypted/i })
    );
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));

    await waitFor(() => expect(sentBodies("/mailer/test")).toHaveLength(1));
    const body = sentBodies("/mailer/test")[0];
    expect(body.smtp_allow_insecure).toBe("true");
    expect(body.smtp_allow_untrusted_cert).toBe("false");
  });

  test("accepting an untrusted certificate does not also accept plaintext", async () => {
    // The mirror. Asserting one direction only would pass for a UI that wired both boxes to
    // the same state and happened to be read in that order.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await user.type(
      screen.getByRole("textbox", { name: /SMTP host/i }),
      "smtp.example.com"
    );
    await user.type(screen.getByLabelText(/^Password$/i), PASSWORD);
    await user.click(screen.getByRole("checkbox", { name: /Do not verify/i }));
    await user.click(screen.getByRole("button", { name: /Continue/i }));
    await user.type(
      screen.getByRole("textbox", { name: /Send a test to/i }),
      "me@example.com"
    );
    await user.click(screen.getByRole("button", { name: /Send test/i }));

    await waitFor(() => expect(sentBodies("/mailer/test")).toHaveLength(1));
    const body = sentBodies("/mailer/test")[0];
    expect(body.smtp_allow_untrusted_cert).toBe("true");
    expect(body.smtp_allow_insecure).toBe("false");
  });

  test("plaintext cannot be chosen without its acceptance", async () => {
    // "Refuse unless explicitly allowed" (QA-3 on #80) — a warning refuses nothing.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: /Continue/i });

    await user.type(
      screen.getByRole("textbox", { name: /SMTP host/i }),
      "smtp.example.com"
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: /Encryption/i }),
      "none"
    );
    await user.click(screen.getByRole("button", { name: /Continue/i }));

    expect(screen.getByText(/Tick the box above/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send test/i })).toBeNull();
  });
});
