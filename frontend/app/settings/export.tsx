import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { authService } from '../../lib/auth';

export default function ExportMyData() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [hasExport, setHasExport] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const token = await authService.getAccessToken();
      if (!token) {
        router.back();
        return;
      }
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/export/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        setHasExport(!!json.hasExport);
        setGeneratedAt(json.generatedAt || null);
      }
    } catch (err) {
      console.error('Export status error:', err);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const token = await authService.getAccessToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/export/trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        setHasExport(true);
        setGeneratedAt(json.generatedAt || new Date().toISOString());
      } else {
        Alert.alert('Export failed', 'Could not generate your export. Please try again.');
      }
    } catch (err) {
      console.error('Export trigger error:', err);
      Alert.alert('Export failed', 'Could not generate your export. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const token = await authService.getAccessToken();
      if (!token) return;
      const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
      const res = await fetch(`${backendUrl}/api/export/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        Alert.alert('Download failed', 'Could not prepare your download link. Please try again.');
        return;
      }
      const json = await res.json();
      if (!json.url) {
        Alert.alert('Download failed', 'Could not prepare your download link. Please try again.');
        return;
      }

      const destination = new Directory(Paths.cache, 'exports');
      destination.create({ intermediates: true, idempotent: true });
      // idempotent: true -- overwrite if a previous download already exists at
      // this path (fixed filename, reused every generation). Without this,
      // downloadFileAsync rejects with DestinationAlreadyExists on any tap
      // after the first successful one -- confirmed root cause of repeated
      // "Download failed" after a working first download.
      const localFile = await File.downloadFileAsync(json.url, destination, { idempotent: true });

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(localFile.uri, {
          mimeType: 'application/zip',
          dialogTitle: 'Save or share your business data export',
        });
      } else {
        Alert.alert('Downloaded', `Saved to: ${localFile.uri}`);
      }
    } catch (err) {
      console.error('Export download error:', err);
      Alert.alert('Download failed', 'Could not download your export. Please try again.');
    } finally {
      setDownloading(false);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return null;
    return new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Export My Data</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#075E54" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <View style={styles.card}>
            <Ionicons name="archive-outline" size={40} color="#075E54" style={{ alignSelf: 'center', marginBottom: 12 }} />
            <Text style={styles.cardTitle}>Your business data, ready to download</Text>
            <Text style={styles.cardBody}>
              A ZIP file with a CSV for each part of your business — customers, invoices, products,
              payments, suppliers, expenses, and more. A fresh copy is prepared automatically every
              night, and you can generate one on demand any time.
            </Text>

            {hasExport && generatedAt ? (
              <Text style={styles.lastGenerated}>Last updated: {formatDate(generatedAt)}</Text>
            ) : (
              <Text style={styles.noExportYet}>No export generated yet.</Text>
            )}

            {hasExport && (
              <TouchableOpacity
                style={[styles.primaryBtn, downloading && styles.btnDisabled]}
                onPress={handleDownload}
                disabled={downloading}
              >
                {downloading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <Ionicons name="download-outline" size={18} color="#FFFFFF" />
                    <Text style={styles.primaryBtnText}>Download</Text>
                  </>
                )}
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.secondaryBtn, generating && styles.btnDisabled]}
              onPress={handleGenerate}
              disabled={generating}
            >
              {generating ? (
                <ActivityIndicator size="small" color="#075E54" />
              ) : (
                <>
                  <Ionicons name="refresh-outline" size={18} color="#075E54" />
                  <Text style={styles.secondaryBtnText}>Generate now</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.noteCard}>
            <Ionicons name="information-circle-outline" size={18} color="#888" />
            <Text style={styles.noteText}>
              Want a specific customer's chat history? Open that customer's chat, tap the three-dot
              menu, and choose "Export chat."
            </Text>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#075E54',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  backBtn: { marginRight: 12 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#222', textAlign: 'center', marginBottom: 8 },
  cardBody: { fontSize: 13, color: '#666', lineHeight: 19, textAlign: 'center', marginBottom: 16 },
  lastGenerated: { fontSize: 12, color: '#075E54', textAlign: 'center', marginBottom: 16, fontWeight: '600' },
  noExportYet: { fontSize: 12, color: '#999', textAlign: 'center', marginBottom: 16, fontStyle: 'italic' },
  primaryBtn: {
    flexDirection: 'row',
    backgroundColor: '#075E54',
    borderRadius: 10,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  primaryBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15, marginLeft: 8 },
  secondaryBtn: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#075E54',
    borderRadius: 10,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryBtnText: { color: '#075E54', fontWeight: '700', fontSize: 15, marginLeft: 8 },
  btnDisabled: { opacity: 0.6 },
  noteCard: {
    flexDirection: 'row',
    marginTop: 16,
    padding: 14,
    backgroundColor: '#FAFAFA',
    borderRadius: 10,
  },
  noteText: { flex: 1, fontSize: 12, color: '#888', marginLeft: 8, lineHeight: 17 },
});
