<script lang="ts">
	import { signInWithGoogle } from '$lib/supabase';

	let signingIn = $state(false);
	let error = $state<string | null>(null);

	async function handleSignIn() {
		signingIn = true;
		error = null;
		try {
			await signInWithGoogle();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sign in failed';
			signingIn = false;
		}
	}
</script>

<div class="auth-overlay">
	<div class="auth-modal">
		<div class="modal-icon">
			<svg viewBox="0 0 23 23" fill="none" width="48" height="48">
				<rect width="11" height="11" fill="#f25022" />
				<rect x="12" width="11" height="11" fill="#7fba00" />
				<rect y="12" width="11" height="11" fill="#00a4ef" />
				<rect x="12" y="12" width="11" height="11" fill="#ffb900" />
			</svg>
		</div>
		<h2>Sign in required</h2>
		<p>Please sign in to access Homer.</p>
		{#if error}
			<div class="error">{error}</div>
		{/if}
		<button onclick={handleSignIn} disabled={signingIn}>
			{#if signingIn}
				<span class="spinner"></span>
				Signing in...
			{:else}
				<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
					<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
					<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
					<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
					<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
				</svg>
				Sign in with Google
			{/if}
		</button>
	</div>
</div>

<style>
	.auth-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 9999;
	}

	.auth-modal {
		background: white;
		padding: 40px 48px;
		border-radius: 8px;
		text-align: center;
		max-width: 400px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
	}

	.modal-icon {
		margin-bottom: 24px;
	}

	h2 {
		font-size: 24px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0 0 8px 0;
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
	}

	p {
		font-size: 14px;
		color: #666;
		margin: 0 0 24px 0;
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
	}

	.error {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 10px 16px;
		border-radius: 4px;
		margin-bottom: 16px;
		font-size: 13px;
	}

	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		background: white;
		border: 1px solid #e0e0e0;
		padding: 12px 24px;
		border-radius: 4px;
		font-size: 14px;
		font-weight: 500;
		color: #1b1b1b;
		cursor: pointer;
		transition: all 0.15s;
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
		min-width: 200px;
	}

	button:hover:not(:disabled) {
		background: #f5f5f5;
		border-color: #ccc;
	}

	button:disabled {
		opacity: 0.7;
		cursor: not-allowed;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid #e0e0e0;
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 480px) {
		.auth-modal {
			margin: 16px;
			padding: 32px 24px;
		}
	}
</style>
