import { useEffect, useState } from "react";
import { isMobile } from "react-device-detect";
import Sidebar from "@/components/SettingsSidebar";
import PreLoader from "@/components/Preloader";
import Mailer from "@/models/mailer";

/**
 * S11b (#108) — guided SMTP setup, on the S11a (#80) backend.
 *
 * The three-step shape is NOT a styling choice. `POST /mailer/settings` recomputes
 * `configHash(settings, password)` and refuses with 409 unless it matches the hash stored by a
 * passing test (`server/endpoints/mailer.js:180-189`). So "test before save" is what the API
 * permits, and a single form with a Save button would 409 on every attempt with no way out.
 *
 * The password (F-3 ruling, #108): held in component state for the life of this wizard, sent
 * with BOTH the test and the save in one pass — it is inside the hash, so a save that omits it
 * hashes a different input and is refused. It is never rendered from a server response
 * (`GET` returns `hasPassword: boolean`, never the value), never written to localStorage or
 * sessionStorage, and gone on reload: changing settings later means retyping it.
 *
 * Mockup B step 3's delivery-log table is NOT here — it has no backend (no notifications
 * table, no endpoint). Deferred to #107 by PMO ruling; this shows the configuration summary
 * and the most recent test result instead.
 */

const BLANK = {
  smtp_host: "",
  smtp_port: "587",
  smtp_secure: "false",
  smtp_allow_insecure: "false",
  smtp_allow_untrusted_cert: "false",
  smtp_username: "",
  smtp_from_address: "",
  smtp_from_name: "",
};

/**
 * The encryption choice is one select over two independent booleans, because that is how the
 * backend models it: `smtp_secure` picks implicit TLS, `smtp_allow_insecure` permits plaintext.
 * Collapsing them into one tri-state here keeps the two flags from drifting into a combination
 * the driver rejects (secure AND insecure at once).
 */
function encryptionOf(settings) {
  if (settings.smtp_secure === "true") return "tls";
  if (settings.smtp_allow_insecure === "true") return "none";
  return "starttls";
}
const ENCRYPTION_FLAGS = {
  starttls: { smtp_secure: "false", smtp_allow_insecure: "false" },
  tls: { smtp_secure: "true", smtp_allow_insecure: "false" },
  none: { smtp_secure: "false", smtp_allow_insecure: "true" },
};

export default function GeneralMailer() {
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [settings, setSettings] = useState(BLANK);
  const [password, setPassword] = useState("");
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [plaintextAccepted, setPlaintextAccepted] = useState(false);
  const [untrustedCertAccepted, setUntrustedCertAccepted] = useState(false);
  const [blockedReason, setBlockedReason] = useState(null);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    let mounted = true;
    Mailer.settings().then((response) => {
      if (!mounted) return;
      if (response?.settings) {
        // QA-1 (#108): PICK the known keys rather than spreading everything except
        // `hasPassword`. A spread is allow-by-default — it accepts whatever the response
        // happens to carry, so the day a secret-bearing field is added to this endpoint (or a
        // proxy injects one) it lands in form state and renders. Listing the fields means a
        // new one is ignored until someone adds it here on purpose.
        const stored = Object.fromEntries(
          Object.keys(BLANK)
            .filter((key) => response.settings[key] !== undefined)
            .map((key) => [key, String(response.settings[key])])
        );
        setSettings({ ...BLANK, ...stored });
        setHasStoredPassword(Boolean(response.settings.hasPassword));
        // An already-verified deployment opens on the status view rather than on an empty
        // form, so an admin arriving to check the configuration is not asked to reconfigure
        // it. `verified` comes from the server; it is not a claim this page can make.
        if (response.verified) {
          setSummary({
            host: stored.smtp_host,
            port: stored.smtp_port,
            encryption: encryptionOf({ ...BLANK, ...stored }),
            lastTest: null,
          });
          setStep(3);
        }
      }
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  /**
   * Editing the configuration invalidates the proof — this is the mockup's rule and the
   * server's: a passing test belongs to the settings it ran against, not to the session.
   * Without it someone verifies one host, edits to another, and saves on the first one's
   * evidence — which the server would refuse with a 409 they could not explain.
   *
   * The result box is cleared with it: leaving a green "Accepted" on screen while the proof is
   * void puts two contradictory answers up at once, and the reassuring one is the stale one.
   */
  function editSettings(patch) {
    setSettings((current) => ({ ...current, ...patch }));
    setTestResult(null);
    setSaveError(null);
  }

  function chooseEncryption(choice) {
    editSettings(ENCRYPTION_FLAGS[choice]);
    // Consent is to THIS choice, not a box that stays ticked from an earlier one.
    if (choice !== "none") setPlaintextAccepted(false);
    setBlockedReason(null);
  }

  function toggleUntrustedCert(accepted) {
    setUntrustedCertAccepted(accepted);
    editSettings({ smtp_allow_untrusted_cert: accepted ? "true" : "false" });
  }

  function continueToTest() {
    // "Refuse unless explicitly allowed" — a warning refuses nothing (QA-3).
    if (encryptionOf(settings) === "none" && !plaintextAccepted) {
      setBlockedReason(
        "Tick the box above to continue with an unencrypted connection."
      );
      return;
    }
    setBlockedReason(null);
    setTestResult(null);
    setStep(2);
  }

  function backToConnection() {
    setStep(1);
    setTestResult(null);
    setSaveError(null);
  }

  async function runTest() {
    setTesting(true);
    setSaveError(null);
    const response = await Mailer.test(settings, password, testTo);
    setTestResult(response);
    setTesting(false);
  }

  async function saveAndEnable() {
    setSaving(true);
    setSaveError(null);
    const response = await Mailer.save(settings, password);
    setSaving(false);
    if (response?.saved) {
      setSummary({
        host: settings.smtp_host,
        port: settings.smtp_port,
        encryption: encryptionOf(settings),
        lastTest: { to: testTo, at: new Date().toISOString() },
      });
      setHasStoredPassword(true);
      setStep(3);
      return;
    }
    // A 409 is not a generic failure. It means the verified hash no longer matches these
    // settings, and the only recovery is to send another test — telling the admin "save
    // failed" would leave them retrying a button that cannot succeed.
    setSaveError(
      response?.status === 409
        ? "These settings have not sent a message yet. Send a test above, then save."
        : (response?.error ??
            "The configuration could not be saved. Nothing was changed.")
    );
  }

  if (loading) return <PreLoader />;

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:pt-6">
          <p className="text-lg leading-6 font-bold text-theme-text-primary md-6 border-white light:border-theme-sidebar-border border-b-2 border-opacity-10 py-4">
            Email delivery
          </p>

          <Stepper step={step} />

          {step === 1 && (
            <ConnectionStep
              settings={settings}
              password={password}
              hasStoredPassword={hasStoredPassword}
              plaintextAccepted={plaintextAccepted}
              untrustedCertAccepted={untrustedCertAccepted}
              blockedReason={blockedReason}
              onEdit={editSettings}
              onPassword={(value) => {
                setPassword(value);
                setTestResult(null);
              }}
              onEncryption={chooseEncryption}
              onPlaintextAccept={setPlaintextAccepted}
              onUntrustedCertAccept={toggleUntrustedCert}
              onContinue={continueToTest}
            />
          )}

          {step === 2 && (
            <VerifyStep
              testTo={testTo}
              onTestTo={setTestTo}
              testing={testing}
              testResult={testResult}
              saving={saving}
              saveError={saveError}
              onRun={runTest}
              onBack={backToConnection}
              onSave={saveAndEnable}
            />
          )}

          {step === 3 && summary && (
            <LiveStep
              summary={summary}
              onReconfigure={() => {
                // Reconfiguring invalidates the previous test for the same reason editing
                // does — and the password is not in state after a reload, so it must be
                // retyped before anything can be tested again.
                setTestResult(null);
                setSaveError(null);
                setPassword("");
                setStep(1);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }) {
  const labels = ["Connection", "Verify", "Live"];
  return (
    <ol
      className="flex items-center gap-2 text-sm mt-6"
      aria-label="Setup progress"
    >
      {labels.map((label, index) => {
        const position = index + 1;
        const done = position < step;
        const current = position === step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={current ? "step" : undefined}
              className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                done
                  ? "bg-green-100 text-green-800"
                  : current
                    ? "bg-theme-bg-primary text-theme-text-primary border border-theme-sidebar-border"
                    : "bg-theme-bg-primary/40 text-theme-text-secondary"
              }`}
            >
              {done ? "✓" : position} {label}
            </span>
            {position < 3 && (
              <span className="text-theme-text-secondary">→</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Label and control are linked by `htmlFor`/`id` rather than by nesting the input inside the
 * <label>. With nesting, the hint text below the control becomes part of the accessible name
 * — "Password Encrypted at rest; never shown again." — so a screen reader announces the
 * warning as though it were the field's name, and `getByLabelText(/^Password$/)` finds
 * nothing. The hint is attached with `aria-describedby` instead, which is what it is: a
 * description, not a name.
 */
function Field({ id, label, hint, children }) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="block">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-theme-text-primary mb-1"
      >
        {label}
      </label>
      {children}
      {hint && (
        <span
          id={hintId}
          className="block text-xs text-theme-text-secondary mt-1"
        >
          {hint}
        </span>
      )}
    </div>
  );
}

const INPUT_CLASS =
  "w-full h-9 px-3 text-sm rounded-lg bg-theme-settings-input-bg border border-theme-sidebar-border text-theme-text-primary outline-none focus:border-sky-500";

function ConnectionStep({
  settings,
  password,
  hasStoredPassword,
  plaintextAccepted,
  untrustedCertAccepted,
  blockedReason,
  onEdit,
  onPassword,
  onEncryption,
  onPlaintextAccept,
  onUntrustedCertAccept,
  onContinue,
}) {
  const encryption = encryptionOf(settings);
  return (
    <section className="mt-6 max-w-3xl">
      <h2 className="font-semibold text-theme-text-primary">1 · Connection</h2>
      <div className="mt-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <Field id="smtp_host" label="SMTP host">
              <input
                type="text"
                id="smtp_host"
                name="smtp_host"
                placeholder="smtp.example.com"
                className={INPUT_CLASS}
                value={settings.smtp_host}
                onChange={(e) => onEdit({ smtp_host: e.target.value })}
              />
            </Field>
          </div>
          <Field id="smtp_port" label="Port">
            <input
              type="text"
              id="smtp_port"
              name="smtp_port"
              className={INPUT_CLASS}
              value={settings.smtp_port}
              onChange={(e) => onEdit({ smtp_port: e.target.value })}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field id="smtp_username" label="Username">
            <input
              type="text"
              id="smtp_username"
              name="smtp_username"
              placeholder="apikey"
              className={INPUT_CLASS}
              value={settings.smtp_username}
              onChange={(e) => onEdit({ smtp_username: e.target.value })}
            />
          </Field>
          <Field
            id="smtp_password"
            label="Password"
            hint={
              hasStoredPassword
                ? "A password is stored. It is never sent back to this page — retype it to change or re-test this configuration."
                : "Encrypted at rest; never shown again."
            }
          >
            <input
              type="password"
              id="smtp_password"
              name="smtp_password"
              autoComplete="new-password"
              placeholder="••••••••••••"
              className={INPUT_CLASS}
              value={password}
              onChange={(e) => onPassword(e.target.value)}
            />
          </Field>
        </div>

        <Field id="encryption" label="Encryption">
          <select
            id="encryption"
            name="encryption"
            className={`${INPUT_CLASS} md:w-64`}
            value={encryption}
            onChange={(e) => onEncryption(e.target.value)}
          >
            <option value="starttls">STARTTLS (recommended)</option>
            <option value="tls">Implicit TLS</option>
            <option value="none">None — plaintext</option>
          </select>
        </Field>

        {encryption === "none" && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <b>Plaintext.</b> The SMTP password and every message — invite links
            included — cross the network unencrypted, readable by anything on
            the path.
            <label className="mt-2 flex items-start gap-2 font-medium">
              <input
                type="checkbox"
                name="accept_plaintext"
                className="mt-0.5 h-4 w-4 rounded border-amber-400"
                checked={plaintextAccepted}
                onChange={(e) => onPlaintextAccept(e.target.checked)}
              />
              <span>
                I accept that mail from this server is sent unencrypted.
              </span>
            </label>
          </div>
        )}

        {/* A SEPARATE consent from plaintext (TL-1 OBS-1 on #80): `smtp_allow_untrusted_cert`
            is its own field in the hash, and one checkbox for both would mean an admin
            accepting plaintext silently also accepts an unverified certificate — two
            different exposures behind one tick.
            Mockup B shows only the plaintext box; this second one is added because omitting
            it leaves the backend field permanently "false" with no way to set it.
            Rendered unconditionally, NOT hidden when plaintext is chosen: hiding it would
            couple the two consents through the UI even though the payload keeps them apart,
            and an admin switching encryption back and forth would find a box they ticked
            has quietly vanished while its value still ships.
            The label names the CONSEQUENCE rather than asking to "accept a risk" — a consent
            whose text does not say what stops happening is not informed. */}
        <div className="rounded-lg border border-theme-sidebar-border px-3 py-2 text-sm text-theme-text-secondary">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              name="accept_untrusted_cert"
              className="mt-0.5 h-4 w-4 rounded"
              checked={untrustedCertAccepted}
              onChange={(e) => onUntrustedCertAccept(e.target.checked)}
            />
            <span>
              Do not verify the SMTP server’s TLS certificate. The connection
              stays encrypted, but nothing checks that the server is the one it
              claims to be, so anyone able to intercept the connection can read
              the password and every message. Only for a server using a
              self-signed certificate.
            </span>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field id="smtp_from_address" label="From address">
            <input
              type="text"
              id="smtp_from_address"
              name="smtp_from_address"
              placeholder="noreply@example.com"
              className={INPUT_CLASS}
              value={settings.smtp_from_address}
              onChange={(e) => onEdit({ smtp_from_address: e.target.value })}
            />
          </Field>
          <Field id="smtp_from_name" label="From name">
            <input
              type="text"
              id="smtp_from_name"
              name="smtp_from_name"
              placeholder="ApproofWorkspace"
              className={INPUT_CLASS}
              value={settings.smtp_from_name}
              onChange={(e) => onEdit({ smtp_from_name: e.target.value })}
            />
          </Field>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={onContinue}
          className="h-9 px-4 text-sm font-medium rounded-lg bg-theme-bg-primary border border-theme-sidebar-border text-theme-text-primary hover:opacity-80"
        >
          Continue
        </button>
        {blockedReason && (
          <span className="text-sm text-amber-700">{blockedReason}</span>
        )}
      </div>
    </section>
  );
}

function VerifyStep({
  testTo,
  onTestTo,
  testing,
  testResult,
  saving,
  saveError,
  onRun,
  onBack,
  onSave,
}) {
  const passed = testResult?.ok === true;
  return (
    <section className="mt-6 max-w-3xl">
      <h2 className="font-semibold text-theme-text-primary">
        2 · Send a real message
      </h2>
      <p className="text-sm text-theme-text-secondary mt-1">
        This must succeed before the configuration can be saved. A mail server
        that was never exercised is a broken invite discovered by whoever it was
        sent to.
      </p>

      <div className="mt-4">
        <Field id="test_to" label="Send a test to">
          <input
            type="text"
            id="test_to"
            name="test_to"
            placeholder="you@example.com"
            className={`${INPUT_CLASS} md:w-96`}
            value={testTo}
            onChange={(e) => onTestTo(e.target.value)}
          />
        </Field>
      </div>

      {testing && (
        <p className="mt-3 text-sm text-theme-text-secondary">Connecting…</p>
      )}

      {testResult && !testing && (
        <div
          role="status"
          className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
            passed
              ? "border-green-300 bg-green-50 text-green-900"
              : "border-red-300 bg-red-50 text-red-900"
          }`}
        >
          {passed ? (
            <>
              <b>Accepted by the server.</b> Check the inbox to confirm it
              arrived — SMTP reports that the next hop took the message, not
              that a mailbox received it.
            </>
          ) : (
            <>
              <b>Connection failed.</b>{" "}
              {testResult?.error ?? "The mail server could not be reached."} The
              configuration was not saved.
            </>
          )}
        </div>
      )}

      {saveError && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {saveError}
        </div>
      )}

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={onRun}
          disabled={testing}
          className="h-9 px-4 text-sm font-medium rounded-lg bg-theme-bg-primary border border-theme-sidebar-border text-theme-text-primary hover:opacity-80 disabled:opacity-50"
        >
          Send test
        </button>
        <button
          type="button"
          onClick={onBack}
          className="h-9 px-4 text-sm font-medium rounded-lg border border-theme-sidebar-border text-theme-text-primary hover:opacity-80"
        >
          Back
        </button>
        {/* Rendered only once a test has passed. The server refuses a save without one
            anyway (409) — this is the visible half of that rule, not the rule itself. A
            client-side gate protects nobody: the endpoint is reachable without the page. */}
        {passed && (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="h-9 px-4 text-sm font-medium rounded-lg bg-green-700 text-white hover:bg-green-600 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save and turn on"}
          </button>
        )}
      </div>
    </section>
  );
}

function LiveStep({ summary, onReconfigure }) {
  return (
    <section className="mt-6 max-w-3xl">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-semibold text-theme-text-primary">
            Email delivery is on
          </h2>
          <p className="text-sm text-theme-text-secondary mt-1 font-mono text-xs">
            {summary.host}:{summary.port} · {summary.encryption}
          </p>
        </div>
        <button
          type="button"
          onClick={onReconfigure}
          className="h-9 px-4 text-sm font-medium rounded-lg border border-theme-sidebar-border text-theme-text-primary hover:opacity-80"
        >
          Reconfigure
        </button>
      </div>

      {summary.lastTest && (
        <div className="mt-4 rounded-lg border border-theme-sidebar-border p-4">
          <p className="text-sm font-medium text-theme-text-primary">
            Most recent test
          </p>
          <p className="text-sm text-theme-text-secondary mt-1">
            Sent to{" "}
            <span className="font-mono text-xs">{summary.lastTest.to}</span> —{" "}
            <b>queued</b>.
          </p>
        </div>
      )}

      <p className="mt-4 text-xs text-theme-text-secondary">
        <b>queued</b> means the server accepted the message; SMTP cannot confirm
        a mailbox received it, so nothing here says “delivered”. A per-message
        delivery log is not built yet (#107).
      </p>
    </section>
  );
}
