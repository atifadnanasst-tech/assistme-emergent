import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';

export default function LoginScreen() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const validatePhone = (input: string): boolean => {
    // Remove any non-numeric characters
    const cleaned = input.replace(/\D/g, '');
    return cleaned.length === 10;
  };

  const handlePhoneChange = (text: string) => {
    // Only allow numeric input
    const cleaned = text.replace(/\D/g, '');
    setPhone(cleaned);
    setError('');
  };

  const handleSendOTP = async () => {
    // Validate phone
    if (!validatePhone(phone)) {
      setError('Enter a valid 10-digit mobile number');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Format phone to E.164 WITHOUT '+' prefix to match Supabase test OTP config
      // Input: 9007188402 → Send: 919007188402
      const formattedPhone = `91${phone}`;
      
      console.log('📱 [LOGIN] Phone sent to Supabase:', formattedPhone);
      
      const { error: otpError } = await supabase.auth.signInWithOtp({
        phone: formattedPhone,
      });

      if (otpError) {
        console.error('❌ [LOGIN] signInWithOtp error:', otpError);
        // Handle specific Supabase errors
        if (otpError.message.includes('rate')) {
          setError('Too many attempts. Try again in 1 hour.');
        } else {
          setError(otpError.message || 'Failed to send OTP. Please try again.');
        }
        setLoading(false);
        return;
      }

      console.log('✅ [LOGIN] OTP request successful');
      
      // Navigate to OTP screen with formatted phone
      router.push({
        pathname: '/otp',
        params: { phone: formattedPhone },
      });
    } catch (err) {
      console.error('Send OTP error:', err);
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const isButtonEnabled = validatePhone(phone) && !loading;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.content}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Logo Section */}
        <View style={styles.logoContainer}>
          <View style={styles.logoTile}>
            <Text style={styles.logoText}>A</Text>
          </View>
          <Text style={styles.appName}>AssistMe</Text>
          <Text style={styles.tagline}>Your AI business assistant</Text>
        </View>

        {/* Input Section */}
        <View style={styles.inputContainer}>
          <View style={styles.phoneInputWrapper}>
            <Text style={styles.prefix}>+91</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter phone number"
              placeholderTextColor="rgba(255, 255, 255, 0.5)"
              value={phone}
              onChangeText={handlePhoneChange}
              keyboardType="phone-pad"
              maxLength={10}
              editable={!loading}
            />
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TouchableOpacity
            style={[
              styles.button,
              !isButtonEnabled && styles.buttonDisabled,
            ]}
            onPress={handleSendOTP}
            disabled={!isButtonEnabled}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Send OTP</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.hintText}>No password needed</Text>
        </View>
      </KeyboardAvoidingView>
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
    paddingHorizontal: 24,
  },
  logoContainer: {
    alignItems: 'center',
    marginTop: 80,
    marginBottom: 60,
  },
  logoTile: {
    width: 80,
    height: 80,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  logoText: {
    fontSize: 48,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  appName: {
    fontSize: 32,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  tagline: {
    fontSize: 16,
    color: '#B2DFDB',
  },
  inputContainer: {
    width: '100%',
  },
  phoneInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 12,
    paddingHorizontal: 16,
    height: 56,
    marginBottom: 8,
  },
  prefix: {
    fontSize: 16,
    color: '#FFFFFF',
    fontWeight: '600',
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 16,
    color: '#FFFFFF',
  },
  errorText: {
    color: '#FFCDD2',
    fontSize: 14,
    marginBottom: 12,
    marginLeft: 4,
  },
  button: {
    backgroundColor: '#25D366',
    borderRadius: 12,
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 16,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  hintText: {
    textAlign: 'center',
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 14,
    marginTop: 16,
  },
});
