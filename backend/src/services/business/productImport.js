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
Return a JSON array only — no explanation, no markdown, no preamble.

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
  "description": string|null
}

Rules:
- Extract ONLY what is explicitly visible. Never hallucinate.
- If price appears without label, treat as selling_price.
- Unit examples: pcs, kg, ml, box, dozen, set, ltr.
- SKU: any alphanumeric code that appears to be a product code.
- Return [] if no products found.
- Return only the JSON array.`;

export function getImportModelForPlan(plan) {
  return (plan === 'business' || plan === 'tajir') ? 'gpt-4o' : 'gpt-4o-mini';
}

export async function extractProductsFromFiles({ files, client, plan }) {
  const importModel = getImportModelForPlan(plan);
  const allExtracted = [];
  let usedFallback = false;
  const uploadedFileIds = [];

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

      const raw = res.choices?.[0]?.message?.content?.trim() || '[]';
      const clean = raw.replace(/```json|```/g, '').trim();
      let extracted = [];
      try { extracted = JSON.parse(clean); } catch { extracted = []; }

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

  return { products: deduped, totalExtracted: allExtracted.length, usedFallback, importModel };
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

export async function confirmImportedProducts({ items, organisationId, supabase }) {
  let created = 0, updated = 0, skipped = 0;
  const errors = [];
  const aliasItems = [];

  for (const item of items) {
    if (item.action === 'skip') { skipped++; continue; }
    const d = item.product_data;

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
      } else { errors.push({ name: d.name, error: result.error, message: result.message }); }
    } else if (item.action === 'update' && item.matched_id) {
      result = await updateProduct(supabase, organisationId, item.matched_id, data);
      if (result.status === 'success') {
        updated++;
        if (item.original_name && item.original_name !== d.name)
          aliasItems.push({ product_id: item.matched_id, raw_product_name: item.original_name, product_name: d.name });
      } else { errors.push({ name: d.name, error: result.error, message: result.message }); }
    }
  }

  if (aliasItems.length > 0)
    await learnVocabularyAliases({ supabase, organisationId, items: aliasItems });

  return { created, updated, skipped, errors };
}
