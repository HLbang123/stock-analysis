'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 分享快照数据（分组名 + 标的代码+名称，明文；不带任何 AI 配置） */
export interface ShareGroup {
  name: string;
  stocks: { code: string; name: string }[];
}
export interface ShareSnapshotData {
  groups: ShareGroup[];
}

/** 一条订阅（码 + 显示名 + 缓存快照；dead=对方已撤销/码过期，仅保留最后快照展示） */
export interface ShareSubscription {
  code: string;
  displayName: string;
  snapshot: ShareSnapshotData | null;
  fetchedAt: number | null; // 本地最近拉取时间
  updatedAt: number | null; // 服务器快照更新时间（拉取时记录）
  dead?: boolean;
}

interface ShareState {
  // 我的分享（shareToken=写凭证，只存本地；分享码=读凭证，给订阅方）
  shareCode: string;
  shareToken: string;
  shareDisplayName: string;
  shareGroupIds: string[]; // 分享的分组 id
  shareMode: 'manual' | 'auto';
  shareExpireDays: number | null; // null=长期
  // 我订阅的
  subscriptions: ShareSubscription[];

  setShare: (code: string, token: string, displayName: string, groupIds: string[]) => void;
  setShareDisplayName: (name: string) => void;
  setShareGroupIds: (ids: string[]) => void;
  setShareMode: (m: 'manual' | 'auto') => void;
  setShareExpireDays: (d: number | null) => void;
  clearShare: () => void;
  upsertSubscription: (sub: ShareSubscription) => void;
  removeSubscription: (code: string) => void;
  markSubscriptionDead: (code: string) => void;
}

export const useShareStore = create<ShareState>()(
  persist(
    (set) => ({
      shareCode: '',
      shareToken: '',
      shareDisplayName: '',
      shareGroupIds: [],
      shareMode: 'manual',
      shareExpireDays: null,
      subscriptions: [],

      setShare: (code, token, displayName, groupIds) =>
        set({ shareCode: code, shareToken: token, shareDisplayName: displayName, shareGroupIds: groupIds }),
      setShareDisplayName: (name) => set({ shareDisplayName: name }),
      setShareGroupIds: (ids) => set({ shareGroupIds: ids }),
      setShareMode: (m) => set({ shareMode: m }),
      setShareExpireDays: (d) => set({ shareExpireDays: d }),
      clearShare: () =>
        set({ shareCode: '', shareToken: '', shareDisplayName: '', shareGroupIds: [] }),
      upsertSubscription: (sub) =>
        set((s) => {
          const i = s.subscriptions.findIndex((x) => x.code === sub.code);
          const subscriptions = [...s.subscriptions];
          // 成功拉到新快照即复活（撤销后对方重新开同码分享的场景）
          if (i >= 0) subscriptions[i] = { ...sub, dead: false };
          else subscriptions.push(sub);
          return { subscriptions };
        }),
      removeSubscription: (code) =>
        set((s) => ({ subscriptions: s.subscriptions.filter((x) => x.code !== code) })),
      markSubscriptionDead: (code) =>
        set((s) => ({
          subscriptions: s.subscriptions.map((x) => (x.code === code ? { ...x, dead: true } : x)),
        })),
    }),
    {
      name: 'stock-share-store',
      // token 与 syncKeyB64 同级（设备可信边界内），全量持久化
      partialize: (s) => ({
        shareCode: s.shareCode,
        shareToken: s.shareToken,
        shareDisplayName: s.shareDisplayName,
        shareGroupIds: s.shareGroupIds,
        shareMode: s.shareMode,
        shareExpireDays: s.shareExpireDays,
        subscriptions: s.subscriptions,
      }),
    }
  )
);
