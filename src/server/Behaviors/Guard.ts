// Example Behavior for the "Guard" job. The instance name must match the jobId exactly — a
// "Farmer" job needs a sibling module named "Farmer". Keep the object itself stateless (see
// ShiftSession.ts's Behavior interface) and key per-shift bookkeeping by `session`, as below.

import { Behavior, ShiftSession } from "server/ShiftSession";

const checkpointsPatrolled = new Map<ShiftSession, number>();

const Guard: Behavior = {
	OnStart(session) {
		checkpointsPatrolled.set(session, 0);
		print(`[Guard] ${session.Player.Name} started a shift`);
	},

	OnActionReward(session, rewardId) {
		if (rewardId === "patrol_checkpoint") {
			checkpointsPatrolled.set(session, (checkpointsPatrolled.get(session) ?? 0) + 1);
		}
	},

	OnAFKStateChanged(session, isAFK) {
		if (isAFK) {
			print(`[Guard] ${session.Player.Name} went AFK`);
		}
	},

	OnEnd(session, reason, payout) {
		const count = checkpointsPatrolled.get(session) ?? 0;
		print(`[Guard] ${session.Player.Name} ended shift (${reason}): ${count} checkpoints, ${payout} paid out`);
		checkpointsPatrolled.delete(session); // avoid growing the map forever
	},

	Destroy() {},
};

export = Guard;
