import type { RunEvent, StepEvent } from '$lib/api/client';

export type StreamingStep = StepEvent & {
	startedAt: number;
	completed: boolean;
};

function parsePayload(payloadJson: string | null): Record<string, unknown> {
	if (!payloadJson) return {};
	try {
		const parsed = JSON.parse(payloadJson);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

export function buildStreamingStepsFromRunEvents(events: RunEvent[]): StreamingStep[] {
	const steps: StreamingStep[] = [];
	const indexByKey = new Map<string, number>();

	for (const event of events) {
		if (event.kind !== 'tool_use' && event.kind !== 'tool_result' && event.kind !== 'thinking') {
			continue;
		}

		const payload = parsePayload(event.payloadJson);
		const toolId = typeof payload.toolId === 'string' ? payload.toolId : undefined;
		const preview = typeof payload.preview === 'string' ? payload.preview : undefined;
		const tool = typeof payload.tool === 'string' ? payload.tool : undefined;
		const startedAt = new Date(event.createdAt).getTime();

		if (event.kind === 'tool_use') {
			const key = toolId ? `tool:${toolId}` : `tool:event:${event.id}`;
			const step: StreamingStep = {
				type: 'tool_use',
				id: toolId,
				tool,
				label: event.label ?? 'Working...',
				labelDone: event.labelDone ?? event.label ?? 'Finished',
				preview,
				startedAt,
				completed: false,
			};
			const existingIndex = indexByKey.get(key);
			if (existingIndex !== undefined) {
				steps[existingIndex] = step;
			} else {
				indexByKey.set(key, steps.length);
				steps.push(step);
			}
			continue;
		}

		if (event.kind === 'tool_result') {
			const key = toolId ? `tool:${toolId}` : `tool:event:${event.id}`;
			const existingIndex = indexByKey.get(key);
			if (existingIndex !== undefined) {
				const existing = steps[existingIndex];
				steps[existingIndex] = {
					...existing,
					completed: true,
					labelDone: event.labelDone ?? existing.labelDone ?? existing.label,
					preview: preview ?? existing.preview,
				};
			} else {
				indexByKey.set(key, steps.length);
				steps.push({
					type: 'tool_use',
					id: toolId,
					tool,
					label: event.label ?? event.labelDone ?? 'Working...',
					labelDone: event.labelDone ?? event.label ?? 'Finished',
					preview,
					startedAt,
					completed: true,
				});
			}
			continue;
		}

		const key = toolId ? `thinking:${toolId}` : `thinking:event:${event.id}`;
		const step: StreamingStep = {
			type: 'thinking',
			id: toolId,
			tool,
			label: event.label ?? '',
			labelDone: event.labelDone ?? event.label ?? '',
			preview,
			startedAt,
			completed: true,
		};
		const existingIndex = indexByKey.get(key);
		if (existingIndex !== undefined) {
			steps[existingIndex] = {
				...steps[existingIndex],
				...step,
				startedAt: steps[existingIndex].startedAt,
			};
		} else {
			indexByKey.set(key, steps.length);
			steps.push(step);
		}
	}

	return steps;
}
