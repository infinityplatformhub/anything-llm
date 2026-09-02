import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import paths from "@/utils/paths";
import System from "@/models/system";

/**
 * O2b (#112) — the preflight step, from the approved mockup
 * (docs/superpowers/mockups/o2-installer-b-checklist.html @ 24951395a).
 *
 * The same `runChecks` the `doctor` CLI runs (#74), reached over
 * GET /system/preflight. #74 put these behind a command line, and an operator
 * who does not read `docker compose logs` never sees them — which is exactly
 * the operator this step is for.
 *
 * TWO THINGS THIS COMPONENT DOES NOT DECIDE.
 *
 * `level` comes from the server and is not re-derived here. Blocking blocks and
 * warn does not, from the same field `exitCodeFor` reads for the CLI's exit
 * code — a second classification in the frontend would let the UI and the boot
 * gate disagree about the same instance.
 *
 * Remedies are DATA. #74 wrote them once, next to the check that knows why it
 * failed; a copy in JSX drifts, and the drift is invisible until someone
 * follows the wrong one.
 */
const DOT = {
  ok: "bg-green-400",
  warn: "bg-yellow-400",
  bad: "bg-red-400",
  run: "bg-blue-400 animate-pulse",
  idle: "bg-white/30",
};

export function dotFor(check) {
  if (!check) return "idle";
  if (check.ok) return "ok";
  return check.level === "warn" ? "warn" : "bad";
}

/** A check that is not ok and not merely a warning stops the step. */
export const blockersOf = (checks = []) =>
  checks.filter((check) => !check.ok && check.level !== "warn");

export default function Preflight({ setHeader, setForwardBtn, setBackBtn }) {
  const navigate = useNavigate();
  const [checks, setChecks] = useState(null);
  const [failed, setFailed] = useState(false);

  const blockers = blockersOf(checks ?? []);
  const passed = (checks ?? []).filter((check) => check.ok).length;
  // `null` means the request failed or was refused. It must NOT read as "all
  // clear": a preflight that cannot run is the one result an installer must not
  // silently treat as a pass.
  const loading = checks === null && !failed;

  useEffect(() => {
    let live = true;
    System.preflight().then((result) => {
      if (!live) return;
      if (!result) return setFailed(true);
      setChecks(result.checks);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setHeader({
      title: "Checking this machine",
      description:
        "The same checks the doctor command runs, before anything is configured.",
    });
    setBackBtn({
      showing: true,
      disabled: false,
      onClick: () => navigate(paths.onboarding.home()),
    });
  }, []);

  useEffect(() => {
    setForwardBtn({
      showing: true,
      // Blocked while loading too: advancing past a preflight that has not
      // answered is the same as advancing past one that failed.
      disabled: loading || failed || blockers.length > 0,
      onClick: () => navigate(paths.onboarding.llmPreference()),
    });
  }, [loading, failed, blockers.length]);

  return (
    <div className="w-full flex items-center justify-center flex-col gap-y-6">
      <div className="flex flex-col border rounded-lg border-white/20 light:border-theme-sidebar-border p-8 gap-y-4 w-full max-w-[600px]">
        {failed ? (
          <div className="text-white text-sm" role="alert">
            The checks could not be read. Run{" "}
            <code className="text-white/80">
              docker compose run --rm --no-deps anything-llm doctor
            </code>{" "}
            to see them.
          </div>
        ) : loading ? (
          <div className="text-white/60 text-sm">Running checks…</div>
        ) : (
          <>
            <div className="rows flex flex-col gap-y-3">
              {checks.map((check) => (
                <div key={check.id} className="flex gap-x-3 items-start">
                  <span
                    aria-hidden
                    data-state={dotFor(check)}
                    className={`dot mt-1.5 h-2 w-2 rounded-full shrink-0 ${DOT[dotFor(check)]}`}
                  />
                  <div className="flex flex-col">
                    <span className="text-white text-sm">{check.detail}</span>
                    {!check.ok && (
                      <span className="fix text-white/60 text-xs mt-0.5">
                        {check.remedy}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="bar text-sm border-t border-white/10 pt-4">
              {blockers.length > 0 ? (
                // Names the blocker rather than reporting a count: "3 of 9
                // passed" tells an operator nothing they can act on.
                <span className="text-red-300">
                  Cannot continue: {blockers[0].detail}
                </span>
              ) : (
                <span className="text-white/70">
                  <span className="count">{passed}</span> of {checks.length}{" "}
                  checks passed.
                </span>
              )}
            </div>

            {/* Separate from the checklist: this row has no state the system can
                compute, so rendering it as a check would mean inventing one.
                QA-3 caught an earlier draft whose ternary returned the same
                value on both arms. */}
            <div className="admin text-white/50 text-xs">
              An administrator account is created in a later step.
            </div>

            {blockers.length === 0 && (
              <div className="next text-white/70 text-xs">
                Next: choose an LLM provider and embedder.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
