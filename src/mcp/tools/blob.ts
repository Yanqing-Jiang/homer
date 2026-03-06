/**
 * Azure Blob Storage tools: blob_upload, blob_upload_content, blob_download, blob_get_content, blob_list, blob_delete, blob_exists, blob_properties
 */

import type { ToolResult, ToolDeps, ToolDefinition } from "./types.js";

export const definitions: ToolDefinition[] = [
  {
    name: "blob_upload",
    description: "Upload a file to Azure Blob Storage.",
    inputSchema: {
      type: "object",
      properties: {
        localFilePath: { type: "string", description: "Path to the local file to upload (supports ~ for home directory)" },
        blobName: { type: "string", description: "Name for the blob (optional, defaults to filename)" },
      },
      required: ["localFilePath"],
    },
  },
  {
    name: "blob_upload_content",
    description: "Upload text or buffer content to Azure Blob Storage.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to upload (text)" },
        blobName: { type: "string", description: "Name for the blob" },
        contentType: { type: "string", description: "Content type (default: application/octet-stream)" },
      },
      required: ["content", "blobName"],
    },
  },
  {
    name: "blob_download",
    description: "Download a blob from Azure Blob Storage to local file system.",
    inputSchema: {
      type: "object",
      properties: {
        blobName: { type: "string", description: "Name of the blob to download" },
        localFilePath: { type: "string", description: "Local path to save the file (supports ~ for home directory)" },
      },
      required: ["blobName", "localFilePath"],
    },
  },
  {
    name: "blob_get_content",
    description: "Download blob content as text.",
    inputSchema: {
      type: "object",
      properties: {
        blobName: { type: "string", description: "Name of the blob to download" },
      },
      required: ["blobName"],
    },
  },
  {
    name: "blob_list",
    description: "List blobs in the Azure storage container.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Optional prefix to filter blobs (e.g., 'backups/')" },
      },
    },
  },
  {
    name: "blob_delete",
    description: "Delete a blob from Azure Blob Storage. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        blobName: { type: "string", description: "Name of the blob to delete" },
        confirm: { type: "boolean", description: "Must be true to confirm deletion" },
      },
      required: ["blobName", "confirm"],
    },
  },
  {
    name: "blob_exists",
    description: "Check if a blob exists in Azure Blob Storage.",
    inputSchema: {
      type: "object",
      properties: {
        blobName: { type: "string", description: "Name of the blob to check" },
      },
      required: ["blobName"],
    },
  },
  {
    name: "blob_properties",
    description: "Get blob metadata and properties.",
    inputSchema: {
      type: "object",
      properties: {
        blobName: { type: "string", description: "Name of the blob" },
      },
      required: ["blobName"],
    },
  },
];

export async function handle(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult | null> {
  switch (name) {
    case "blob_upload": {
      const { localFilePath, blobName } = args as { localFilePath: string; blobName?: string };
      try {
        const blob = await deps.getAzureBlob();
        const result = await blob.uploadBlob(localFilePath, blobName);
        return { content: [{ type: "text", text: `Uploaded to blob storage: ${result.blobName}\nURL: ${result.url}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to upload: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "blob_upload_content": {
      const { content, blobName, contentType } = args as { content: string; blobName: string; contentType?: string };
      try {
        const blob = await deps.getAzureBlob();
        const result = await blob.uploadBlobContent(content, blobName, contentType);
        return { content: [{ type: "text", text: `Uploaded content to blob storage: ${result.blobName}\nURL: ${result.url}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to upload content: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "blob_download": {
      const { blobName, localFilePath } = args as { blobName: string; localFilePath: string };
      try {
        const blob = await deps.getAzureBlob();
        const path = await blob.downloadBlob(blobName, localFilePath);
        return { content: [{ type: "text", text: `Downloaded blob to: ${path}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to download: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "blob_get_content": {
      const { blobName } = args as { blobName: string };
      try {
        const blob = await deps.getAzureBlob();
        const content = await blob.downloadBlobContent(blobName, true);
        return { content: [{ type: "text", text: String(content) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to get content: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "blob_list": {
      const { prefix } = args as { prefix?: string };
      try {
        const blob = await deps.getAzureBlob();
        const blobs = await blob.listBlobs(prefix);
        return { content: [{ type: "text", text: JSON.stringify(blobs, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to list blobs: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "blob_delete": {
      const { blobName, confirm } = args as { blobName: string; confirm: boolean };
      if (!confirm) return { content: [{ type: "text", text: "Deletion not confirmed. Set confirm=true to proceed." }], isError: true };
      try {
        const blob = await deps.getAzureBlob();
        await blob.deleteBlob(blobName);
        return { content: [{ type: "text", text: `Deleted blob: ${blobName}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to delete: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "blob_exists": {
      const { blobName } = args as { blobName: string };
      try {
        const blob = await deps.getAzureBlob();
        const exists = await blob.blobExists(blobName);
        return { content: [{ type: "text", text: exists ? `Blob exists: ${blobName}` : `Blob does not exist: ${blobName}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to check existence: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "blob_properties": {
      const { blobName } = args as { blobName: string };
      try {
        const blob = await deps.getAzureBlob();
        const props = await blob.getBlobProperties(blobName);
        return { content: [{ type: "text", text: JSON.stringify(props, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to get properties: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    default:
      return null;
  }
}
