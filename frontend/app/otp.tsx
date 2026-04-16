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
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '../lib/supabase';
import { authService } from '../lib/auth';

const TIMER_DURATION = 28; // seconds

export default function OTPScreen() {
  const router = useRouter();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  
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
      // Verify OTP with Supabase
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        phone: phone!,
        token: otpString,
        type: 'sms',
      });

      if (verifyError) {
        // Handle specific errors
        if (verifyError.message.includes('expired')) {
          setError('OTP expired. Tap Resend.');
        } else if (verifyError.message.includes('invalid')) {
          setError('Incorrect OTP. Try again.');
        } else {
          setError(verifyError.message || 'Verification failed. Try again.');
        }
        
        // Shake animation and clear
        shakeAnimation();
        setTimeout(() => {
          setOtp(['', '', '', '', '', '']);
          inputRefs.current[0]?.focus();
        }, 500);
        
        setLoading(false);
        return;
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

      // Store session securely
      await authService.storeSession(
        data.session.access_token,
        data.session.refresh_token,
        setupData.organisation_id,
        setupData.user_id,
        setupData.role
      );

      // Navigate to home
      router.replace('/home');
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
      const { error: resendError } = await supabase.auth.signInWithOtp({
        phone: phone!,
      });

      if (resendError) {
        setError(resendError.message || 'Failed to resend OTP.');
      } else {
        // Reset timer and OTP
        setTimer(TIMER_DURATION);
        setCanResend(false);
        setOtp(['', '', '', '', '', '']);
        inputRefs.current[0]?.focus();
      }
    } catch (err) {
      console.error('Resend OTP error:', err);
      setError('Failed to resend OTP. Please try again.');
    } finally {
      setResending(false);
    }
  };

  const handleChangeNumber = () => {
    router.back();
  };

  const maskedPhone = phone
    ? `${phone.slice(0, 3)} XXXXX ${phone.slice(-4)}`
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
