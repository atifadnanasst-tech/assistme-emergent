import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import StubScreen from '../../../components/StubScreen';

export default function NewQuoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StubScreen title="New Quote" description={`Create quote for ${id?.slice(0, 8)}… — coming in Flow 4`} />;
}
