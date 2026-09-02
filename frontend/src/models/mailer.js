import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

/**
 * S11b (#108) — client for the three mailer routes shipped by S11a (#80).
 *
 * All three are gated `requirePermission("system.write", orgResource)` on the server, so every
 * call carries the auth header. The page is additionally behind `AdminRoute`, but that only
 * decides what renders — the server decides what happens.
 *
 * The password is a PARAMETER on both `test` and `save`, never a return value. `settings()`
 * gives back `hasPassword: boolean` and never the string, because a password sent to the page
 * is a password in the page source, the browser cache, and any screenshot of it. Nothing here
 * stores it either: the caller holds it in component state for the life of the wizard and it
 * is gone on reload, which is the #108 F-3 ruling.
 */
const Mailer = {
  settings: async () => {
    return await fetch(`${API_BASE}/mailer/settings`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { settings: null, verified: false, error: e.message };
      });
  },

  /**
   * Send a real message. Must succeed before `save` will be accepted — the server stores a
   * hash of exactly these settings plus this password, and refuses a save that does not match.
   */
  test: async (settings, password, to) => {
    // The recipient field is `to`, matching `endpoints/mailer.js:95` (`body?.to`). Named
    // deliberately rather than something friendlier: any other key arrives as an empty
    // recipient and is refused with 400, which would read as a mail failure rather than as a
    // client bug.
    return await fetch(`${API_BASE}/mailer/test`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ ...settings, password, to }),
    })
      .then((res) => res.json())
      .catch((e) => {
        console.error(e);
        return { ok: false, error: e.message };
      });
  },

  /**
   * Persist. Returns `{saved, error}`; a 409 means the verified hash no longer matches these
   * settings, which the UI must present as "test again", not as a generic failure — see the
   * page for why that distinction is load-bearing.
   *
   * The response status is returned alongside the body: 409 and 500 are different states with
   * different recoveries, and a caller that only reads `saved` cannot tell them apart.
   */
  save: async (settings, password) => {
    return await fetch(`${API_BASE}/mailer/settings`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ ...settings, password }),
    })
      .then(async (res) => ({ status: res.status, ...(await res.json()) }))
      .catch((e) => {
        console.error(e);
        return { status: 0, saved: false, error: e.message };
      });
  },
};

export default Mailer;
