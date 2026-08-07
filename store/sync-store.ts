'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 云同步身份与元数据（本地持久化）。
 * syncKey 只存在于已配对设备本地（同步码方案=零知识，服务器只见密文）。
 * 注：syncId/syncKeyB64 存 localStorage 属设备可信边界内，与 AI profile 的 apiKey 同级。
 */

interface SyncState {
  // 身份（开启云同步后生成；关闭/换码时清空）
  syncId: string;
  syncKeyB64: string;
  keyHash: string;
  enabled: boolean;
  // 同步行为
  autoSync: boolean;          // 默认开（L2 准实时）；关 = 纯手动
  // 进度
  lastVersion: number;        // 本地已确认的服务器版本
  lastSyncAt: number | null;  // 最近一次成功上传/拉取时间戳
  lastError: string | null;   // 最近一次自动同步错误（弹窗展示用，失败不弹窗）
  // 引导条
  bannerDismissed: boolean;

  setIdentity: (id: string, keyB64: string, keyHash: string) => void;
  clearIdentity: () => void;
  setAutoSync: (v: boolean) => void;
  markSynced: (version: number, at: number) => void;
  setLastError: (msg: string | null) => void;
  dismissBanner: () => void;
}

export const useSyncStore = create<SyncState>()(
  persist(
    (set) => ({
      syncId: '',
      syncKeyB64: '',
      keyHash: '',
      enabled: false,
      autoSync: true,
      lastVersion: 0,
      lastSyncAt: null,
      lastError: null,
      bannerDismissed: false,

      setIdentity: (syncId, syncKeyB64, keyHash) =>
        set({ syncId, syncKeyB64, keyHash, enabled: true, lastError: null }),
      clearIdentity: () =>
        set({ syncId: '', syncKeyB64: '', keyHash: '', enabled: false, lastVersion: 0, lastSyncAt: null, lastError: null }),
      setAutoSync: (v) => set({ autoSync: v }),
      markSynced: (version, at) => set({ lastVersion: version, lastSyncAt: at, lastError: null }),
      setLastError: (msg) => set({ lastError: msg }),
      dismissBanner: () => set({ bannerDismissed: true }),
    }),
    {
      name: 'stock-sync-store',
      partialize: (state) => ({
        syncId: state.syncId,
        syncKeyB64: state.syncKeyB64,
        keyHash: state.keyHash,
        enabled: state.enabled,
        autoSync: state.autoSync,
        lastVersion: state.lastVersion,
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastError,
        bannerDismissed: state.bannerDismissed,
      }),
    }
  )
);
