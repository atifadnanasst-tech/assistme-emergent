import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useSegments } from 'expo-router';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';
import { useAuth } from '../contexts/AuthContext';

const TIMER_DURATION = 28; // seconds

export default function OTPScreen() {
  const router = useRouter();
  const segments = useSegments();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const { setIsAuthenticated } = useAuth();
  
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [timer, setTimer] = useState(TIMER_DURATION);
  const [canResend, setCanResend] = useState(false);
  const [resending, setResending] = useState(false);
  
  const inputRefs = useRef<(TextInput | null)[]>([]);
  const shakeAnim = useRef(new Animated.Value(0)).current;

  // Countdown timer
  useEffect(() => {
    if (timer > 0) {
      const interval = setInterval(() => {
        setTimer((prev) => {
          if (prev <= 1) {
            setCanResend(true);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [timer]);

  // Auto-verify when all boxes filled
  useEffect(() => {
    const otpString = otp.join('');
    if (otpString.length === 6 && !loading) {
      handleVerifyOTP(otpString);
    }
  }, [otp]);

  const handleOtpChange = (value: string, index: number) => {
    // Only allow numeric input
    if (value && !/^\d$/.test(value)) return;

    const newOtp = [...otp];
    newOtp[index] = value;
    setOtp(newOtp);
    setError('');

    // Move to next box
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyPress = (e: any, index: number) => {
    if (e.nativeEvent.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerifyOTP = async (otpString: string) => {
    if (otpString.length !== 6) return;

    setLoading(true);
    setError('');

    try {
      console.log('🔐 [OTP] ========== VERIFY OTP START ==========');
      console.log('🔐 [OTP] Phone:', phone);
      console.log('🔐 [OTP] OTP String:', otpString);
      
      // Verify OTP with Supabase
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        phone: phone!,
        token: otpString,
        type: 'sms',
      });

      // ISSUE 2 LOGGING: Full verifyOtp response
      console.log('📊 [OTP] Full verifyOtp response:', {
        hasData: !!data,
        hasSession: !!data?.session,
        hasUser: !!data?.user,
        hasError: !!verifyError,
        session: data?.session ? {
          access_token: data.session.access_token?.substring(0, 20) + '...',
          refresh_token: data.session.refresh_token?.substring(0, 20) + '...',
          expires_at: data.session.expires_at,
          token_type: data.session.token_type,
        } : null,
        user: data?.user ? {
          id: data.user.id,
          phone: data.user.phone,
        } : null,
        error: verifyError ? {
          message: verifyError.message,
          status: verifyError.status,
        } : null,
      });

      if (verifyError) {
        console.error('❌ [OTP] Verification error:', verifyError);
        
        // Handle specific errors
        if (verifyError.message.includes('expired')) {
          // EXPIRED OTP: Lock boxes, show resend only
          setError('OTP expired. Tap Resend.');
          setLoading(false);
          // Note: Boxes remain filled and locked - only Resend available
          return;
        } else if (verifyError.message.includes('invalid')) {
          // WRONG OTP: Shake, clear, allow retry
          setError('Incorrect OTP. Try again.');
          shakeAnimation();
          setTimeout(() => {
            setOtp(['', '', '', '', '', '']);
            inputRefs.current[0]?.focus();
          }, 500);
          setLoading(false);
          return;
        } else {
          // UNKNOWN ERROR: Shake and clear
          setError(verifyError.message || 'Verification failed. Try again.');
          shakeAnimation();
          setTimeout(() => {
            setOtp(['', '', '', '', '', '']);
            inputRefs.current[0]?.focus();
          }, 500);
          setLoading(false);
          return;
        }
      }

      if (!data.session) {
        setError('Session not created. Please try again.');
        setLoading(false);
        return;
      }

      // Call backend setup-session
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const setupResponse = await fetch(`${backendUrl}/api/auth/setup-session`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${data.session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!setupResponse.ok) {
        const errorData = await setupResponse.json();
        setError(errorData.error || 'Setup failed. Please try again.');
        setLoading(false);
        return;
      }

      const setupData = await setupResponse.json();

      // ISSUE 2 LOGGING: Full setup-session response
      console.log('📊 [OTP] Full setup-session response:', {
        status: setupResponse.status,
        statusText: setupResponse.statusText,
        data: setupData,
      });

      console.log('✅ [OTP] Backend setup-session successful:', {
        organisation_id: setupData.organisation_id,
        user_id: setupData.user_id,
        role: setupData.role,
        is_new_user: setupData.is_new_user,
      });

      // STEP 1: Store ALL session data securely (awaits each operation)
      console.log('🔐 [OTP] Starting secure storage of session data...');
      await authService.storeSession(
        data.session.access_token,
        data.session.refresh_token,
        setupData.organisation_id,
        setupData.user_id,
        setupData.role
      );
      console.log('🔐 [OTP] All session data stored successfully');

      // STEP 2: Verify tokens are actually stored before proceeding
      const storedToken = await authService.getAccessToken();
      const storedOrgId = await authService.getOrganisationId();
      
      // ISSUE 2 LOGGING: Value of SecureStore immediately after storing
      console.log('📊 [OTP] SecureStore verification immediately after storing:');
      console.log('  - Token exists:', !!storedToken);
      console.log('  - Token (first 20 chars):', storedToken?.substring(0, 20) + '...');
      console.log('  - Org ID:', storedOrgId);
      console.log('🔍 [OTP] Verification - Token stored:', !!storedToken);
      console.log('🔍 [OTP] Verification - Org ID stored:', storedOrgId);

      if (!storedToken || !storedOrgId) {
        console.error('❌ [OTP] Storage verification failed!');
        setError('Session storage failed. Please try again.');
        setLoading(false);
        return;
      }

      // STEP 3: Set the Supabase session in memory
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

      // Update auth state - navigation guard will handle redirect to /home
      console.log('🔐 [OTP] Setting authentication state to true');
      setIsAuthenticated(true);
      console.log('✅ [OTP] Authentication complete - guard will handle navigation');
    } catch (err) {
      console.error('Verify OTP error:', err);
      setError('Something went wrong. Please try again.');
      setLoading(false);
    }
  };

  const shakeAnimation = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, {
        toValue: 10,
        duration: 50,
        useNativeDriver: true,
      }),
      Animated.timing(shakeAnim, {
        toValue: -10,
        duration: 50,
        useNativeDriver: true,
      }),
      Animated.timing(shakeAnim, {
        toValue: 10,
        duration: 50,
        useNativeDriver: true,
      }),
      Animated.timing(shakeAnim, {
        toValue: 0,
        duration: 50,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const handleResendOTP = async () => {
    setResending(true);
    setError('');

    try {
      console.log('📱 [OTP] Resend - Phone sent to Supabase:', phone);
      
      const { error: resendError } = await supabase.auth.signInWithOtp({
        phone: phone!,
      });

      if (resendError) {
        console.error('❌ [OTP] Resend error:', resendError);
        setError(resendError.message || 'Failed to resend OTP.');
      } else {
        console.log('✅ [OTP] Resend successful');
        // Reset timer and OTP
        setTimer(TIMER_DURATION);
        setCanResend(false);
        setOtp(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
      }
    } catch (err) {
      console.error('❌ [OTP] Resend OTP error:', err);
      setError('Failed to resend OTP. Please try again.');
    } finally {
      setResending(false);
    }
  };

  const handleChangeNumber = () => {
    router.back();
  };

  // Mask phone number for display
  // Handles both formats: 919007188402 or +919007188402
  const maskedPhone = phone
    ? phone.startsWith('+')
      ? `${phone.slice(0, 3)} XXXXX ${phone.slice(-4)}`  // +91 XXXXX 8402
      : `+${phone.slice(0, 2)} XXXXX ${phone.slice(-4)}` // +91 XXXXX 8402
    : '';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.content}>
        {/* Logo */}
        <View style={styles.logoTile}>
          <Text style={styles.logoText}>A</Text>
        </View>

        {/* Heading */}
        <Text style={styles.heading}>Verify Account</Text>
        <Text style={styles.subtext}>{maskedPhone}</Text>

        {/* OTP Input Boxes */}
        <Animated.View
          style={[
            styles.otpContainer,
            { transform: [{ translateX: shakeAnim }] },
          ]}
        >
          {otp.map((digit, index) => (
            <TextInput
              key={index}
              ref={(ref) => (inputRefs.current[index] = ref)}
              style={[
                styles.otpBox,
                digit ? styles.otpBoxFilled : styles.otpBoxEmpty,
              ]}
              value={digit}
              onChangeText={(value) => handleOtpChange(value, index)}
              onKeyPress={(e) => handleKeyPress(e, index)}
              keyboardType="number-pad"
              maxLength={1}
              editable={!loading}
              selectTextOnFocus
            />
          ))}
        </Animated.View>

        {/* Error message */}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {/* Loading indicator */}
        {loading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color="#FFFFFF" />
            <Text style={styles.loadingText}>Verifying...</Text>
          </View>
        )}

        {/* Auto-detecting indicator */}
        {!loading && otp.every((d) => !d) && (
          <Text style={styles.autoDetectText}>Auto-detecting OTP ...</Text>
        )}

        {/* Resend timer/link */}
        <View style={styles.resendContainer}>
          {canResend ? (
            <TouchableOpacity
              onPress={handleResendOTP}
              disabled={resending}
            >
              <Text style={styles.resendActive}>
                {resending ? 'Resending...' : 'Resend OTP'}
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.resendInactive}>
              Resend in 0:{timer.toString().padStart(2, '0')}
            </Text>
          )}
        </View>

        {/* Change number */}
        <TouchableOpacity onPress={handleChangeNumber}>
          <Text style={styles.changeNumber}>Change number</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#075E54',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 60,
  },
  logoTile: {
    width: 64,
    height: 64,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 32,
  },
  logoText: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#075E54',
  },
  heading: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  subtext: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.7)',
    marginBottom: 48,
  },
  otpContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 16,
  },
  otpBox: {
    width: 48,
    height: 56,
    borderRadius: 12,
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  otpBoxEmpty: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    color: '#FFFFFF',
  },
  otpBoxFilled: {
    backgroundColor: '#B2DFDB',
    color: '#075E54',
  },
  errorText: {
    color: '#FFCDD2',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
  },
  loadingText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    marginLeft: 8,
  },
  autoDetectText: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 14,
    marginTop: 16,
  },
  resendContainer: {
    marginTop: 32,
  },
  resendActive: {
    color: '#25D366',
    fontSize: 16,
    fontWeight: '600',
  },
  resendInactive: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 16,
  },
  changeNumber: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    marginTop: 16,
    textDecorationLine: 'underline',
  },
});
