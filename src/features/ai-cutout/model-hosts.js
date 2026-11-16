/**
 * Where AI cutout models may be downloaded from (pure, no DOM)
 * @module features/ai-cutout/model-hosts
 *
 * A model file comes from this site (public/models, the registry's own
 * files) or from another origin: a registry entry with a `url`, or a
 * model the user added by URL. A file from another origin is fetched with
 * CORS, so its host must send Access-Control-Allow-Origin. Measured on
 * 2026-11-16 (see the PR that added custom models):
 *
 * - Hugging Face `…/resolve/<revision>/<path>`: the 302 from huggingface.co
 *   echoes the Origin in Access-Control-Allow-Origin and the CDN it
 *   redirects to (us.aws.cdn.hf.co) sends `*`, so a browser can download it.
 * - GitHub release assets (`github.com/…/releases/download/…`): neither the
 *   302 from github.com nor release-assets.githubusercontent.com sends
 *   Access-Control-Allow-Origin, so a browser cannot.
 *
 * The page's Content-Security-Policy (src/index.html) keeps `connect-src`
 * to this site and MODEL_HOST_SOURCES: frames never leave the device, and
 * the page cannot talk to any other host. A URL on another host is refused
 * here with a clear reason before anything is fetched (the same rule in
 * the worker, whose own policy would not stop it). A model on any other
 * host can still be added as a local file.
 */

/**
 * Hosts a model can be downloaded from, besides this site: a host and its
 * subdomains (huggingface.co redirects downloads to *.hf.co).
 */
export const MODEL_HOSTS = Object.freeze(['huggingface.co', 'hf.co']);

/**
 * The CSP `connect-src` sources MODEL_HOSTS amount to (a unit test keeps
 * src/index.html in step)
 */
export const MODEL_HOST_SOURCES = Object.freeze(
  MODEL_HOSTS.flatMap((host) => [`https://${host}`, `https://*.${host}`]),
);

/** Human-readable list of the allowed hosts (UI copy) */
export const MODEL_HOSTS_LABEL = 'Hugging Face';

/**
 * Whether a host name is one of MODEL_HOSTS or a subdomain of one
 * @param {string} hostname
 * @returns {boolean}
 */
export function isModelHost(hostname) {
  const host = hostname.toLowerCase();
  return MODEL_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * @typedef {{ ok: true, url: string } | { ok: false, reason: string }} ModelUrlCheck
 */

/**
 * Whether a model may be downloaded from `input`, and the URL to fetch:
 * this site's own files, or an https URL on MODEL_HOSTS. A Hugging Face
 * page URL (`/blob/`) becomes its download URL (`/resolve/`).
 * @param {string} input - Absolute, or relative to `baseHref`
 * @param {string} baseHref - The page (or worker) location
 * @returns {ModelUrlCheck}
 */
export function checkModelUrl(input, baseHref) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, reason: 'Enter the URL of an .onnx file.' };
  /** @type {URL} */
  let url;
  try {
    url = new URL(text, baseHref);
  } catch {
    return { ok: false, reason: 'This is not a valid URL.' };
  }
  const base = new URL(baseHref);
  if (url.origin === base.origin) return { ok: true, url: url.href };
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Only https URLs can be downloaded.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with a user name or password are not supported.' };
  }
  if (!isModelHost(url.hostname)) {
    return {
      ok: false,
      reason: `Models can be downloaded from ${MODEL_HOSTS_LABEL} only (this page talks to no other site). Download the file and add it from your computer instead.`,
    };
  }
  if (url.hostname === 'huggingface.co' || url.hostname === 'hf.co') {
    // https://huggingface.co/<owner>/<repo>/blob/<revision>/<path> is the
    // file's page; /resolve/ is the file itself
    const parts = url.pathname.split('/');
    const blob = parts.indexOf('blob');
    if (blob >= 3) {
      parts[blob] = 'resolve';
      url.pathname = parts.join('/');
    }
  }
  return { ok: true, url: url.href };
}

/**
 * The file name at the end of a URL ("model_fp16.onnx"), or '' when none
 * @param {string} href
 * @returns {string}
 */
export function urlFileName(href) {
  try {
    const path = new URL(href).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
  } catch {
    return '';
  }
}
