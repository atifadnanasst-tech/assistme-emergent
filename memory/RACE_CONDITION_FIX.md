# Race Condition Fix - Complete Implementation

## Problem Identified
After successful OTP verification, the app navigated back to Screen 1 instead of /home due to a race condition where session tokens were not fully persisted before the navigation guard executed.

## Root Cause
1. Storage operations were not properly awaited in sequence
2. No in-memory state update after storage
3. Navigation guard executed before session state was ready
4. No loading gate to prevent premature redirect logic

## Fix Applied (Exact Sequence)

### 1. Storage Operations - Sequential Awaits with Logging
**File**: `/app/frontend/lib/auth.ts`

**Changes**:
- Each `SecureStore.setItemAsync()` now awaited individually
- Added detailed logging for each storage step
- Console logs confirm completion of each operation

**Code**:
```typescript
async storeSession(accessToken, refreshToken, orgId, userId, role) {
  console.log('🔐 [AUTH] Starting session storage...');
  await SecureStore.setItemAsync(TOKEN_KEY, accessToken);
  console.log('🔐 [AUTH] ✅ Access token stored');
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
  console.log('🔐 [AUTH] ✅ Refresh token stored');
  await SecureStore.setItemAsync(ORG_ID_KEY, orgId);
  console.log('🔐 [AUTH] ✅ Organisation ID stored');
  await SecureStore.setItemAsync(USER_ID_KEY, userId);
  console.log('🔐 [AUTH] ✅ User ID stored');
  await SecureStore.setItemAsync(USER_ROLE_KEY, role);
  console.log('🔐 [AUTH] ✅ User role stored');
  console.log('🔐 [AUTH] All session data stored successfully');
}
```

### 2. OTP Verification Handler - 5-Step Sequence with Verification
**File**: `/app/frontend/app/otp.tsx`

**Changes Applied**:

**STEP 1**: Await ALL storage operations
```typescript
console.log('🔐 [OTP] Starting secure storage of session data...');
await authService.storeSession(
  data.session.access_token,
  data.session.refresh_token,
  setupData.organisation_id,
  setupData.user_id,
  setupData.role
);
console.log('🔐 [OTP] All session data stored successfully');
```

**STEP 2**: Verify tokens are actually stored before proceeding
```typescript
const storedToken = await authService.getAccessToken();
const storedOrgId = await authService.getOrganisationId();
console.log('🔍 [OTP] Verification - Token stored:', !!storedToken);
console.log('🔍 [OTP] Verification - Org ID stored:', storedOrgId);

if (!storedToken || !storedOrgId) {
  console.error('❌ [OTP] Storage verification failed!');
  setError('Session storage failed. Please try again.');
  setLoading(false);
  return;
}
```

**STEP 3**: Set Supabase session in memory
```typescript
console.log('🔄 [OTP] Setting Supabase session in memory...');
const { error: setSessionError } = await supabase.auth.setSession({
  access_token: data.session.access_token,
  refresh_token: data.session.refresh_token,
});

if (setSessionError) {
  console.error('❌ [OTP] Failed to set Supabase session:', setSessionError);
  setError('Session setup failed. Please try again.');
  setLoading(false);
  return;
}

console.log('✅ [OTP] Supabase session set in memory');
```

**STEP 4**: Small delay to ensure all state updates propagate
```typescript
await new Promise(resolve => setTimeout(resolve, 100));
```

**STEP 5**: Navigate to home (only after everything is ready)
```typescript
console.log('🚀 [OTP] Navigating to /home...');
router.replace('/home');
```

### 3. Navigation Guard - Loading Gate with Logging
**File**: `/app/frontend/app/_layout.tsx`

**Changes**:

**Added `isCheckingAuth` state**:
```typescript
const [isCheckingAuth, setIsCheckingAuth] = useState(false);
```

**Loading Gate in useEffect**:
```typescript
if (!isReady || isCheckingAuth) {
  console.log('🚦 [LAYOUT] Auth check in progress, skipping navigation logic');
  return;
}
```

**Detailed logging in navigation guard**:
```typescript
console.log('🚦 [LAYOUT] Navigation guard executing:', {
  isAuthenticated,
  currentSegment: segments[0],
  inAuthGroup,
});
```

**Enhanced checkAuth with logging**:
```typescript
const checkAuth = async () => {
  setIsCheckingAuth(true);
  console.log('🔍 [LAYOUT] Starting auth check...');
  
  try {
    const token = await authService.getAccessToken();
    console.log('🔍 [LAYOUT] Token check:', token ? 'Token found' : 'No token');
    
    if (token) {
      const isValid = await authService.isSessionValid();
      console.log('🔍 [LAYOUT] Session validity:', isValid);
      
      if (isValid) {
        setIsAuthenticated(true);
        console.log('✅ [LAYOUT] Session valid - user authenticated');
      } else {
        // Refresh logic with logging
      }
    } else {
      setIsAuthenticated(false);
      console.log('❌ [LAYOUT] No token - user not authenticated');
    }
  } catch (error) {
    console.error('❌ [LAYOUT] Auth check error:', error);
    setIsAuthenticated(false);
  } finally {
    setIsCheckingAuth(false);
    setIsReady(true);
    await SplashScreen.hideAsync();
    console.log('✅ [LAYOUT] Auth check complete');
  }
};
```

**Loading screen guard**:
```typescript
if (!isReady || isCheckingAuth) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color="#075E54" />
    </View>
  );
}
```

## Logging Points Added

### Point 1: Before Navigation in OTP Handler
- `🔐 [OTP] Starting secure storage of session data...`
- `🔐 [OTP] All session data stored successfully`
- `🔍 [OTP] Verification - Token stored: true`
- `🔍 [OTP] Verification - Org ID stored: <uuid>`
- `✅ [OTP] Supabase session set in memory`
- `🚀 [OTP] Navigating to /home...`

### Point 2: Inside Auth Guard
- `🔍 [LAYOUT] Starting auth check...`
- `🔍 [LAYOUT] Token check: Token found`
- `🔍 [LAYOUT] Session validity: true`
- `✅ [LAYOUT] Session valid - user authenticated`
- `🚦 [LAYOUT] Navigation guard executing: {...}`
- `✅ [LAYOUT] User on correct screen, no redirect needed`

## Expected Console Output on Successful Login

```
🔐 [OTP] Starting secure storage of session data...
🔐 [AUTH] Starting session storage...
🔐 [AUTH] ✅ Access token stored
🔐 [AUTH] ✅ Refresh token stored
🔐 [AUTH] ✅ Organisation ID stored
🔐 [AUTH] ✅ User ID stored
🔐 [AUTH] ✅ User role stored
🔐 [AUTH] All session data stored successfully
🔐 [OTP] All session data stored successfully
🔍 [OTP] Verification - Token stored: true
🔍 [OTP] Verification - Org ID stored: <uuid>
🔄 [OTP] Setting Supabase session in memory...
✅ [OTP] Supabase session set in memory
🚀 [OTP] Navigating to /home...
🔍 [LAYOUT] Starting auth check...
🔍 [LAYOUT] Token check: Token found
🔍 [LAYOUT] Session validity: true
✅ [LAYOUT] Session valid - user authenticated
✅ [LAYOUT] Auth check complete
🚦 [LAYOUT] Navigation guard executing: { isAuthenticated: true, currentSegment: 'home', inAuthGroup: false }
✅ [LAYOUT] User on correct screen, no redirect needed
```

## Testing Checklist

- [ ] Login with phone number
- [ ] Enter OTP: 123456
- [ ] Check console for all storage logs
- [ ] Verify token is stored before navigation
- [ ] Confirm navigation to /home (not back to Screen 1)
- [ ] Check console shows "User on correct screen"
- [ ] Refresh page - should stay on /home
- [ ] Repeat flow 3-5 times to confirm consistency

## Files Modified

1. `/app/frontend/lib/auth.ts` - Sequential storage with logging
2. `/app/frontend/app/otp.tsx` - 5-step verification sequence
3. `/app/frontend/app/_layout.tsx` - Loading gate and navigation guard logging

## Status

✅ Race condition fix implemented
⏳ Awaiting testing to confirm OTP flow lands on /home consistently
❌ Do NOT proceed to Flow 2 until confirmed working

**Next Step**: Test the complete flow and verify console logs show correct sequence.
