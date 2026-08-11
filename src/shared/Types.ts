export interface BoostTier {
	Time: number;
	Multiplier: number;
}

export interface JobConfig {
	DisplayName: string;
	Team?: string; // defaults to the job's key
	FixedIncomePerMinute: number;
	AFKThreshold?: number; // seconds idle before auto-end; default 75
	AFKWarningThreshold?: number; // seconds idle before AFKWarning fires; default 45
	Boosts?: BoostTier[]; // sorted ascending by Time; highest tier reached multiplies payout
	ActionRewards: Record<string, number>; // only these rewardIds are accepted by ActionReward
	RequiresGamepassId?: number;
}

export type ShiftEndReason = "manual" | "died" | "afk" | "disconnect" | "replaced";

export interface RemoteEvents {
	ShiftStarted: RemoteEvent;
	ShiftUpdated: RemoteEvent;
	ShiftEnded: RemoteEvent;
	FinishShift: RemoteEvent;
	ActivityPing: RemoteEvent;
	PromptGamepass: RemoteEvent;
	JobError: RemoteEvent;
	AFKWarning: RemoteEvent;
}
