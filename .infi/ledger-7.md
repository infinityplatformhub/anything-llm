# Ledger — issue 7 (P0-4D(a): .env atomic write 0600 + secret-leak scan)

Ruling: branch renamed to approof/p0-4d-env-hygiene-a — the name in the brief already belonged to a stale worktree at b5146345 that carries unrelated P0-7 work; reusing it would have mixed two tasks in one branch. If wrong, the PR opens under a name nobody expects and has to be renamed.

Ruling: exported writeEnvFileAtomic as a named function rather than inlining the atomic write inside dumpENV — dumpENV needs a live production process env to produce content, so testing the file properties through it would mean faking 50 env keys. If wrong, the module surface grows by one function that only tests call.

Ruling: refuse-and-return-false on a foreign-owned .env instead of throwing — every dumpENV call site ignores the return value, and throwing would turn a settings save into a 500 after the settings were already applied to process.env. If wrong, a misconfigured deployment silently stops persisting env changes and only the console line says why.

Ruling: masked the secret values in the updateENV response body rather than dropping the keys — the response is the only place the caller learns which settings were accepted, and the frontend does read the shape. If wrong, an operator reading the response cannot tell a masked value from a literal ten-asterisk value they typed.

Ruling: secret detection is a name heuristic over the env key (KEY, TOKEN, SECRET, PASSWORD, PEPPER, SALT, CREDENTIAL, PWD), marked with a ponytail comment — a per-key secret flag on KEY_MAPPING would touch every one of the ~200 entries for no test-visible gain today. If wrong, a future provider credential whose env name avoids all eight words is echoed in full.

Ruling: chmod the existing file to 0600 before the rename, not only the temp file — the rename replaces the inode so the old mode does not survive, but the window before it does, and an existing world-readable .env is exactly the state this task exists to end. If wrong, one redundant chmod syscall per dump.

Ruling: accepted the first full-suite run's single suite-level failure as a flake after reproducing it green twice — t1-authz-migration.test.js failed in an afterAll teardown timeout, passes alone (14/14) with the change applied, and the second full run was 72/72. If wrong, a real teardown race is being carried forward under a flake label.

Ruling: rebased onto approof/main at bf457759 after check passed on the older base — main had moved eight commits ahead while this task ran, and the pre-rebase diff carried 858 deletions of other people's work. If wrong, the rebase silently dropped a change that the older base still had.

Ruling: treated the afterAll hook timeouts in engine.test.js and t1-authz-migration.test.js as a pre-existing flake, not a regression — both drop a Postgres database in an afterAll that inherits the default 5000 ms hook timeout while their beforeAll gets 300_000, both pass in isolation (29/29 together), and neither file nor anything they import appears in this diff. If wrong, a real teardown contention introduced by the extra HTTP suite is being carried forward as somebody else's problem.

Ruling: an existing 0644 .env is tightened on write, not on boot — matrix item 3. Boot-time chmod would touch the file on every start of every deployment including ones that never write it, and dumpENV is the only path that puts secrets there, so the write is the moment the guarantee is owed. If wrong, an upgraded deployment that never saves a setting keeps its 0644 .env until the first write.

Ruling: keys outside protectedKeys are dropped on dump — matrix item 7, pre-existing and accepted unchanged. dumpENV rebuilds the file from an allowlist rather than editing it, so an operator-added key such as a custom proxy variable does not survive a settings save. Widening the allowlist is a behaviour change beyond this task's blast radius and belongs with the CredentialStore work that has to enumerate the keys anyway. If wrong, an operator silently loses a hand-added env line the first time an admin saves a provider setting, and this ledger is the only place that says so.

Ruling: refuse a symlinked .env rather than resolving it with realpath and writing to the target — matrix item 5. realpath would preserve the convenience of a deliberately symlinked .env, but it cannot distinguish the operator's own symlink from a planted one, and the safe-looking version of this bug is what made the original hole invisible. If wrong, a deployment that intentionally symlinks .env onto shared storage stops persisting settings and gets a console line explaining why.

Ruling: uniqueness of the temp filename comes from 8 random bytes, not from the pid and timestamp — matrix item 8. Two dumps inside one process and one millisecond produce an identical pid-plus-time name, and the exclusive open then makes the second one throw. If wrong, the temp names are longer than they need to be.

Ruling: the symlink and owner checks use lstat with a caught ENOENT rather than an existsSync guard — existsSync resolves the link, so a symlink aimed at a path that does not exist yet reports absent and the write creates the victim file through the link. If wrong, one extra try block on a path that is almost always a plain file.

Ruling: dropped the pre-rename chmod of the destination entirely rather than moving it to after the rename, on QA-2's finding. The rename replaces the inode, so the new file already carries the temp file's 0600 and the old mode cannot survive; the chmod was buying nothing while handing an attacker a chmod through whatever the path resolved to. Verified by test — an existing 0644 file still ends at 0600 with no chmod call left in the function. If wrong, a file that somehow survives the rename keeps a loose mode with nothing left to tighten it.

Ruling: the engine.test.js and t1-authz-migration.test.js teardown timeouts stay out of this branch, on PMO's instruction, after I had briefly fixed them here and dropped that commit. The diagnosis stands — both afterAll blocks drop a Postgres database on the default 5000 ms hook budget while their matching beforeAll gets 300_000 — but the fix belongs to whoever owns those suites, not to a .env hygiene branch. If wrong, full-suite runs on this branch stay vulnerable to a teardown failure unrelated to the code under review, and the next person re-diagnoses it from scratch.
