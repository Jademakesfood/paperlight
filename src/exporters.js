import { jsPDF } from 'jspdf';
import { Document, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import { loadImage } from './scanner.js';

const safeName = (name) => (name || 'Paperlight scan').replace(/[\\/:*?"<>|]/g, '-');

function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function shareOrDownload(blob, filename, title, allowShare = true) {
  const file = new File([blob], filename, { type: blob.type });
  if (allowShare && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
      // Some embedded browsers report file sharing support but block the
      // native sheet. Falling back to a normal file save keeps export usable.
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function exportPdf(document) {
  let pdf;
  const probe = new jsPDF();
  for (let index = 0; index < document.pages.length; index += 1) {
    const page = document.pages[index];
    const image = probe.getImageProperties(page.processed);
    const orientation = image.width > image.height ? 'landscape' : 'portrait';
    const format = [image.width, image.height];
    if (!pdf) pdf = new jsPDF({ orientation, unit: 'px', format, hotfixes: ['px_scaling'] });
    else pdf.addPage(format, orientation);
    pdf.addImage(page.processed, 'JPEG', 0, 0, image.width, image.height, undefined, 'FAST');
  }
  const blob = pdf.output('blob');
  await shareOrDownload(blob, `${safeName(document.name)}.pdf`, document.name);
}

export async function exportWord(document) {
  const children = [];
  for (const [index, page] of document.pages.entries()) {
    const image = await loadImage(page.processed);
    const maxWidth = 600;
    const maxHeight = 780;
    const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
    children.push(new Paragraph({
      children: [new ImageRun({ data: dataUrlToBytes(page.processed), transformation: { width: image.naturalWidth * scale, height: image.naturalHeight * scale }, type: 'jpg' })],
      pageBreakBefore: index > 0,
    }));
    if (page.ocrText) children.push(new Paragraph({ children: [new TextRun({ text: page.ocrText, color: 'FFFFFF', size: 2 })] }));
  }
  const docx = new Document({ sections: [{ properties: {}, children }] });
  const blob = await Packer.toBlob(docx);
  await shareOrDownload(blob, `${safeName(document.name)}.docx`, document.name, false);
}

export async function exportImages(doc) {
  if (doc.pages.length === 1) {
    const blob = new Blob([dataUrlToBytes(doc.pages[0].processed)], { type: 'image/jpeg' });
    await shareOrDownload(blob, `${safeName(doc.name)}.jpg`, doc.name);
    return;
  }
  const files = doc.pages.map((page, i) => new File([dataUrlToBytes(page.processed)], `${safeName(doc.name)}-${i + 1}.jpg`, { type: 'image/jpeg' }));
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files, title: doc.name }); return; }
    catch (error) { if (error.name === 'AbortError') return; }
  }
  // Fallback: save each page. Downloads are staggered so browsers do not drop
  // all but the first, and each object URL is revoked only after it is used.
  for (const [index, file] of files.entries()) {
    await new Promise((resolve) => setTimeout(resolve, index ? 350 : 0));
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = file.name; anchor.rel = 'noopener';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
