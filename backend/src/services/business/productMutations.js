/**
 * AssistMe — productMutations.js
 * Location: /backend/src/services/business/productMutations.js
 * Created: Session G, Jun 2026
 *
 * PURPOSE: Product persistence primitives — create, update, archive, restore.
 *          Separation of concerns:
 *            Resolution  → prepareTransactionDocument.resolveProduct()
 *            Persistence → this file
 *
 * CONSUMERS (current):
 *   POST /api/products         → createProduct()
 *   PATCH /api/products/:id    → updateProduct() / archiveProduct() / restoreProduct()
 *
 * CONSUMERS (planned):
 *   Import Products → resolveProduct() [caller] + createProduct() or updateProduct()
 *   Spark Catalog   → resolveProduct() [caller] + createProduct() or updateProduct()
 *
 * RETURN SHAPE (all functions):
 *   { status: "success", operation: "create"|"update"|"archive"|"restore", product? }
 *   { status: "failed", error: string, message?: string }
 */

export async function createProduct(supabase, orgId, data) {
  try {
    const { name, sellingPrice, taxRate = 0, category = null, costPrice = 0, unit = "pcs", sku, description, customFields } = data;
    if (!name?.trim()) return { status: "failed", error: "name_required" };
    if (sellingPrice == null || Number(sellingPrice) < 0) return { status: "failed", error: "invalid_selling_price" };
    const insertRow = {
      organisation_id: orgId,
      name: name.trim(),
      selling_price: Number(sellingPrice),
      cost_price: Number(costPrice) || 0,
      tax_rate: Number(taxRate) || 0,
      category: category?.trim() || null,
      unit: unit?.trim() || "pcs",
      is_active: true,
      custom_fields: customFields || {},
    };
    if (sku) insertRow.sku = sku.trim();
    if (description) insertRow.description = description.trim();
    const { data: product, error } = await supabase.from("products").insert(insertRow).select("id, name, selling_price, cost_price, tax_rate, category, unit, is_active, sku, description").single();
    if (error?.code === "23505") return { status: "failed", error: "sku_conflict", message: "A product with this SKU already exists." };
    if (error) { console.error("[createProduct]", error.message); return { status: "failed", error: "db_error", message: error.message }; }
    console.log("[createProduct] Created:", product.id, product.name);
    return { status: "success", operation: "create", product };
  } catch (err) {
    console.error("[createProduct]", err.message);
    return { status: "failed", error: "server_error", message: err.message };
  }
}

export async function updateProduct(supabase, orgId, productId, data) {
  try {
    const updates = {};
    if (data.name !== undefined) {
      if (!data.name.trim()) return { status: "failed", error: "name_required" };
      updates.name = data.name.trim();
    }
    if (data.sellingPrice !== undefined) {
      if (Number(data.sellingPrice) < 0) return { status: "failed", error: "invalid_selling_price" };
      updates.selling_price = Number(data.sellingPrice);
    }
    if (data.costPrice !== undefined) {
      if (Number(data.costPrice) < 0) return { status: "failed", error: "invalid_cost_price" };
      updates.cost_price = Number(data.costPrice);
    }
    if (data.taxRate !== undefined) {
      const tr = Number(data.taxRate);
      if (tr < 0 || tr > 100) return { status: "failed", error: "invalid_tax_rate" };
      updates.tax_rate = tr;
    }
    if (data.category !== undefined) updates.category = data.category?.trim() || null;
    if (data.unit !== undefined) updates.unit = data.unit?.trim() || "pcs";
    if (data.sku !== undefined) updates.sku = data.sku?.trim() || null;
    if (data.description !== undefined) updates.description = data.description?.trim() || null;
    if (data.customFields && Object.keys(data.customFields).length > 0) {
      const { data: existing } = await supabase.from("products").select("custom_fields").eq("id", productId).single();
      updates.custom_fields = { ...(existing?.custom_fields || {}), ...data.customFields };
    }
    if (Object.keys(updates).length === 0) return { status: "failed", error: "no_fields" };
    const { data: product, error } = await supabase.from("products").update(updates)
      .eq("id", productId).eq("organisation_id", orgId)
      .select("id, name, selling_price, cost_price, tax_rate, category, unit, is_active").single();
    if (error) { console.error("[updateProduct]", error.message); return { status: "failed", error: "db_error", message: error.message }; }
    console.log("[updateProduct] Updated:", productId, Object.keys(updates));
    return { status: "success", operation: "update", product };
  } catch (err) {
    console.error("[updateProduct]", err.message);
    return { status: "failed", error: "server_error", message: err.message };
  }
}

export async function archiveProduct(supabase, orgId, productId) {
  try {
    const { error } = await supabase.from("products")
      .update({ is_active: false, deleted_at: new Date().toISOString() })
      .eq("id", productId).eq("organisation_id", orgId);
    if (error) { console.error("[archiveProduct]", error.message); return { status: "failed", error: "db_error" }; }
    console.log("[archiveProduct] Archived:", productId);
    return { status: "success", operation: "archive" };
  } catch (err) {
    console.error("[archiveProduct]", err.message);
    return { status: "failed", error: "server_error" };
  }
}

export async function restoreProduct(supabase, orgId, productId) {
  try {
    const { error } = await supabase.from("products")
      .update({ is_active: true, deleted_at: null })
      .eq("id", productId).eq("organisation_id", orgId);
    if (error) { console.error("[restoreProduct]", error.message); return { status: "failed", error: "db_error" }; }
    console.log("[restoreProduct] Restored:", productId);
    return { status: "success", operation: "restore" };
  } catch (err) {
    console.error("[restoreProduct]", err.message);
    return { status: "failed", error: "server_error" };
  }
}
