import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, statSync, readFileSync } from "fs";
import { join, extname, basename } from "path";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";

const UPLOADS_DIR = `${config.paths.uploadLanding}/web`;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = [
  // Text
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "text/javascript",
  "application/json",
  "application/xml",
  // Images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // PDF
  "application/pdf",
  // Code
  "application/javascript",
  "application/typescript",
];

// Extension to mime type mapping for fallback
const EXT_TO_MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "application/typescript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

export interface UploadResult {
  id: string;
  filename: string;
  path: string;
  mimeType: string;
  size: number;
  sessionId: string;
  createdAt: string;
}

/**
 * Register uploads API routes
 */
export function registerUploadsRoutes(server: FastifyInstance): void {
  // Ensure uploads directory exists
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  // Upload file
  server.post("/api/uploads", async (request: FastifyRequest, reply: FastifyReply) => {
    const contentType = request.headers["content-type"] || "";

    if (!contentType.includes("multipart/form-data")) {
      reply.status(400);
      return { error: "Content-Type must be multipart/form-data" };
    }

    try {
      const data = await request.file();
      if (!data) {
        reply.status(400);
        return { error: "No file provided" };
      }

      const { filename, mimetype, file } = data;
      const sessionId = (request.body as any)?.sessionId || "default";

      // Validate mime type
      const ext = extname(filename).toLowerCase();
      const mimeType = mimetype || EXT_TO_MIME[ext] || "application/octet-stream";

      const isAllowed = ALLOWED_TYPES.some(t =>
        mimeType.startsWith(t.split("/")[0] ?? "") || mimeType === t
      ) || Object.keys(EXT_TO_MIME).includes(ext);

      if (!isAllowed) {
        reply.status(400);
        return { error: `File type not allowed: ${mimeType}` };
      }

      // Read file into buffer
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of file) {
        totalSize += chunk.length;
        if (totalSize > MAX_FILE_SIZE) {
          reply.status(400);
          return { error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB` };
        }
        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);

      // Create session-specific directory
      const sessionDir = join(UPLOADS_DIR, sessionId);
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
      }

      // Generate unique filename
      const id = randomUUID();
      const safeFilename = `${id}${ext}`;
      const filePath = join(sessionDir, safeFilename);

      // Save file
      writeFileSync(filePath, buffer);

      const result: UploadResult = {
        id,
        filename: basename(filename),
        path: filePath,
        mimeType,
        size: buffer.length,
        sessionId,
        createdAt: new Date().toISOString(),
      };

      logger.info({ id, filename, size: buffer.length }, "File uploaded");

      reply.status(201);
      return result;
    } catch (error) {
      logger.error({ error }, "Upload failed");
      reply.status(500);
      return { error: "Upload failed" };
    }
  });

  // List uploads for a session
  server.get("/api/uploads/:sessionId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.params as { sessionId: string };
    const sessionDir = join(UPLOADS_DIR, sessionId);

    if (!existsSync(sessionDir)) {
      return { uploads: [] };
    }

    try {
      const files = readdirSync(sessionDir);
      const uploads: UploadResult[] = files.map(filename => {
        const filePath = join(sessionDir, filename);
        const stats = statSync(filePath);
        const ext = extname(filename).toLowerCase();
        const id = basename(filename, ext);

        return {
          id,
          filename,
          path: filePath,
          mimeType: EXT_TO_MIME[ext] || "application/octet-stream",
          size: stats.size,
          sessionId,
          createdAt: stats.birthtime.toISOString(),
        };
      });

      return { uploads };
    } catch (error) {
      logger.error({ error, sessionId }, "Failed to list uploads");
      reply.status(500);
      return { error: "Failed to list uploads" };
    }
  });

  // Get upload content (for reading file content)
  server.get("/api/uploads/:sessionId/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId, id } = request.params as { sessionId: string; id: string };
    const sessionDir = join(UPLOADS_DIR, sessionId);

    if (!existsSync(sessionDir)) {
      reply.status(404);
      return { error: "Upload not found" };
    }

    try {
      const files = readdirSync(sessionDir);
      const file = files.find(f => f.startsWith(id));

      if (!file) {
        reply.status(404);
        return { error: "Upload not found" };
      }

      const filePath = join(sessionDir, file);
      const ext = extname(file).toLowerCase();
      const mimeType = EXT_TO_MIME[ext] || "application/octet-stream";
      const stats = statSync(filePath);

      // For text files, return content
      if (mimeType.startsWith("text/") || mimeType === "application/json") {
        const content = readFileSync(filePath, "utf-8");
        return {
          id,
          filename: file,
          mimeType,
          size: stats.size,
          content,
        };
      }

      // For binary files, return base64
      const buffer = readFileSync(filePath);
      return {
        id,
        filename: file,
        mimeType,
        size: stats.size,
        base64: buffer.toString("base64"),
      };
    } catch (error) {
      logger.error({ error, sessionId, id }, "Failed to get upload");
      reply.status(500);
      return { error: "Failed to get upload" };
    }
  });

  // Delete upload
  server.delete("/api/uploads/:sessionId/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId, id } = request.params as { sessionId: string; id: string };
    const sessionDir = join(UPLOADS_DIR, sessionId);

    if (!existsSync(sessionDir)) {
      reply.status(404);
      return { error: "Upload not found" };
    }

    try {
      const files = readdirSync(sessionDir);
      const file = files.find(f => f.startsWith(id));

      if (!file) {
        reply.status(404);
        return { error: "Upload not found" };
      }

      const filePath = join(sessionDir, file);
      unlinkSync(filePath);

      logger.info({ id, sessionId }, "File deleted");

      return { deleted: true, id };
    } catch (error) {
      logger.error({ error, sessionId, id }, "Failed to delete upload");
      reply.status(500);
      return { error: "Failed to delete upload" };
    }
  });
}

/**
 * Read file content for chat context
 */
export function getUploadContent(sessionId: string, uploadId: string): string | null {
  const sessionDir = join(UPLOADS_DIR, sessionId);

  if (!existsSync(sessionDir)) {
    return null;
  }

  try {
    const files = readdirSync(sessionDir);
    const file = files.find(f => f.startsWith(uploadId));

    if (!file) {
      return null;
    }

    const filePath = join(sessionDir, file);
    const ext = extname(file).toLowerCase();
    const mimeType = EXT_TO_MIME[ext] || "application/octet-stream";

    // For text files, return content directly
    if (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml") {
      return readFileSync(filePath, "utf-8");
    }

    // For images, return a placeholder
    if (mimeType.startsWith("image/")) {
      return `[Image file: ${file}]`;
    }

    // For PDFs, return a placeholder (could be enhanced with PDF parsing)
    if (mimeType === "application/pdf") {
      return `[PDF file: ${file}]`;
    }

    return `[Binary file: ${file}]`;
  } catch (error) {
    logger.error({ error, sessionId, uploadId }, "Failed to read upload content");
    return null;
  }
}
