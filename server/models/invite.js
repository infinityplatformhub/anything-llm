const { safeJsonParse } = require("../utils/http");
const prisma = require("../utils/prisma");

const Invite = {
  // 256-bit from crypto.randomBytes (R6/R7); uuid-apikey was 122 bits and an
  // invite code redeems a real account.
  /** `person@example.com` -> `p***@example.com`. Enough to tell rows apart. */
  maskEmail: (address = "") => {
    const value = String(address);
    const at = value.indexOf("@");
    if (at <= 0) return "***";
    // One leading character only: a longer prefix on a short local part leaves
    // little to guess, which defeats the point of masking at all.
    return `${value[0]}***${value.slice(at)}`;
  },

  makeCode: () => {
    const crypto = require("crypto");
    return `apw-inv-${crypto.randomBytes(32).toString("base64url")}`;
  },

  /** How long a MAILED invite stays redeemable. Copy-link invites keep no expiry. */
  mailedInviteTtlMs: 7 * 24 * 60 * 60 * 1000,

  /**
   * S11a (#80): `email` is the address this invite was mailed to, and supplying
   * one implies an expiry.
   *
   * The pairing is enforced HERE rather than at the routes because two routes
   * create invites (`endpoints/admin.js`, `endpoints/api/admin/index.js`) and
   * both come through this function — it is the only place that sees every
   * creation. A link sent to an inbox and valid forever is a bearer credential
   * sitting in mail history, and unlike a copy-link invite nobody can say where
   * it ended up.
   *
   * Omitting `email` keeps the old behaviour exactly: no address, no expiry.
   */
  create: async function ({
    createdByUserId = 0,
    workspaceIds = [],
    email = null,
    expiresAt,
  }) {
    try {
      const normalizedEmail =
        typeof email === "string" && email.trim() ? email.trim() : null;
      // An explicit `expiresAt` wins (an admin choosing 24 hours); otherwise a
      // mailed invite gets the default and a copy-link invite gets none.
      const expiry =
        expiresAt !== undefined
          ? expiresAt
          : normalizedEmail
            ? new Date(Date.now() + this.mailedInviteTtlMs)
            : null;

      if (normalizedEmail && !expiry)
        return {
          invite: null,
          error: "An emailed invite must have an expiry.",
        };

      const invite = await prisma.invites.create({
        data: {
          code: this.makeCode(),
          createdBy: createdByUserId,
          workspaceIds: JSON.stringify(workspaceIds),
          email: normalizedEmail,
          expiresAt: expiry,
        },
      });
      return { invite, error: null };
    } catch (error) {
      console.error("FAILED TO CREATE INVITE.", error.message);
      return { invite: null, error: error.message };
    }
  },

  deactivate: async function (inviteId = null) {
    try {
      const invite = await prisma.invites.findUnique({
        where: { id: Number(inviteId) },
      });
      if (!invite) return { success: false, error: "Invite not found" };

      await prisma.invites.update({
        where: { id: Number(inviteId) },
        data: { status: "disabled" },
      });
      return { success: true, error: null };
    } catch (error) {
      console.error(error.message);
      return { success: false, error: "Failed to deactivate invite" };
    }
  },

  /**
   * S11a (#80), TL-2 OBS-1: claim CONDITIONALLY, and let the database arbitrate.
   *
   * The route reads the invite, creates a user, then claims — three awaits, and
   * between the read and the write another request can do the same. An
   * unconditional `update` lets both win: two accounts from one invite, and the
   * second silently overwrites the first's `claimedBy`.
   *
   * So the conditions that made the invite redeemable are repeated in the WHERE
   * clause, and `count` is the answer. Re-checking expiry here too is not
   * redundant: the read that preceded this happened at a different instant, and
   * an invite that expires in between must not be claimable.
   */
  markClaimed: async function (inviteId = null, user) {
    try {
      const now = new Date();
      const claim = await prisma.invites.updateMany({
        where: {
          id: Number(inviteId),
          status: "pending",
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: { status: "claimed", claimedBy: user.id },
      });

      // Zero means somebody else claimed it, or it expired, between the read and
      // now. Not an error the caller can fix — but emphatically not a success.
      if (claim.count !== 1)
        return { success: false, error: "Invite not found or is invalid." };

      const invite = await prisma.invites.findUnique({
        where: { id: Number(inviteId) },
      });

      try {
        if (!!invite?.workspaceIds) {
          const { Workspace } = require("./workspace");
          const { WorkspaceUser } = require("./workspaceUsers");
          const workspaceIds = (await Workspace.where({})).map(
            (workspace) => workspace.id
          );
          const ids = safeJsonParse(invite.workspaceIds)
            .map((id) => Number(id))
            .filter((id) => workspaceIds.includes(id));
          if (ids.length !== 0) await WorkspaceUser.createMany(user.id, ids);
        }
      } catch (e) {
        console.error(
          "Could not add user to workspaces automatically",
          e.message
        );
      }

      return { success: true, error: null };
    } catch (error) {
      console.error(error.message);
      return { success: false, error: error.message };
    }
  },

  /**
   * S11a (#80): the REDEMPTION lookup. An expired invite is returned as null —
   * the same answer a code that never existed gets, which is what keeps this
   * from confirming that a code was real.
   *
   * Expiry lives HERE, not at the routes. `GET /invite/:code` and
   * `POST /invite/:code` already carry byte-identical copies of the status
   * check between them; a third copy per call site is a third place to forget
   * it, and the existing duplication is the evidence that it happens.
   *
   * NOT for `deactivate` or the admin listings. An admin deactivating an
   * expired invite is tidying, and an admin list that hides expired rows cannot
   * answer "did this invite ever get used?". Those read the table directly and
   * should keep doing so — "can this be redeemed" and "does this row exist" are
   * different questions.
   */
  get: async function (clause = {}) {
    try {
      const invite = await prisma.invites.findFirst({ where: clause });
      if (!invite) return null;
      // `expiresAt` null means never expires: that is every invite created
      // before S11 and every copy-link invite since. Reading null as expired
      // would retire all of them, and the failure would be indistinguishable
      // from a bad code.
      if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now())
        return null;
      return invite;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.invites.count({ where: clause });
      return count;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.invites.deleteMany({ where: clause });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  where: async function (clause = {}, limit) {
    try {
      const invites = await prisma.invites.findMany({
        where: clause,
        take: limit || undefined,
      });
      return invites;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * S11a (#80), TL-1: the recipient address is MASKED unless the caller may
   * manage users.
   *
   * Until this release `invites.email` was always null, so the listings could
   * return whole rows harmlessly. Populating that column is what turned
   * `GET /admin/invites` into a roster of every address invited — readable by
   * anyone holding `invite.read`, which is a far wider grant than "may see who
   * we contacted". This change created the exposure, so it closes it.
   *
   * Masked rather than removed: an admin needs to recognise WHICH invite is
   * which, and `j***@example.com` does that without publishing the address.
   *
   * @param {{unmaskEmail?: boolean}} [options] full addresses, for a caller the
   *   route has already checked holds `user.manage`. Never true for an API key:
   *   the scope vocabulary cannot express that permission.
   */
  whereWithUsers: async function (clause = {}, limit, options = {}) {
    const { User } = require("./user");
    try {
      const invites = await this.where(clause, limit);
      for (const invite of invites)
        if (invite.email && options.unmaskEmail !== true)
          invite.email = this.maskEmail(invite.email);
      for (const invite of invites) {
        if (invite.claimedBy) {
          const acceptedUser = await User.get({ id: invite.claimedBy });
          invite.claimedBy = {
            id: acceptedUser?.id,
            username: acceptedUser?.username,
          };
        }

        if (invite.createdBy) {
          const createdUser = await User.get({ id: invite.createdBy });
          invite.createdBy = {
            id: createdUser?.id,
            username: createdUser?.username,
          };
        }
      }
      return invites;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },
};

module.exports = { Invite };
