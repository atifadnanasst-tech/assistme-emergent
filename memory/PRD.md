# AssistMe — Product Requirements Document

## Overview
AssistMe is a WhatsApp-style business operating system for Indian MSME traders. This document tracks the implementation of each flow.

## Tech Stack
- **Frontend**: React Native + Expo (iOS + Android)
- **Backend**: Node.js + Hono
- **Database**: Supabase PostgreSQL (31 tables, fully deployed)
- **Auth**: Supabase Auth (Phone OTP via Twilio)
- **AI**: Switchable (Anthropic/OpenAI) via AI_PROVIDER env var

## Build Status

### ✅ Base Scaffolding (Complete)
- Backend: Node.js + Hono + Supabase client
- Frontend: React Native + Expo + Supabase client
- Navigation shell with expo-router
- Environment configuration structure

### 🚧 Flow 1: Auth (OTP Login + Session) - IN PROGRESS
**Status**: Implementation complete, awaiting testing

**What's Built**:
- ✅ Login screen with phone input (+91 prefix)
- ✅ OTP verification screen with 6-box input
- ✅ Supabase Auth integration (signInWithOtp, verifyOtp)
- ✅ SecureStore for secure token storage
- ✅ Backend POST /api/auth/setup-session endpoint
- ✅ Token validation with Supabase Admin SDK
- ✅ Atomic user + organisation creation
- ✅ System tags seeding (6 tags with is_system=true)
- ✅ Session management and navigation
- ✅ Auto-verify when OTP boxes filled
- ✅ Resend OTP with timer (28 seconds)
- ✅ Error handling for wrong/expired OTP
- ✅ Session check on app launch

**Testing Pending**:
- Phone number validation
- OTP send/verify flow
- Backend setup-session endpoint
- System tags creation
- Navigation flow (login → OTP → home)
- Session persistence
- Error states

---

## Implementation Log

### 2025-01-XX: Base Project Scaffolding
- Converted backend from FastAPI+MongoDB to Node.js+Hono+Supabase
- Initialized Supabase clients (frontend with ANON_KEY, backend with SERVICE_ROLE_KEY)
- Set up expo-router navigation structure
- Created placeholder screens and API endpoints
- Ready for Flow 1 implementation
