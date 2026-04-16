import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import StubScreen from '../../components/StubScreen';

export default function ChatScreen() {
  const { customer_id } = useLocalSearchParams<{ customer_id: string }>();

  return (
    <StubScreen
      title="Chat"
      description={`Customer chat screen (${customer_id?.slice(0, 8)}…) — coming in Flow 3`}
    />
  );
}
