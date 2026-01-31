// Super user access control
export const ALLOWED_EMAIL = '[redacted]';

export function isAuthorizedUser(email: string | undefined): boolean {
	if (!email) return false;
	return email.toLowerCase().trim() === ALLOWED_EMAIL.toLowerCase();
}
