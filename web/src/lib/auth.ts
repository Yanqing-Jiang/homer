// Client-side authorization is purely cosmetic - server enforces actual authorization
// via 403 responses. This file is kept for API compatibility but always returns true.
// Authorization is handled server-side in src/web/auth.ts

export function isAuthorizedUser(_email: string | undefined): boolean {
	// All authorization is enforced server-side
	// Client just needs to handle 403 responses appropriately
	return true;
}
