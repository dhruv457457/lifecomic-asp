import path from "node:path";
import { v2 as cloudinary } from "cloudinary";

// Durable object storage for generated comics. The Cloudinary SDK auto-configures from the
// CLOUDINARY_URL env var (cloudinary://<key>:<secret>@<cloud>), so we never read the secret here.
// When it's unset we return null and the server falls back to serving files from local disk — fine
// for local dev, but on Railway (ephemeral FS) set CLOUDINARY_URL so paid comics survive redeploys.

export function storageEnabled() {
  return Boolean(process.env.CLOUDINARY_URL);
}

function baseId(p) {
  return path.basename(p, path.extname(p));
}

/** Uploads one file and returns its CDN URL. Images go as `image`; pdf/json/txt as `raw`. */
async function uploadOne(filePath, folder, { raw = false, publicId } = {}) {
  const res = await cloudinary.uploader.upload(filePath, {
    folder,
    resource_type: raw ? "raw" : "image",
    public_id: publicId ?? baseId(filePath),
    overwrite: true,
    use_filename: true,
    unique_filename: false,
  });
  return res.secure_url;
}

/**
 * Uploads a comic's deliverables to Cloudinary and returns the same URL shape as the local
 * `fileUrls()` (pdf, pages[], storyboard, imagePrompts, socialCaption). Returns null when storage is
 * disabled so the caller can fall back to local URLs. `files` are the local paths from createComic.
 */
export async function uploadComic(id, files) {
  if (!storageEnabled()) return null;
  const folder = `lifecomic/${id}`;

  const pages = [];
  for (const p of files.pages || []) {
    pages.push(await uploadOne(p, `${folder}/pages`));
  }

  const out = { pages };
  if (files.pdf) out.pdf = await uploadOne(files.pdf, folder, { raw: true, publicId: "comic" });
  if (files.storyboard) out.storyboard = await uploadOne(files.storyboard, folder, { raw: true, publicId: "storyboard" });
  if (files.imagePrompts) out.imagePrompts = await uploadOne(files.imagePrompts, folder, { raw: true, publicId: "image_prompts" });
  if (files.socialCaption) out.socialCaption = await uploadOne(files.socialCaption, folder, { raw: true, publicId: "social_caption" });
  return out;
}
