<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		icon?: 'ideas' | 'plans' | 'sessions' | 'jobs' | 'search';
		title: string;
		description?: string;
		children?: Snippet;
	}

	let { icon = 'search', title, description, children }: Props = $props();
</script>

<div class="empty-state">
	<div class="icon-container">
		{#if icon === 'ideas'}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
				<path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
			</svg>
		{:else if icon === 'plans'}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
				<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>
			</svg>
		{:else if icon === 'sessions'}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
			</svg>
		{:else if icon === 'jobs'}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
				<path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
			</svg>
		{:else}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
				<circle cx="11" cy="11" r="8"/>
				<path d="M21 21l-4.35-4.35"/>
			</svg>
		{/if}
	</div>
	<h3 class="title">{title}</h3>
	{#if description}
		<p class="description">{description}</p>
	{/if}
	{#if children}
		<div class="actions">
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
	}

	.icon-container {
		width: 64px;
		height: 64px;
		background: #f3f4f6;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 16px;
	}

	.icon-container svg {
		width: 32px;
		height: 32px;
		color: #9ca3af;
	}

	.title {
		font-size: 16px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0 0 8px 0;
	}

	.description {
		font-size: 14px;
		color: #666;
		margin: 0;
		max-width: 300px;
	}

	.actions {
		margin-top: 16px;
	}
</style>
