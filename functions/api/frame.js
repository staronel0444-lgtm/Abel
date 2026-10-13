// POST /api/frame — scene analysis for the Camera page.
//
// Body:     { image: "<base64 JPEG, no data: prefix>" }
// Response: { crop: {x,y,w,h}, subject, tip, lighting: {level, ev, warmth, note}, model }
//
// Like /api/generate, the server owns the prompt, so this can only analyze a
// camera frame — it is not a general vision proxy. It sits behind the same
// FORGE_PASSWORD gate as the rest of the app.

import { handle, json, readJson, requireString, HttpError } from '../../lib/http.js';
import { analyzeFrame } from '../../lib/frame.js';

// The client sends ~768px frames (~100 KB); this leaves plenty of headroom
// while refusing anything that is clearly not a viewfinder snapshot.
const MAX_IMAGE_CHARS = 2_000_000;

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const image = requireString(body, 'image', { max: MAX_IMAGE_CHARS });
  if (!image.startsWith('/9j/') || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    throw new HttpError(400, 'image must be a base64-encoded JPEG');
  }
  return json(await analyzeFrame(env, { image }));
});
