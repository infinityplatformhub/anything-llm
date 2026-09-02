# Techlead-1 — #126 slice 1 `2286a997e` (plain; pre-read is the only gate)

§7.14: no suite run. Read against `4646ed17b`.

## Both questions answered yes

**The gate decides, and the condition is not repeated outside it.** `Home/index.jsx:151-163`
builds one `gate(children)` helper and wraps **both** return paths (`:166` thread branch,
`:178` default branch). Grepped the whole file for a second copy: the only other `!workspace`
is `createDefaultWorkspace:52`, an unrelated error check on `Workspace.new`'s response, and
the only other `loading` is `HomeContent`'s own streaming state at `:204`. So the decision
exists once. Dev2's note that their first draft duplicated it is the right thing to have
caught — a wrapper plus a surviving inline `if` would have made the component decorative while
every test passed.

**No source assertion remains.** `grep readFileSync` in `capabilityGate.test.jsx` returns
nothing; the whole file mounts `WorkspaceGate` with plain props. RF-3's removal of the drift
check is justified because the render tests now cover what it stood in for — this is the
follow-up the (a) ruling on #40 t4 promised, delivered.

The extraction itself is the right shape: `WorkspaceGate` reads no hook and no context
(`:23-39`, decision entirely from props), which is what lets the test mount it with no app tree
and no mocking. That is the property that makes the difference from #40 t4, and the docblock
says so.

## Fixture quality

- RF-4 positive control (`:42-49`) is first, and its comment names why: without it, a gate that renders the dead end for everyone satisfies every negative assertion below.
- The loading test (`:64-85`) asserts the **transition** via `rerender` rather than the loading state alone, with the reason stated — `loading` and `denied` are the same value out of `can()`, so only the transition shows the gate distinguishes them.
- RF-5 has two cases (`:89-104`): having a workspace beats a missing capability *and* beats loading. The second is the one that catches a rewrite that folds `!workspace` into the capability check.

## NIT — `canCreate={can("workspace.create")}` is evaluated by the caller, so the capability string is untested

The gate takes a boolean, which is what makes it renderable — right trade. But it moves the
one thing a mutation could get wrong (the action string) out of the tested component:
`can("workspace.write")` at `:157` would pass all seven tests. #40 t4's site-identity fixture
covered that for the inline version; after the extraction nothing does.

Not worth a source assertion — that is the pattern this issue removes. The honest options are
either to note it in the ledger as a known limit of the extraction, or to cover it in slice 2
alongside `SettingsSidebar` where the same question arises for several capabilities at once. I
would take the ledger line now and the fixture in slice 2.

## Verdict

**PASS.** The extraction is clean, the condition lives in one place, and the tests render
rather than transcribe. One ledger line for the capability-string gap.
