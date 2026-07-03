import { App, Modal, Notice, normalizePath } from 'obsidian';
import { CanvasCrop, CropRect } from './canvas-crop';
import { SourceResolver, ResolvedImage, MirrorSource, MirrorImage } from './resolver';

// ── Archive helper ──────────────────────────────────────────────────────

async function archiveAndSave(app: App, filePath: string, newContent: ArrayBuffer): Promise<void> {
  if (await app.vault.adapter.exists(filePath)) {
    const old = await app.vault.adapter.readBinary(filePath);
    await writeToArchive(app, filePath, old);
  }
  await app.vault.adapter.writeBinary(filePath, newContent);
}

/** Write `content` into `.archive/<name>_<timestamp><ext>` next to `filePath`. */
async function writeToArchive(app: App, filePath: string, content: ArrayBuffer): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  const file = filePath.substring(filePath.lastIndexOf('/') + 1);
  const extIdx = file.lastIndexOf('.');
  const ext = extIdx >= 0 ? file.substring(extIdx) : '';
  const name = extIdx >= 0 ? file.substring(0, extIdx) : file;
  const archiveDir = normalizePath(`${dir}/.archive`);
  if (!await app.vault.adapter.exists(archiveDir)) {
    await app.vault.adapter.mkdir(archiveDir);
  }
  const ts = new Date().toISOString().replace(/[-:.]/g, '').substring(0, 15);
  const archivePath = normalizePath(`${archiveDir}/${name}_${ts}${ext}`);
  await app.vault.adapter.writeBinary(archivePath, content);
}

// ── Mime helper ──────────────────────────────────────────────────────────

function mimeFromPath(p: string): string {
  if (/\.jpe?g$/i.test(p)) return 'image/jpeg';
  return 'image/png';
}

// ── Refresh image in DOM ─────────────────────────────────────────────────

/** Update all visible <img> elements showing a given asset with new content.
 *  Matches strictly on the full vault-relative path (not basename substring)
 *  so that two assets sharing a basename across folders, OR an asset whose
 *  basename is a substring of another, never cross-pollinate visually.
 *
 *  Tags matched elements with `data-crop-path` so subsequent refreshes
 *  still find them even after `src` has been replaced with a blob URL. */
function refreshImageInDom(assetPath: string, buffer: ArrayBuffer) {
  const blob = new Blob([buffer], { type: 'image/png' });
  const newUrl = URL.createObjectURL(blob);
  const fileName = assetPath.split('/').pop() ?? '';
  const encodedFile = encodeURIComponent(fileName);
  const encodedPath = encodeURI(assetPath);

  document.querySelectorAll('img').forEach(img => {
    const tagPath = img.getAttribute('data-crop-path');
    const src = img.getAttribute('src') ?? '';
    let match = false;
    if (tagPath) {
      // Once tagged, only the exact same path can refresh us again.
      match = tagPath === assetPath;
    } else {
      // First contact: require the full vault-relative path in src to
      // distinguish basename collisions across folders.
      match = src.includes(assetPath) || src.includes(encodedPath);
      // Last-resort fallback for legacy embeds whose src has no path
      // component (e.g. some inline-rendered cases): exact basename only.
      if (!match && !src.includes('/')) {
        match = src === fileName || src === encodedFile;
      }
    }
    if (match) {
      img.setAttribute('data-crop-path', assetPath);
      img.src = newUrl;
    }
  });
}

// ── Single Crop Modal ───────────────────────────────────────────────────

export class CropModal extends Modal {
  private resolver: SourceResolver;
  private resolved: ResolvedImage;
  private crop: CanvasCrop | null = null;
  /** Invoked when the user declares the auto-match wrong. Lets the caller
   *  re-pick the correct mirror source + page (records manual provenance).
   *  When absent, the button falls back to browsing the current source. */
  private onWrongMatch?: () => void;

  constructor(app: App, resolver: SourceResolver, resolved: ResolvedImage, onWrongMatch?: () => void) {
    super(app);
    this.resolver = resolver;
    this.resolved = resolved;
    this.onWrongMatch = onWrongMatch;
  }

  async onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('crop-helper-modal');
    contentEl.empty();

    if (!this.resolved.renderPath) {
      contentEl.createEl('p', { text: 'No full-page render available for this image. Run cascade_extract first.' });
      return;
    }

    // Top bar
    const topBar = contentEl.createDiv({ cls: 'crop-top-bar' });
    const r = this.resolved;
    const matchLabel = r.matchMethod === 'sha256' ? '' : ` (${r.matchMethod} ${Math.round(r.confidence * 100)}%)`;
    topBar.createSpan({ text: `${r.mirrorImageFile}  |  Page ${r.page}  |  Source: ${r.mirrorSource.name}${matchLabel}`, cls: 'crop-info' });

    const controls = topBar.createDiv({ cls: 'crop-controls' });

    // Show "Wrong match?" link for non-exact matches. Re-picking the SOURCE
    // is the correct recovery: the whole premise is that r.mirrorSource is
    // wrong, so browsing it again is a dead end. onWrongMatch opens a
    // course-wide mirror + page picker and records manual provenance.
    if (r.matchMethod !== 'sha256') {
      const wrongBtn = controls.createEl('button', {
        text: this.onWrongMatch ? 'Wrong source? Pick correct...' : 'Wrong match? Browse...',
        cls: 'crop-wrong-match',
      });
      wrongBtn.addEventListener('click', () => {
        this.close();
        if (this.onWrongMatch) this.onWrongMatch();
        else new BrowseModal(this.app, this.resolver, r.coursePath, r.mirrorSource).open();
      });
    }

    const saveBtn = controls.createEl('button', { text: 'Save crop', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => this.saveCrop());

    const hint = topBar.createDiv({ cls: 'crop-hint' });
    hint.innerHTML = 'Draw rectangle &rarr; <b>Enter</b> or double-click to save &nbsp;|&nbsp; <b>Space+drag</b> to pan &nbsp;|&nbsp; <b>Scroll</b> to zoom &nbsp;|&nbsp; <b>Esc</b> to close';

    // Main area
    const main = contentEl.createDiv({ cls: 'crop-main-area' });
    const canvasContainer = main.createDiv({ cls: 'crop-canvas-container' });
    const previewContainer = main.createDiv({ cls: 'crop-preview-container' });
    previewContainer.createEl('div', { text: 'Preview', cls: 'crop-preview-label' });

    // Canvas crop component
    this.crop = new CanvasCrop(canvasContainer, previewContainer);
    this.crop.onConfirm = () => this.saveCrop();
    this.crop.onCancel = () => this.close();

    // Load render
    try {
      const buffer = await this.app.vault.adapter.readBinary(this.resolved.renderPath);
      await this.crop.loadFromBuffer(buffer, mimeFromPath(this.resolved.renderPath));

      // Pre-position selection on the original crop area
      const r = this.resolved;
      const initRect = await this.resolver.findInitialCropRect(
        r.mirrorSource, r.page, r.mirrorImageFile,
        this.crop.renderWidth, this.crop.renderHeight,
        r.bbox);
      if (initRect) this.crop.setInitialSelection(initRect);

      canvasContainer.focus();
    } catch (e) {
      new Notice(`Failed to load render: ${e}`);
    }
  }

  private async saveCrop() {
    if (!this.crop?.selection) {
      new Notice('Draw a crop rectangle first');
      return;
    }
    // Snapshot selection before the modal closes (which destroys this.crop).
    const selection = { ...this.crop.selection };
    let r = this.resolved;

    // Multi-occurrence guard: if ≥2 distinct asset filenames point at this
    // (mirror, mirrorFile), the asset is a per-occurrence crop variant and
    // saving must NOT overwrite the mirror raw nor propagate to siblings.
    // Defends against lecture-images entries that escaped the batch script's
    // multi-occurrence detection (e.g. legacy provenance, manual edits).
    if (r.writeBackToMirror) {
      let siblings = 0;
      try {
        siblings = await this.resolver.countAssetSiblings(
          r.coursePath, r.mirrorSource.name, r.mirrorImageFile);
      } catch { /* best-effort */ }
      if (siblings >= 2) {
        r = { ...r, writeBackToMirror: false };
        new Notice(
          `${siblings} references share ${r.mirrorImageFile} — saving as per-occurrence crop (mirror raw preserved).`,
          6000,
        );
      }
    }

    const saving = new Notice('Saving crop...', 0);
    let buffer: ArrayBuffer | null = null;
    try {
      buffer = await this.crop.exportCrop();
    } catch (e) {
      saving.hide();
      new Notice(`Export failed: ${e}`);
      return;
    }
    if (!buffer) {
      saving.hide();
      new Notice('Failed to export crop');
      return;
    }

    // CRITICAL PATH — read old asset (for later archive), write new asset,
    // close modal. Everything else (archive write, cascade report, mirror
    // writeback, copies) runs detached after close.
    let oldAssetBytes: ArrayBuffer | null = null;
    try {
      if (r.assetPath && await this.app.vault.adapter.exists(r.assetPath)) {
        try { oldAssetBytes = await this.app.vault.adapter.readBinary(r.assetPath); }
        catch { /* best-effort */ }
      }
      if (r.assetPath) {
        await this.app.vault.adapter.writeBinary(r.assetPath, buffer);
      }
      if (r.assetPath) refreshImageInDom(r.assetPath, buffer);
      if (r.writeBackToMirror) refreshImageInDom(r.mirrorImagePath, buffer);

      saving.hide();
      const assetName = r.assetPath?.split('/').pop();
      new Notice(`Crop saved: ${assetName ?? r.mirrorImageFile}`);
      this.close();
    } catch (e) {
      saving.hide();
      new Notice(`Save failed: ${e}`);
      return;
    }

    // DETACHED — runs after close, failures are logged but don't bother the user.
    void this.backgroundFinalize(r, buffer, selection, oldAssetBytes);
  }

  /** Archival, cascade report, mirror write-back, and copy propagation.
   *  Runs after the modal has closed; user already sees the updated asset. */
  private async backgroundFinalize(
    r: ResolvedImage,
    buffer: ArrayBuffer,
    selection: { x: number; y: number; width: number; height: number },
    oldAssetBytes: ArrayBuffer | null,
  ) {
    try {
      // Archive previous asset version (we captured bytes BEFORE overwriting)
      if (oldAssetBytes && r.assetPath) {
        await writeToArchive(this.app, r.assetPath, oldAssetBytes);
      }

      if (r.writeBackToMirror) {
        await archiveAndSave(this.app, r.mirrorImagePath, buffer);
        const copies = await this.resolver.findAssetCopies(
          r.mirrorSource.name, r.mirrorImageFile, r.coursePath);
        for (const copy of copies) {
          if (copy !== r.assetPath && await this.app.vault.adapter.exists(copy)) {
            await archiveAndSave(this.app, copy, buffer);
          }
        }
      }

      await this.resolver.updateCascadeReport(r.mirrorSource, r.page, selection);

      // Persist provenance — once the user has confirmed a crop, the
      // (asset, mirror, mirrorFile, page, bbox) mapping is authoritative.
      // Clear pending_crop unconditionally: a saved crop means Elena
      // finished refining the render_fallback asset.
      const assetName = r.assetPath?.split('/').pop();
      if (assetName) {
        await this.resolver.saveProvenanceEntry(r.coursePath, assetName, {
          mirror: r.mirrorSource.name,
          mirrorFile: r.mirrorImageFile,
          page: r.page,
          bbox: selection,
          writeBackToMirror: r.writeBackToMirror,
          source: 'save',
          pending_crop: false,
        });
      }
    } catch (e) {
      console.error('[crop-helper] backgroundFinalize failed:', e);
    }
  }

  onClose() {
    this.crop?.destroy();
    this.contentEl.empty();
  }
}

// ── Browse Modal ────────────────────────────────────────────────────────

export class BrowseModal extends Modal {
  private resolver: SourceResolver;
  private coursePath: string;
  private mirrorSource: MirrorSource;
  private images: MirrorImage[] = [];
  private currentIndex = 0;
  private crop: CanvasCrop | null = null;
  private sidebarEl: HTMLElement | null = null;
  private counterEl: HTMLElement | null = null;
  private correctedCount = 0;
  private hideFilter = false;

  constructor(app: App, resolver: SourceResolver, coursePath: string, mirrorSource: MirrorSource) {
    super(app);
    this.resolver = resolver;
    this.coursePath = coursePath;
    this.mirrorSource = mirrorSource;
  }

  async onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('crop-helper-modal');
    contentEl.empty();

    this.images = await this.resolver.getMirrorImages(this.mirrorSource);
    this.correctedCount = this.images.filter(i => i.hasCorrectedCrop).length;

    if (this.images.length === 0) {
      contentEl.createEl('p', { text: 'No images found in this mirror source.' });
      return;
    }

    // Top bar
    const topBar = contentEl.createDiv({ cls: 'crop-top-bar' });
    this.counterEl = topBar.createSpan({ cls: 'crop-info' });
    this.updateCounter();

    const controls = topBar.createDiv({ cls: 'crop-controls' });

    const hideToggle = controls.createEl('label', { cls: 'crop-filter-label' });
    const cb = hideToggle.createEl('input', { type: 'checkbox' });
    cb.addEventListener('change', () => {
      this.hideFilter = cb.checked;
      this.rebuildSidebar();
    });
    hideToggle.appendText(' Hide corrected');

    const saveBtn = controls.createEl('button', { text: 'Save & Next', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => this.saveCropAndNext());

    const hint = topBar.createDiv({ cls: 'crop-hint' });
    hint.innerHTML = '<b>&uarr;&darr;</b> navigate &nbsp;|&nbsp; Draw + <b>Enter</b> to crop &nbsp;|&nbsp; <b>Space+drag</b> pan &nbsp;|&nbsp; <b>Scroll</b> zoom';

    // Main area with sidebar
    const main = contentEl.createDiv({ cls: 'crop-main-area crop-browse-layout' });

    // Sidebar
    this.sidebarEl = main.createDiv({ cls: 'crop-sidebar' });
    this.rebuildSidebar();

    // Canvas area
    const rightArea = main.createDiv({ cls: 'crop-right-area' });
    const canvasContainer = rightArea.createDiv({ cls: 'crop-canvas-container' });
    const previewContainer = rightArea.createDiv({ cls: 'crop-preview-container' });
    previewContainer.createEl('div', { text: 'Preview', cls: 'crop-preview-label' });

    this.crop = new CanvasCrop(canvasContainer, previewContainer);
    this.crop.onConfirm = () => this.saveCropAndNext();
    this.crop.onCancel = () => this.close();

    // Keyboard nav on sidebar
    this.sidebarEl.tabIndex = 0;
    this.sidebarEl.addEventListener('keydown', (e) => {
      if (e.code === 'ArrowDown') { e.preventDefault(); this.navigate(1); }
      if (e.code === 'ArrowUp') { e.preventDefault(); this.navigate(-1); }
      if (e.code === 'Enter') { e.preventDefault(); canvasContainer.focus(); }
    });

    // Load first image
    await this.loadImage(0);
  }

  private rebuildSidebar() {
    if (!this.sidebarEl) return;
    this.sidebarEl.empty();

    const filtered = this.hideFilter
      ? this.images.filter(i => !i.hasCorrectedCrop)
      : this.images;

    for (let i = 0; i < this.images.length; i++) {
      const img = this.images[i];
      if (this.hideFilter && img.hasCorrectedCrop) continue;

      const item = this.sidebarEl.createDiv({
        cls: `crop-sidebar-item ${i === this.currentIndex ? 'is-active' : ''} ${img.hasCorrectedCrop ? 'is-corrected' : ''}`,
      });
      item.dataset.index = String(i);

      // Thumbnail
      const thumb = item.createDiv({ cls: 'crop-sidebar-thumb' });
      this.loadThumbnail(img.path, thumb);

      // Info
      const info = item.createDiv({ cls: 'crop-sidebar-info' });
      info.createDiv({ text: img.file, cls: 'crop-sidebar-name' });
      info.createDiv({ text: `Page ${img.page}`, cls: 'crop-sidebar-page' });
      if (img.hasCorrectedCrop) {
        info.createDiv({ text: 'corrected', cls: 'crop-sidebar-badge' });
      }

      item.addEventListener('click', () => this.loadImage(i));
    }
  }

  private async loadThumbnail(path: string, container: HTMLElement) {
    try {
      const buf = await this.app.vault.adapter.readBinary(path);
      const blob = new Blob([buf], { type: mimeFromPath(path) });
      const url = URL.createObjectURL(blob);
      const img = container.createEl('img');
      img.src = url;
    } catch {
      container.createSpan({ text: '?', cls: 'crop-thumb-error' });
    }
  }

  private async loadImage(index: number) {
    this.currentIndex = index;
    const img = this.images[index];
    if (!img) return;

    // Update sidebar selection
    this.sidebarEl?.querySelectorAll('.crop-sidebar-item').forEach((el, i) => {
      const idx = parseInt((el as HTMLElement).dataset.index ?? '-1');
      el.toggleClass('is-active', idx === index);
    });

    this.updateCounter();

    // Resolve render
    const renderPath = await this.resolver.resolveRender(this.mirrorSource, img.page);
    if (!renderPath) {
      new Notice(`No render available for page ${img.page}`);
      return;
    }

    try {
      const buffer = await this.app.vault.adapter.readBinary(renderPath);
      await this.crop!.loadFromBuffer(buffer, mimeFromPath(renderPath));

      // Pre-position selection on the original crop area
      const initRect = await this.resolver.findInitialCropRect(
        this.mirrorSource, img.page, img.file,
        this.crop!.renderWidth, this.crop!.renderHeight);
      if (initRect) this.crop!.setInitialSelection(initRect);
    } catch (e) {
      new Notice(`Failed to load render: ${e}`);
    }
  }

  private navigate(delta: number) {
    const visible = this.images
      .map((img, i) => ({ img, i }))
      .filter(({ img }) => !this.hideFilter || !img.hasCorrectedCrop);

    const curVisIdx = visible.findIndex(v => v.i === this.currentIndex);
    const next = curVisIdx + delta;
    if (next >= 0 && next < visible.length) {
      this.loadImage(visible[next].i);
      // Scroll sidebar item into view
      const el = this.sidebarEl?.querySelector(`[data-index="${visible[next].i}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  }

  private async saveCropAndNext() {
    if (!this.crop?.selection) {
      new Notice('Draw a crop rectangle first');
      return;
    }

    const buffer = await this.crop.exportCrop();
    if (!buffer) {
      new Notice('Failed to export crop');
      return;
    }

    const img = this.images[this.currentIndex];

    try {
      // Save to mirror
      await archiveAndSave(this.app, img.path, buffer);

      // Save to asset copies
      const copies = await this.resolver.findAssetCopies(
        this.mirrorSource.name, img.file, this.coursePath);
      for (const copy of copies) {
        if (await this.app.vault.adapter.exists(copy)) {
          await archiveAndSave(this.app, copy, buffer);
        }
      }

      // Update cascade report
      await this.resolver.updateCascadeReport(this.mirrorSource, img.page, this.crop.selection);

      // Mark as corrected
      img.hasCorrectedCrop = true;
      this.correctedCount = this.images.filter(i => i.hasCorrectedCrop).length;
      this.updateCounter();
      this.rebuildSidebar();

      // Refresh all visible instances in the DOM (path-based match)
      refreshImageInDom(img.path, buffer);
      for (const copy of copies) {
        refreshImageInDom(copy, buffer);
      }

      new Notice(`Saved: ${img.file}`);

      // Advance to next
      this.navigate(1);
    } catch (e) {
      new Notice(`Save failed: ${e}`);
    }
  }

  private updateCounter() {
    if (this.counterEl) {
      this.counterEl.textContent = `${this.currentIndex + 1} / ${this.images.length} — ${this.correctedCount} corrected  |  ${this.mirrorSource.name}`;
    }
  }

  onClose() {
    this.crop?.destroy();
    this.contentEl.empty();
  }
}
