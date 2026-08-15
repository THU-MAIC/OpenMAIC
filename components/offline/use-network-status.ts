'use client';

import { useEffect, useState } from 'react';

interface NetworkInformationLike extends EventTarget {
  effectiveType?: string;
  downlink?: number;
  saveData?: boolean;
}

export interface NetworkStatus {
  online: boolean;
  effectiveType?: string;
  downlink?: number;
  saveData: boolean;
  changedAt: number;
}

const INITIAL_NETWORK_STATUS: NetworkStatus = {
  online: true,
  saveData: false,
  changedAt: 0,
};

function getConnection(): NetworkInformationLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
}

function readNetworkStatus(): NetworkStatus {
  const connection = getConnection();
  return {
    online: navigator.onLine,
    effectiveType: connection?.effectiveType,
    downlink: connection?.downlink,
    saveData: connection?.saveData ?? false,
    changedAt: Date.now(),
  };
}

export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(INITIAL_NETWORK_STATUS);

  useEffect(() => {
    const connection = getConnection();
    const update = () => setStatus(readNetworkStatus());

    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    connection?.addEventListener('change', update);
    update();

    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      connection?.removeEventListener('change', update);
    };
  }, []);

  return status;
}
