// Idea types
export type IdeaStatus = 'draft' | 'review' | 'planning' | 'execution' | 'archived';

export interface Idea {
	id: string;
	title: string;
	source: string;
	status: IdeaStatus;
	content: string;
	context?: string;
	tags?: string[];
	link?: string;
	notes?: string;
	timestamp: string;
}

// Plan types
export type PlanStatus = 'planning' | 'execution' | 'completed';
export type PhaseStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanTask {
	text: string;
	completed: boolean;
}

export interface PlanPhase {
	name: string;
	status: PhaseStatus;
	tasks: PlanTask[];
}

export interface Plan {
	id: string;
	title: string;
	status: PlanStatus;
	currentPhase: string;
	description?: string;
	phases: PlanPhase[];
	feedbackLog?: string[];
	createdAt: string;
	updatedAt: string;
}

// Session types
export type SessionStatus = 'active' | 'expired';

export interface SessionMessage {
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
}

export interface Session {
	id: string;
	title: string;
	model: string;
	status: SessionStatus;
	messages: SessionMessage[];
	createdAt: string;
	lastActive: string;
}

// Job types
export type JobStatus = 'enabled' | 'disabled';
export type JobRunStatus = 'success' | 'failed' | 'running';

export interface JobRun {
	id: string;
	startedAt: string;
	completedAt: string | null;
	success: boolean;
	output?: string;
	error?: string;
	exitCode?: number;
	durationMs?: number | null;
}

export interface ScheduledJob {
	id: string;
	name: string;
	cron: string;
	cronHuman: string;
	lane: string;
	enabled: boolean;
	timeout: number | null;
	model: string | null;
	lastRun: string | null;
	lastSuccess: string | null;
	consecutiveFailures: number;
	nextRuns: string[];
}

export interface ScheduledJobDetail extends ScheduledJob {
	query?: string;
	state?: {
		lastRunAt: string | null;
		lastSuccessAt: string | null;
		consecutiveFailures: number;
	};
	history: JobRun[];
}

export interface CalendarEvent {
	jobId: string;
	jobName: string;
	date: string;
	time: string;
	enabled: boolean;
}
