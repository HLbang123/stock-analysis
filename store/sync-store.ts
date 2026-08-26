'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * 云同步身份与元数据（本地持久化）。
 * syncKey 只存在于已配对设备本地（同步码方案=零知识，服务器只见密文）。
 * 注：syncId/syncKeyB64 存 localStorage 属设备可信边界内，与 AI profile 的 apiKey 同级。
 */

/** 共享设备清单条目（随快照 blob v2 四处同步；lastSyncedAt=该设备最近一次实际上传时间） */
export interface SyncDeviceEntry {
  id: string;
  name: string;
  lastSyncedAt: number;
}

/** 本机设备 id：6 字节随机 hex（同步组内唯一即可，跨组可复用） */
function randomDeviceId(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 默认设备名：微信内置浏览器优先识别，其次平台+浏览器（用户可在弹窗改名） */
export function defaultDeviceName(): string {
  if (typeof navigator === 'undefined') return '浏览器';
  const ua = navigator.userAgent;
  if (/MicroMessenger/i.test(ua)) return '微信内置浏览器';
  const mobile = /Android/i.test(ua) ? 'Android' : /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : '';
  if (mobile) return mobile;
  const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : '浏览器';
  const os = /Win/i.test(navigator.platform || '') ? 'Windows' : /Mac/i.test(navigator.platform || '') ? 'Mac' : /Linux/i.test(navigator.platform || '') ? 'Linux' : '';
  return os ? `${os} ${browser}` : browser;
}

interface SyncState {
  // 身份（开启云同步后生成；关闭/换码时清空）
  syncId: string;
  syncKeyB64: string;
  keyHash: string;
  enabled: boolean;
  // 同步行为
  autoSync: boolean;          // 默认开（L2 准实时）；关 = 纯手动
  // 本机设备身份（随 persist 保存；clearIdentity 不清，换身份仍算同一台设备）
  deviceId: string;
  deviceName: string;
  // 共享设备清单（随快照 blob 同步，多端一份）
  devices: SyncDeviceEntry[];
  // 进度
  lastVersion: number;        // 本地已确认的服务器版本
  lastSyncAt: number | null;  // 最近一次成功上传/拉取时间戳
  lastError: string | null;   // 最近一次自动同步错误（弹窗展示用，失败不弹窗）
  // 引导条
  bannerDismissed: boolean;

  setIdentity: (id: string, keyB64: string, keyHash: string) => void;
  clearIdentity: () => void;
  setAutoSync: (v: boolean) => void;
  ensureDevice: () => void;
  setDeviceName: (name: string) => void;
  upsertDevice: (entry: SyncDeviceEntry) => void;
  setDevices: (list: SyncDeviceEntry[]) => void;
  markSynced: (version: number, at: number) => void;
  setLastError: (msg: string | null) => void;
  dismissBanner: () => void;
}

export const useSyncStore = create<SyncState>()(
  persist(
    (set, get) => ({
      syncId: '',
      syncKeyB64: '',
      keyHash: '',
      enabled: false,
      autoSync: true,
      deviceId: '',
      deviceName: '',
      devices: [],
      lastVersion: 0,
      lastSyncAt: null,
      lastError: null,
      bannerDismissed: false,

      setIdentity: (syncId, syncKeyB64, keyHash) =>
        set({ syncId, syncKeyB64, keyHash, enabled: true, lastError: null }),
      clearIdentity: () =>
        set({ syncId: '', syncKeyB64: '', keyHash: '', enabled: false, lastVersion: 0, lastSyncAt: null, lastError: null, devices: [] }),
      setAutoSync: (v) => set({ autoSync: v }),
      // 首台设备 / 首次使用懒生成；重复调用幂等
      ensureDevice: () => {
        if (get().deviceId) return;
        set({ deviceId: randomDeviceId(), deviceName: defaultDeviceName() });
      },
      setDeviceName: (name) => set({ deviceName: name }),
      upsertDevice: (entry) =>
        set((s) => {
          const i = s.devices.findIndex((d) => d.id === entry.id);
          const devices = [...s.devices];
          if (i >= 0) devices[i] = entry;
          else devices.push(entry);
          return { devices };
        }),
      setDevices: (devices) => set({ devices }),
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
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        devices: state.devices,
        lastVersion: state.lastVersion,
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastError,
        bannerDismissed: state.bannerDismissed,
      }),
    }
  )
);
