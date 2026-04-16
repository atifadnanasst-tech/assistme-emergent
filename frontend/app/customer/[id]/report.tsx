import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import StubScreen from '../../../components/StubScreen';

export default function CustomerReportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StubScreen title="Customer Report" description={`Contact details for ${id?.slice(0, 8)}… — coming in Flow 3B`} />;
}
