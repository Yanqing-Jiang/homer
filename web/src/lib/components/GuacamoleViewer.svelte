<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Guacamole from 'guacamole-common-js';

	// Props
	interface Props {
		connectionName?: string;
		guacamoleUrl?: string;
		token?: string;
		onConnect?: () => void;
		onDisconnect?: () => void;
		onError?: (error: string) => void;
	}

	let {
		connectionName = 'Mac Desktop',
		guacamoleUrl = '/guac/guacamole',
		token = '',
		onConnect,
		onDisconnect,
		onError
	}: Props = $props();

	// State
	let displayContainer: HTMLDivElement;
	let client: Guacamole.Client | null = $state(null);
	let connected = $state(false);
	let connecting = $state(false);
	let error = $state<string | null>(null);
	let keyboard: Guacamole.Keyboard | null = null;
	// Mouse type is incomplete in @types/guacamole-common-js
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let mouse: any = null;

	// Compute WebSocket tunnel URL
	function getTunnelUrl(): string {
		// Use relative URL that will be proxied
		// In production: Azure Container Apps proxies /guac/* to guac.jiangyanqing.com
		const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const baseUrl = guacamoleUrl.startsWith('http')
			? guacamoleUrl.replace(/^http/, 'ws')
			: `${wsProtocol}//${window.location.host}${guacamoleUrl}`;
		return `${baseUrl}/websocket-tunnel`;
	}

	function connect() {
		if (connecting || connected) return;

		connecting = true;
		error = null;

		try {
			// Create WebSocket tunnel
			const tunnelUrl = getTunnelUrl();
			const tunnel = new Guacamole.WebSocketTunnel(tunnelUrl);

			// Create client
			client = new Guacamole.Client(tunnel);

			// Handle client state changes
			client.onstatechange = (state: number) => {
				switch (state) {
					case 0: // IDLE
						break;
					case 1: // CONNECTING
						connecting = true;
						break;
					case 2: // WAITING
						break;
					case 3: // CONNECTED
						connecting = false;
						connected = true;
						onConnect?.();
						break;
					case 4: // DISCONNECTING
						break;
					case 5: // DISCONNECTED
						connecting = false;
						connected = false;
						onDisconnect?.();
						break;
				}
			};

			// Handle errors
			client.onerror = (err: Guacamole.Status) => {
				const errorMsg = err.message || `Error code: ${err.code}`;
				error = errorMsg;
				connecting = false;
				onError?.(errorMsg);
			};

			// Get display element and add to container
			const display = client.getDisplay();
			const element = display.getElement();

			// Clear container and add display
			displayContainer.innerHTML = '';
			displayContainer.appendChild(element);

			// Auto-scale display to fit container
			display.onresize = (width: number, height: number) => {
				const containerWidth = displayContainer.clientWidth;
				const containerHeight = displayContainer.clientHeight;

				if (width > 0 && height > 0) {
					const scaleX = containerWidth / width;
					const scaleY = containerHeight / height;
					const scale = Math.min(scaleX, scaleY, 1);

					display.scale(scale);
				}
			};

			// Setup keyboard
			keyboard = new Guacamole.Keyboard(document);
			keyboard.onkeydown = (keysym: number) => {
				client?.sendKeyEvent(1, keysym);
			};
			keyboard.onkeyup = (keysym: number) => {
				client?.sendKeyEvent(0, keysym);
			};

			// Setup mouse
			mouse = new Guacamole.Mouse(element);
			mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (mouseState: Guacamole.Mouse.State) => {
				client?.sendMouseState(mouseState);
			};

			// Connect with parameters
			// The token should contain authentication info from Guacamole auth
			const connectParams = token ? `token=${encodeURIComponent(token)}` : '';
			client.connect(connectParams);

		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : 'Failed to connect';
			error = errorMsg;
			connecting = false;
			onError?.(errorMsg);
		}
	}

	function disconnect() {
		if (keyboard) {
			keyboard.onkeydown = null;
			keyboard.onkeyup = null;
			keyboard = null;
		}

		if (mouse) {
			mouse.onmousedown = null;
			mouse.onmouseup = null;
			mouse.onmousemove = null;
			mouse = null;
		}

		if (client) {
			client.disconnect();
			client = null;
		}

		connected = false;
		connecting = false;
	}

	function handleResize() {
		if (client && connected) {
			const display = client.getDisplay();
			const width = display.getWidth();
			const height = display.getHeight();

			if (width > 0 && height > 0 && displayContainer) {
				const containerWidth = displayContainer.clientWidth;
				const containerHeight = displayContainer.clientHeight;
				const scaleX = containerWidth / width;
				const scaleY = containerHeight / height;
				const scale = Math.min(scaleX, scaleY, 1);

				display.scale(scale);
			}
		}
	}

	// Reconnect when connection name changes
	$effect(() => {
		// Track connectionName to trigger reconnect
		const _ = connectionName;
		if (connected) {
			disconnect();
			// Small delay before reconnecting
			setTimeout(connect, 100);
		}
	});

	onMount(() => {
		// Add resize listener
		window.addEventListener('resize', handleResize);

		// Auto-connect on mount
		connect();
	});

	onDestroy(() => {
		window.removeEventListener('resize', handleResize);
		disconnect();
	});

	// Expose methods for parent component
	export function reconnect() {
		disconnect();
		setTimeout(connect, 100);
	}

	export function isConnected() {
		return connected;
	}
</script>

<div class="guacamole-viewer">
	{#if error}
		<div class="error-overlay">
			<div class="error-content">
				<svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
					<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
				</svg>
				<p class="error-message">{error}</p>
				<button class="retry-btn" onclick={connect}>Retry Connection</button>
			</div>
		</div>
	{:else if connecting}
		<div class="connecting-overlay">
			<div class="connecting-content">
				<div class="spinner"></div>
				<p>Connecting to {connectionName}...</p>
			</div>
		</div>
	{/if}

	<div
		class="display-container"
		class:hidden={!connected || !!error}
		bind:this={displayContainer}
	></div>
</div>

<style>
	.guacamole-viewer {
		width: 100%;
		height: 100%;
		position: relative;
		background: #1e1e1e;
		overflow: hidden;
	}

	.display-container {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.display-container.hidden {
		visibility: hidden;
	}

	.display-container :global(canvas) {
		cursor: default;
	}

	.connecting-overlay,
	.error-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(30, 30, 30, 0.95);
		z-index: 10;
	}

	.connecting-content,
	.error-content {
		text-align: center;
		color: #fff;
	}

	.spinner {
		width: 48px;
		height: 48px;
		border: 4px solid rgba(255, 255, 255, 0.2);
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 1s linear infinite;
		margin: 0 auto 16px;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.connecting-content p,
	.error-content p {
		margin: 16px 0;
		font-size: 14px;
		color: #ccc;
	}

	.error-content svg {
		color: #f44336;
		margin-bottom: 8px;
	}

	.error-message {
		color: #ff6b6b;
		max-width: 400px;
		word-break: break-word;
	}

	.retry-btn {
		margin-top: 16px;
		padding: 10px 24px;
		background: #0078d4;
		color: white;
		border: none;
		border-radius: 4px;
		font-size: 14px;
		cursor: pointer;
		transition: background 0.15s;
	}

	.retry-btn:hover {
		background: #106ebe;
	}
</style>
