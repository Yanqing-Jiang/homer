import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

export interface JWTPayload {
  sub: string;          // User ID
  email?: string;       // User email
  aud: string;          // Audience (authenticated)
  role?: string;        // Role (authenticated, anon)
  iat?: number;         // Issued at
  exp?: number;         // Expiration
}

export interface AuthenticatedRequest extends FastifyRequest {
  user?: JWTPayload;
}

/**
 * Verify a Supabase JWT token
 */
export function verifySupabaseToken(token: string): JWTPayload | null {
  const secret = config.auth.supabaseJwtSecret;

  if (!secret) {
    logger.warn("No Supabase JWT secret configured - auth disabled");
    return null;
  }

  try {
    // Validate JWT with proper claims verification
    const verifyOptions: jwt.VerifyOptions = {
      algorithms: ["HS256"],
      audience: "authenticated",
    };

    // Add issuer validation if supabaseUrl is configured
    if (config.auth.supabaseUrl) {
      verifyOptions.issuer = `${config.auth.supabaseUrl}/auth/v1`;
    }

    const payload = jwt.verify(token, secret, verifyOptions) as JWTPayload;

    return payload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.debug("JWT token expired");
    } else if (error instanceof jwt.JsonWebTokenError) {
      logger.debug({ error: (error as Error).message }, "Invalid JWT token");
    } else {
      logger.error({ error }, "JWT verification error");
    }
    return null;
  }
}

/**
 * Check if email is authorized
 */
export function isAuthorizedEmail(email: string | undefined): boolean {
  const allowedEmail = config.web.allowedEmail;
  if (!allowedEmail) {
    logger.warn("No allowed email configured - all authenticated users allowed");
    return true;
  }

  if (!email) return false;
  return email.toLowerCase().trim() === allowedEmail.toLowerCase().trim();
}

/**
 * Auth middleware for API routes
 *
 * When web.exposeExternally is true:
 * - Validates Bearer token from Authorization header
 * - Verifies JWT signature with Supabase secret
 * - Checks email against allowedEmail
 *
 * When web.exposeExternally is false:
 * - Only allows localhost access (rejects proxied requests)
 * - Skips token authentication for valid localhost connections
 */
export async function authMiddleware(
  request: AuthenticatedRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip auth for health checks
  if (request.url === "/health" || request.url === "/health/auth") {
    return;
  }

  // When not exposed externally, only allow genuine localhost requests
  if (!config.web.exposeExternally) {
    // Reject any request that appears to be proxied (SSRF protection)
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      logger.warn({ forwarded }, "Rejected proxied request when exposeExternally=false");
      reply.status(403).send({
        error: "Forbidden",
        message: "External access not allowed"
      });
      return;
    }

    // Only allow actual localhost connections
    const ip = request.ip;
    const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocalhost) {
      logger.warn({ ip }, "Rejected non-localhost request when exposeExternally=false");
      reply.status(403).send({
        error: "Forbidden",
        message: "Only localhost access allowed"
      });
      return;
    }

    // Valid localhost request - skip auth
    return;
  }

  // Extract token from Authorization header
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    reply.status(401).send({
      error: "Unauthorized",
      message: "Missing or invalid Authorization header"
    });
    return;
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  // Verify JWT
  const payload = verifySupabaseToken(token);
  if (!payload) {
    reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or expired token"
    });
    return;
  }

  // Check if email is authorized
  if (!isAuthorizedEmail(payload.email)) {
    logger.warn({ email: payload.email }, "Unauthorized email attempted access");
    reply.status(403).send({
      error: "Forbidden",
      message: "You are not authorized to access this resource"
    });
    return;
  }

  // Attach user to request
  request.user = payload;
  logger.debug({ userId: payload.sub, email: payload.email }, "Authenticated request");
}

/**
 * Create auth hook for Fastify
 */
export function createAuthHook() {
  return async (request: AuthenticatedRequest, reply: FastifyReply) => {
    await authMiddleware(request, reply);
  };
}
