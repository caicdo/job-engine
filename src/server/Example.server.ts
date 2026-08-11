import { JobEngine } from "server/JobEngine";
import Jobs from "shared/Config/Jobs";

const Players = game.GetService("Players");
const Workspace = game.GetService("Workspace");

// Stand-in for your own currency system.
function payout(player: Player, amount: number): void {
	const leaderstats = player.FindFirstChild("leaderstats");
	const money = leaderstats?.FindFirstChild("Money");
	if (money?.IsA("NumberValue")) {
		money.Value += amount;
	} else {
		print(`[Example] would pay ${player.Name} ${amount}`);
	}
}

const engine = new JobEngine({
	Jobs: Jobs,
	Payout: payout,
	DefaultTeam: "Citizens",
	BehaviorsFolder: script.Parent!.FindFirstChild("Behaviors"),

	ValidateStart: (player, jobId) => {
		const leaderstats = player.FindFirstChild("leaderstats");
		const wanted = leaderstats?.FindFirstChild("Wanted");
		if (jobId === "Guard" && wanted?.IsA("IntValue") && wanted.Value > 0) {
			return { ok: false, reason: "You can't work as a Guard while wanted." };
		}
		return { ok: true };
	},

	LocationsRoot: Workspace.FindFirstChild("JobLocations"),
});

engine.ShiftStarted.Connect((player, jobId) => {
	print(`[Example] ${player.Name} started job ${jobId}`);
});

engine.ShiftEnded.Connect((player, jobId, payoutAmount, reason) => {
	print(`[Example] ${player.Name} ended job ${jobId} (${reason}): ${payoutAmount}`);
});

Players.PlayerRemoving.Connect((player) => {
	engine.OnPlayerRemoving(player);
});
