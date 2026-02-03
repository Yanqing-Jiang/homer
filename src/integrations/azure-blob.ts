import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

/**
 * Azure Blob Storage Service
 * Provides upload, download, list, and delete operations for blob storage
 */

let containerClient: ContainerClient | null = null;

/**
 * Initialize Azure Blob Storage client
 */
export function initializeBlobClient(): ContainerClient {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_STORAGE_CONTAINER || 'homer-data';

  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING not set in environment');
  }

  if (!containerClient) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    containerClient = blobServiceClient.getContainerClient(containerName);
    logger.info({ containerName }, 'Azure Blob Storage client initialized');
  }

  return containerClient;
}

/**
 * Create container if it doesn't exist
 */
export async function ensureContainer(): Promise<void> {
  try {
    const client = initializeBlobClient();
    const exists = await client.exists();

    if (!exists) {
      logger.info('Creating container...');
      await client.create();
      logger.info('Container created successfully');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to ensure container exists');
    throw error;
  }
}

/**
 * Upload a file to Azure Blob Storage
 */
export async function uploadBlob(
  localFilePath: string,
  blobName?: string
): Promise<{ url: string; blobName: string }> {
  try {
    const client = initializeBlobClient();

    // Use provided blob name or derive from file path
    const finalBlobName = blobName || path.basename(localFilePath);

    // Expand tilde in path
    const expandedPath = localFilePath.replace(/^~/, process.env.HOME || '');

    if (!fs.existsSync(expandedPath)) {
      throw new Error(`File not found: ${expandedPath}`);
    }

    const blockBlobClient = client.getBlockBlobClient(finalBlobName);

    // Detect content type from file extension
    const contentType = getContentType(expandedPath);

    logger.info({ localFilePath: expandedPath, blobName: finalBlobName }, 'Uploading file to blob storage');

    await blockBlobClient.uploadFile(expandedPath, {
      blobHTTPHeaders: { blobContentType: contentType }
    });

    logger.info({ blobName: finalBlobName }, 'File uploaded successfully');

    return {
      url: blockBlobClient.url,
      blobName: finalBlobName
    };
  } catch (error) {
    logger.error({ error, localFilePath }, 'Failed to upload blob');
    throw error;
  }
}

/**
 * Upload text/buffer content to Azure Blob Storage
 */
export async function uploadBlobContent(
  content: string | Buffer,
  blobName: string,
  contentType?: string
): Promise<{ url: string; blobName: string }> {
  try {
    const client = initializeBlobClient();
    const blockBlobClient = client.getBlockBlobClient(blobName);

    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const finalContentType = contentType || 'application/octet-stream';

    logger.info({ blobName, size: buffer.length }, 'Uploading content to blob storage');

    await blockBlobClient.upload(buffer, buffer.length, {
      blobHTTPHeaders: { blobContentType: finalContentType }
    });

    logger.info({ blobName }, 'Content uploaded successfully');

    return {
      url: blockBlobClient.url,
      blobName
    };
  } catch (error) {
    logger.error({ error, blobName }, 'Failed to upload blob content');
    throw error;
  }
}

/**
 * Download a blob to local file system
 */
export async function downloadBlob(
  blobName: string,
  localFilePath: string
): Promise<string> {
  try {
    const client = initializeBlobClient();
    const blockBlobClient = client.getBlockBlobClient(blobName);

    // Expand tilde in path
    const expandedPath = localFilePath.replace(/^~/, process.env.HOME || '');

    // Ensure directory exists
    const dir = path.dirname(expandedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    logger.info({ blobName, localFilePath: expandedPath }, 'Downloading blob');

    await blockBlobClient.downloadToFile(expandedPath);

    logger.info({ blobName, localFilePath: expandedPath }, 'Blob downloaded successfully');

    return expandedPath;
  } catch (error) {
    logger.error({ error, blobName, localFilePath }, 'Failed to download blob');
    throw error;
  }
}

/**
 * Download blob content as string or buffer
 */
export async function downloadBlobContent(
  blobName: string,
  asText: boolean = true
): Promise<string | Buffer> {
  try {
    const client = initializeBlobClient();
    const blockBlobClient = client.getBlockBlobClient(blobName);

    logger.info({ blobName }, 'Downloading blob content');

    const downloadResponse = await blockBlobClient.download();

    if (!downloadResponse.readableStreamBody) {
      throw new Error('No readable stream in download response');
    }

    const chunks: Buffer[] = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const buffer = Buffer.concat(chunks);
    logger.info({ blobName, size: buffer.length }, 'Blob content downloaded');

    return asText ? buffer.toString('utf-8') : buffer;
  } catch (error) {
    logger.error({ error, blobName }, 'Failed to download blob content');
    throw error;
  }
}

/**
 * List blobs in the container
 */
export async function listBlobs(prefix?: string): Promise<Array<{
  name: string;
  size: number;
  lastModified: Date;
  contentType?: string;
}>> {
  try {
    const client = initializeBlobClient();

    logger.info({ prefix }, 'Listing blobs');

    const blobs: Array<{
      name: string;
      size: number;
      lastModified: Date;
      contentType?: string;
    }> = [];

    const options = prefix ? { prefix } : {};

    for await (const blob of client.listBlobsFlat(options)) {
      blobs.push({
        name: blob.name,
        size: blob.properties.contentLength || 0,
        lastModified: blob.properties.lastModified || new Date(),
        contentType: blob.properties.contentType
      });
    }

    logger.info({ count: blobs.length, prefix }, 'Blobs listed');

    return blobs;
  } catch (error) {
    logger.error({ error, prefix }, 'Failed to list blobs');
    throw error;
  }
}

/**
 * Delete a blob
 */
export async function deleteBlob(blobName: string): Promise<void> {
  try {
    const client = initializeBlobClient();
    const blockBlobClient = client.getBlockBlobClient(blobName);

    logger.info({ blobName }, 'Deleting blob');

    await blockBlobClient.delete();

    logger.info({ blobName }, 'Blob deleted successfully');
  } catch (error) {
    logger.error({ error, blobName }, 'Failed to delete blob');
    throw error;
  }
}

/**
 * Check if a blob exists
 */
export async function blobExists(blobName: string): Promise<boolean> {
  try {
    const client = initializeBlobClient();
    const blockBlobClient = client.getBlockBlobClient(blobName);

    return await blockBlobClient.exists();
  } catch (error) {
    logger.error({ error, blobName }, 'Failed to check blob existence');
    return false;
  }
}

/**
 * Get blob metadata and properties
 */
export async function getBlobProperties(blobName: string): Promise<{
  size: number;
  lastModified: Date;
  contentType?: string;
  metadata?: Record<string, string>;
}> {
  try {
    const client = initializeBlobClient();
    const blockBlobClient = client.getBlockBlobClient(blobName);

    const properties = await blockBlobClient.getProperties();

    return {
      size: properties.contentLength || 0,
      lastModified: properties.lastModified || new Date(),
      contentType: properties.contentType,
      metadata: properties.metadata
    };
  } catch (error) {
    logger.error({ error, blobName }, 'Failed to get blob properties');
    throw error;
  }
}

/**
 * Helper: Detect content type from file extension
 */
function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.xml': 'application/xml',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.db': 'application/x-sqlite3'
  };

  return contentTypes[ext] || 'application/octet-stream';
}
