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
 * Every file is independent, so all uploads run concurrently (a single page comic serialized 5 round
 * trips before; a book could serialize 8) — this cuts real seconds off the paid-route response time.
 */
export async function uploadComic(id, files) {
  if (!storageEnabled()) return null;
  const folder = `lifecomic/${id}`;

  const [pages, pdf, storyboard, imagePrompts, socialCaption] = await Promise.all([
    Promise.all((files.pages || []).map((p) => uploadOne(p, `${folder}/pages`))),
    files.pdf ? uploadOne(files.pdf, folder, { raw: true, publicId: "comic" }) : null,
    files.storyboard ? uploadOne(files.storyboard, folder, { raw: true, publicId: "storyboard" }) : null,
    files.imagePrompts ? uploadOne(files.imagePrompts, folder, { raw: true, publicId: "image_prompts" }) : null,
    files.socialCaption ? uploadOne(files.socialCaption, folder, { raw: true, publicId: "social_caption" }) : null,
  ]);

  const out = { pages };
  if (pdf) out.pdf = pdf;
  if (storyboard) out.storyboard = storyboard;
  if (imagePrompts) out.imagePrompts = imagePrompts;
  if (socialCaption) out.socialCaption = socialCaption;
  return out;
}

/**
 * Uploads a comic's character-reference sheet and returns its durable URL, or null on failure/when
 * storage is disabled. Only called for series-continuity chapters (see lib/series.js) — most one-off
 * comics never need a persistent URL for their reference art, so this stays off the default path.
 */
export async function uploadCharacterReference(id, filePath) {
  if (!storageEnabled()) return null;
  try {
    return await uploadOne(filePath, `lifecomic/${id}/panels`, { publicId: "character_ref" });
  } catch {
    return null;
  }
}
