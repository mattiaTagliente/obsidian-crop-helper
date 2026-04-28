// PDF page rendering via pdf.js (runs on main thread, no worker needed)

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

// Disable web worker - single page render is fast enough on main thread
GlobalWorkerOptions.workerSrc = '';

/**
 * Render a single PDF page to a PNG ArrayBuffer.
 * @param pdfData  - raw PDF file content
 * @param pageNum  - 1-indexed page number
 * @param dpi      - render resolution (default 200)
 */
export async function renderPdfPage(
  pdfData: ArrayBuffer,
  pageNum: number,
  dpi = 200,
): Promise<ArrayBuffer> {
  const doc = await getDocument({
    data: new Uint8Array(pdfData),
    useSystemFonts: true,
  }).promise;

  try {
    const page = await doc.getPage(pageNum);
    const scale = dpi / 72; // PDF default is 72 DPI
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;

    await page.render({ canvasContext: ctx, viewport }).promise;

    return new Promise<ArrayBuffer>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('Failed to create PNG blob'));
          blob.arrayBuffer().then(resolve, reject);
        },
        'image/png',
      );
    });
  } finally {
    await doc.destroy();
  }
}
