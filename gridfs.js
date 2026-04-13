const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const fs = require('fs');
const path = require('path');
const os = require('os');

let bucket;

function getBucket() {
  if (!bucket) {
    bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
  }
  return bucket;
}

// Wait for mongoose connection before using GridFS
function ensureConnection() {
  if (mongoose.connection.readyState !== 1) {
    return new Promise((resolve, reject) => {
      mongoose.connection.once('open', resolve);
      mongoose.connection.once('error', reject);
    });
  }
  return Promise.resolve();
}

/**
 * Save a Buffer to GridFS
 * @param {Buffer} buffer - File data
 * @param {string} filename - Unique filename (e.g., "documents-1234567890-file.pdf")
 * @param {Object} metadata - Optional metadata (proposalId, originalName, etc.)
 */
async function saveToGridFS(buffer, filename, metadata = {}) {
  await ensureConnection();
  const b = getBucket();

  return new Promise((resolve, reject) => {
    const uploadStream = b.openUploadStream(filename, { metadata });
    uploadStream.on('finish', () => resolve(uploadStream.id));
    uploadStream.on('error', reject);
    uploadStream.end(buffer);
  });
}

/**
 * Read a file from GridFS into a Buffer
 * @param {string} filename
 * @returns {Promise<Buffer>}
 */
async function readFromGridFS(filename) {
  await ensureConnection();
  const b = getBucket();

  return new Promise((resolve, reject) => {
    const chunks = [];
    const downloadStream = b.openDownloadStreamByName(filename);
    downloadStream.on('data', (chunk) => chunks.push(chunk));
    downloadStream.on('end', () => resolve(Buffer.concat(chunks)));
    downloadStream.on('error', reject);
  });
}

/**
 * Stream a file from GridFS directly to an HTTP response
 * @param {string} filename
 * @param {import('express').Response} res
 */
async function streamFromGridFS(filename, res) {
  await ensureConnection();
  const b = getBucket();

  return new Promise((resolve, reject) => {
    const downloadStream = b.openDownloadStreamByName(filename);
    downloadStream.on('error', reject);
    downloadStream.on('end', resolve);
    downloadStream.pipe(res);
  });
}

/**
 * Delete a file from GridFS by filename
 * @param {string} filename
 */
async function deleteFromGridFS(filename) {
  await ensureConnection();
  const b = getBucket();

  const files = await b.find({ filename }).toArray();
  for (const file of files) {
    await b.delete(file._id);
  }
}

/**
 * Delete all files for a given proposalId
 * @param {string} proposalId
 */
async function deleteAllByProposal(proposalId) {
  await ensureConnection();
  const b = getBucket();

  const files = await b.find({ 'metadata.proposalId': proposalId }).toArray();
  for (const file of files) {
    await b.delete(file._id);
  }
}

/**
 * Check if a file exists in GridFS
 * @param {string} filename
 * @returns {Promise<boolean>}
 */
async function existsInGridFS(filename) {
  await ensureConnection();
  const b = getBucket();

  const files = await b.find({ filename }).limit(1).toArray();
  return files.length > 0;
}

/**
 * Write buffer to a temp file, run callback, then cleanup.
 * Needed for Python scripts (qpdf, compress_pdf, extract_pdf, etc.) that require file paths.
 * @param {Buffer} buffer
 * @param {string} filename - Used for extension detection
 * @param {Function} callback - async (tempFilePath) => result
 * @returns {Promise<*>} - callback result
 */
async function withTempFile(buffer, filename, callback) {
  const ext = path.extname(filename);
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `gridfs_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);

  try {
    fs.writeFileSync(tempPath, buffer);
    const result = await callback(tempPath);
    return result;
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

module.exports = {
  saveToGridFS,
  readFromGridFS,
  streamFromGridFS,
  deleteFromGridFS,
  deleteAllByProposal,
  existsInGridFS,
  withTempFile
};
