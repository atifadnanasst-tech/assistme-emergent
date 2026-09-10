/**
 * AssistMe — productImport.js
 * Location: /backend/src/services/business/productImport.js
 * Created: Session H, Jun 2026
 *
 * PURPOSE: AI-native product catalog import engine.
 *   extractProductsFromFiles() — GPT-4o extraction from images + PDFs
 *   resolveImportedProducts()  — SKU + name resolution against existing catalog
 *   confirmImportedProducts()  — bulk create/update + alias learning
 *
 * MODEL TIERING:
 *   tajir / business plan → gpt-4o
 *   all others            → gpt-4o-mini
 *
 * FIELDS PERSISTED:
 *   products columns: name, sku, description, category, unit, selling_price, cost_price, tax_rate
 *   custom_fields:    hsn_code, brand, discount_pct (merge — never replaces existing keys)
 */

import { resolveProduct, learnVocabularyAliases } from './prepareTransactionDocument.js';
import { createProduct, updateProduct } from './productMutations.js';

const MAX_IMPORTED_PRODUCTS = 500;
const MAX_IMPORTED_FILES = 10;

const PRODUCT_IMPORT_PROMPT = `You are extracting product catalog data from a business document.
Extract every product visible in the source. For each product, extract all available fields.
Also extract the supplier/vendor name if visible (e.g. on a letterhead, header, or "From:" line) -- this is a SINGLE document-level fact, not per-product.
Return a JSON object only -- no explanation, no markdown, no preamble.

Shape:
{
  "supplier_name": string|null,
  "products": [ { ...one object per product, schema below... } ]
}

Schema per product (use null for missing fields):
{
  "name": string,
  "sku": string|null,
  "category": string|null,
  "unit": string|null,
  "selling_price": number|null,
  "cost_price": number|null,
  "tax_rate": number|null,
  "discount_pct": number|null,
  "hsn_code": string|null,
  "brand": string|null,
  "description": string|null,
  "quantity": number|null
}

Rules:
- Extract ONLY what is explicitly visible. Never hallucinate.
- If price appears without label, treat as selling_price.
- Unit examples: pcs, kg, ml, box, dozen, set, ltr.
- SKU: any alphanumeric code that appears to be a product code.
- quantity: how many units are being received/listed, if a quantity column or count is visible (e.g. on a purchase bill or stock sheet). Never guess -- null if not shown.
- supplier_name: the vendor/supplier's own business name if printed on the document, not anything we would generate. Never guess -- null if not visible.
- Return "products": [] if no products found.
- Return only the JSON object described above.`;

export function getImportModelForPlan(plan) {
  return (plan === 'business' || plan === 'tajir') ? 'gpt-4o' : 'gpt-4o-mini';
}

export async function extractProductsFromFiles({ files, client, plan }) {
  const importModel = getImportModelForPlan(plan);
  const allExtracted = [];
  let usedFallback = false;
  const uploadedFileIds = [];
  let detectedSupplierName = null;

  for (const file of files.slice(0, MAX_IMPORTED_FILES)) {
    try {
      const isImage = file.mime_type?.startsWith('image/');
      const isPDF = file.mime_type === 'application/pdf';
      let messages;

      if (isImage) {
        messages = [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: file.url, detail: 'high' } },
            { type: 'text', text: PRODUCT_IMPORT_PROMPT }
          ]
        }];
      } else if (isPDF) {
        try {
          const pdfRes = await fetch(file.url);
          if (!pdfRes.ok) throw new Error('Failed to fetch PDF');
          const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
          const { toFile } = await import('openai');
          const uploadedFile = await client.files.create({
            file: await toFile(pdfBuffer, file.name || 'catalog.pdf', { type: 'application/pdf' }),
            purpose: 'user_data',
          });
          uploadedFileIds.push(uploadedFile.id);
          messages = [{
            role: 'user',
            content: [
              { type: 'file', file: { file_id: uploadedFile.id } },
              { type: 'text', text: PRODUCT_IMPORT_PROMPT }
            ]
          }];
        } catch (pdfErr) {
          usedFallback = true;
          console.warn('[productImport] PDF processing failed:', pdfErr.message);
          continue;
        }
      } else {
        continue;
      }

      const res = await client.chat.completions.create({
        model: importModel,
        messages,
        max_tokens: 4000,
        temperature: 0.1,
      });

      const raw = res.choices?.[0]?.message?.content?.trim() || '{}';
      const clean = raw.replace(/```json|```/g, '').trim();
      let parsed = {};
      try { parsed = JSON.parse(clean); } catch { parsed = {}; }
      const extracted = Array.isArray(parsed.products) ? parsed.products : [];
      // First file to name a supplier wins -- an import batch is
      // treated as one cohesive vendor, matching how the review sheet
      // presents a single batch-level vendor field, not one per file.
      if (!detectedSupplierName && parsed.supplier_name?.trim()) {
        detectedSupplierName = parsed.supplier_name.trim();
      }

      for (const p of extracted) {
        if (!p.name?.trim()) continue;
        allExtracted.push({ ...p, _source_file: file.name || 'unknown' });
      }
    } catch (fileErr) {
      console.error('[productImport] file error:', fileErr.message);
    }
  }

  for (const fid of uploadedFileIds) {
    try { await client.files.delete(fid); } catch {}
  }

  const seenSku = new Set();
  const seenKey = new Set();
  const deduped = allExtracted.filter(p => {
    if (p.sku) {
      const skuKey = p.sku.trim().toLowerCase();
      if (seenSku.has(skuKey)) return false;
      seenSku.add(skuKey);
      return true;
    }
    const nameKey = [
      (p.name || '').toLowerCase().trim().replace(/\s+/g, ' '),
      (p.unit || '').toLowerCase().trim(),
      (p.brand || '').toLowerCase().trim(),
    ].join('|');
    if (seenKey.has(nameKey)) return false;
    seenKey.add(nameKey);
    return true;
  });

  if (deduped.length > MAX_IMPORTED_PRODUCTS) deduped.splice(MAX_IMPORTED_PRODUCTS);

  return { products: deduped, totalExtracted: allExtracted.length, usedFallback, importModel, detectedSupplierName };
}

export async function resolveImportedProducts({ products, organisationId, supabase }) {
  let totalResolved = 0, totalNew = 0, totalFuzzy = 0;

  const resolved = await Promise.all(products.map(async (p) => {
    if (p.sku) {
      const { data: skuMatch } = await supabase.from('products')
        .select('id, name, selling_price, cost_price, tax_rate, category, sku')
        .eq('organisation_id', organisationId).eq('sku', p.sku.trim()).eq('is_active', true)
        .maybeSingle();
      if (skuMatch) {
        totalResolved++;
        return { ...p, resolution_status: 'existing', confidence: 1.0, matched_product: skuMatch, resolution_type: 'sku' };
      }
    }

    const result = await resolveProduct({ productName: p.name, customerId: null, organisationId, supabase });
    if (result.resolution_type === 'exact' || result.resolution_type === 'vocabulary') {
      totalResolved++;
      return { ...p, resolution_status: 'existing', confidence: result.resolution_type === 'exact' ? 1.0 : 0.9, matched_product: result.resolved, resolution_type: result.resolution_type };
    } else if (result.resolution_type === 'fuzzy') {
      totalFuzzy++;
      return { ...p, resolution_status: 'fuzzy', confidence: result.confidence, matched_product: result.resolved, resolution_type: 'fuzzy' };
    } else {
      totalNew++;
      return { ...p, resolution_status: 'new', confidence: 0.95, matched_product: null, resolution_type: 'unresolved' };
    }
  }));

  return { resolved, totalResolved, totalNew, totalFuzzy };
}

export async function confirmImportedProducts({ items, organisationId, supabase, vendorId }) {
  let created = 0, updated = 0, skipped = 0, quantityAdded = 0;
  const errors = [];
  const aliasItems = [];

  for (const item of items) {
    if (item.action === 'skip') { skipped++; continue; }
    const d = item.product_data;
    const importQuantity = Number(d.quantity) || 0;

    const customFields = {};
    if (d.hsn_code) customFields.hsn_code = d.hsn_code;
    if (d.brand) customFields.brand = d.brand;
    if (d.discount_pct) customFields.discount_pct = d.discount_pct;

    const data = {
      name: d.name,
      sku: d.sku || undefined,
      description: d.description || undefined,
      sellingPrice: d.selling_price ?? 0,
      costPrice: d.cost_price ?? 0,
      taxRate: d.tax_rate ?? 0,
      category: d.category || null,
      unit: d.unit || 'pcs',
      customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
    };

    let result;
    if (item.action === 'create') {
      result = await createProduct(supabase, organisationId, data);
      if (result.status === 'success') {
        created++;
        if (item.original_name && item.original_name !== d.name)
          aliasItems.push({ product_id: result.product.id, raw_product_name: item.original_name, product_name: d.name });
        // Starting stock (Sept 2026, basic inventory module) -- a
        // brand-new product from import, same as any other creation
        // path: always an increment from zero, never an overwrite.
        if (importQuantity > 0) {
          const { adjustInventory } = await import('./adjustInventory.js');
          const invResult = await adjustInventory({
            supabase, organisationId, productId: result.product.id, delta: importQuantity, vendorId,
            referenceType: 'manual_stock_entry', notes: 'Starting stock from catalog import',
          });
          if (invResult.status === 'success') quantityAdded += importQuantity;
        }
      } else { errors.push({ name: d.name, error: result.error, message: result.message }); }
    } else if (item.action === 'update' && item.matched_id) {
      result = await updateProduct(supabase, organisationId, item.matched_id, data);
      if (result.status === 'success') {
        updated++;
        if (item.original_name && item.original_name !== d.name)
          aliasItems.push({ product_id: item.matched_id, raw_product_name: item.original_name, product_name: d.name });
        // Existing product matched during import: every OTHER field
        // above already went through updateProduct() as a normal
        // overwrite (new price replaces old price, etc). Quantity is
        // deliberately never part of that `data` object and never
        // overwritten -- it's always an ADDITIVE increment via
        // adjustInventory(), on top of whatever stock already exists.
        if (importQuantity > 0) {
          const { adjustInventory } = await import('./adjustInventory.js');
          const invResult = await adjustInventory({
            supabase, organisationId, productId: item.matched_id, delta: importQuantity, vendorId,
            referenceType: 'manual_stock_entry', notes: 'Stock added via catalog import',
          });
          if (invResult.status === 'success') quantityAdded += importQuantity;
        }
      } else { errors.push({ name: d.name, error: result.error, message: result.message }); }
    }
  }

  if (aliasItems.length > 0)
    await learnVocabularyAliases({ supabase, organisationId, items: aliasItems });

  return { created, updated, skipped, quantityAdded, errors };
}
