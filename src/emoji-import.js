import { inflateRawSync } from "node:zlib";

const IMAGE_EXTENSIONS = new Set([".png", ".gif", ".jpg", ".jpeg"]);
const MAX_ARCHIVE_ENTRIES = 100;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 15 * 1024 * 1024;
const MAX_EMOJI_BYTES = 256 * 1024;

function extensionOf(filename) {
  const name = String(filename || "").split(/[\\/]/).pop() || "";
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "";
}

export function emojiNameFromFilename(filename) {
  const base = String(filename || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const name = stem.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 32);
  return /^[A-Za-z0-9_]{2,32}$/.test(name) ? name : null;
}

export function extractSingleEmojiFile(filename, data) {
  const extension = extensionOf(filename);
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error("File harus berekstensi .png, .gif, .jpg, atau .jpeg.");
  }
  const buffer = Buffer.from(data);
  if (!buffer.length || buffer.length > MAX_EMOJI_BYTES) {
    throw new Error("Ukuran gambar emoji harus 1 byte sampai 256 KiB.");
  }
  const name = emojiNameFromFilename(filename);
  if (!name) {
    throw new Error("Nama file harus menghasilkan nama emoji 2–32 karakter (huruf, angka, garis bawah).");
  }
  return [{ name, filename: String(filename), data: buffer }];
}

export function extractEmojiFilesFromZip(data) {
  const archive = Buffer.from(data);
  const minimumEocdSize = 22;
  const searchStart = Math.max(0, archive.length - 22 - 0xffff);
  let eocdOffset = -1;
  for (let offset = archive.length - minimumEocdSize; offset >= searchStart; offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("File ZIP tidak valid atau tidak didukung.");

  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new Error("ZIP berisi terlalu banyak file. Maksimal 100 entri.");
  }
  if (entryCount === 0) throw new Error("ZIP tidak berisi file emoji.");

  const results = [];
  const skipped = [];
  let cursor = centralDirectoryOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Struktur ZIP tidak valid.");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const filenameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const filenameStart = cursor + 46;
    const filenameEnd = filenameStart + filenameLength;
    if (filenameEnd > archive.length) throw new Error("Nama file ZIP terpotong.");

    const filename = archive.toString("utf8", filenameStart, filenameEnd);
    cursor = filenameEnd + extraLength + commentLength;
    const normalizedPath = filename.replace(/\\/g, "/");
    const basename = normalizedPath.split("/").pop() || "";
    if (!basename || normalizedPath.endsWith("/")) continue;
    if (!IMAGE_EXTENSIONS.has(extensionOf(basename))) {
      skipped.push(basename + ": bukan file gambar yang didukung");
      continue;
    }
    if (flags & 0x1) {
      skipped.push(basename + ": ZIP terenkripsi tidak didukung");
      continue;
    }
    if (uncompressedSize > MAX_EMOJI_BYTES) {
      skipped.push(basename + ": ukuran lebih dari 256 KiB");
      continue;
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error("Total ukuran gambar hasil ekstraksi ZIP melebihi 15 MiB.");
    }
    if (localHeaderOffset + 30 > archive.length || archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      skipped.push(basename + ": header file ZIP tidak valid");
      continue;
    }
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd > archive.length) {
      skipped.push(basename + ": data file ZIP terpotong");
      continue;
    }

    try {
      const compressed = archive.subarray(dataStart, dataEnd);
      let imageData;
      if (method === 0) imageData = Buffer.from(compressed);
      else if (method === 8) imageData = inflateRawSync(compressed, { maxOutputLength: MAX_EMOJI_BYTES });
      else {
        skipped.push(basename + ": metode kompresi ZIP tidak didukung");
        continue;
      }
      if (imageData.length !== uncompressedSize || imageData.length === 0 || imageData.length > MAX_EMOJI_BYTES) {
        skipped.push(basename + ": ukuran hasil ekstraksi tidak valid");
        continue;
      }
      const name = emojiNameFromFilename(basename);
      if (!name) {
        skipped.push(basename + ": nama emoji harus 2–32 karakter");
        continue;
      }
      results.push({ name, filename: basename, data: imageData });
    } catch {
      skipped.push(basename + ": gagal mengekstrak gambar");
    }
  }

  if (!results.length) throw new Error("Tidak ada gambar emoji valid di ZIP. " + skipped.slice(0, 5).join("; "));
  return { files: results.slice(0, 50), skipped, totalEntries: entryCount };
}
