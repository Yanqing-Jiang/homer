#!/usr/bin/env tsx
/**
 * Test Azure Blob Storage connection
 * Usage: tsx scripts/test-azure-blob.ts
 */

import 'dotenv/config';
import {
  uploadBlobContent,
  downloadBlobContent,
  listBlobs,
  deleteBlob,
  blobExists,
  ensureContainer
} from '../src/integrations/azure-blob.js';

async function testAzureBlobStorage() {
  console.log('🧪 Testing Azure Blob Storage connection...\n');

  const testBlobName = `test-homer-${Date.now()}.txt`;
  const testContent = `Hello from HOMER!\nTimestamp: ${new Date().toISOString()}`;

  try {
    // Test 0: Ensure container exists
    console.log('0️⃣  Ensuring container exists...');
    await ensureContainer();
    console.log('✅ Container ready\n');

    // Test 1: Upload content
    console.log('1️⃣  Testing upload...');
    const uploadResult = await uploadBlobContent(testContent, testBlobName, 'text/plain');
    console.log(`✅ Upload successful: ${uploadResult.blobName}`);
    console.log(`   URL: ${uploadResult.url}\n`);

    // Test 2: Check if blob exists
    console.log('2️⃣  Testing blob exists...');
    const exists = await blobExists(testBlobName);
    console.log(`✅ Blob exists: ${exists}\n`);

    // Test 3: Download content
    console.log('3️⃣  Testing download...');
    const downloadedContent = await downloadBlobContent(testBlobName, true);
    console.log(`✅ Download successful`);
    console.log(`   Content matches: ${downloadedContent === testContent}\n`);

    // Test 4: List blobs
    console.log('4️⃣  Testing list blobs...');
    const blobs = await listBlobs('test-homer-');
    console.log(`✅ Found ${blobs.length} test blob(s)\n`);

    // Test 5: Delete blob
    console.log('5️⃣  Testing delete...');
    await deleteBlob(testBlobName);
    console.log(`✅ Delete successful\n`);

    // Test 6: Verify deletion
    console.log('6️⃣  Verifying deletion...');
    const stillExists = await blobExists(testBlobName);
    console.log(`✅ Blob deleted: ${!stillExists}\n`);

    console.log('🎉 All tests passed! Azure Blob Storage is configured correctly.');
    console.log('\nYou can now use these MCP tools:');
    console.log('  - blob_upload: Upload files to Azure');
    console.log('  - blob_download: Download files from Azure');
    console.log('  - blob_list: List all blobs');
    console.log('  - blob_delete: Delete blobs');
    console.log('  - blob_get_content: Get blob content as text');
    console.log('  - blob_upload_content: Upload text content');

  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error('\nPlease check:');
    console.error('  1. AZURE_STORAGE_CONNECTION_STRING is set correctly in .env');
    console.error('  2. Container "homer-data" exists in your Azure Storage account');
    console.error('  3. You have read/write permissions on the container');
    process.exit(1);
  }
}

testAzureBlobStorage();
