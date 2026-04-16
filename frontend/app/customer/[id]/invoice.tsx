import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import StubScreen from '../../../components/StubScreen';

export default function NewInvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StubScreen title="New Invoice" description={`Create invoice for ${id?.slice(0, 8)}… — coming in Flow 4`} />;
}
