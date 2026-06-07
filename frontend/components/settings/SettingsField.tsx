/**
 * AssistMe — SettingsField.tsx
 * Phase 2, Jun 2026
 *
 * Reusable labeled input field for settings screens.
 * Supports: text, email, phone, number, multiline.
 * Used by: BusinessProfileScreen, future settings screens.
 */
import React from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';

interface SettingsFieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  required?: boolean;
  editable?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'numeric';
  autoCapitalize?: 'none' | 'words' | 'sentences' | 'characters';
  multiline?: boolean;
  numberOfLines?: number;
  maxLength?: number;
  hint?: string;
  style?: object;
}

export function SettingsField({
  label,
  value,
  onChangeText,
  placeholder,
  required = false,
  editable = true,
  keyboardType = 'default',
  autoCapitalize = 'sentences',
  multiline = false,
  numberOfLines = 1,
  maxLength,
  hint,
  style,
}: SettingsFieldProps) {
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.label}>
        {label}{required ? ' *' : ''}
      </Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#AAAAAA"
        editable={editable}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        multiline={multiline}
        numberOfLines={multiline ? numberOfLines : undefined}
        textAlignVertical={multiline ? 'top' : 'center'}
        maxLength={maxLength}
      />
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: 12 },
  label: { fontSize: 13, color: '#444444', marginBottom: 4, fontWeight: '500' },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1A1A1A',
  },
  inputMultiline: { height: 100, paddingTop: 10 },
  hint: { fontSize: 12, color: '#888888', marginTop: 4 },
});
