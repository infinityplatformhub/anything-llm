const { User } = require("../../models/user");

class ActorIdentityStore {
  async resolveActor(actorRef) {
    if (actorRef.type !== "user") return { ...actorRef, active: true, workspaceIds: [], groupIds: [] };
    const user = await User.get({ id: Number(actorRef.id) });
    if (!user || user.suspended) return null;
    return { ...actorRef, ...user, active: true, workspaceIds: [], groupIds: [] };
  }
}

module.exports = { ActorIdentityStore };
