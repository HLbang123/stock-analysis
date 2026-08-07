'use client';

/** 云同步引擎挂载点（空渲染组件，Shell 内全站生效） */
import { useEffect } from 'react';
import { initSyncEngine } from '@/services/sync/engine';

export function SyncEngine() {
  useEffect(() => {
    initSyncEngine();
  }, []);
  return null;
}
