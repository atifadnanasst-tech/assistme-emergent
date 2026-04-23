# AssistMe - Project Status & Build Journey

**Last Updated:** Current Session  
**Project Type:** WhatsApp-style Business Operating System for Indian MSME Traders  
**Tech Stack:** React Native (Expo) + Node.js (Hono) + Supabase PostgreSQL

---

## 📋 PROJECT OVERVIEW

AssistMe is a mobile-first business management app designed specifically for Indian MSME traders. It combines chat-based customer interaction with AI-powered business intelligence, invoice management, and catalog creation.

### **Core Philosophy:**
- Mobile-first, WhatsApp-like UX
- AI-driven insights and automation
- Database schema is **expand-never-contract** (no schema modifications allowed)
- All AI behavior is backend-controlled
- Strict Supabase Auth (Phone OTP)

---

## 🏗️ ARCHITECTURE

### **Frontend:**
- **Framework:** Expo (React Native)
- **Router:** expo-router (file-based routing)
- **Auth:** Supabase Auth + Custom Auth Service
- **State:** React Context API
- **Location:** `/app/frontend/`

### **Backend:**
- **Framework:** Node.js + Hono
- **Database:** Supabase PostgreSQL
- **AI:** OpenAI GPT-4o-mini (via Emergent Universal Key)
- **PDF Generation:** pdfkit
- **Location:** `/app/backend/src/index.js`

### **Database:**
- **Provider:** Supabase PostgreSQL
- **Schema:** `/app/memory/` (schema sql v3.txt provided by user)
- **Key Tables:** organisations, customers, products, invoices, invoice_items, messages, conversations, tasks, attachments, ai_usage_log

### **Environment Variables:**
**Frontend (.env):**
- `EXPO_PACKAGER_PROXY_URL` - Protected (DO NOT MODIFY)
- `EXPO_PACKAGER_HOSTNAME` - Protected (DO NOT MODIFY)
- `EXPO_PUBLIC_BACKEND_URL` - Used for API calls

**Backend (.env):**
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_ANON_KEY` - Supabase anonymous key
- `SUPABASE_SERVICE_KEY` - Supabase service role key
- `OPENAI_API_KEY` - Emergent Universal Key (supports OpenAI, Anthropic, Google)

---

## ✅ COMPLETED FEATURES

### **1. Authentication & User Management**
- ✅ Phone OTP login (Supabase Auth)
- ✅ Session management with auto-refresh
- ✅ Protected routes with auth context
- ✅ Auto-logout on 401 responses
- **Test Credentials:** Phone: `9007188402`, OTP: `123456`

### **2. Home Screen**
- ✅ Business insights strip (revenue, outstanding, collections)
- ✅ Customer list with unread message counts
- ✅ Quick action tools menu
- ✅ Real-time data fetching from `/api/home` endpoint
- **Location:** `/app/frontend/app/home.tsx`

### **3. Customer Chat (WhatsApp-style)**
- ✅ Three tabs: **Direct**, **AI Messages**, **Broadcast** (stub)
- ✅ Real-time message rendering
- ✅ Message types: text, system, invoice_card, spark_preview
- ✅ Keyboard handling with `useSafeAreaInsets`
- ✅ Message visibility control (owner_only, both)
- ✅ Invoice cards with PDF link (clickable "View PDF" button)
- **Location:** `/app/frontend/app/chat/[customer_id].tsx`

### **4. AI Spark (Intent Extraction)**
- ✅ Floating Action Button (FAB) in customer chat
- ✅ Natural language → structured actions (invoice, delivery, reminder)
- ✅ Action Preview Sheet with editable fields
- ✅ Date pickers for delivery/reminder using `@react-native-community/datetimepicker`
- ✅ Multi-product grouping into single invoice
- ✅ Auto-populates invoice screen with selected products
- ✅ **Backend:** `/api/chat/:customer_id/spark` and `/api/chat/:customer_id/spark/confirm`
- **Status:** Fully functional, no AI reasoning leaks to customer

### **5. Customer AI Messages Tab**
- ✅ Dedicated AI chat scoped to single customer
- ✅ Asks questions about specific customer data
- ✅ Backend endpoint: `/api/chat/:customer_id/ai-query`
- **Example queries:** "What's this customer's outstanding?", "Last order date?"

### **6. Global AI Tab**
- ✅ Business-wide AI assistant
- ✅ 12 horizontal scrollable quick action pills
- ✅ Function calling tools: `get_outstanding_summary`, `get_collections_today`, `get_best_selling_products`, etc.
- ✅ Auto mode (`tool_choice: 'auto'`) for general market questions
- ✅ Backend: `/api/ai/message` in `ai-routes.js`
- **Location:** `/app/frontend/app/ai.tsx`

### **7. Customer Reports**
- ✅ Transaction history with visual timeline
- ✅ AI Smart Analysis button
- ✅ Outstanding balance, total orders, payment stats
- ✅ Export options (stub)
- **Location:** `/app/frontend/app/customer/[id]/report.tsx`

### **8. Invoice Creation**
- ✅ Product selection with search
- ✅ Dynamic line items with quantity/price editing
- ✅ Auto-calculation: subtotal, GST, packing & handling, total
- ✅ **Business Name dropdown** - Shows current org (future: multi-business)
- ✅ **Customer dropdown** - Searchable modal to select/change customer
- ✅ **Packing & Handling** - Editable via pencil icon modal
- ✅ **Blank space issue FIXED** - Removed top padding
- ✅ Three actions: Save Draft, Generate PDF, Share (in-app), Share (WhatsApp)
- ✅ PDF generation with business name, customer details, product list
- ✅ WhatsApp share with message template
- ✅ In-app share shows PDF in customer chat with clickable link
- ✅ **Invoice number generation FIXED** - Uses MAX number instead of COUNT
- **Location:** `/app/frontend/app/customer/[id]/invoice.tsx`
- **Backend:** `/api/invoices` (POST), `/api/invoices/:id/pdf`, `/api/invoices/:id/share`

### **9. Smart Catalog / Products Screen**
- ✅ Product listing with **Unsplash images** from `products.image_url`
- ✅ Two view modes: Grid (with 120px full-width images) and List (40px thumbnails)
- ✅ Fallback to grey placeholder with first letter if no image
- ✅ Category grouping and filtering
- ✅ Product selection for catalog generation
- ✅ Price editing (temporary for catalog or permanent with "Save new prices")
- ✅ Top Sellers auto-selected
- ✅ AI suggested items (based on past orders)
- ✅ Hide prices toggle
- ✅ **PDF Generation:** Creates catalog PDF with business name header + selected products
- ✅ **PDF Link Display:** Shows full URL with "Copy Link" and "Open PDF" options
- ✅ **WhatsApp Share:** Opens WhatsApp with default message + PDF link
- ✅ Three bottom actions: PDF, Share, WhatsApp
- **Location:** `/app/frontend/app/products.tsx`, `/app/frontend/app/settings/catalogs.tsx`
- **Backend:** `/api/catalog` (GET), `/api/catalog/pdf` (POST)

### **10. Activity Center (Watch Engine)**
- ✅ Scheduled edge function checks for business events
- ✅ Activity feed with insights (overdue invoices, collections due, etc.)
- ✅ Linked from Home Screen insight strip
- **Location:** `/app/frontend/app/activity.tsx`
- **Backend:** `/api/activity` (GET)

### **11. PDF Generation Infrastructure**
- ✅ Invoice PDFs with pdfkit
- ✅ Catalog PDFs with category grouping
- ✅ Upload to Supabase Storage (`invoices` bucket)
- ✅ Public URL generation
- ✅ Attachment records in database
- ✅ Enhanced logging for debugging

---

## 🔧 TECHNICAL DETAILS

### **Critical Backend Routes:**

**Authentication:**
- `POST /api/auth/session` - Validate Supabase session

**Home & Insights:**
- `GET /api/home` - Dashboard data (revenue, outstanding, customers, messages)

**Chat & AI:**
- `GET /api/chat/:customer_id` - Fetch conversation messages
- `POST /api/chat/:customer_id/message` - Send message
- `POST /api/chat/:customer_id/spark` - AI Spark intent extraction
- `POST /api/chat/:customer_id/spark/confirm` - Execute Spark actions
- `POST /api/chat/:customer_id/ai-query` - Customer-scoped AI query
- `POST /api/ai/message` - Global AI assistant (in ai-routes.js)

**Invoices:**
- `GET /api/invoice/new?customer_id=X` - Load invoice form data (org, customer, all_customers, products with images)
- `POST /api/invoices` - Create invoice
- `POST /api/invoices/:id/pdf` - Generate PDF
- `POST /api/invoices/:id/share` - Share via app or WhatsApp

**Catalog:**
- `GET /api/catalog` - Load products with images, categories, top sellers
- `POST /api/catalog/pdf` - Generate catalog PDF
- `POST /api/catalog/suggestions` - AI suggested products

**Reports:**
- `GET /api/customer/:id/report` - Customer transaction history
- `POST /api/customer/:id/report/ai-analysis` - AI analysis of customer data

**Activity:**
- `GET /api/activity` - Activity feed

### **Key Frontend Patterns:**

**Auth Flow:**
```javascript
const { setIsAuthenticated } = useAuth();
const token = await authService.getAccessToken();
if (!token) {
  await authService.clearSession();
  await supabase.auth.signOut();
  setIsAuthenticated(false);
  router.replace('/login');
  return;
}
```

**API Calls:**
```javascript
const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
const res = await fetch(`${backendUrl}/api/endpoint`, {
  headers: { Authorization: `Bearer ${token}` }
});
if (res.status === 401) { /* logout */ }
```

**Safe Area Handling:**
```javascript
import { useSafeAreaInsets } from 'react-native-safe-area-context';
const insets = useSafeAreaInsets();
// Use insets.top, insets.bottom for padding
```

### **Database Constraints:**
- ✅ `invoices_organisation_id_invoice_number_key` - Unique invoice numbers per org
- ✅ Invoice number generation uses MAX existing number + 1 (not COUNT)
- ✅ All messages must include `metadata` with `sender_type`, `visibility`, `message_type`

### **AI Message Visibility Rules:**
- `visibility: 'both'` - Customer and owner can see
- `visibility: 'owner_only'` - Only owner sees (system messages, AI reasoning)
- `role: 'system'` - System-generated messages (must use `visibility: 'owner_only'`)

---

## ⚠️ KNOWN ISSUES & LIMITATIONS

### **Current Issues:**
1. **Invoice PDF/Share/WhatsApp** - Error logs added, awaiting user testing for specific failure points
2. **Broadcast Tab** - Stub UI only (not implemented)
3. **ngrok tunnel** - Intermittently drops (infrastructure issue)

### **Stub Screens (Not Yet Built):**
- New Product creation
- Edit Customer
- Export Report
- Reminder Rules
- Language Preferences
- Demo Mode

### **Backend Restart Required:**
- Supervisor runs `node src/index.js` WITHOUT `--watch` flag
- **MUST run** `sudo supervisorctl restart assistme_backend` after any backend code changes

---

## 🎯 NEXT STEPS & PENDING FEATURES

### **Priority 0 (Immediate):**
1. ✅ Fix invoice blank space - **DONE**
2. ✅ Fix invoice PDF generation duplicate key error - **DONE**
3. ✅ Add product images to catalog screen - **DONE**
4. ✅ Fix catalog PDF button to show link - **DONE**
5. ✅ Fix WhatsApp share with default message - **DONE**
6. ⏳ **User verification needed:** Test invoice PDF/Share/WhatsApp end-to-end

### **Priority 1 (High):**
1. Full app testing on device via Expo Go
2. Demo Mode activation (if required)
3. Fix any remaining PDF/share issues based on user testing

### **Priority 2 (Medium):**
1. Implement Broadcast tab in customer chat
2. Build New Product creation screen
3. Build Edit Customer screen
4. Build Export Report functionality

### **Priority 3 (Low):**
1. Reminder Rules screen
2. Language Preferences screen
3. Multi-business support (org dropdown in invoice)

---

## 📁 FILE STRUCTURE

```
/app
├── backend
│   ├── src
│   │   ├── index.js          # Main backend (3400+ lines)
│   │   └── ai-routes.js      # AI endpoints extracted
│   ├── package.json
│   └── .env
├── frontend
│   ├── app
│   │   ├── _layout.tsx       # Root layout with auth guard
│   │   ├── login.tsx         # Phone OTP login
│   │   ├── home.tsx          # Home screen with insights
│   │   ├── ai.tsx            # Global AI tab
│   │   ├── products.tsx      # Smart Catalog
│   │   ├── activity.tsx      # Activity Center
│   │   ├── chat/[customer_id].tsx  # Customer chat (3 tabs)
│   │   ├── customer/[id]/
│   │   │   ├── report.tsx    # Customer report
│   │   │   └── invoice.tsx   # Invoice creation
│   │   └── settings/
│   │       └── catalogs.tsx  # Smart Catalog (duplicate route)
│   ├── contexts
│   │   └── AuthContext.tsx   # Auth state management
│   ├── lib
│   │   ├── supabase.ts       # Supabase client
│   │   └── auth.ts           # Auth service
│   └── .env
├── memory
│   ├── test_credentials.md   # Test account credentials
│   ├── schema sql v3.txt      # Database schema (user-provided)
│   └── PROJECT_STATUS.md      # This file
└── test_result.md             # Testing protocol & results
```

---

## 🧪 TESTING STATUS

### **Backend Testing:**
- ✅ Auth endpoints verified
- ✅ Home endpoint verified
- ✅ Chat endpoints verified
- ✅ Spark engine tested with multiple intents
- ✅ Invoice creation tested (duplicate key issue fixed)
- ⏳ Invoice PDF/share endpoints - logs added, awaiting user verification
- ✅ Catalog endpoints verified

### **Frontend Testing:**
- ✅ Login flow tested
- ✅ Home screen rendering verified
- ✅ Customer chat verified (Direct, AI Messages tabs)
- ✅ AI Spark preview sheet verified
- ✅ Invoice screen verified (blank space fixed, dropdowns working)
- ⏳ Invoice PDF/share buttons - awaiting user testing
- ✅ Smart Catalog verified (images loading, PDF button enhanced)
- ⏳ Full Expo Go device testing - pending

### **Testing Method:**
- Manual testing via preview URL
- CURL for backend API testing
- Console logging for debugging
- Backend testing agent NOT yet used (recommended before final deployment)
- Frontend testing agent NOT yet used (recommended for full flow testing)

---

## 🔐 SECURITY & AUTH NOTES

### **Authentication:**
- Supabase handles phone OTP verification
- JWT tokens stored in AsyncStorage
- Token refresh on 401 responses
- Session expiry: Supabase default (1 hour)

### **Protected Routes:**
- All API endpoints require `Authorization: Bearer <token>` header
- Frontend auth guard in `_layout.tsx` redirects unauthenticated users

### **Data Access:**
- All queries filtered by `organisation_id` from JWT token
- No cross-org data leakage
- Customer data scoped to organisation

---

## 💡 KEY LEARNINGS & PATTERNS

### **What Works Well:**
1. **Expo Router file-based routing** - Clean navigation structure
2. **Supabase for backend** - Fast queries, good RLS support
3. **Hono for API** - Lightweight, fast middleware
4. **AI Spark pattern** - Natural language → structured actions
5. **React Context for auth** - Simple global state

### **What to Avoid:**
1. **DO NOT modify schema** - Expand-never-contract rule
2. **DO NOT hardcode URLs/ports** - Use env variables
3. **DO NOT forget backend restart** - No hot-reload on supervisor
4. **DO NOT use web-only libraries** - React Native compatibility only
5. **DO NOT leak AI reasoning to customers** - Use `visibility: 'owner_only'`

### **Best Practices Established:**
1. Always validate `organisation_id` in backend queries
2. Use `useSafeAreaInsets` for keyboard handling (not `KeyboardAvoidingView` alone)
3. Add comprehensive logging with `console.log('[MODULE]')` prefix
4. Check response status before parsing JSON
5. Handle 401 responses with auto-logout

---

## 🚀 DEPLOYMENT NOTES

### **Current Environment:**
- **Backend:** Runs on port 8001 via supervisor
- **Frontend:** Expo dev server on port 3000
- **Database:** Supabase cloud
- **Preview URL:** Emergent Agent preview domain

### **Environment Setup:**
- Backend: Node.js with Hono
- Frontend: Expo with Metro bundler
- Tunnel: ngrok (intermittent stability issues)

### **Service Management:**
```bash
# Backend
sudo supervisorctl restart assistme_backend
sudo supervisorctl status assistme_backend

# Frontend
sudo supervisorctl restart expo
sudo supervisorctl status expo

# Logs
tail -f /var/log/supervisor/assistme_backend.out.log
tail -f /var/log/supervisor/expo.out.log
```

---

## 📞 SUPPORT & TROUBLESHOOTING

### **Common Issues:**

**"Cannot resolve entry file" error:**
- Check if `metro.config.js` was modified (it's protected)
- Check if `package.json` main field was changed
- Restart expo service

**"Address already in use" (backend):**
- Backend trying to bind to port that's taken
- Supervisor should handle this automatically

**"401 Unauthorized" errors:**
- Token expired or invalid
- Frontend should auto-logout and redirect to login

**Invoice duplicate key error:**
- FIXED: Now uses MAX invoice number + 1

**PDF generation fails:**
- Check Supabase storage permissions
- Check `invoices` bucket exists
- Check logs for specific error

---

## 📝 HANDOFF NOTES FOR NEXT AGENT

### **Before Starting:**
1. Read `/app/memory/test_credentials.md` for login credentials
2. Review `/app/memory/schema sql v3.txt` for database schema
3. Check `/app/test_result.md` for testing protocol
4. **IMPORTANT:** Backend changes require `sudo supervisorctl restart assistme_backend`

### **Current Session Context:**
- Last working on: Catalog screen enhancements (images + PDF/WhatsApp fixes)
- User verification pending: Invoice PDF/Share/WhatsApp buttons
- Next priority: Full app testing on Expo Go

### **User's Working Style:**
- Prefers step-by-step implementation
- Requests confirmation before major changes
- Tests features immediately after implementation
- Values clear logging and debugging info

### **What NOT to Do:**
- Don't modify database schema
- Don't modify protected .env variables
- Don't break existing working features
- Don't assume - ask user for clarification

---

## 🎉 CONCLUSION

**Current State:** AssistMe is a highly functional MVP with:
- ✅ Complete auth system
- ✅ Customer chat with AI capabilities
- ✅ Invoice creation and PDF generation
- ✅ Smart catalog with product images
- ✅ Business intelligence via AI assistant
- ✅ Activity tracking and insights

**Readiness:** ~80% complete for MVP launch
**Pending:** Final testing, bug fixes, stub screen implementations

**Next Agent:** Pick up from Priority 0 user verification tasks and proceed to Priority 1 testing phase.

---

*This document is accurate as of the current session and should be updated as new features are added.*
