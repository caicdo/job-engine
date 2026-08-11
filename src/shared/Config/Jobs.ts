import { JobConfig } from "shared/Types";

const Jobs: Record<string, JobConfig> = {
	Guard: {
		DisplayName: "Guard",
		Team: "Guards",
		FixedIncomePerMinute: 40,
		AFKThreshold: 75,
		AFKWarningThreshold: 45,
		Boosts: [
			{ Time: 300, Multiplier: 1.25 }, // 5 min in
			{ Time: 900, Multiplier: 1.5 }, // 15 min in
		],
		ActionRewards: {
			patrol_checkpoint: 15,
			resolve_incident: 40,
		},
	},

	Farmer: {
		DisplayName: "Farmer",
		Team: "Farmers",
		FixedIncomePerMinute: 25,
		AFKThreshold: 90,
		AFKWarningThreshold: 60,
		Boosts: [{ Time: 600, Multiplier: 1.2 }],
		ActionRewards: {
			harvest_crop: 10,
			sell_at_market: 20,
		},
	},
};

export default Jobs;
