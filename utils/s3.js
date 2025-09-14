// lib/s3.js
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT, // necesario en MinIO/compatibles
  maxAttempts: 3,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET;

async function uploadPdfStream(key, bodyStream, opts = {}) {
  const { cacheSeconds = 3600, inlineName = key } = opts;

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: bodyStream,
      ContentType: 'application/pdf',
      ContentDisposition: `inline; filename="${inlineName}"`,
      CacheControl: `public, max-age=${cacheSeconds}`,
    },
  });

  await upload.done();

  // Si más adelante expones un CDN/bucket público, puedes devolver su URL aquí.
  // Por ahora: URL firmada que caduca (segura).
  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: `inline; filename="${inlineName}"`,
    ResponseContentType: 'application/pdf',
  });
  return await getSignedUrl(s3, cmd, { expiresIn: 3600 }); // 1h
}

module.exports = { uploadPdfStream };
