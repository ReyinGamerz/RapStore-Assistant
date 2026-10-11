/**
 * Parse a UTF-8 CSV file with a header row.
 * Required columns: name, price, category. Optional: emoji, description.
 */
export function parseProductCsv(input, { maxRows = 500 } = {}) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ",") { row.push(field.trim()); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim()); field = "";
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
      if (rows.length > maxRows + 1) throw new Error("CSV melebihi batas " + maxRows + " produk.");
    } else field += ch;
  }
  if (quoted) throw new Error("CSV tidak valid: ada tanda kutip yang belum ditutup.");
  if (field.length || row.length) { row.push(field.trim()); if (row.some(value => value !== "")) rows.push(row); }
  if (rows.length < 2) throw new Error("CSV harus berisi header dan minimal satu baris produk.");
  if (rows.length - 1 > maxRows) throw new Error("Maksimal " + maxRows + " produk per import.");

  const headers = rows.shift().map(value => value.toLowerCase().replace(/^\uFEFF/, ""));
  const index = Object.fromEntries(headers.map((header, i) => [header, i]));
  for (const required of ["name", "price", "category"]) {
    if (index[required] === undefined) throw new Error('Kolom wajib "' + required + '" tidak ditemukan.');
  }
  const products = rows.map((values, i) => {
    const get = key => index[key] === undefined ? "" : String(values[index[key]] ?? "").trim();
    const name = get("name");
    const priceText = get("price").replace(/^Rp\s*/i, "").replace(/\./g, "").replace(/,/g, "").replace(/\s/g, "");
    const price = Number(priceText);
    const category = get("category");
    if (!name || name.length > 100) throw new Error("Baris " + (i + 2) + ": nama wajib diisi dan maksimal 100 karakter.");
    if (!/^\d+$/.test(priceText) || !Number.isSafeInteger(price) || price < 1) throw new Error("Baris " + (i + 2) + ": harga harus angka Rupiah positif (contoh 12500).");
    if (!category || category.length > 80) throw new Error("Baris " + (i + 2) + ": kategori wajib diisi dan maksimal 80 karakter.");
    return { name, price, category, emoji: get("emoji"), description: get("description") };
  });
  return products;
}
