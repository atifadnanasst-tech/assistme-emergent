# Flow 1 - Final Testing Requirements

## Changes Applied

### 1. ✅ Logout Sequence Fixed
**File**: `/app/frontend/app/home.tsx` + `/app/frontend/lib/auth.ts`

**Complete Sequence**:
```typescript
// STEP 1: Delete all SecureStore items
await SecureStore.deleteItemAsync('access_token')        // ✅
await SecureStore.deleteItemAsync('refresh_token')       // ✅
await SecureStore.deleteItemAsync('organisation_id')     // ✅
await SecureStore.deleteItemAsync('user_id')             // ✅
await SecureStore.deleteItemAsync('user_role')           // ✅

// STEP 2: Sign out from Supabase
await supabase.auth.signOut()                            // ✅

// STEP 3: Navigate to login
router.replace('/login')                                 // ✅
```

**Logging Added**:
- `🗑️ [AUTH] Starting session clearance...`
- `🗑️ [AUTH] ✅ Access token deleted`
- `🗑️ [AUTH] ✅ Refresh token deleted`
- `🗑️ [AUTH] ✅ Organisation ID deleted`
- `🗑️ [AUTH] ✅ User ID deleted`
- `🗑️ [AUTH] ✅ User role deleted`
- `✅ [AUTH] All session data cleared`
- `🔓 [LOGOUT] Signing out from Supabase...`
- `✅ [LOGOUT] Supabase signOut complete`
- `🚀 [LOGOUT] Navigating to login...`

### 2. ✅ 100ms Delay Removed
**File**: `/app/frontend/app/otp.tsx`

**Before**:
```typescript
await new Promise(resolve => setTimeout(resolve, 100)); // ❌ Temporary hack
router.replace('/home');
```

**After**:
```typescript
// Navigate to home (proper await sequencing - no delay needed)
router.replace('/home'); // ✅ Based on proper awaits only
```

**Reason**: Flow now works correctly based on proper await sequencing alone. All storage operations are awaited individually, Supabase session is set in memory, and storage is verified before navigation.

### 3. Auth Flow Summary

**Login Flow (OTP → Home)**:
1. All SecureStore operations awaited individually ✅
2. Storage verified before proceeding ✅
3. Supabase session set in memory ✅
4. Navigate to /home ✅

**Logout Flow (Home → Login)**:
1. All SecureStore items deleted individually ✅
2. Supabase signOut called ✅
3. Navigate to /login ✅

---

## Required Testing (Expo Go on Device)

### Test Environment
- **Platform**: Expo Go on physical device (iOS or Android)
- **NOT**: Web preview (web testing not sufficient)
- **Demo Phone**: Any 10-digit number (e.g., 9876543210)
- **Demo OTP**: 123456 (if configured in Supabase)

---

### Test 1: Auto-Login on App Open
**Steps**:
1. Open app for the first time (fresh install or after clearing data)
2. Login with phone + OTP
3. Reach home screen
4. Close app completely (swipe away from multitasking)
5. Reopen app

**Expected Result**: ✅
- App checks for stored session
- Finds valid token
- Skips login/OTP screens
- Lands directly on /home
- No flickering or bouncing

**Console Logs**:
```
🔍 [LAYOUT] Starting auth check...
🔍 [LAYOUT] Token check: Token found
🔍 [LAYOUT] Session validity: true
✅ [LAYOUT] Session valid - user authenticated
✅ [LAYOUT] Auth check complete
🚦 [LAYOUT] Navigation guard executing: { isAuthenticated: true, currentSegment: 'home', inAuthGroup: false }
✅ [LAYOUT] User on correct screen, no redirect needed
```

---

### Test 2: Logout Flow
**Steps**:
1. From home screen, tap "Logout" button
2. Observe navigation

**Expected Result**: ✅
- Lands on login screen
- Does NOT bounce back to home
- Stays on login screen
- All SecureStore items deleted
- Supabase session cleared

**Console Logs**:
```
🚪 [LOGOUT] Starting logout sequence...
🗑️ [LOGOUT] Clearing SecureStore...
🗑️ [AUTH] Starting session clearance...
🗑️ [AUTH] ✅ Access token deleted
🗑️ [AUTH] ✅ Refresh token deleted
🗑️ [AUTH] ✅ Organisation ID deleted
🗑️ [AUTH] ✅ User ID deleted
🗑️ [AUTH] ✅ User role deleted
✅ [AUTH] All session data cleared
✅ [LOGOUT] SecureStore cleared
🔓 [LOGOUT] Signing out from Supabase...
✅ [LOGOUT] Supabase signOut complete
🚀 [LOGOUT] Navigating to login...
✅ [LOGOUT] Logout complete
🔍 [LAYOUT] Starting auth check...
🔍 [LAYOUT] Token check: No token
❌ [LAYOUT] No token - user not authenticated
```

---

### Test 3: Fresh Login After Logout
**Steps**:
1. From login screen (after logout)
2. Enter phone number: 9876543210
3. Tap "Send OTP"
4. Enter OTP: 123456
5. Observe navigation

**Expected Result**: ✅
- OTP verification succeeds
- All session data stored
- Lands on /home
- Does NOT bounce back to login
- Session persists

**Console Logs**:
```
✅ [OTP] Backend setup-session successful
🔐 [OTP] Starting secure storage of session data...
🔐 [AUTH] Starting session storage...
🔐 [AUTH] ✅ Access token stored
🔐 [AUTH] ✅ Refresh token stored
🔐 [AUTH] ✅ Organisation ID stored
🔐 [AUTH] ✅ User ID stored
🔐 [AUTH] ✅ User role stored
✅ [AUTH] All session data stored successfully
🔐 [OTP] All session data stored successfully
🔍 [OTP] Verification - Token stored: true
🔍 [OTP] Verification - Org ID stored: <uuid>
✅ [OTP] Supabase session set in memory
🚀 [OTP] Navigating to /home...
```

---

### Test 4: Session Persistence (App Restart)
**Steps**:
1. Complete Test 3 (fresh login → home)
2. Close app completely (swipe away)
3. Wait 5 seconds
4. Reopen app

**Expected Result**: ✅
- App checks for stored session
- Finds valid token
- Auto-login succeeds
- Lands on /home directly
- No login screen shown

**Console Logs**:
```
🔍 [LAYOUT] Starting auth check...
🔍 [LAYOUT] Token check: Token found
🔍 [LAYOUT] Session validity: true
✅ [LAYOUT] Session valid - user authenticated
✅ [LAYOUT] Auth check complete
```

---

## Testing Instructions

### How to Test on Expo Go

1. **Install Expo Go**:
   - iOS: Download from App Store
   - Android: Download from Play Store

2. **Get QR Code**:
   - Backend logs will show QR code after expo starts
   - Or use: `https://trader-flow-guide.preview.emergentagent.com`

3. **Scan QR Code**:
   - iOS: Open Camera app → point at QR
   - Android: Open Expo Go → tap "Scan QR Code"

4. **Enable Console Logs**:
   - Shake device → tap "Debug Remote JS"
   - Open Chrome DevTools to see logs
   - Or use: Expo Go menu → "Show Performance Monitor"

5. **Run All 4 Tests**:
   - Test 1: Auto-login ✅
   - Test 2: Logout ✅
   - Test 3: Fresh login ✅
   - Test 4: App restart ✅

---

## Success Criteria

**All 4 tests must pass**:
- ✅ Test 1: Auto-login works
- ✅ Test 2: Logout lands on login, no bounce
- ✅ Test 3: Fresh login lands on home, no bounce
- ✅ Test 4: Session persists after restart

**Additional Checks**:
- No race conditions
- No flickering/bouncing between screens
- All console logs appear in correct sequence
- SecureStore operations complete before navigation
- Supabase session set correctly

---

## If Any Test Fails

**Report**:
1. Which test failed (1, 2, 3, or 4)
2. What actually happened vs expected
3. Console logs at the point of failure
4. Device type (iOS/Android)

**Do NOT proceed to Flow 2** until all 4 tests pass consistently.

---

## Next Steps After Testing

Once all 4 tests pass:
1. ✅ Flow 1 is COMPLETE
2. ✅ Mark gate check as PASSED
3. ✅ Ready to proceed to Flow 2

If any test fails:
1. ❌ Fix the specific issue
2. ❌ Re-test all 4 tests
3. ❌ Do NOT proceed to Flow 2

---

## Current Status

- ✅ Logout sequence fixed (complete sequence with logging)
- ✅ 100ms delay removed (proper await sequencing only)
- ✅ All logging in place
- ⏳ Awaiting device testing (4 tests)
- ❌ DO NOT proceed to Flow 2 until all tests pass

**Testing Platform Required**: Expo Go on physical device (not web)
