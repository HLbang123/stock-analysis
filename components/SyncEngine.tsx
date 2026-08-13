'use client';

/** 云同步 + 分享自动上传挂载点（空渲染组件，Shell 内全站生效） */
import { useEffect } from 'react';
import { initSyncEngine } from '@/services/sync/engine';
import { initShareAutoSync } from '@/services/share/engine';

export function SyncEngine() {
  useEffect(() => {
    initSyncEngine();
    initShareAutoSync();
  }, []);
  return null;
}
