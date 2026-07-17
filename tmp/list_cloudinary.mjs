import { v2 as cloudinary } from "cloudinary";
// cloudinary auto-configures from CLOUDINARY_URL env var

let all = [];
let next = undefined;
do {
  const res = await cloudinary.api.resources({
    type: "upload",
    prefix: "lifecomic/",
    max_results: 500,
    next_cursor: next,
    resource_type: "image",
  });
  all = all.concat(res.resources);
  next = res.next_cursor;
} while (next);

// Also raw (pdfs/json/txt) so we can see storyboard.json timestamps too, but images alone suffice for a timeline.
all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

for (const r of all) {
  console.log(r.created_at, "|", r.public_id, "|", r.bytes, "bytes");
}
console.log("TOTAL:", all.length);
