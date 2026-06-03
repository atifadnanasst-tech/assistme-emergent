/**
 * AssistMe - BottomSheet primitive
 * Location: /frontend/components/primitives/BottomSheet.tsx
 * Created: Session G, Jun 2026
 *
 * PURPOSE: Reusable bottom sheet modal — presentation only, no business logic.
 *          Follows the exact Modal pattern from customer_id.tsx (Action Preview Sheet).
 *
 * CURRENT CONSUMERS: ProductFormSheet
 * PLANNED CONSUMERS: Action Preview Sheet, Date Picker Sheet, Payment Sheet
 *
 * BUILD-BESIDE-THEN-MIGRATE: customer_id.tsx inline modals stay untouched.
 * New screens use this primitive. Migration happens after 100-200 users.
 */

import React from 'react';
import {
  Modal, View, Pressable, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface BottomSheetProps {
  visible: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
  maxHeight?: number;
  scrollable?: boolean;
}

export default function BottomSheet({ visible, onDismiss, children, maxHeight, scrollable = true }: BottomSheetProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.overlay}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={onDismiss} />
          <View style={[styles.container, { paddingBottom: insets.bottom + 8 }]}>
            <View style={styles.handle} />
            {scrollable ? (
              <ScrollView style={{ maxHeight: maxHeight || 520 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {children}
              </ScrollView>
            ) : (
              <View style={{ maxHeight: maxHeight || 520 }}>{children}</View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  container: {
    backgroundColor: '#FFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 12,
  },
  handle: { width: 40, height: 4, backgroundColor: '#DDD', borderRadius: 2, alignSelf: 'center', marginVertical: 12 },
});
