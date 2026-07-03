import { Plugin, Notice, normalizePath, FuzzySuggestModal, App, setIcon } from 'obsidian';
import { SourceResolver, MirrorSource, ResolvedImage } from './resolver';
import { CropModal, BrowseModal } from './crop-modal';

// ── Pickers ──────────────────────────────────────────────────────────────

class CoursePicker extends FuzzySuggestModal<string> {
  private courses: string[];
  private onPick: (course: string) => void;
  constructor(app: App, courses: string[], onPick: (course: string) => void) {
    super(app);
    this.courses = courses;
    this.onPick = onPick;
    this.setPlaceholder('Select a course...');
  }
  getItems() { return this.courses; }
  getItemText(item: string) { return item; }
  onChooseItem(item: string) { this.onPick(item); }
}

class MirrorPicker extends FuzzySuggestModal<MirrorSource> {
  private mirrors: MirrorSource[];
  private onPick: (ms: MirrorSource) => void;
  constructor(app: App, mirrors: MirrorSource[], onPick: (ms: MirrorSource) => void) {
    super(app);
    this.mirrors = mirrors;
    this.onPick = onPick;
    this.setPlaceholder('Select a source...');
  }
  getItems() { return this.mirrors; }
  getItemText(item: MirrorSource) { return item.name; }
  onChooseItem(item: MirrorSource) { this.onPick(item); }
}

interface PageOption { page: number; label: string; }

class PagePicker extends FuzzySuggestModal<PageOption> {
  private pages: PageOption[];
  private onPick: (page: number) => void;
  constructor(app: App, pages: PageOption[], onPick: (page: number) => void) {
    super(app);
    this.pages = pages;
    this.onPick = onPick;
    this.setPlaceholder('Select a page...');
  }
  getItems() { return this.pages; }
  getItemText(item: PageOption) { return item.label; }
  onChooseItem(item: PageOption) { this.onPick(item.page); }
}

// ── Plugin ───────────────────────────────────────────────────────────────

export default class CropHelperPlugin extends Plugin {
  private resolver!: SourceResolver;

  async onload() {
    this.resolver = new SourceResolver(this.app);

    // ── Image context menu: Reading mode via DOM injection ──
    const contextHandler = (evt: MouseEvent) => {
      const target = evt.target as HTMLElement;
      const embed = target.closest('.internal-embed.image-embed')
        ?? (target.tagName === 'IMG' ? target.closest('.internal-embed') : null);
      if (!embed) return;

      const imagePath = embed.getAttribute('src');
      if (!imagePath) return;

      const noteFile = this.app.workspace.getActiveFile();
      if (!noteFile) return;

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node instanceof HTMLElement && node.classList.contains('menu')) {
              observer.disconnect();
              this.injectCropMenuItems(node, imagePath, noteFile.path);
              return;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true });
      setTimeout(() => observer.disconnect(), 500);
    };
    document.addEventListener('contextmenu', contextHandler, true);
    this.register(() => document.removeEventListener('contextmenu', contextHandler, true));

    // ── Editor-menu for Source/Live Preview modes ──
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const match = line.match(/!\[.*?\]\(([^)]+)\)/);
        if (!match) return;

        const imagePath = match[1];
        const noteFile = (info as any).file ?? this.app.workspace.getActiveFile();
        if (!noteFile) return;

        menu.addItem(item => {
          item.setTitle('Re-crop...').setIcon('crop')
            .onClick(() => this.openCropForAsset(imagePath, noteFile.path));
        });
        menu.addItem(item => {
          item.setTitle('Browse & re-crop all...').setIcon('images')
            .onClick(() => this.openBrowseFromNote(noteFile.path));
        });
      })
    );

    // ── Commands ──
    this.addCommand({
      id: 'recrop-current',
      name: 'Re-crop current image',
      editorCallback: (editor) => {
        const line = editor.getLine(editor.getCursor().line);
        const match = line.match(/!\[.*?\]\(([^)]+)\)/);
        if (!match) {
          new Notice('Place cursor on a line with an image embed');
          return;
        }
        const noteFile = this.app.workspace.getActiveFile();
        if (!noteFile) return;
        this.openCropForAsset(match[1], noteFile.path);
      },
    });

    this.addCommand({
      id: 'browse-recrop',
      name: 'Browse & re-crop images',
      callback: () => this.openBrowse(),
    });

    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild crop index',
      callback: () => this.rebuildIndex(),
    });

    this.addCommand({
      id: 'list-pending-crops',
      name: 'List pending crops (render_fallback)',
      callback: () => this.listPendingCrops(),
    });

    this.addCommand({
      id: 'normalize-mirror-layout',
      name: 'Normalize mirror layout (repair drifted mirrors)',
      callback: () => this.normalizeMirrorLayout(),
    });

    // ── Post-processor: decorate render_fallback assets ──
    // Reading-mode image embeds get the .crop-helper-pending class when
    // their asset has pending_crop=true in .provenance.json. Cheap: one
    // provenance read per active note (cached by Obsidian's adapter).
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      const noteFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!noteFile) return;
      const coursePath = await this.resolver.detectCoursePath(ctx.sourcePath);
      if (!coursePath) return;
      const prov = await this.resolver.loadProvenance(coursePath);
      const embeds = el.querySelectorAll('.internal-embed.image-embed, img');
      embeds.forEach((node) => {
        const src = (node as HTMLElement).getAttribute('src')
          ?? (node as HTMLElement).getAttribute('alt');
        if (!src) return;
        const fname = src.split('/').pop()!.split('?')[0];
        const entry = prov.entries[fname];
        if (entry?.pending_crop === true) {
          (node as HTMLElement).addClass('crop-helper-pending');
        }
      });
    });
  }

  /** Repair "layout drift" in content mirrors of the active course. Some older
   *  cascade_extract runs placed `_cascade_report.json`, `p<N>_render.png` and
   *  `p<N>_grid.png` under `images/` instead of at the mirror root, where the
   *  canonical material-enrich layout requires them. The resolver tolerates
   *  drift in-memory; this command makes the disk layout canonical so other
   *  tooling (render_fallback.py, validate_manifest.py) sees the expected
   *  structure too. Cascade report is MOVED (single canonical location);
   *  render/grid PNGs are COPIED (render_fallback expects copies in images/). */
  private async normalizeMirrorLayout(): Promise<void> {
    const noteFile = this.app.workspace.getActiveFile();
    if (!noteFile) { new Notice('Open a file in a course first'); return; }
    const coursePath = await this.resolver.detectCoursePath(noteFile.path);
    if (!coursePath) { new Notice('No course with content mirror found'); return; }

    const mirrorRoot = normalizePath(`${coursePath}/materiale/.content_mirror`);
    const listing = await this.app.vault.adapter.list(mirrorRoot);
    let mirrorsTouched = 0;
    let filesMoved = 0;
    const errors: string[] = [];

    for (const folder of listing.folders) {
      const imagesDir = normalizePath(`${folder}/images`);
      if (!await this.app.vault.adapter.exists(imagesDir)) continue;

      const imgListing = await this.app.vault.adapter.list(imagesDir);
      let mirrorDirty = false;

      for (const fp of imgListing.files) {
        const name = fp.split('/').pop()!;
        const isCascade = name === '_cascade_report.json';
        const isRenderOrGrid = /^p\d+_(render|grid)\.(png|jpe?g)$/i.test(name);
        if (!isCascade && !isRenderOrGrid) continue;

        const dst = normalizePath(`${folder}/${name}`);
        if (await this.app.vault.adapter.exists(dst)) continue;

        try {
          if (isCascade) {
            const data = await this.app.vault.adapter.read(fp);
            await this.app.vault.adapter.write(dst, data);
            await this.app.vault.adapter.remove(fp);
          } else {
            const data = await this.app.vault.adapter.readBinary(fp);
            await this.app.vault.adapter.writeBinary(dst, data);
          }
          filesMoved++;
          mirrorDirty = true;
        } catch (e) {
          errors.push(`${name}: ${e}`);
          console.error(`[crop-helper] normalize failed for ${fp}:`, e);
        }
      }
      if (mirrorDirty) mirrorsTouched++;
    }

    this.resolver.invalidateMemCache(coursePath);
    const summary = `Normalized ${mirrorsTouched} mirror(s), ${filesMoved} file(s)`;
    new Notice(errors.length ? `${summary} (${errors.length} errors — see console)` : summary, 6000);
    console.log(`[crop-helper] ${summary}`);
  }

  private async listPendingCrops(): Promise<void> {
    const noteFile = this.app.workspace.getActiveFile();
    if (!noteFile) { new Notice('No active file'); return; }
    const coursePath = await this.resolver.detectCoursePath(noteFile.path);
    if (!coursePath) { new Notice('Active file is outside a course directory'); return; }
    const prov = await this.resolver.loadProvenance(coursePath);
    const pending = Object.entries(prov.entries)
      .filter(([, e]) => e.pending_crop === true)
      .map(([asset, e]) => `${asset} → ${e.mirror} p${e.page}`);
    if (pending.length === 0) {
      new Notice('No pending crops in this course');
      return;
    }
    new Notice(`${pending.length} pending crop(s):\n${pending.slice(0, 15).join('\n')}${pending.length > 15 ? `\n…+${pending.length - 15}` : ''}`, 12000);
  }

  // ── Inject items into an existing Obsidian menu DOM element ──────

  private injectCropMenuItems(menuEl: HTMLElement, imagePath: string, notePath: string) {
    menuEl.createDiv({ cls: 'menu-separator' });

    const item1 = menuEl.createDiv({ cls: 'menu-item' });
    const icon1 = item1.createDiv({ cls: 'menu-item-icon' });
    setIcon(icon1, 'crop');
    item1.createDiv({ cls: 'menu-item-title', text: 'Re-crop...' });
    item1.addEventListener('click', (e) => {
      e.stopPropagation();
      menuEl.parentElement?.removeChild(menuEl);
      document.querySelector('.menu-bg')?.remove();
      this.openCropForAsset(imagePath, notePath);
    });
    item1.addEventListener('mouseenter', () => item1.addClass('selected'));
    item1.addEventListener('mouseleave', () => item1.removeClass('selected'));

    const item2 = menuEl.createDiv({ cls: 'menu-item' });
    const icon2 = item2.createDiv({ cls: 'menu-item-icon' });
    setIcon(icon2, 'gallery-horizontal-end');
    item2.createDiv({ cls: 'menu-item-title', text: 'Browse & re-crop all...' });
    item2.addEventListener('click', (e) => {
      e.stopPropagation();
      menuEl.parentElement?.removeChild(menuEl);
      document.querySelector('.menu-bg')?.remove();
      this.openBrowseFromNote(notePath);
    });
    item2.addEventListener('mouseenter', () => item2.addClass('selected'));
    item2.addEventListener('mouseleave', () => item2.removeClass('selected'));
  }

  // ── Right-click flow ───────────────────────────────────────────────

  private async openCropForAsset(imagePath: string, notePath: string) {
    const noteDir = notePath.substring(0, notePath.lastIndexOf('/'));
    const cleaned = imagePath.replace(/^\.\//, '');
    const resolved = cleaned.startsWith('/')
      ? cleaned.slice(1)
      : normalizePath(`${noteDir}/${cleaned}`);
    const fileName = resolved.split('/').pop()!;

    const progress = new Notice('Resolving image source...', 0);
    let result;
    try {
      result = await this.resolver.resolveFromAsset(fileName, notePath);
    } catch (e) {
      progress.hide();
      console.error('[crop-helper] resolveFromAsset threw:', e);
      new Notice(`Resolve failed: ${e}`);
      return;
    }

    if (!result) {
      progress.hide();
      // Try the heavy on-demand subregion sweep (covers pastes with no filename hint)
      const coursePath = await this.resolver.detectCoursePath(notePath);
      if (coursePath) {
        const heavy = new Notice('No quick match — searching page renders (this may take a moment)...', 0);
        try {
          const entry = await this.resolver.resolveUnmatchedHeavy(coursePath, fileName);
          heavy.hide();
          if (entry) {
            const res = await this.resolver.resolveFromAsset(fileName, notePath, false);
            if (res && res.renderPath) {
              this.openCropModal(res, fileName, notePath);
              return;
            }
          }
        } catch (e) {
          heavy.hide();
          console.error('[crop-helper] heavy resolve threw:', e);
        }
      }
      // Still nothing: manual picker.
      await this.pickSourceManually(fileName, notePath, 'miss');
      return;
    }

    progress.hide();
    if (!result.renderPath) {
      new Notice(`No full-page render available for page ${result.page}. Run cascade_extract.`);
      return;
    }

    this.openCropModal(result, fileName, notePath);
  }

  /** Open the crop modal, wiring the "wrong source" escape hatch so the user
   *  can re-pick the correct mirror + page (records manual provenance) when
   *  the automatic match is wrong. */
  private openCropModal(resolved: ResolvedImage, fileName: string, notePath: string) {
    new CropModal(
      this.app, this.resolver, resolved,
      () => { void this.pickSourceManually(fileName, notePath, 'wrong'); },
    ).open();
  }

  /** Manual source picker: user picks mirror + page, match is persisted as
   *  authoritative provenance, then the crop modal reopens on the correct
   *  render. Used both as the no-match fallback and as the "wrong source"
   *  recovery from the crop modal. */
  private async pickSourceManually(
    fileName: string, notePath: string, reason: 'miss' | 'wrong' = 'miss',
  ) {
    const coursePath = await this.resolver.detectCoursePath(notePath);
    if (!coursePath) {
      new Notice('No course with content mirror found for this note');
      return;
    }
    const mirrors = await this.resolver.findMirrors(coursePath);
    if (mirrors.length === 0) {
      new Notice('No mirror sources found in this course');
      return;
    }

    new Notice(reason === 'wrong'
      ? `Pick the correct source for "${fileName}".`
      : `No automatic match for "${fileName}". Pick source manually.`);

    const pickMirror = (ms: MirrorSource) => {
      const pages = this.collectPages(ms);
      if (pages.length === 0) {
        new Notice(`Mirror "${ms.name}" has no pages in cascade_report`);
        return;
      }
      new PagePicker(this.app, pages, async (page) => {
        await this.resolver.setManualMatch(coursePath, fileName, ms.name, page);
        // Re-resolve and open crop modal
        const resolved = await this.resolver.resolveFromAsset(fileName, notePath, false);
        if (!resolved || !resolved.renderPath) {
          new Notice(`No render available for page ${page}`);
          return;
        }
        this.openCropModal(resolved, fileName, notePath);
      }).open();
    };

    // Always show the mirror picker on a "wrong source" recovery — a
    // single-mirror course is not the common case, and forcing the picker
    // still lets the user confirm/switch rather than auto-reopening the same
    // (possibly wrong) source.
    if (mirrors.length === 1 && reason !== 'wrong') {
      pickMirror(mirrors[0]);
    } else {
      new MirrorPicker(this.app, mirrors, pickMirror).open();
    }
  }

  /** Build a list of page options from a mirror's cascade_report. */
  private collectPages(ms: MirrorSource): PageOption[] {
    const pages: PageOption[] = [];
    if (ms.cascadeReport?.pages) {
      for (const k of Object.keys(ms.cascadeReport.pages)) {
        const page = parseInt(k, 10);
        if (!Number.isFinite(page)) continue;
        const pd = ms.cascadeReport.pages[k];
        const hint = pd.P1?.length || pd.P2_auto?.length
          ? ` — ${(pd.P1?.length ?? 0) + (pd.P2_auto?.length ?? 0)} extract(s)`
          : '';
        pages.push({ page, label: `Page ${page}${hint}` });
      }
    }
    pages.sort((a, b) => a.page - b.page);
    return pages;
  }

  // ── Browse flow ────────────────────────────────────────────────────

  private async openBrowseFromNote(notePath: string) {
    const coursePath = await this.resolver.detectCoursePath(notePath);
    if (!coursePath) {
      new Notice('No course with content mirror found');
      return;
    }
    const mirrors = await this.resolver.findMirrors(coursePath);
    if (mirrors.length === 0) {
      new Notice('No mirror sources found');
      return;
    }
    if (mirrors.length === 1) {
      new BrowseModal(this.app, this.resolver, coursePath, mirrors[0]).open();
    } else {
      new MirrorPicker(this.app, mirrors, (ms) => {
        new BrowseModal(this.app, this.resolver, coursePath, ms).open();
      }).open();
    }
  }

  private async openBrowse() {
    const rootListing = await this.app.vault.adapter.list('');
    const courses: string[] = [];

    for (const folder of rootListing.folders) {
      const name = folder.split('/').pop()!;
      if (name.startsWith('.')) continue;
      const mirrorPath = normalizePath(`${folder}/materiale/.content_mirror`);
      if (await this.app.vault.adapter.exists(mirrorPath)) {
        courses.push(name);
      }
    }

    if (courses.length === 0) {
      new Notice('No courses with content mirrors found');
      return;
    }

    new CoursePicker(this.app, courses, async (course) => {
      const mirrors = await this.resolver.findMirrors(course);
      if (mirrors.length === 0) {
        new Notice('No mirror sources found');
        return;
      }
      new MirrorPicker(this.app, mirrors, (ms) => {
        new BrowseModal(this.app, this.resolver, course, ms).open();
      }).open();
    }).open();
  }

  // ── Rebuild index ──────────────────────────────────────────────────

  private async rebuildIndex() {
    const noteFile = this.app.workspace.getActiveFile();
    if (!noteFile) {
      new Notice('Open a file in a course first');
      return;
    }

    const coursePath = await this.resolver.detectCoursePath(noteFile.path);
    if (!coursePath) {
      new Notice('No course found for the current file');
      return;
    }

    new Notice('Rebuilding crop index...');
    const index = await this.resolver.buildIndex(coursePath);
    const count = Object.keys(index.entries).length;
    const unmatched = index.unmatched?.length ?? 0;
    new Notice(`Index rebuilt: ${count} matched, ${unmatched} unmatched`);
  }
}
