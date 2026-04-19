import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { logger } from "../../utils/logger.js";

const SAS_VALID_MINUTES = 15;
const SAS_SKEW_MINUTES = 5;

interface ParsedConnection {
  accountName: string;
  accountKey: string;
  endpointSuffix: string;
}

function parseConnectionString(connStr: string): ParsedConnection | null {
  const parts = connStr.split(";").filter(Boolean);
  const map = new Map<string, string>();
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  const accountName = map.get("AccountName");
  const accountKey = map.get("AccountKey");
  const endpointSuffix = map.get("EndpointSuffix") ?? "core.windows.net";
  if (!accountName || !accountKey) return null;
  return { accountName, accountKey, endpointSuffix };
}

export function registerBlobRoutes(server: FastifyInstance): void {
  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER ?? "homer-data";

  if (!connStr) {
    logger.warn("AZURE_STORAGE_CONNECTION_STRING not set — /api/blobs/download disabled");
    return;
  }

  const parsed = parseConnectionString(connStr);
  if (!parsed) {
    logger.warn("AZURE_STORAGE_CONNECTION_STRING could not be parsed — /api/blobs/download disabled");
    return;
  }

  const credential = new StorageSharedKeyCredential(parsed.accountName, parsed.accountKey);
  const blobBaseUrl = `https://${parsed.accountName}.blob.${parsed.endpointSuffix}`;
  const blobServiceClient = new BlobServiceClient(blobBaseUrl, credential);

  // Wildcard for blob names that may contain slashes.
  server.get("/api/blobs/download/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const blobPath = (request.params as { "*": string })["*"];
    if (!blobPath) {
      reply.status(400);
      return { error: "blob path required" };
    }

    try {
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobPath);

      // Verify blob exists before minting a SAS (cheap HEAD).
      const exists = await blobClient.exists();
      if (!exists) {
        reply.status(404);
        return { error: "blob not found" };
      }

      const filename = blobPath.split("/").pop() ?? blobPath;
      const now = Date.now();
      const sasToken = generateBlobSASQueryParameters(
        {
          containerName,
          blobName: blobPath,
          permissions: BlobSASPermissions.parse("r"),
          protocol: SASProtocol.Https,
          startsOn: new Date(now - SAS_SKEW_MINUTES * 60 * 1000),
          expiresOn: new Date(now + SAS_VALID_MINUTES * 60 * 1000),
          contentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
        },
        credential
      ).toString();

      const downloadUrl = `${blobBaseUrl}/${containerName}/${encodeURI(blobPath)}?${sasToken}`;
      return reply.redirect(downloadUrl, 302);
    } catch (err) {
      logger.warn({ err, blobPath }, "Failed to generate blob download redirect");
      reply.status(500);
      return { error: "failed to generate download link" };
    }
  });
}
