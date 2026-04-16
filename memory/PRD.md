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

### ⏳ Flow 1: Auth (OTP Login + Session)
**Status**: Awaiting flow prompt

**Requirements Summary**:
- Phone OTP login via Supabase Auth
- No Twilio SDK (configured in Supabase dashboard)
- Real OTP flow (no bypass)
- Demo phone with fixed OTP: 123456
- Session management with Supabase

---

## Implementation Log

### 2025-01-XX: Base Project Scaffolding
- Converted backend from FastAPI+MongoDB to Node.js+Hono+Supabase
- Initialized Supabase clients (frontend with ANON_KEY, backend with SERVICE_ROLE_KEY)
- Set up expo-router navigation structure
- Created placeholder screens and API endpoints
- Ready for Flow 1 implementation
