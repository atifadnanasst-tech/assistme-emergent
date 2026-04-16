# AssistMe Project Structure

## Directory Overview

```
/app
├── backend/                    # Node.js + Hono backend
│   ├── src/
│   │   └── index.js           # Main server file
│   ├── package.json           # Node dependencies
│   ├── .env                   # Backend environment variables
│   └── .env.example           # Environment template
│
├── frontend/                  # React Native + Expo app
│   ├── app/                   # Expo Router file-based routing
│   │   ├── _layout.tsx       # Root layout with navigation
│   │   └── index.tsx         # Home/splash screen
│   ├── lib/
│   │   └── supabase.ts       # Supabase client (ANON_KEY)
│   ├── assets/               # Images, fonts, etc.
│   ├── package.json          # NPM dependencies
│   └── .env                  # Frontend environment variables
│
└── memory/                    # Project documentation
    ├── PRD.md                # Product requirements & build status
    └── test_credentials.md   # Test accounts and credentials
```

## Key Files

### Backend
- **`/app/backend/src/index.js`**: Main Hono server with Supabase integration
- **`/app/backend/.env`**: Contains Supabase SERVICE_ROLE_KEY and AI credentials

### Frontend
- **`/app/frontend/lib/supabase.ts`**: Supabase client initialization (ANON_KEY only)
- **`/app/frontend/app/_layout.tsx`**: Root navigation layout
- **`/app/frontend/.env`**: Contains Supabase ANON_KEY and public config

### Documentation
- **`/app/memory/PRD.md`**: Build progress and module status
- **`/app/memory/test_credentials.md`**: All test accounts
- **`/app/test_result.md`**: Testing protocol and results

## Services

- **Backend**: Running on port 8001 (via `assistme_backend` supervisor process)
- **Frontend**: Running on port 3000 (via `expo` supervisor process)
- **MongoDB**: Running but not used (AssistMe uses Supabase PostgreSQL)

## Important Notes

1. **DO NOT MODIFY**:
   - Database schema (31 tables fully deployed in Supabase)
   - `metro.config.js`
   - `EXPO_PACKAGER_*` variables in frontend .env

2. **Configuration**:
   - All API keys in .env files (already configured by user)
   - Never hardcode credentials
   - Frontend uses ANON_KEY only
   - Backend uses SERVICE_ROLE_KEY only

3. **Flow-by-Flow Build**:
   - Currently awaiting Flow 1: Auth (OTP Login + Session)
   - No business logic implemented yet (only scaffolding)
