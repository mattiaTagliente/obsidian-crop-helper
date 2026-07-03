import { App, normalizePath } from 'obsidian';
import { renderPdfPage } from './pdf-render';

// ── Types ──────────────────────────────────────────────────────────────

export interface MirrorSource {
  name: string;
  dir: string;  // vault-relative
  cascadeReport: CascadeReport | null;
}

export interface CascadeReport {
  pdf: string;
  dpi: number;
  total_pdf_pages: number;
  pages: Record<string, CascadePageData>;
}

export interface CascadePageData {
  pdf_index: number;
  P1: Array<{ file: string; bbox: number[] }>;
  P2_auto: Array<{ rect: number[]; file: string }>;
  grid: { render_file: string; grid_file: string | null; w: number; h: number };
  manual_crop?: { x: number; y: number; width: number; height: number; timestamp: string };
}

export type MatchMethod =
  | 'sha256'
  | 'dhash'
  | 'render_full'
  | 'render_subregion'
  | 'name_page'
  | 'dims'
  | 'manual'
  | 'sidecar'
  | 'self_source'
  | 'ncc';

// Self-source filename patterns. Files matching any of these are produced by
// Elena directly (paste, screenshot, phone photo) and are not crops of any
// mirror image — fuzzy matchers must not be invoked on them.
const SELF_SOURCE_PATTERNS: RegExp[] = [
  /^Pasted image \d{14}\.(png|jpe?g)$/i,         // Obsidian clipboard paste
  /^Screenshot \d{4}-\d{2}-\d{2} \d{6}\.(png|jpe?g)$/i, // Win/macOS screenshots
  /^\d{18,}\.(jpg|jpeg|png)$/i,                   // Telegram-style numeric stem
];
function isSelfSource(name: string): boolean {
  return SELF_SOURCE_PATTERNS.some(re => re.test(name));
}

// Mirror sub-images live under <mirrorDir>/images/<file>; full-page renders
// (matchMethod='ncc' against p<N>_render.png) sit at <mirrorDir>/<file>.
// Both filename forms feed the same resolver pipeline.
function mirrorFileSubPath(mirrorFile: string): string {
  return /_render\.(png|jpe?g)$/i.test(mirrorFile) ? mirrorFile : `images/${mirrorFile}`;
}

// Full-page renders are the source-of-truth canvas for re-cropping.
// Saving a crop back into them destroys the ability to re-crop a different
// region later. writeBackToMirror MUST be false for these regardless of
// match method, sidecar contents, or legacy index entries.
function isPageRenderFile(mirrorFile: string): boolean {
  return /^p\d+_render\.(png|jpe?g)$/i.test(mirrorFile);
}

// Confidence floor below which a fuzzy match (dhash/dims) without sidecar
// backing is treated as spurious — fall back to self-source instead.
const FUZZY_CONFIDENCE_FLOOR = 0.95;

// ── Provenance sidecar ─────────────────────────────────────────────────
//
// `<coursePath>/asset/.provenance.json` is the authoritative map asset →
// (mirror, mirrorFile, page, bbox). Written by:
//   - lecture-images skill when inserting an image into a lecture (source: 'lecture-images')
//   - the user via "Wrong match?" picker (source: 'manual')
//   - CropModal after a successful save (source: 'save')
//   - automatic bootstrap from sha256 entries of the legacy index (source: 'bootstrap')
// Read as Tier 0 in resolveFromAsset, before any heuristic.

export interface ProvenanceEntry {
  mirror: string;
  mirrorFile: string;
  page: number;
  bbox?: { x: number; y: number; width: number; height: number };
  writeBackToMirror?: boolean;
  source: 'lecture-images' | 'lecture-images-batch' | 'manual' | 'save' | 'bootstrap';
  /** True when the asset is a whole-page render (mapping=render_fallback)
   *  awaiting manual recrop. lecture-images sets this on insertion;
   *  CropModal clears it (sets false) on save. UI decorations consume it
   *  to highlight pending crops in the editor. */
  pending_crop?: boolean;
  ts?: string;
}

export interface ProvenanceData {
  version: 1;
  entries: Record<string, ProvenanceEntry>;
}

export interface CropIndexData {
  version: 7;
  signature: string;
  entries: Record<string, CropIndexEntry>;
  unmatched: string[];
}

export interface CropIndexEntry {
  mirror: string;
  mirrorFile: string;
  page: number;
  matchMethod: MatchMethod;
  confidence: number; // 0-1, 1 = exact match
  /** Render-pixel bbox on the mirror's page render, when known (T3 subregion). */
  bbox?: { x: number; y: number; width: number; height: number };
  /** True iff the asset IS the mirror raw file (safe to overwrite on save). */
  writeBackToMirror?: boolean;
}

export interface ResolvedImage {
  coursePath: string;
  mirrorSource: MirrorSource;
  mirrorImageFile: string;
  mirrorImagePath: string;
  page: number;
  renderPath: string | null;
  assetPath: string | null;
  matchMethod: MatchMethod;
  confidence: number;
  bbox?: { x: number; y: number; width: number; height: number };
  /** True iff saving the crop should overwrite the mirror raw image. */
  writeBackToMirror: boolean;
}

export interface MirrorImage {
  file: string;
  path: string;
  page: number;
  hasCorrectedCrop: boolean;
}

// ── SHA-256 helper ─────────────────────────────────────────────────────

async function sha256(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function shortHash(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h))
    .slice(0, 10)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Perceptual hash (dHash) ────────────────────────────────────────────

/** Compute a 64-bit difference hash from an image buffer.
 *  Resize to 9x8, compare horizontal neighbors → 64 bits → 16 hex chars. */
function dhashFromImage(img: HTMLImageElement, size = 8): string {
  const canvas = document.createElement('canvas');
  canvas.width = size + 1;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return dhashFromRGBA(data, size);
}

/** Compute dHash from raw RGBA data of a (size+1) × size canvas. */
function dhashFromRGBA(data: Uint8ClampedArray, size = 8): string {
  let bits = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const li = (y * (size + 1) + x) * 4;
      const ri = (y * (size + 1) + (x + 1)) * 4;
      const lumL = data[li] * 0.299 + data[li + 1] * 0.587 + data[li + 2] * 0.114;
      const lumR = data[ri] * 0.299 + data[ri + 1] * 0.587 + data[ri + 2] * 0.114;
      bits += lumL > lumR ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function hammingDistance(a: string, b: string): number {
  let dist = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += ((xor >> 3) & 1) + ((xor >> 2) & 1) + ((xor >> 1) & 1) + (xor & 1);
  }
  return dist;
}

/** Count set bits in a 16-hex-char (64-bit) dHash. */
function dhashOnes(hex: string): number {
  let ones = 0;
  for (let i = 0; i < hex.length; i++) {
    const n = parseInt(hex[i], 16);
    ones += ((n >> 3) & 1) + ((n >> 2) & 1) + ((n >> 1) & 1) + (n & 1);
  }
  return ones;
}

/** A dHash is degenerate when the image is near-uniform (few luminance
 *  transitions): almost all bits 0 (e.g. an all-black slide → 0 ones) or
 *  almost all 1. Such hashes carry no discriminative signal and act as
 *  attractors that pull unrelated low-detail assets within the fuzzy hamming
 *  threshold (root cause of the DDES-formula ↔ black-Fortran-slide mismatch).
 *  Real content dHashes sit in the ~16–48 band. Fuzzy tiers skip these; true
 *  byte-identical duplicates are still caught upstream by the sha256 tier. */
function isDegenerateDhash(hex: string): boolean {
  const ones = dhashOnes(hex);
  return ones < 8 || ones > 56;
}

/** Load an image from ArrayBuffer, return HTMLImageElement */
function loadImage(buffer: ArrayBuffer, mime = 'image/png'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

function getImageDimensions(img: HTMLImageElement): { w: number; h: number } {
  return { w: img.naturalWidth, h: img.naturalHeight };
}

/** Run an async op over `items` with bounded concurrency. Preserves input order. */
async function runBatched<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Compute shortcode strings for a mirror name, e.g. "propulsione_avanzata_appunti"
 *  → ["pravap", "proavaapp", "propavanappu", "propuavanzappun"].
 *  Used for filename-abbreviation disambiguation (e.g. asset "propav" matches
 *  "propulsione_avanzata_*" because "propav" is a prefix of "propavanappu"). */
function mirrorShortCodes(mirror: string): string[] {
  const parts = mirror.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const codes: string[] = [];
  for (const len of [2, 3, 4, 5]) {
    codes.push(parts.map(p => p.slice(0, len)).join(''));
  }
  return codes;
}

// ── Manifest parser ────────────────────────────────────────────────────

function parseImageInventory(text: string): Map<string, number> {
  const map = new Map<string, number>();
  const lines = text.split('\n');
  let currentPage = -1;
  let inFiles = false;

  for (const line of lines) {
    const pageMatch = line.match(/^\s*-\s+page:\s*(\d+)/);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
      inFiles = false;
      continue;
    }

    const inlineMatch = line.match(/^\s*files:\s*\[([^\]]*)\]/);
    if (inlineMatch && currentPage >= 0) {
      const hits = inlineMatch[1].match(/[\w.\-\/]+\.(?:png|jpg|jpeg)/gi);
      if (hits) {
        for (const f of hits) map.set(f.split('/').pop()!, currentPage);
      }
      inFiles = false;
      continue;
    }

    if (/^\s*files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }

    if (inFiles && currentPage >= 0) {
      const itemMatch = line.match(/^\s*-\s+(.+\.(?:png|jpg|jpeg))/i);
      if (itemMatch) {
        const fn = itemMatch[1].trim().replace(/^['"]|['"]$/g, '').split('/').pop()!;
        map.set(fn, currentPage);
      } else if (!/^\s*$/.test(line) && !/^\s+-/.test(line)) {
        inFiles = false;
      }
    }
  }
  return map;
}

// ── Internal types for indexing ────────────────────────────────────────

interface MirrorEntry {
  mirror: string;
  file: string;
  page: number;
  hasGrid: boolean;
  sha: string;
  dhash: string;
  w: number;
  h: number;
}

interface RenderDesc {
  mirror: string;
  page: number;
  path: string;
  img: HTMLImageElement;
  dhash: string;
  w: number;
  h: number;
}

// ── Resolver ───────────────────────────────────────────────────────────

export class SourceResolver {
  constructor(private app: App) {}

  // In-memory cache: skip on-disk signature recompute (6s on OneDrive) on
  // subsequent right-clicks within TTL. Explicit "Rebuild crop index" or
  // resolveFromAsset miss-with-allowRebuild still force a fresh build.
  private indexMemCache: Map<string, { data: CropIndexData; expiresAt: number }> = new Map();
  private static readonly INDEX_MEM_TTL_MS = 5 * 60 * 1000;

  /** Find course root (has materiale/.content_mirror/) */
  async detectCoursePath(filePath: string): Promise<string | null> {
    const parts = filePath.replace(/\\/g, '/').split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const candidate = parts.slice(0, i + 1).join('/');
      const mirrorPath = normalizePath(`${candidate}/materiale/.content_mirror`);
      if (await this.app.vault.adapter.exists(mirrorPath)) {
        return candidate;
      }
    }
    return null;
  }

  /** Resolve a mirror-relative artefact path with auto-fallback for layout drift.
   *  Canonical layout (material-enrich SKILL.md): cascade_report + p<N>_render +
   *  p<N>_grid live at the mirror root; sub-images live under images/. Older
   *  cascade_extract runs sometimes placed root artefacts inside images/ — this
   *  helper tries the canonical location first and the drifted one second,
   *  returning whichever exists. No disk mutations; safe in OneDrive scenarios.
   *  Use the "Normalize mirror layout" command to repair drift on disk. */
  private async resolveMirrorFile(mirrorDir: string, fileName: string): Promise<string | null> {
    if (fileName.includes('/')) {
      const p = normalizePath(`${mirrorDir}/${fileName}`);
      return (await this.app.vault.adapter.exists(p)) ? p : null;
    }
    const isRootArtefact = fileName === '_cascade_report.json'
      || /^p\d+_(render|grid)\.(png|jpe?g)$/i.test(fileName);
    const primary = isRootArtefact ? mirrorDir : `${mirrorDir}/images`;
    const fallback = isRootArtefact ? `${mirrorDir}/images` : mirrorDir;
    const p1 = normalizePath(`${primary}/${fileName}`);
    if (await this.app.vault.adapter.exists(p1)) return p1;
    const p2 = normalizePath(`${fallback}/${fileName}`);
    if (await this.app.vault.adapter.exists(p2)) return p2;
    return null;
  }

  /** List all mirror sources for a course */
  async findMirrors(coursePath: string): Promise<MirrorSource[]> {
    const mirrorRoot = normalizePath(`${coursePath}/materiale/.content_mirror`);
    if (!await this.app.vault.adapter.exists(mirrorRoot)) return [];

    const listing = await this.app.vault.adapter.list(mirrorRoot);
    const sources: MirrorSource[] = [];

    for (const folder of listing.folders) {
      const name = folder.split('/').pop()!;
      let cascadeReport: CascadeReport | null = null;
      const reportPath = await this.resolveMirrorFile(folder, '_cascade_report.json');
      if (reportPath) {
        try {
          cascadeReport = JSON.parse(await this.app.vault.adapter.read(reportPath));
        } catch { /* skip */ }
      }
      sources.push({ name, dir: folder, cascadeReport });
    }
    return sources;
  }

  /** Get all images in a mirror's images/ directory. */
  async getMirrorImages(ms: MirrorSource): Promise<MirrorImage[]> {
    const imagesDir = normalizePath(`${ms.dir}/images`);
    if (!await this.app.vault.adapter.exists(imagesDir)) return [];

    const pageMap = await this.loadManifestPageMap(ms);

    const listing = await this.app.vault.adapter.list(imagesDir);
    const corrected = new Set<number>();
    if (ms.cascadeReport) {
      for (const [k, v] of Object.entries(ms.cascadeReport.pages)) {
        if (v.manual_crop) corrected.add(parseInt(k));
      }
    }

    const images: MirrorImage[] = [];
    for (const fp of listing.files) {
      const file = fp.split('/').pop()!;
      if (!/\.(png|jpg|jpeg)$/i.test(file)) continue;
      if (/_thumb\.(png|jpg|jpeg)$/i.test(file)) continue;

      let page = pageMap.get(file);
      if (page == null) {
        const m = file.match(/^p(\d+)_/);
        if (m) page = parseInt(m[1], 10);
      }
      if (page == null) continue;

      images.push({ file, path: fp, page, hasCorrectedCrop: corrected.has(page) });
    }
    images.sort((a, b) => a.page - b.page || a.file.localeCompare(b.file));
    return images;
  }

  async loadManifestPageMap(ms: MirrorSource): Promise<Map<string, number>> {
    const manifestPath = normalizePath(`${ms.dir}/_manifest.yaml`);
    if (!await this.app.vault.adapter.exists(manifestPath)) return new Map();
    try {
      const content = await this.app.vault.adapter.read(manifestPath);
      return parseImageInventory(content);
    } catch {
      return new Map();
    }
  }

  // ── Signature / staleness ────────────────────────────────────────────

  /** Compute a fingerprint of asset + mirror state. If it changes, the
   *  index is rebuilt. Cheap enough to run every time getOrBuildIndex is called. */
  async computeSignature(coursePath: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    const parts: string[] = [];

    // Asset images: name + size + mtime (stats in parallel)
    const assetDir = normalizePath(`${coursePath}/asset`);
    if (await adapter.exists(assetDir)) {
      const listing = await adapter.list(assetDir);
      const files = listing.files
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        .sort();
      const stats = await runBatched(files, 20, (fp) => adapter.stat(fp));
      for (let i = 0; i < files.length; i++) {
        const fp = files[i]; const s = stats[i];
        parts.push(`A|${fp.split('/').pop()}|${s?.size ?? 0}|${s?.mtime ?? 0}`);
      }
    }

    // Mirror sources: manifest + cascade mtime, image count (mirror loops in parallel)
    const mirrorRoot = normalizePath(`${coursePath}/materiale/.content_mirror`);
    if (await adapter.exists(mirrorRoot)) {
      const listing = await adapter.list(mirrorRoot);
      const folders = listing.folders.sort();
      const mirrorParts = await runBatched(folders, 8, async (folder) => {
        const name = folder.split('/').pop()!;
        const manifestPath = normalizePath(`${folder}/_manifest.yaml`);
        const cascadePath = normalizePath(`${folder}/_cascade_report.json`);
        const [mStat, cStat] = await Promise.all([adapter.stat(manifestPath), adapter.stat(cascadePath)]);
        const local: string[] = [`M|${name}|${mStat?.mtime ?? 0}|${cStat?.mtime ?? 0}`];
        const imagesDir = normalizePath(`${folder}/images`);
        if (await adapter.exists(imagesDir)) {
          const imgList = await adapter.list(imagesDir);
          const n = imgList.files.filter(f => /\.(png|jpg|jpeg)$/i.test(f)).length;
          local.push(`I|${name}|${n}`);
        }
        return local;
      });
      for (const arr of mirrorParts) parts.push(...arr);
    }

    return shortHash(parts.join('\n'));
  }

  // ── Hash index ───────────────────────────────────────────────────────

  async getOrBuildIndex(coursePath: string, forceRebuild = false): Promise<CropIndexData> {
    // Fast path: in-memory cache hit within TTL — skips 6s signature stat sweep.
    if (!forceRebuild) {
      const cached = this.indexMemCache.get(coursePath);
      if (cached && cached.expiresAt > Date.now()) return cached.data;
    } else {
      this.indexMemCache.delete(coursePath);
    }

    const indexPath = normalizePath(`${coursePath}/asset/.crop_index.json`);
    if (!forceRebuild && await this.app.vault.adapter.exists(indexPath)) {
      try {
        const data = JSON.parse(await this.app.vault.adapter.read(indexPath)) as CropIndexData;
        if (data.version === 7) {
          const sig = await this.computeSignature(coursePath);
          if (data.signature === sig) {
            this.indexMemCache.set(coursePath, {
              data, expiresAt: Date.now() + SourceResolver.INDEX_MEM_TTL_MS,
            });
            return data;
          }
          console.log('[crop-helper] Index signature changed, rebuilding');
        }
      } catch { /* rebuild */ }
    }
    const fresh = await this.buildIndex(coursePath);
    this.indexMemCache.set(coursePath, {
      data: fresh, expiresAt: Date.now() + SourceResolver.INDEX_MEM_TTL_MS,
    });
    return fresh;
  }

  /** Drop the in-memory index cache. Called by "Rebuild crop index" command
   *  and after setManualMatch so the next right-click reflects the change. */
  invalidateMemCache(coursePath?: string): void {
    if (coursePath) this.indexMemCache.delete(coursePath);
    else this.indexMemCache.clear();
  }

  async buildIndex(coursePath: string): Promise<CropIndexData> {
    const t0 = performance.now();
    const mirrors = await this.findMirrors(coursePath);
    console.log(`[crop-helper] buildIndex: ${coursePath}, ${mirrors.length} mirrors`);

    // Pre-compute mirror raw image data (T1 sha256, T2 dhash) — parallel batched
    const mirrorEntries: MirrorEntry[] = [];
    const shaMap = new Map<string, MirrorEntry[]>();

    // Flatten: [(ms, imgMeta), ...]
    type FlatImg = { ms: MirrorSource; img: MirrorImage };
    const flatImgs: FlatImg[] = [];
    const mirrorImagesByMirror = await runBatched(mirrors, 8, (ms) => this.getMirrorImages(ms));
    for (let i = 0; i < mirrors.length; i++) {
      for (const img of mirrorImagesByMirror[i]) flatImgs.push({ ms: mirrors[i], img });
    }

    // Parallel decode: readBinary + sha256 + loadImage + dhash. Concurrency 10
    // balances throughput vs memory (each decode holds a full image in RAM).
    const partialEntries = await runBatched(flatImgs, 10, async ({ ms, img }) => {
      try {
        const buf = await this.app.vault.adapter.readBinary(img.path);
        const sha = await sha256(buf);
        const mime = /\.jpe?g$/i.test(img.file) ? 'image/jpeg' : 'image/png';
        const imgEl = await loadImage(buf, mime);
        const dh = dhashFromImage(imgEl);
        const hasGrid = !!ms.cascadeReport?.pages[String(img.page)]?.grid?.render_file;
        return {
          mirror: ms.name, file: img.file, page: img.page, hasGrid,
          sha, dhash: dh, w: imgEl.naturalWidth, h: imgEl.naturalHeight,
        } as MirrorEntry;
      } catch { return null; }
    });
    for (const e of partialEntries) {
      if (!e) continue;
      mirrorEntries.push(e);
      if (!shaMap.has(e.sha)) shaMap.set(e.sha, []);
      shaMap.get(e.sha)!.push(e);
    }
    console.log(`[crop-helper] mirror raw images: ${mirrorEntries.length} (${Math.round(performance.now() - t0)}ms)`);

    // NOTE: render pre-loading removed. Loading 600+ renders at buildIndex time
    // was the main I/O bottleneck (~30-60s on OneDrive). T3-full is skipped.
    // T3-subregion is on-demand via resolveUnmatchedHeavy (loads only the 1-3
    // renders at a hinted page).
    const renders: RenderDesc[] = [];

    // Match assets through tier cascade (FAST TIERS ONLY — no render preload)
    const t2 = performance.now();
    const assetDir = normalizePath(`${coursePath}/asset`);
    const index: CropIndexData = { version: 7, signature: '', entries: {}, unmatched: [] };
    const stats: Record<string, number> = {
      sha256: 0, dhash: 0, render_full: 0, render_subregion: 0,
      name_page: 0, dims: 0, miss: 0,
    };

    if (await this.app.vault.adapter.exists(assetDir)) {
      const listing = await this.app.vault.adapter.list(assetDir);
      const assetFiles = listing.files.filter(fp => /\.(png|jpg|jpeg)$/i.test(fp));

      // Decode + match each asset in parallel (batched).
      const results = await runBatched(assetFiles, 10, async (fp, ai) => {
        if (ai % 40 === 0) console.log(`[crop-helper] matching asset ${ai}/${assetFiles.length}`);
        const file = fp.split('/').pop()!;
        try {
          const buf = await this.app.vault.adapter.readBinary(fp);
          const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png';
          const sha = await sha256(buf);
          const assetImg = await loadImage(buf, mime);
          const assetDhash = dhashFromImage(assetImg);
          const assetDims = getImageDimensions(assetImg);
          const entry = this.matchAssetCascade(
            file, sha, assetDhash, assetDims, mirrorEntries, shaMap,
          );
          return { file, entry };
        } catch {
          return { file, entry: null };
        }
      });

      for (const { file, entry } of results) {
        if (entry) {
          index.entries[file] = entry;
          stats[entry.matchMethod] = (stats[entry.matchMethod] ?? 0) + 1;
        } else {
          index.unmatched.push(file);
          stats.miss++;
        }
      }
    }

    const t3 = performance.now();
    console.log(`[crop-helper] asset matching: ${Math.round(t3 - t2)}ms, stats=${JSON.stringify(stats)}`);
    index.signature = await this.computeSignature(coursePath);
    await this.saveIndex(coursePath, index);
    // Bootstrap sha256 entries into provenance sidecar (idempotent).
    await this.bootstrapProvenanceFromIndex(coursePath, index);
    console.log(`[crop-helper] buildIndex total: ${Math.round(performance.now() - t0)}ms`);
    return index;
  }

  /** On-demand heavy match for a single asset that the regular cascade missed.
   *  Runs the expensive sub-region sweep across ALL renders. */
  async resolveUnmatchedHeavy(
    coursePath: string, assetFileName: string,
  ): Promise<CropIndexEntry | null> {
    const assetPath = normalizePath(`${coursePath}/asset/${assetFileName}`);
    if (!await this.app.vault.adapter.exists(assetPath)) return null;

    const mirrors = await this.findMirrors(coursePath);
    // Rebuild renders cache (lightweight path)
    const renders: RenderDesc[] = [];
    for (const ms of mirrors) {
      const pages = new Set<number>();
      if (ms.cascadeReport) {
        for (const k of Object.keys(ms.cascadeReport.pages)) pages.add(parseInt(k));
      }
      try {
        const listing = await this.app.vault.adapter.list(ms.dir);
        for (const fp of listing.files) {
          const m = fp.split('/').pop()!.match(/^p(\d+)_render\.(?:png|jpg|jpeg)$/i);
          if (m) pages.add(parseInt(m[1]));
        }
      } catch { /* */ }
      for (const page of pages) {
        const rp = await this.resolveRender(ms, page);
        if (!rp) continue;
        try {
          const buf = await this.app.vault.adapter.readBinary(rp);
          const mime = /\.jpe?g$/i.test(rp) ? 'image/jpeg' : 'image/png';
          const img = await loadImage(buf, mime);
          renders.push({ mirror: ms.name, page, path: rp, img,
            dhash: dhashFromImage(img), w: img.naturalWidth, h: img.naturalHeight });
        } catch { /* */ }
      }
    }

    const buf = await this.app.vault.adapter.readBinary(assetPath);
    const mime = /\.jpe?g$/i.test(assetFileName) ? 'image/jpeg' : 'image/png';
    const assetImg = await loadImage(buf, mime);
    const assetDhash = dhashFromImage(assetImg);
    const assetDims = getImageDimensions(assetImg);

    const ts = this.matchSubregion(assetDhash, assetDims, renders);
    if (!ts) return null;
    const mirrorFile = `p${ts.page}_render.png`;
    const entry: CropIndexEntry = {
      mirror: ts.mirror, mirrorFile, page: ts.page,
      matchMethod: 'render_subregion', confidence: ts.confidence,
      bbox: ts.bbox, writeBackToMirror: false,
    };

    // Persist to index
    const index = await this.getOrBuildIndex(coursePath);
    index.entries[assetFileName] = entry;
    index.unmatched = (index.unmatched ?? []).filter(f => f !== assetFileName);
    index.signature = await this.computeSignature(coursePath);
    await this.saveIndex(coursePath, index);
    return entry;
  }

  async saveIndex(coursePath: string, index: CropIndexData): Promise<void> {
    const indexPath = normalizePath(`${coursePath}/asset/.crop_index.json`);
    await this.app.vault.adapter.write(indexPath, JSON.stringify(index, null, 2));
    // Keep mem cache coherent with the just-persisted entries.
    this.indexMemCache.set(coursePath, {
      data: index, expiresAt: Date.now() + SourceResolver.INDEX_MEM_TTL_MS,
    });
  }

  /** Record a user-chosen (mirror, page) mapping for an asset. Used by the
   *  interactive picker when all automatic tiers miss. */
  async setManualMatch(
    coursePath: string,
    assetFileName: string,
    mirror: string,
    page: number,
    mirrorFile?: string,
  ): Promise<void> {
    const index = await this.getOrBuildIndex(coursePath);
    const resolvedMirrorFile = mirrorFile
      ?? this.pickMirrorFileForPageSync(mirror, page, index)
      ?? `p${page}_render.png`;
    index.entries[assetFileName] = {
      mirror, mirrorFile: resolvedMirrorFile, page,
      matchMethod: 'manual', confidence: 1.0, writeBackToMirror: false,
    };
    index.unmatched = (index.unmatched ?? []).filter(f => f !== assetFileName);
    index.signature = await this.computeSignature(coursePath);
    await this.saveIndex(coursePath, index);
    // Promote to provenance sidecar so future right-clicks bypass heuristics.
    await this.saveProvenanceEntry(coursePath, assetFileName, {
      mirror, mirrorFile: resolvedMirrorFile, page,
      writeBackToMirror: false, source: 'manual',
    });
  }

  // ── Tier helpers ─────────────────────────────────────────────────────

  /** T3-full: cheap, O(N) — compare asset dHash to each render's whole-page dHash.
   *  Matches when asset is a full-page screenshot / copy of the render. */
  private matchFullRender(
    assetDhash: string,
    assetDims: { w: number; h: number },
    renders: RenderDesc[],
  ): { mirror: string; page: number; method: 'render_full'; confidence: number } | null {
    if (renders.length === 0) return null;
    const assetAspect = assetDims.w / assetDims.h;
    let best: { r: RenderDesc; dist: number } | null = null;
    for (const r of renders) {
      const renderAspect = r.w / r.h;
      const aRatio = Math.min(assetAspect, renderAspect) / Math.max(assetAspect, renderAspect);
      if (aRatio < 0.85) continue;
      const dist = hammingDistance(assetDhash, r.dhash);
      if (!best || dist < best.dist) best = { r, dist };
    }
    if (best && best.dist <= 8) {
      return {
        mirror: best.r.mirror, page: best.r.page, method: 'render_full',
        confidence: parseFloat((1.0 - best.dist / 64).toFixed(3)),
      };
    }
    return null;
  }

  /** T3-subregion: expensive — slide multi-scale windows across renders.
   *  Only called with a restricted pool (e.g. renders at hinted page), or
   *  on-demand for assets that filename heuristics cannot resolve. */
  private matchSubregion(
    assetDhash: string,
    assetDims: { w: number; h: number },
    renders: RenderDesc[],
    opts: { pageHint?: number | null; mirrorHint?: string | null } = {},
  ): { mirror: string; page: number; method: 'render_subregion'; confidence: number;
       bbox: { x: number; y: number; width: number; height: number } } | null {
    let pool = renders;
    if (opts.pageHint != null) pool = pool.filter(r => r.page === opts.pageHint);
    if (opts.mirrorHint) pool = pool.filter(r => r.mirror === opts.mirrorHint);
    if (pool.length === 0) return null;

    const assetAspect = assetDims.w / assetDims.h;
    const scales = [0.9, 0.7, 0.5, 0.35, 0.22];
    const tmp = document.createElement('canvas');
    tmp.width = 9; tmp.height = 8;
    const tctx = tmp.getContext('2d')!;

    let bestMirror = '';
    let bestPage = 0;
    let bestDist = 65;
    let bestX = 0, bestY = 0, bestW = 0, bestH = 0;

    outer: for (const r of pool) {
      for (const s of scales) {
        const wW = Math.round(s * r.w);
        const wH = Math.round(wW / assetAspect);
        if (wH > r.h || wW < 60 || wH < 60) continue;
        const stepX = Math.max(20, Math.round(wW * 0.25));
        const stepY = Math.max(20, Math.round(wH * 0.25));
        for (let y = 0; y + wH <= r.h; y += stepY) {
          for (let x = 0; x + wW <= r.w; x += stepX) {
            tctx.clearRect(0, 0, 9, 8);
            tctx.drawImage(r.img, x, y, wW, wH, 0, 0, 9, 8);
            const data = tctx.getImageData(0, 0, 9, 8).data;
            const hex = dhashFromRGBA(data, 8);
            const dist = hammingDistance(assetDhash, hex);
            if (dist < bestDist) {
              bestDist = dist;
              bestMirror = r.mirror;
              bestPage = r.page;
              bestX = x; bestY = y; bestW = wW; bestH = wH;
            }
          }
        }
        if (bestDist <= 3) break outer;
      }
    }

    if (bestDist <= 10) {
      return {
        mirror: bestMirror, page: bestPage, method: 'render_subregion',
        confidence: parseFloat((1.0 - bestDist / 64).toFixed(3)),
        bbox: { x: bestX, y: bestY, width: bestW, height: bestH },
      };
    }
    return null;
  }

  /** Run the synchronous tier cascade for a single asset. Returns the index
   *  entry or null if no tier matched. Does no render I/O — render-based
   *  tiers (T3) are handled lazily via resolveUnmatchedHeavy. */
  private matchAssetCascade(
    file: string,
    sha: string,
    assetDhash: string,
    assetDims: { w: number; h: number },
    mirrorEntries: MirrorEntry[],
    shaMap: Map<string, MirrorEntry[]>,
  ): CropIndexEntry | null {
    // T1: SHA-256 exact
    const shaMatches = shaMap.get(sha);
    if (shaMatches && shaMatches.length > 0) {
      const best = shaMatches.find(m => m.hasGrid) ?? shaMatches[0];
      return {
        mirror: best.mirror, mirrorFile: best.file, page: best.page,
        matchMethod: 'sha256', confidence: 1.0, writeBackToMirror: true,
      };
    }

    // T2: dHash on mirror raw images.
    // Threshold ≤5 (was ≤10): dist 6-10 produced false positives where
    // low-entropy mirror images (mostly-blank scans) attracted unrelated assets
    // — e.g. a single mirror page collected 7 unrelated assets at dist 9-10.
    // Aspect-ratio gate (≥0.85) blocks portrait/landscape mismatches.
    // Entropy gate: a near-uniform asset (or mirror candidate) produces a
    // degenerate dHash that matches anything at small hamming distance. Skip
    // fuzzy matching for such hashes — an exact duplicate is still resolved by
    // the sha256 tier above; a non-identical low-entropy asset falls through to
    // name_page/dims or stays unmatched (→ manual picker) rather than binding
    // to a spurious all-black slide.
    const assetAspectT2 = assetDims.w / assetDims.h;
    let bestDhash: MirrorEntry | null = null;
    let bestDist = 6;
    if (!isDegenerateDhash(assetDhash)) {
      for (const me of mirrorEntries) {
        if (isDegenerateDhash(me.dhash)) continue;
        const meAspect = me.w / me.h;
        const aRatio = Math.min(assetAspectT2, meAspect) / Math.max(assetAspectT2, meAspect);
        if (aRatio < 0.85) continue;
        const dist = hammingDistance(assetDhash, me.dhash);
        if (dist < bestDist) { bestDist = dist; bestDhash = me; }
      }
    }
    if (bestDhash && bestDist <= 5) {
      return {
        mirror: bestDhash.mirror, mirrorFile: bestDhash.file, page: bestDhash.page,
        matchMethod: 'dhash', confidence: parseFloat((1.0 - bestDist / 64).toFixed(3)),
        writeBackToMirror: true,
      };
    }

    // T4: name→page heuristic (no renders needed; uses filename shortcodes)
    const np = this.matchByNameAndPage(file, mirrorEntries);
    if (np) {
      return {
        mirror: np.mirror, mirrorFile: np.mirrorFile, page: np.page,
        matchMethod: 'name_page', confidence: np.confidence,
        writeBackToMirror: false,
      };
    }

    // T5: dims + name similarity (weak fallback)
    const assetBase = file.replace(/\.[^.]+$/, '').toLowerCase().replace(/[_\-]/g, ' ');
    let bestDims: MirrorEntry | null = null;
    let bestDimsScore = 0;
    for (const me of mirrorEntries) {
      const wr = Math.min(assetDims.w, me.w) / Math.max(assetDims.w, me.w);
      const hr = Math.min(assetDims.h, me.h) / Math.max(assetDims.h, me.h);
      if (wr < 0.8 || hr < 0.8) continue;
      const mirrorBase = me.file.replace(/\.[^.]+$/, '').replace(/^p\d+_/, '').toLowerCase().replace(/[_\-]/g, ' ');
      const assetWords = assetBase.split(/\s+/).filter(w => w.length >= 3);
      const mirrorWords = new Set(mirrorBase.split(/\s+/).filter(w => w.length >= 3));
      const shared = assetWords.filter(w => mirrorWords.has(w)).length;
      const total = Math.max(assetWords.length, mirrorWords.size, 1);
      const nameScore = shared / total;
      const score = (wr + hr) / 2 * 0.4 + nameScore * 0.6;
      if (score > bestDimsScore && nameScore > 0) { bestDimsScore = score; bestDims = me; }
    }
    if (bestDims && bestDimsScore > 0.3) {
      return {
        mirror: bestDims.mirror, mirrorFile: bestDims.file, page: bestDims.page,
        matchMethod: 'dims', confidence: parseFloat(bestDimsScore.toFixed(3)),
        writeBackToMirror: true,
      };
    }
    return null;
  }

  /** Parse a page hint from an asset filename. */
  private parsePageHint(fileName: string): number | null {
    const m = fileName.toLowerCase().match(/(?:^|[^a-z0-9])p(?:age|ag|g)?[_\-]?(\d{1,4})/i);
    if (!m) return null;
    const page = parseInt(m[1], 10);
    if (page <= 0 || page > 9999) return null;
    return page;
  }

  /** T4: parse p(\d+) from asset filename, disambiguate mirror via shortcodes.
   *  No render I/O. Uses filename abbreviation matching: asset token "propav"
   *  matches mirror "propulsione_avanzata_appunti" because "propav" is a prefix
   *  of its shortcode "propavanappu". */
  private matchByNameAndPage(
    assetFile: string,
    mirrorEntries: MirrorEntry[],
  ): { mirror: string; page: number; mirrorFile: string; confidence: number } | null {
    const nameLower = assetFile.toLowerCase();
    const m = nameLower.match(/(?:^|[^a-z0-9])p(?:age|ag|g)?[_\-]?(\d{1,4})/i);
    if (!m) return null;
    const page = parseInt(m[1], 10);
    if (page <= 0 || page > 9999) return null;

    // NOTE: a "lecture-tag mismatch" filter (asset lez12 vs mirror lez3b) was
    // tried here and is semantically wrong: the "lez{NN}_p{MM}.png" convention
    // means "asset USED in lecture NN that originally appeared on page MM of
    // SOME mirror" — not "mirror is tagged lezNN". An asset of lez12 can
    // legitimately come from a mirror tagged lez3b (or slides, or any other
    // source for that lecture). Heuristics over filenames are intrinsically
    // lossy; the authoritative answer lives in asset/.provenance.json.

    // Group entries by mirror for pages matching
    const byMirror = new Map<string, MirrorEntry[]>();
    for (const e of mirrorEntries) {
      if (e.page !== page) continue;
      if (!byMirror.has(e.mirror)) byMirror.set(e.mirror, []);
      byMirror.get(e.mirror)!.push(e);
    }
    if (byMirror.size === 0) return null;

    const pickFile = (mirror: string): string => {
      const ents = byMirror.get(mirror) ?? [];
      if (ents.length === 0) return `p${page}_render.png`;
      const best = ents.find(e => e.hasGrid) ?? ents[0];
      return best.file;
    };

    if (byMirror.size === 1) {
      const mirror = Array.from(byMirror.keys())[0];
      return { mirror, page, mirrorFile: pickFile(mirror), confidence: 0.7 };
    }

    // Tokens ≥3 chars from asset name, excluding the page number itself
    const pageStr = m[1];
    const tokens = nameLower.split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3 && t !== pageStr && !t.startsWith('p' + pageStr));

    let bestMirror: string | null = null;
    let bestScore = 0;
    for (const mirror of byMirror.keys()) {
      const ml = mirror.toLowerCase();
      const mTokens = ml.split(/[^a-z0-9]+/).filter(t => t.length >= 3);
      const shortCodes = mirrorShortCodes(mirror);
      let score = 0;
      for (const t of tokens) {
        if (ml.includes(t)) score += 3;
        for (const mt of mTokens) {
          if (t === mt) score += 3;
          else if (t.length >= 4 && mt.startsWith(t)) score += 2;
          else if (mt.length >= 4 && t.startsWith(mt)) score += 2;
        }
        // Shortcode abbreviation match (e.g. "propav" ~ "propavanappu")
        for (const code of shortCodes) {
          if (t.length >= 4 && code.startsWith(t)) { score += 2; break; }
        }
      }
      if (score > bestScore) { bestScore = score; bestMirror = mirror; }
    }
    if (bestMirror && bestScore >= 2) {
      return { mirror: bestMirror, page, mirrorFile: pickFile(bestMirror), confidence: 0.55 };
    }

    // Still ambiguous: default to the mirror with most entries at this page
    // (proxy for "the main source"). User can re-pick via "Wrong match?" button.
    let fallbackMirror: string | null = null;
    let maxEntries = 0;
    for (const [mirror, ents] of byMirror.entries()) {
      if (ents.length > maxEntries) { maxEntries = ents.length; fallbackMirror = mirror; }
    }
    if (fallbackMirror) {
      return { mirror: fallbackMirror, page, mirrorFile: pickFile(fallbackMirror), confidence: 0.35 };
    }
    return null;
  }

  private pickMirrorFileForPage(
    mirror: string, page: number, mirrorEntries: MirrorEntry[],
  ): string | null {
    const ents = mirrorEntries.filter(e => e.mirror === mirror && e.page === page);
    if (ents.length === 0) return null;
    const best = ents.find(e => e.hasGrid) ?? ents[0];
    return best.file;
  }

  /** Synchronous variant using an already-built index. Picks any known
   *  asset's mirrorFile at the same (mirror, page) as a reasonable default. */
  private pickMirrorFileForPageSync(
    mirror: string, page: number, index: CropIndexData,
  ): string | null {
    for (const e of Object.values(index.entries)) {
      if (e.mirror === mirror && e.page === page) return e.mirrorFile;
    }
    return null;
  }

  // ── Provenance sidecar ────────────────────────────────────────────────

  private provenancePath(coursePath: string): string {
    return normalizePath(`${coursePath}/asset/.provenance.json`);
  }

  async loadProvenance(coursePath: string): Promise<ProvenanceData> {
    const p = this.provenancePath(coursePath);
    if (!await this.app.vault.adapter.exists(p)) return { version: 1, entries: {} };
    try {
      const d = JSON.parse(await this.app.vault.adapter.read(p));
      if (d?.version === 1 && d.entries) return d as ProvenanceData;
    } catch { /* fall through */ }
    return { version: 1, entries: {} };
  }

  async getProvenanceEntry(coursePath: string, assetFileName: string): Promise<ProvenanceEntry | null> {
    const data = await this.loadProvenance(coursePath);
    return data.entries[assetFileName] ?? null;
  }

  async saveProvenanceEntry(
    coursePath: string, assetFileName: string, entry: ProvenanceEntry,
  ): Promise<void> {
    const data = await this.loadProvenance(coursePath);
    data.entries[assetFileName] = { ...entry, ts: entry.ts ?? new Date().toISOString() };
    await this.app.vault.adapter.write(this.provenancePath(coursePath), JSON.stringify(data, null, 2));
  }

  /** Mirror sha256 entries of the legacy crop index into the provenance sidecar.
   *  Idempotent: never overwrites existing sidecar entries. Run after buildIndex
   *  so that on first contact with a course, the byte-perfect matches become
   *  authoritative provenance and bypass heuristics on subsequent right-clicks. */
  private async bootstrapProvenanceFromIndex(coursePath: string, index: CropIndexData): Promise<void> {
    const data = await this.loadProvenance(coursePath);
    let changed = false;
    for (const [file, e] of Object.entries(index.entries)) {
      if (e.matchMethod !== 'sha256') continue;
      if (data.entries[file]) continue;
      // Page renders stay immutable even when bootstrapped from sha256
      // matches — overwriting them destroys the re-crop canvas.
      const writeBack = isPageRenderFile(e.mirrorFile)
        ? false
        : (e.writeBackToMirror ?? true);
      data.entries[file] = {
        mirror: e.mirror, mirrorFile: e.mirrorFile, page: e.page,
        bbox: e.bbox, writeBackToMirror: writeBack,
        source: 'bootstrap', ts: new Date().toISOString(),
      };
      changed = true;
    }
    if (changed) {
      await this.app.vault.adapter.write(this.provenancePath(coursePath), JSON.stringify(data, null, 2));
    }
  }

  /** Build a ResolvedImage for a self-sourced asset (manual paste / hand-crafted).
   *  The asset itself is the canvas; no mirror back-write, no cascade lookup. */
  private buildSelfSourceResolved(
    coursePath: string, assetFileName: string,
  ): ResolvedImage {
    const assetPath = normalizePath(`${coursePath}/asset/${assetFileName}`);
    const ms: MirrorSource = {
      name: 'self (manual paste)',
      dir: normalizePath(`${coursePath}/asset`),
      cascadeReport: null,
    };
    return {
      coursePath, mirrorSource: ms,
      mirrorImageFile: assetFileName,
      mirrorImagePath: assetPath,
      page: 1,
      renderPath: assetPath,
      assetPath,
      matchMethod: 'self_source', confidence: 1.0,
      writeBackToMirror: false,
    };
  }

  /** Build a ResolvedImage directly from a provenance entry, no heuristics. */
  private async resolveFromProvenance(
    coursePath: string, assetFileName: string, prov: ProvenanceEntry,
  ): Promise<ResolvedImage | null> {
    const mirrorDir = normalizePath(`${coursePath}/materiale/.content_mirror/${prov.mirror}`);
    if (!await this.app.vault.adapter.exists(mirrorDir)) return null;
    let cascadeReport: CascadeReport | null = null;
    const reportPath = await this.resolveMirrorFile(mirrorDir, '_cascade_report.json');
    if (reportPath) {
      try { cascadeReport = JSON.parse(await this.app.vault.adapter.read(reportPath)); } catch { /* */ }
    }
    const ms: MirrorSource = { name: prov.mirror, dir: mirrorDir, cascadeReport };
    const mirrorImagePath = (await this.resolveMirrorFile(mirrorDir, prov.mirrorFile))
      ?? normalizePath(`${mirrorDir}/${mirrorFileSubPath(prov.mirrorFile)}`);
    const renderPath = await this.resolveRender(ms, prov.page);
    // Page renders are immutable canvases for re-crop. Override any legacy
    // sidecar entry that asserted writeBackToMirror=true on a pNNN_render.
    const writeBack = isPageRenderFile(prov.mirrorFile)
      ? false
      : (prov.writeBackToMirror ?? false);
    return {
      coursePath, mirrorSource: ms, mirrorImageFile: prov.mirrorFile,
      mirrorImagePath, page: prov.page, renderPath,
      assetPath: normalizePath(`${coursePath}/asset/${assetFileName}`),
      matchMethod: 'sidecar', confidence: 1.0, bbox: prov.bbox,
      writeBackToMirror: writeBack,
    };
  }

  // ── Right-click resolution ────────────────────────────────────────────

  async resolveFromAsset(
    assetFileName: string,
    noteFilePath: string,
    allowRebuild = true,
  ): Promise<ResolvedImage | null> {
    const coursePath = await this.detectCoursePath(noteFilePath);
    if (!coursePath) return null;

    // Tier 0: provenance sidecar — authoritative, no heuristics.
    const prov = await this.getProvenanceEntry(coursePath, assetFileName);
    if (prov) {
      const resolved = await this.resolveFromProvenance(coursePath, assetFileName, prov);
      if (resolved) return resolved;
      console.warn(`[crop-helper] sidecar entry for ${assetFileName} pointed at missing mirror; falling back to index`);
    }

    // Gate A: known self-source filename patterns (paste / screenshot / phone
    // photo). Bypass the index entirely; otherwise fuzzy matchers will
    // hallucinate a mirror link.
    if (isSelfSource(assetFileName)) {
      return this.buildSelfSourceResolved(coursePath, assetFileName);
    }

    let index = await this.getOrBuildIndex(coursePath);
    let entry = index.entries[assetFileName];

    // Miss: force a rebuild once and retry (covers assets added since
    // the last signature-triggered rebuild).
    if (!entry && allowRebuild) {
      console.log(`[crop-helper] No entry for ${assetFileName}, forcing rebuild`);
      index = await this.buildIndex(coursePath);
      entry = index.entries[assetFileName];
    }
    if (!entry) return null;

    // Gate B: low-confidence fuzzy match without sidecar backing → self-source.
    // sha256 / sidecar / manual / name_page are deterministic; dhash/dims/render_*
    // below the floor are unreliable on hand-crafted pastes and silently mislead.
    const fuzzy = entry.matchMethod === 'dhash'
      || entry.matchMethod === 'dims'
      || entry.matchMethod === 'render_full'
      || entry.matchMethod === 'render_subregion';
    if (fuzzy && (entry.confidence ?? 0) < FUZZY_CONFIDENCE_FLOOR) {
      console.log(`[crop-helper] ${assetFileName}: low-confidence ${entry.matchMethod} ${entry.confidence} — treating as self-source`);
      return this.buildSelfSourceResolved(coursePath, assetFileName);
    }

    const mirrorDir = normalizePath(`${coursePath}/materiale/.content_mirror/${entry.mirror}`);
    let cascadeReport: CascadeReport | null = null;
    const reportPath = await this.resolveMirrorFile(mirrorDir, '_cascade_report.json');
    if (reportPath) {
      try { cascadeReport = JSON.parse(await this.app.vault.adapter.read(reportPath)); } catch { /* */ }
    }

    const ms: MirrorSource = { name: entry.mirror, dir: mirrorDir, cascadeReport };
    const mirrorImagePath = (await this.resolveMirrorFile(mirrorDir, entry.mirrorFile))
      ?? normalizePath(`${mirrorDir}/${mirrorFileSubPath(entry.mirrorFile)}`);
    const renderPath = await this.resolveRender(ms, entry.page);

    // Page renders are immutable canvases for re-crop — never write back
    // regardless of match method or legacy index flags.
    const writeBack = isPageRenderFile(entry.mirrorFile)
      ? false
      : (entry.writeBackToMirror ?? (entry.matchMethod === 'sha256'
          || entry.matchMethod === 'dhash' || entry.matchMethod === 'dims'));
    return {
      coursePath,
      mirrorSource: ms,
      mirrorImageFile: entry.mirrorFile,
      mirrorImagePath,
      page: entry.page,
      renderPath,
      assetPath: normalizePath(`${coursePath}/asset/${assetFileName}`),
      matchMethod: entry.matchMethod ?? 'sha256',
      confidence: entry.confidence ?? 1.0,
      bbox: entry.bbox,
      writeBackToMirror: writeBack,
    };
  }

  // ── Render resolution ─────────────────────────────────────────────────

  async resolveRender(ms: MirrorSource, page: number): Promise<string | null> {
    const dir = ms.dir;
    const report = ms.cascadeReport;

    // 1. CASCADE REPORT (authoritative)
    if (report?.pages[String(page)]?.grid?.render_file) {
      const rf = report.pages[String(page)].grid.render_file;
      const p = await this.resolveMirrorFile(dir, rf);
      if (p) return p;
    }

    // 2. Filename patterns. Sidecar `page` is 1-based — try that first.
    // pdfIndex (0-based) is a legacy fallback for cascade_extract artefacts;
    // never let it shadow a 1-based render with the same numeric stem.
    const pdfIndex = report?.pages[String(page)]?.pdf_index;
    const candidates = [
      String(page),
      String(page).padStart(3, '0'),
      ...(pdfIndex != null ? [String(pdfIndex)] : []),
      ...(pdfIndex != null ? [String(pdfIndex).padStart(3, '0')] : []),
    ];
    for (const pad of candidates) {
      for (const ext of ['png', 'jpg']) {
        const p = await this.resolveMirrorFile(dir, `p${pad}_render.${ext}`);
        if (p) return p;
      }
    }

    // 3. Photo-based source: map page to source photo
    if (report) {
      const sourceRelative = this.absoluteToVaultRelative(report.pdf);
      if (sourceRelative && await this.app.vault.adapter.exists(sourceRelative)) {
        const stat = await this.app.vault.adapter.stat(sourceRelative);
        if (stat?.type === 'folder') {
          const listing = await this.app.vault.adapter.list(sourceRelative);
          const photos = listing.files
            .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
            .sort();
          if (page > 0 && page <= photos.length) {
            return photos[page - 1];
          }
        }
      }
    }

    // 4. PDF source: render with pdf.js and cache
    if (report) {
      const rendered = await this.renderAndCachePdfPage(ms, page);
      if (rendered) return rendered;
    }

    return null;
  }

  private async renderAndCachePdfPage(ms: MirrorSource, page: number): Promise<string | null> {
    const report = ms.cascadeReport;
    if (!report) return null;

    const sourceRelative = this.absoluteToVaultRelative(report.pdf);
    if (!sourceRelative) return null;

    let pdfPath: string | null = null;
    for (const candidate of [sourceRelative, `${sourceRelative}.pdf`]) {
      if (await this.app.vault.adapter.exists(candidate)) {
        const stat = await this.app.vault.adapter.stat(candidate);
        if (stat?.type === 'file') { pdfPath = candidate; break; }
      }
    }
    if (!pdfPath) return null;

    try {
      const pdfData = await this.app.vault.adapter.readBinary(pdfPath);
      const dpi = report.dpi || 200;
      const pngBuffer = await renderPdfPage(pdfData, page, dpi);
      const renderName = `p${page}_render.png`;
      const renderPath = normalizePath(`${ms.dir}/${renderName}`);
      await this.app.vault.adapter.writeBinary(renderPath, pngBuffer);
      return renderPath;
    } catch (e) {
      console.error(`[crop-helper] PDF render failed for page ${page}:`, e);
      return null;
    }
  }

  /** Find asset copies of a mirror image via the index.
   *  For render-level / name-page matches the mirrorFile is a stand-in, not
   *  the actual image pixel content, so only propagate across STRICT matches.
   *  Entries with `bbox` set are sub-crops (multi-occurrence variants of the
   *  same source page) and must NEVER inherit a sibling's save. */
  async findAssetCopies(mirrorName: string, mirrorFile: string, coursePath: string): Promise<string[]> {
    const index = await this.getOrBuildIndex(coursePath);
    const copies: string[] = [];
    for (const [assetFile, entry] of Object.entries(index.entries)) {
      if (entry.mirror !== mirrorName || entry.mirrorFile !== mirrorFile) continue;
      if (entry.bbox) continue;  // sub-crop, not a byte-identical copy
      const method = entry.matchMethod ?? 'sha256';
      if (method === 'sha256' || method === 'dhash') {
        copies.push(normalizePath(`${coursePath}/asset/${assetFile}`));
      }
    }
    return copies;
  }

  /** Count distinct asset filenames pointing at the same (mirror, mirrorFile).
   *  Consults BOTH the legacy index and the provenance sidecar so the
   *  multi-occurrence guard fires before the index has been rebuilt with the
   *  newly-inserted siblings (lecture-images writes provenance directly). */
  async countAssetSiblings(
    coursePath: string, mirrorName: string, mirrorFile: string,
  ): Promise<number> {
    const seen = new Set<string>();
    try {
      const index = await this.getOrBuildIndex(coursePath);
      for (const [assetFile, entry] of Object.entries(index.entries)) {
        if (entry.mirror === mirrorName && entry.mirrorFile === mirrorFile) {
          seen.add(assetFile);
        }
      }
    } catch { /* best-effort */ }
    try {
      const prov = await this.loadProvenance(coursePath);
      for (const [assetFile, e] of Object.entries(prov.entries)) {
        if (e.mirror === mirrorName && e.mirrorFile === mirrorFile) {
          seen.add(assetFile);
        }
      }
    } catch { /* best-effort */ }
    return seen.size;
  }

  async updateCascadeReport(
    ms: MirrorSource, page: number,
    crop: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    const reportPath = normalizePath(`${ms.dir}/_cascade_report.json`);
    if (!await this.app.vault.adapter.exists(reportPath)) return;
    try {
      const report = JSON.parse(await this.app.vault.adapter.read(reportPath));
      const pageKey = String(page);
      if (!report.pages[pageKey]) report.pages[pageKey] = {};
      report.pages[pageKey].manual_crop = {
        ...crop,
        timestamp: new Date().toISOString(),
      };
      await this.app.vault.adapter.write(reportPath, JSON.stringify(report, null, 2));
    } catch { /* skip */ }
  }

  // ── Initial crop rect ─────────────────────────────────────────────────

  async findInitialCropRect(
    ms: MirrorSource,
    page: number,
    mirrorImageFile: string,
    renderWidth: number,
    renderHeight: number,
    bboxFromIndex?: { x: number; y: number; width: number; height: number },
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    // Prefer the sub-region bbox recorded by T3 template match, if present.
    if (bboxFromIndex) return { ...bboxFromIndex };

    const report = ms.cascadeReport;
    if (!report) return null;

    const pageData = report.pages[String(page)];
    if (!pageData) return null;

    // 1. manual_crop: stored in render pixel coords
    if (pageData.manual_crop) {
      return {
        x: pageData.manual_crop.x,
        y: pageData.manual_crop.y,
        width: pageData.manual_crop.width,
        height: pageData.manual_crop.height,
      };
    }

    // 2. Match against P1/P2 extracted files via SHA-256. For NCC entries
    // pointing at full-page renders the SHA gate cannot match (renders are
    // bigger than P1/P2 sub-images by design); the modal still works because
    // we drop to "no initial selection" via the null return below.
    const mirrorImagePath = (await this.resolveMirrorFile(ms.dir, mirrorImageFile))
      ?? normalizePath(`${ms.dir}/${mirrorFileSubPath(mirrorImageFile)}`);
    let targetHash: string;
    try {
      targetHash = await sha256(await this.app.vault.adapter.readBinary(mirrorImagePath));
    } catch { return null; }

    const pageDims = (pageData as any).page_dims;
    if (!pageDims) return null;

    const scaleX = renderWidth / pageDims.width;
    const scaleY = renderHeight / pageDims.height;

    for (const p1 of pageData.P1 || []) {
      if (!p1.file || !p1.bbox) continue;
      const p1Path = normalizePath(`${ms.dir}/${p1.file}`);
      try {
        const h = await sha256(await this.app.vault.adapter.readBinary(p1Path));
        if (h === targetHash) {
          const [x0, y0, x1, y1] = p1.bbox;
          return { x: x0 * scaleX, y: y0 * scaleY, width: (x1 - x0) * scaleX, height: (y1 - y0) * scaleY };
        }
      } catch { /* skip */ }
    }

    for (const p2 of pageData.P2_auto || []) {
      if (!p2.file) continue;
      const rect = (p2 as any).padded_rect || p2.rect;
      if (!rect) continue;
      const p2Path = normalizePath(`${ms.dir}/${p2.file}`);
      try {
        const h = await sha256(await this.app.vault.adapter.readBinary(p2Path));
        if (h === targetHash) {
          const [x0, y0, x1, y1] = rect;
          return { x: x0 * scaleX, y: y0 * scaleY, width: (x1 - x0) * scaleX, height: (y1 - y0) * scaleY };
        }
      } catch { /* skip */ }
    }

    return null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private absoluteToVaultRelative(absPath: string): string | null {
    const normalized = absPath.replace(/\\/g, '/');
    const adapter = this.app.vault.adapter as any;
    const base = (adapter.getBasePath?.() ?? adapter.basePath ?? '').replace(/\\/g, '/');
    if (!base) return null;
    if (normalized.startsWith(base)) {
      return normalized.slice(base.length).replace(/^\//, '');
    }
    return null;
  }
}
