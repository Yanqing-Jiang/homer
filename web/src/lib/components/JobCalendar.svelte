<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Calendar, type EventDropArg } from '@fullcalendar/core';
	import dayGridPlugin from '@fullcalendar/daygrid';
	import interactionPlugin from '@fullcalendar/interaction';
	import type { CalendarEvent, ScheduledJob } from '$lib/api/client';
	import { updateScheduledJob } from '$lib/api/client';

	interface Props {
		events: CalendarEvent[];
		jobs: ScheduledJob[];
		onMonthChange?: (date: Date) => void;
		onEventClick?: (jobId: string) => void;
	}

	let { events, jobs, onMonthChange, onEventClick }: Props = $props();

	let calendarEl: HTMLDivElement | null = $state(null);
	let calendar: Calendar | null = null;
	let rescheduling = $state(false);

	function getLaneColor(lane: string): string {
		switch (lane) {
			case 'work':
				return '#3b82f6';
			case 'invest':
				return '#22c55e';
			case 'personal':
				return '#a855f7';
			case 'learning':
				return '#f59e0b';
			default:
				return '#6b7280';
		}
	}

	function createCalendarEvents() {
		return events.map((event) => {
			const job = jobs.find((j) => j.id === event.jobId);
			const lane = job?.lane || '';
			return {
				id: `${event.jobId}-${event.date}-${event.time}`,
				title: event.jobName,
				start: `${event.date}T${event.time}:00`,
				backgroundColor: event.enabled ? getLaneColor(lane) : '#d1d5db',
				borderColor: event.enabled ? getLaneColor(lane) : '#d1d5db',
				textColor: event.enabled ? '#ffffff' : '#6b7280',
				extendedProps: {
					jobId: event.jobId,
					lane,
					enabled: event.enabled,
					time: event.time
				}
			};
		});
	}

	async function handleEventDrop(info: EventDropArg) {
		if (!info.event.start) {
			info.revert();
			return;
		}

		const jobId = info.event.extendedProps.jobId as string;
		const time = info.event.extendedProps.time as string;
		const newDate = info.event.start;

		// Confirm with user
		const newDateStr = newDate.toLocaleDateString('en-US', {
			weekday: 'long',
			month: 'short',
			day: 'numeric'
		});

		if (!confirm(`Reschedule this job to ${newDateStr} at ${time}?\n\nThis will change the job's schedule to run weekly on ${newDate.toLocaleDateString('en-US', { weekday: 'long' })}s.`)) {
			info.revert();
			return;
		}

		rescheduling = true;
		try {
			await updateScheduledJob(jobId, {
				scheduledDate: newDate.toISOString()
			});
			// Trigger reload
			if (onMonthChange) {
				onMonthChange(newDate);
			}
		} catch (e) {
			console.error('Failed to reschedule job:', e);
			alert(`Failed to reschedule: ${e instanceof Error ? e.message : 'Unknown error'}`);
			info.revert();
		} finally {
			rescheduling = false;
		}
	}

	onMount(() => {
		if (!calendarEl) return;

		calendar = new Calendar(calendarEl, {
			plugins: [dayGridPlugin, interactionPlugin],
			initialView: 'dayGridMonth',
			editable: true,
			droppable: false,
			eventStartEditable: true,
			eventDurationEditable: false,
			events: createCalendarEvents(),
			headerToolbar: {
				left: 'prev,next today',
				center: 'title',
				right: ''
			},
			eventClick: (info) => {
				const jobId = info.event.extendedProps.jobId as string;
				if (onEventClick) {
					onEventClick(jobId);
				}
			},
			eventDrop: handleEventDrop,
			datesSet: (info) => {
				if (onMonthChange) {
					onMonthChange(info.start);
				}
			},
			eventDidMount: (info) => {
				// Add tooltip
				const { lane, time, enabled } = info.event.extendedProps;
				info.el.title = `${info.event.title}\n${time} - ${lane}${enabled ? '' : ' (disabled)'}`;
			}
		});

		calendar.render();
	});

	// Update events when they change
	$effect(() => {
		if (calendar && events) {
			const eventSource = calendar.getEventSources()[0];
			if (eventSource) {
				eventSource.remove();
			}
			calendar.addEventSource(createCalendarEvents());
		}
	});

	onDestroy(() => {
		if (calendar) {
			calendar.destroy();
		}
	});
</script>

<div class="job-calendar" class:rescheduling>
	{#if rescheduling}
		<div class="reschedule-overlay">
			<div class="reschedule-spinner"></div>
			<span>Rescheduling...</span>
		</div>
	{/if}
	<div bind:this={calendarEl} class="calendar-container"></div>
</div>

<style>
	.job-calendar {
		position: relative;
		background: white;
		border-radius: 8px;
		padding: 16px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
	}

	.job-calendar.rescheduling {
		pointer-events: none;
		opacity: 0.7;
	}

	.reschedule-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(255, 255, 255, 0.8);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		z-index: 10;
		border-radius: 8px;
		font-size: 14px;
		color: #0078d4;
	}

	.reschedule-spinner {
		width: 20px;
		height: 20px;
		border: 2px solid #e0e0e0;
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.calendar-container {
		min-height: 600px;
	}

	/* FullCalendar overrides */
	:global(.job-calendar .fc) {
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
	}

	:global(.job-calendar .fc-toolbar-title) {
		font-size: 20px !important;
		font-weight: 600;
		color: #1b1b1b;
	}

	:global(.job-calendar .fc-button) {
		background: white !important;
		border: 1px solid #e0e0e0 !important;
		color: #666 !important;
		font-size: 14px !important;
		padding: 8px 12px !important;
		box-shadow: none !important;
	}

	:global(.job-calendar .fc-button:hover) {
		background: #f5f5f5 !important;
		color: #1b1b1b !important;
	}

	:global(.job-calendar .fc-button-active) {
		background: #e5f1fb !important;
		border-color: #0078d4 !important;
		color: #0078d4 !important;
	}

	:global(.job-calendar .fc-daygrid-day) {
		cursor: default;
	}

	:global(.job-calendar .fc-daygrid-day-number) {
		font-size: 14px;
		color: #1b1b1b;
		padding: 8px;
	}

	:global(.job-calendar .fc-event) {
		cursor: grab;
		font-size: 11px;
		padding: 2px 6px;
		border-radius: 3px;
		margin-bottom: 2px;
	}

	:global(.job-calendar .fc-event:active) {
		cursor: grabbing;
	}

	:global(.job-calendar .fc-event-dragging) {
		opacity: 0.8;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
	}

	:global(.job-calendar .fc-day-today) {
		background: #f0f9ff !important;
	}

	:global(.job-calendar .fc-col-header-cell) {
		background: #f5f5f5;
		font-weight: 600;
		font-size: 12px;
		text-transform: uppercase;
		color: #666;
		padding: 12px 8px;
	}

	:global(.job-calendar .fc-scrollgrid) {
		border-color: #e0e0e0 !important;
	}

	:global(.job-calendar .fc-scrollgrid-section > td) {
		border-color: #e0e0e0;
	}

	:global(.job-calendar .fc-daygrid-day-frame) {
		min-height: 100px;
	}

	:global(.job-calendar .fc-more-link) {
		font-size: 11px;
		color: #0078d4;
	}
</style>
