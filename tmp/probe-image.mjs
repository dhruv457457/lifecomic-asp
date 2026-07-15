// One real OpenRouter image-generation call to learn the response shape + prove the key works.
import fs from "node:fs";

const key = process.env.OPENROUTER_API_KEY;
const model = process.env.LIFECOMIC_IMAGE_MODEL || "google/gemini-3.1-flash-lite-image";
if (!key) { console.error("no OPENROUTER_API_KEY"); process.exit(1); }

const body = {
  model,
  messages: [
    {
      role: "user",
      content:
        "A single slice-of-life manga comic panel: a tired young builder with messy black hair " +
        "and a hoodie waking up late in a messy room full of sticky notes, warm morning light, " +
        "expressive face. Clean line art, no text, no speech bubbles, no watermark.",
    },
  ],
  modalities: ["image", "text"],
};

const t0 = Date.now();
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://lifecomic.local",
    "X-Title": "LifeComic",
  },
  body: JSON.stringify(body),
});

console.log("HTTP", res.status, "in", Date.now() - t0, "ms");
const json = await res.json();

if (!res.ok) {
  console.log("ERROR body:", JSON.stringify(json).slice(0, 800));
  process.exit(1);
}

const msg = json.choices?.[0]?.message ?? {};
console.log("message keys:", Object.keys(msg));
console.log("usage:", JSON.stringify(json.usage));

const images = msg.images ?? [];
console.log("images count:", images.length);
if (images[0]) {
  console.log("image[0] keys:", Object.keys(images[0]));
  const url = images[0].image_url?.url ?? images[0].url ?? "";
  console.log("url prefix:", String(url).slice(0, 40));
  const m = String(url).match(/^data:(image\/\w+);base64,(.+)$/s);
  if (m) {
    fs.mkdirSync("tmp", { recursive: true });
    fs.writeFileSync("tmp/probe-panel.png", Buffer.from(m[2], "base64"));
    console.log("SAVED tmp/probe-panel.png", (m[2].length * 0.75 / 1024).toFixed(1), "KB");
  }
} else {
  console.log("no images; full message:", JSON.stringify(msg).slice(0, 600));
}
