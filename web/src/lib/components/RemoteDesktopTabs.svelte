<script lang="ts">
	import GuacamoleViewer from './GuacamoleViewer.svelte';

	interface Tab {
		id: string;
		name: string;
		icon: string;
		color: string;
		url?: string;  // Optional direct URL hint for the browser
	}

	const tabs: Tab[] = [
		{
			id: 'chatgpt',
			name: 'ChatGPT',
			icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
			color: '#10A37F',
			url: 'https://chat.openai.com'
		},
		{
			id: 'claude',
			name: 'Claude',
			icon: 'M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18l6.9 3.45L12 11.09 5.1 7.63 12 4.18zM4 16.54V9.09l7 3.5v7.45l-7-3.5zm9 3.5v-7.45l7-3.5v7.45l-7 3.5z',
			color: '#D97706',
			url: 'https://claude.ai'
		},
		{
			id: 'gemini',
			name: 'Gemini',
			icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.65 14.65l-2.12-2.12a3.5 3.5 0 1 1 1.41-1.41l2.12 2.12-1.41 1.41zM10 13c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z',
			color: '#4285F4',
			url: 'https://gemini.google.com'
		}
	];

	// State
	let activeTab = $state<string>('chatgpt');
	let connectionStatus = $state<Record<string, 'disconnected' | 'connecting' | 'connected'>>({
		chatgpt: 'disconnected',
		claude: 'disconnected',
		gemini: 'disconnected'
	});

	// Guacamole configuration
	// In development: use relative /guac (proxied by Vite)
	// In production: use Azure Container Apps proxy
	const GUAC_PROXY_URL = import.meta.env.VITE_GUAC_PROXY_URL || 'https://homer-proxy.icycoast-7ad83edf.westus2.azurecontainerapps.io/guac/guacamole';
	const guacamoleUrl = $state(
		import.meta.env.DEV ? '/guac/guacamole' : GUAC_PROXY_URL
	);

	function selectTab(tabId: string) {
		activeTab = tabId;
	}

	function handleConnect(tabId: string) {
		connectionStatus[tabId] = 'connected';
	}

	function handleDisconnect(tabId: string) {
		connectionStatus[tabId] = 'disconnected';
	}

	function handleError(tabId: string, error: string) {
		connectionStatus[tabId] = 'disconnected';
		console.error(`[${tabId}] Connection error:`, error);
	}

	function getStatusColor(status: string): string {
		switch (status) {
			case 'connected': return '#22c55e';
			case 'connecting': return '#f59e0b';
			default: return '#6b7280';
		}
	}
</script>

<div class="remote-desktop-tabs">
	<!-- Tab Bar -->
	<div class="tab-bar">
		{#each tabs as tab}
			<button
				class="tab-button"
				class:active={activeTab === tab.id}
				style="--tab-color: {tab.color}"
				onclick={() => selectTab(tab.id)}
			>
				<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
					<path d={tab.icon}/>
				</svg>
				<span class="tab-name">{tab.name}</span>
				<span
					class="status-dot"
					style="background-color: {getStatusColor(connectionStatus[tab.id])}"
					title={connectionStatus[tab.id]}
				></span>
			</button>
		{/each}

		<div class="tab-bar-spacer"></div>

		<!-- Connection info -->
		<div class="connection-info">
			<span class="connection-label">Remote Desktop</span>
			<span class="connection-status" style="color: {getStatusColor(connectionStatus[activeTab])}">
				{connectionStatus[activeTab]}
			</span>
		</div>
	</div>

	<!-- Tab Content -->
	<div class="tab-content">
		{#each tabs as tab}
			<div class="tab-panel" class:active={activeTab === tab.id}>
				{#if activeTab === tab.id}
					<GuacamoleViewer
						connectionName={tab.name}
						guacamoleUrl={guacamoleUrl}
						onConnect={() => handleConnect(tab.id)}
						onDisconnect={() => handleDisconnect(tab.id)}
						onError={(error) => handleError(tab.id, error)}
					/>
				{/if}
			</div>
		{/each}

		<!-- Hint overlay when disconnected -->
		{#if connectionStatus[activeTab] === 'disconnected'}
			<div class="hint-overlay">
				<div class="hint-content">
					<svg viewBox="0 0 24 24" fill="currentColor" width="64" height="64">
						<path d="M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7l-2 3v1h8v-1l-2-3h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z"/>
					</svg>
					<h3>Remote Desktop Access</h3>
					<p>
						Connect to your Mac Mini to access
						<strong style="color: {tabs.find(t => t.id === activeTab)?.color}">{tabs.find(t => t.id === activeTab)?.name}</strong>
					</p>
					<p class="hint-small">
						Make sure Guacamole is running and Screen Sharing is enabled on your Mac.
					</p>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.remote-desktop-tabs {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: #1b1b1b;
	}

	.tab-bar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px 12px;
		background: #2d2d2d;
		border-bottom: 1px solid #404040;
		flex-shrink: 0;
	}

	.tab-button {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		background: transparent;
		border: none;
		border-radius: 6px 6px 0 0;
		color: #999;
		font-size: 13px;
		cursor: pointer;
		transition: all 0.15s;
		position: relative;
	}

	.tab-button:hover {
		background: rgba(255, 255, 255, 0.05);
		color: #fff;
	}

	.tab-button.active {
		background: #1b1b1b;
		color: var(--tab-color, #fff);
	}

	.tab-button.active::after {
		content: '';
		position: absolute;
		bottom: -1px;
		left: 0;
		right: 0;
		height: 2px;
		background: var(--tab-color, #0078d4);
	}

	.tab-name {
		font-weight: 500;
	}

	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.tab-bar-spacer {
		flex: 1;
	}

	.connection-info {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 12px;
		background: rgba(0, 0, 0, 0.2);
		border-radius: 4px;
		font-size: 12px;
	}

	.connection-label {
		color: #666;
	}

	.connection-status {
		text-transform: capitalize;
		font-weight: 500;
	}

	.tab-content {
		flex: 1;
		position: relative;
		overflow: hidden;
	}

	.tab-panel {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		visibility: hidden;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.tab-panel.active {
		visibility: visible;
		opacity: 1;
	}

	.hint-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(27, 27, 27, 0.9);
		z-index: 5;
	}

	.hint-content {
		text-align: center;
		color: #999;
		max-width: 400px;
		padding: 24px;
	}

	.hint-content svg {
		color: #444;
		margin-bottom: 16px;
	}

	.hint-content h3 {
		color: #fff;
		font-size: 18px;
		font-weight: 600;
		margin: 0 0 12px;
	}

	.hint-content p {
		margin: 8px 0;
		line-height: 1.5;
	}

	.hint-small {
		font-size: 12px;
		color: #666;
	}

	/* Responsive */
	@media (max-width: 640px) {
		.tab-button {
			padding: 8px 12px;
		}

		.tab-name {
			display: none;
		}

		.connection-info {
			display: none;
		}
	}
</style>
